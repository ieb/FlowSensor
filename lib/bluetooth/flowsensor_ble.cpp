#define LOG_LOCAL_LEVEL ESP_LOG_INFO
#include "esp_log.h"
#include <Preferences.h>

#include "flowsensor_ble.h"

static const char* TAG = "FS_BLE";

// BMS register offsets (little-endian — byte-swapped from BMS big-endian by copyReg03/copyReg04)
#define REG03_PACK_V_U16      0
#define REG03_CURRENT_S16     2
#define REG03_REMAINING_U16   4
#define REG03_FULL_U16        6
#define REG03_CYCLES_U16      8
#define REG03_ERRORS_U16      16
#define REG03_SOC_U8          19
#define REG03_FET_U8          20
#define REG03_NCELLS_U8       21
#define REG03_NNTC_U8         22
// NTC temps start at offset 23 (each U16 little-endian)


void FlowSensorBLE::begin(const char* deviceName) {
    _pin = BLE_PIN_NUMBER;

    NimBLEDevice::init(deviceName);
    NimBLEDevice::setMTU(64);

    _server = NimBLEDevice::createServer();
    _server->setCallbacks(this);

    NimBLEService* service = _server->createService(FS_SERVICE_UUID);

    // AB01 — FlowSensor state (NOTIFY + READ)
    _flowSensorChar = service->createCharacteristic(
        FS_FLOW_CHAR_UUID,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
    );

    // AB02 — Command (WRITE + WRITE_NR)
    _commandChar = service->createCharacteristic(
        FS_COMMAND_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    _commandChar->setCallbacks(this);


    // Start advertising both services
    NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
    advertising->addServiceUUID(FS_SERVICE_UUID);
    advertising->setName(deviceName);
    advertising->enableScanResponse(true);
    advertising->start();

    ESP_LOGI(TAG, "BLE server started: %s (PIN: %s)", deviceName, _pin);



    // now start the client if it has been paired.
    Preferences p;
    if (p.begin("flowble", true)) {
        String address = p.getString("address", "none");
        String pin = p.getString("pin", "none");
        if ( !address.equals("none") && !pin.equals("none")) {
            pair(address, pin, false);
        }
        p.end();
    }



}

bool FlowSensorBLE::hasAuthenticatedClients() const {
    for (auto &it : _clients) {
        if (it.second.authed) return true;
    }
    return false;
}



void FlowSensorBLE::unpair() {
    if ( _remoteClient != nullptr ) {
        _remoteClient->disconnect();
        _remoteClient = nullptr;
        _flowRemoteChar = nullptr;
    }
}

// Would be better if this was not static, but that would require binding this.
void FlowSensorBLE::notifyWrite(NimBLERemoteCharacteristic* pRemoteCharacteristic, uint8_t* pData, size_t length, bool isNotify) {
    if (length == 2) {
        if (pData[0] == FS_MAGIC_AUTH_RESP) {
            if (pData[1] == 0x01) {
                ESP_LOGI(TAG, "Pin code accepted");
            } else {
                ESP_LOGE(TAG, "Pin code rejected");
            }
        } else {
            ESP_LOGI(TAG, "Unexpected Pin code response");
        }
    } else {
        ESP_LOGI(TAG, "Unexpected Pin code messagee");
    }
    std::string str  = (isNotify == true) ? "Notification" : "Indication";
    str             += " from ";
    str             += pRemoteCharacteristic->getClient()->getPeerAddress().toString();
    str             += ": Service = " + pRemoteCharacteristic->getRemoteService()->getUUID().toString();
    str             += ", Characteristic = " + pRemoteCharacteristic->getUUID().toString();
    str             += ", Value = " + std::string((char*)pData, length);
    ESP_LOGI(TAG, "%s", str.c_str());
}


void FlowSensorBLE::pair(String &address, String &pin, bool save ) {
    unpair();
    _remoteClient = NimBLEDevice::createClient(NimBLEAddress(address.c_str(), 1));
    _remoteClient->connect();
    NimBLERemoteService* pFlowService = _remoteClient->getService(FM_SERVICE_UUID);
    _flowRemoteChar = pFlowService->getCharacteristic(FM_FLOW_CHAR_UUID);
    // use a lambda to call this, so operatons can be performed if required on the connection.
    auto cb = [this](NimBLERemoteCharacteristic* pRemoteCharacteristic, uint8_t* pData, size_t length, bool isNotify) {
        this->notifyWrite(pRemoteCharacteristic, pData, length, isNotify);
    };
    _flowRemoteChar->subscribe(false, cb);

    if (_flowRemoteChar != nullptr) {
        uint8_t data[] = {FS_MAGIC_FLOWSENSOR, FS_CMD_AUTH, 0x00, 0x00, 0x00, 0x00};
        pin.getBytes(&data[2],4);
        _flowRemoteChar->writeValue(pin, true); // 'true' asks for a response
    }
    if (save) {
        Preferences p;
        if (p.begin("flowble", false)) {
            p.putString("address", address);
            p.putString("pin", pin);
            p.end();
        }
    }

}

void FlowSensorBLE::notifyPair() {
    if (_flowRemoteChar != nullptr) {
        unsigned long now = millis();
        if ((_flowPairDirty && 
            (now - _lastFlowPairNotify >= FS_MIN_FLOWSENSOR_INTERVAL_MS)) 
            || (now - _lastFlowPairNotify >= FS_FLOWSENSOR_INTERVAL_MS)) {

            _flowRemoteChar->writeValue(_flowBuffer, 12 , false);
            _lastFlowPairNotify = now;
            _flowPairDirty = false;
        }
    }
}



void FlowSensorBLE::notify() {
    if (_server->getConnectedCount() == 0) {
        if (!_clients.empty()) {
            ESP_LOGW(TAG, "Missed disconnect detected — clearing %d client(s)", _clients.size());
            _clients.clear();
            NimBLEDevice::getAdvertising()->start();
            digitalWrite(BLE_LED_PIN, LOW);
        }
        return;
    }

    unsigned long now = millis();

    // Disconnect any client that connected but never authenticated within the
    // idle window. Stops an attacker (or a broken client) from holding the
    // FS_MAX_CLIENTS connection slots and denying service to legitimate peers.
    // Collect handles first and disconnect after the loop so we don't mutate
    // the map while iterating.
    uint16_t idleHandles[FS_MAX_CLIENTS];
    size_t nIdle = 0;
    for (auto &kv : _clients) {
        if (!kv.second.authed
            && (now - kv.second.connectedAtMs) > FS_UNAUTH_IDLE_TIMEOUT_MS
            && nIdle < FS_MAX_CLIENTS) {
            idleHandles[nIdle++] = kv.first;
        }
    }
    for (size_t i = 0; i < nIdle; i++) {
        ESP_LOGW(TAG, "Client %u idle-unauth timeout — disconnecting",
                 idleHandles[i]);
        _server->disconnect(idleHandles[i]);
    }

    if (!hasAuthenticatedClients()) return;

    // Autopilot when updated, or at least every 5s
    if ((_flowDirty && (now - _lastFlowNotify >= FS_MIN_FLOWSENSOR_INTERVAL_MS)) || (now - _lastFlowNotify >= FS_FLOWSENSOR_INTERVAL_MS)) {
        _flowSensorChar->setValue(_flowBuffer, 12);
        // only send to clients that have authenticated.
        for (auto &kv : _clients) {
            if ( kv.second.authed) {
                _flowSensorChar->notify(kv.first);
            }
        }
        _lastFlowNotify = now;
        _flowDirty = false;
    }

    if ( (now - _ledSwitch) > 1000 ) {
        _ledSwitch = now;
        _ledOn = !_ledOn;
        digitalWrite(BLE_LED_PIN, _ledOn);
    }
    return;
}

// Helper to write little-endian values into a buffer
static void writeU16(uint8_t* buf, uint8_t &pos, double val, double scale, uint16_t na) {
    uint16_t v = (val <= -1e8) ? na : (uint16_t)(val * scale);
    buf[pos++] = v & 0xFF;
    buf[pos++] = (v >> 8) & 0xFF;
}

static void writeS16(uint8_t* buf, uint8_t &pos, double val, double scale, int16_t na) {
    int16_t v = (val <= -1e8) ? na : (int16_t)(val * scale);
    buf[pos++] = v & 0xFF;
    buf[pos++] = (v >> 8) & 0xFF;
}

static void writeS32(uint8_t* buf, uint8_t &pos, double val, double scale, int32_t na) {
    int32_t v = (val <= -1e8) ? na : (int32_t)(val * scale);
    buf[pos++] = v & 0xFF;
    buf[pos++] = (v >> 8) & 0xFF;
    buf[pos++] = (v >> 16) & 0xFF;
    buf[pos++] = (v >> 24) & 0xFF;
}

static void writeU32(uint8_t* buf, uint8_t &pos, uint32_t val) {
    buf[pos++] = val & 0xFF;
    buf[pos++] = (val >> 8) & 0xFF;
    buf[pos++] = (val >> 16) & 0xFF;
    buf[pos++] = (val >> 24) & 0xFF;
}

void FlowSensorBLE::setFlowState(uint8_t state, 
    float flowRateLPM, float upstreamC, float downstreamC, float voltage, float power) {
    uint8_t pos = 0;
    _flowBuffer[pos++] = FS_MAGIC_FLOWSENSOR;
    _flowBuffer[pos++] = state;

    // FlowSensor readings.
    writeU16(_flowBuffer, pos, flowRateLPM, 0.01, 0xFFFF);  // LPM 0.01
    writeU16(_flowBuffer, pos, upstreamC-273.15, 0.1, 0x7FFF);     // K 0.1
    writeU16(_flowBuffer, pos, downstreamC-273.15, 0.1, 0x7FFF);   // K 0.1
    writeU16(_flowBuffer, pos, voltage, 0.01, 0xFFFF);      // V 0.01
    writeU16(_flowBuffer, pos, power, 0.01, 0xFFFF);        // W 0.01
    _flowDirty = true;
    _flowPairDirty = true;
}



// --- BLE Callbacks ---

void FlowSensorBLE::onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) {
    uint16_t connHandle = connInfo.getConnHandle();
    _clients[connHandle] = ClientState{false, 0, 0, millis()};
    ESP_LOGI(TAG, "Client %d connected — awaiting auth (%d clients)", connHandle, _clients.size());

    // Keep advertising so more clients can connect (up to BW_MAX_CLIENTS)
    if (_server->getConnectedCount() < FS_MAX_CLIENTS) {
        NimBLEDevice::getAdvertising()->start();
    }
}

void FlowSensorBLE::onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) {
    uint16_t connHandle = connInfo.getConnHandle();
    _clients.erase(connHandle);
    ESP_LOGI(TAG, "Client %d disconnected (reason=%d) — %d clients remain", connHandle, reason, _clients.size());

    // Restart advertising if below max
    if (_server->getConnectedCount() < FS_MAX_CLIENTS) {
        NimBLEDevice::getAdvertising()->start();
    }
    if ( _server->getConnectedCount() == 0) {
        _ledOn = false;
        digitalWrite(BLE_LED_PIN, _ledOn);
    }
}


void FlowSensorBLE::onWrite(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) {
    NimBLEAttValue val = pCharacteristic->getValue();
    if (val.size() >= 2) {
        handleCommand(connInfo.getConnHandle(), val.data(), val.size());
    }
}

void FlowSensorBLE::handleCommand(uint16_t connHandle, const uint8_t* data, size_t len) {
    if (len < 2 || data[0] != FS_MAGIC_FLOWSENSOR) return;

    uint8_t cmd = data[1];

    auto it = _clients.find(connHandle);
    if (it == _clients.end()) return;  // unknown handle, e.g. post-disconnect race
    ClientState &state = it->second;

    // Auth command — allowed, but rate-limited per connection AND globally.
    if (cmd == FS_CMD_AUTH) {
        unsigned long now = millis();

        // Global lockout (survives reconnects): blocks brute-force attempts
        // that try to reset the per-connection counter by disconnecting.
        if (_globalBlockUntilMs != 0 && (long)(_globalBlockUntilMs - now) > 0) {
            ESP_LOGW(TAG, "Auth rejected: global lockout active");
            sendAuthResponse(connHandle, false);
            return;
        }
        // Window expired — clear global state so legitimate users start fresh.
        if (_globalBlockUntilMs != 0) {
            _globalBlockUntilMs = 0;
            _globalAuthFailures = 0;
        }

        if (state.blockUntilMs != 0 && (long)(state.blockUntilMs - now) > 0) {
            ESP_LOGW(TAG, "Client %d auth attempt during lockout (failures=%u)",
                     connHandle, state.failures);
            sendAuthResponse(connHandle, false);
            return;
        }
        bool ok = false;
        if (len >= 6) {
            char pin[5] = {0};
            memcpy(pin, data + 2, 4);
            if (_pin.equals(pin)) ok = true;
        }
        if (ok) {
            state.authed = true;
            state.failures = 0;
            state.blockUntilMs = 0;
            _globalAuthFailures = 0;
            _globalBlockUntilMs = 0;
            sendAuthResponse(connHandle, true);
            ESP_LOGI(TAG, "Client %d auth accepted", connHandle);
        } else {
            state.failures++;
            _globalAuthFailures++;
            sendAuthResponse(connHandle, false);
            ESP_LOGW(TAG, "Client %d auth denied (failures=%u global=%u)",
                     connHandle, state.failures, _globalAuthFailures);
            if (state.failures >= FS_AUTH_MAX_FAILURES) {
                ESP_LOGW(TAG, "Client %d exceeded per-connection limit — disconnecting",
                         connHandle);
                _server->disconnect(connHandle);
                return;
            }
            if (state.failures % FS_AUTH_LOCKOUT_FAILURES == 0) {
                state.blockUntilMs = now + FS_AUTH_LOCKOUT_MS;
                ESP_LOGW(TAG, "Client %d entering %lu ms auth lockout", connHandle,
                         (unsigned long)FS_AUTH_LOCKOUT_MS);
            }
            if (_globalAuthFailures >= FS_AUTH_GLOBAL_LOCKOUT_FAILURES) {
                _globalBlockUntilMs = now + FS_AUTH_GLOBAL_LOCKOUT_MS;
                ESP_LOGW(TAG, "Global auth lockout engaged for %lu ms",
                         (unsigned long)FS_AUTH_GLOBAL_LOCKOUT_MS);
            }
        }
        return;
    }

    // All other commands require auth
    if (!state.authed) {
        ESP_LOGW(TAG, "Client %d cmd 0x%02X rejected — not authenticated", connHandle, cmd);
        return;
    }

    if (_commandCallback) {
        const uint8_t* payload = (len > 2) ? data + 2 : nullptr;
        size_t payloadLen = (len > 2) ? len - 2 : 0;
        _commandCallback(cmd, payload, payloadLen);
    }
}

void FlowSensorBLE::sendAuthResponse(uint16_t connHandle, bool accepted) {
    uint8_t resp[2] = { FS_MAGIC_AUTH_RESP, uint8_t(accepted ? 0x01 : 0x00) };
    _flowSensorChar->setValue(resp, 2);
    _flowSensorChar->notify(connHandle);
}
