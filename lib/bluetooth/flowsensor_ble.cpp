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
    pairMeter();

}

bool FlowSensorBLE::hasAuthenticatedClients() const {
    for (auto &it : _clients) {
        if (it.second.authed) return true;
    }
    return false;
}



void FlowSensorBLE::unpairMeter() {
    if ( _remoteClient != nullptr ) {
        _remoteClient->disconnect();
        _remoteClient = nullptr;
        _flowMeterChar = nullptr;
        status = status & 0xF7; // clear bit 4

    }
}

void FlowSensorBLE::notifyWrite(NimBLERemoteCharacteristic* pRemoteCharacteristic, uint8_t* pData, size_t length, bool isNotify) {
    if (length == 2) {
        if (pData[0] == FS_MAGIC_AUTH_RESP) {
            if (pData[1] == 0x01) {
                ESP_LOGI(TAG, "Pin code accepted");
                status = status | 0x10; // set bit 5 
            } else {
                ESP_LOGE(TAG, "Pin code rejected");
                status = status & 0xEF; // clear bit 5 not authentcated
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


void FlowSensorBLE::pairMeter() {
    String address = "none";
    String pin = "none";
    Preferences p;
    if (p.begin("flowble", false)) {
        address = p.getString("address", "none");
        pin = p.getString("pin", "none");
        p.end();
    }
    if (address.equals("none") || pin.equals("none")) {
        ESP_LOGI(TAG, "addreess or pin missing, cant pair");
        return;
    }    


    status = status | 0x04; // set bit 3 configured
    unpairMeter();
    status = status & 0xE7; // clear bits 4 and 5
    _remoteClient = NimBLEDevice::createClient(NimBLEAddress(address.c_str(), 1));
    _remoteClient->connect();
    status = status | 0x08; // set bit 4 connected
    NimBLERemoteService* pFlowService = _remoteClient->getService(FM_SERVICE_UUID);
    _flowMeterChar = pFlowService->getCharacteristic(FM_FLOW_CHAR_UUID);
    // use a lambda to call this, so operatons can be performed if required on the connection.
    auto cb = [this](NimBLERemoteCharacteristic* pRemoteCharacteristic, uint8_t* pData, size_t length, bool isNotify) {
        this->notifyWrite(pRemoteCharacteristic, pData, length, isNotify);
    };
    _flowMeterChar->subscribe(false, cb);

    if (_flowMeterChar != nullptr) {
        uint8_t data[] = {FS_MAGIC_FLOWSENSOR, FS_CMD_AUTH, 0x00, 0x00, 0x00, 0x00};
        pin.getBytes(&data[2],4);
        _flowMeterChar->writeValue(pin, true); // 'true' asks for a response
    }
}

void FlowSensorBLE::notifyMeter() {
    if (_flowMeterChar != nullptr) {
        unsigned long now = millis();
        if ((_flowMeterDirty && 
            (now - _lastFlowMeterNotify >= FS_MIN_FLOWSENSOR_INTERVAL_MS)) 
            || (now - _lastFlowMeterNotify >= FS_FLOWSENSOR_INTERVAL_MS)) {

            _flowMeterChar->writeValue(_flowMeterBuffer, 12 , false);
            _lastFlowMeterNotify = now;
            _flowMeterDirty = false;
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

void FlowSensorBLE::setFlowState(sensor_state_t state, 
    float flowRateLPM, float upstreamC, float downstreamC, float voltage, float power) {
    uint8_t pos = 0;
    _flowBuffer[pos++] = FS_MAGIC_FLOWSENSOR;

    if(state == STATE_AIR) {
        status = (status & 0xFC) | 0x01; 
    } else if (state == STATE_STILL) {
        status = (status & 0xFC) | 0x02; 
    } else if (state == STATE_FLOW) {
        status = (status & 0xFC) | 0x03; 
    }
    _flowBuffer[pos++] = status;

    // FlowSensor readings.
    writeU16(_flowBuffer, pos, flowRateLPM, 100.0, 0xFFFF);  // LPM 0.01
    writeU16(_flowBuffer, pos, upstreamC+273.15, 100.0, 0x7FFF);     // K 0.01
    writeU16(_flowBuffer, pos, downstreamC+273.15, 100.0, 0x7FFF);   // K 0.01
    writeU16(_flowBuffer, pos, voltage, 100.0, 0xFFFF);      // V 0.01
    writeU16(_flowBuffer, pos, power, 100.0, 0xFFFF);        // W 0.01
    _flowDirty = true;


    // update the flow meter buffer, which contans the cmd as well as the data.
    pos = 0;
    _flowMeterBuffer[pos++] = FS_MAGIC_FLOWSENSOR;
    _flowMeterBuffer[pos++] = FS_CMD_FLOWMETER_UPDATE;

    if(state == STATE_AIR) {
        status = (status & 0xFC) | 0x01; 
    } else if (state == STATE_STILL) {
        status = (status & 0xFC) | 0x02; 
    } else if (state == STATE_FLOW) {
        status = (status & 0xFC) | 0x03; 
    }
    _flowMeterBuffer[pos++] = status;

    // FlowSensor readings.
    writeU16(_flowMeterBuffer, pos, flowRateLPM, 100.0, 0xFFFF);  // LPM 0.01
    writeU16(_flowMeterBuffer, pos, upstreamC+273.15, 100.0, 0x7FFF);     // K 0.1
    writeU16(_flowMeterBuffer, pos, downstreamC+273.15, 100.0, 0x7FFF);   // K 0.1
    writeU16(_flowMeterBuffer, pos, voltage, 100.0, 0xFFFF);      // V 0.01
    writeU16(_flowMeterBuffer, pos, power, 100.0, 0xFFFF);        // W 0.01


    _flowMeterDirty = true;
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

    if ( cmd == FS_CMD_PAIR_MAC ) {
        String address;
        for (int i = 0; i < 6; ++i) {
            char buf[3];
            sprintf(buf,"%02X", data[i]);
            address += buf;
            if ( i < 5) {
                address += ':';
            }
        }
        Preferences p;
        if (p.begin("flowble", true)) {
            p.putString("address", address);
            p.end();
        }
        pairMeter();

    } else if (cmd == FS_CMD_PAIR_PIN) {
        String pin;
        for (int i = 0; i < 4; ++i) {
            pin += data[i];
        }
        Preferences p;
        if (p.begin("flowble", true)) {
            p.putString("pin", pin);
            p.end();
        }
        pairMeter();
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
