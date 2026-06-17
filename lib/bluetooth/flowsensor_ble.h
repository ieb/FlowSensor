#pragma once

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <functional>
#include <map>

#include "sensor.h"

// GATT UUIDs matching BoatWatch protocol
#define FS_SERVICE_UUID        "0000ab00-0000-1000-8000-00805f9b34fb"
#define FS_FLOW_CHAR_UUID      "0000ab01-0000-1000-8000-00805f9b34fb"
#define FS_COMMAND_CHAR_UUID   "0000ab02-0000-1000-8000-00805f9b34fb"

#define FM_SERVICE_UUID        "0000ac00-0000-1000-8000-00805f9b34fb"
#define FM_FLOW_CHAR_UUID      "0000ac01-0000-1000-8000-00805f9b34fb"


// Binary protocol constants
#define FS_MAGIC_FLOWSENSOR 0xEE
#define FS_MAGIC_AUTH_RESP 0xAF

// Command IDs
#define FS_CMD_AUTH           0xF0
#define FS_CMD_PAIR_MAC       0x01
#define FS_CMD_PAIR_PIN       0x02
#define FS_CMD_FLOWMETER_UPDATE 0x50

// Notification intervals
#define FS_MIN_FLOWSENSOR_INTERVAL_MS 500   // max 5s
#define FS_FLOWSENSOR_INTERVAL_MS 5000

#define BLE_LED_PIN 8

#define FS_MAX_CLIENTS 3

#ifndef BLE_PIN_NUMBER
#define BLE_PIN_NUMBER "0000"
#endif

// BLE auth brute-force hardening
#define FS_AUTH_LOCKOUT_FAILURES        5        // consecutive failures per connection before lockout
#define FS_AUTH_LOCKOUT_MS              30000UL  // 30 s lockout per connection
#define FS_AUTH_MAX_FAILURES            10       // per-connection total before force-disconnect
// Global counters survive reconnects, so an attacker cycling connections
// still accumulates toward a global lockout.
#define FS_AUTH_GLOBAL_LOCKOUT_FAILURES 20       // cumulative across all connections
#define FS_AUTH_GLOBAL_LOCKOUT_MS       300000UL // 5 min global lockout
// Disconnect clients that linger without authenticating.
#define FS_UNAUTH_IDLE_TIMEOUT_MS       30000UL  // 30 s to authenticate after connect

class FlowSensorBLE : public NimBLEServerCallbacks,
                     public NimBLECharacteristicCallbacks {
public:
    using CommandCallback = std::function<void(uint8_t cmd, const uint8_t* payload, size_t len)>;

    void begin(const char* deviceName);
    void notify();

    // pair with a remote service
    void pairMeter();
    // unpair with a reemote service
    void unpairMeter();
    // notify the paired service
    void notifyMeter();


    // Set autopilot state for next notification
    void setFlowState(sensor_state_t state, float flowRateLPM, float upstreamC, float downstreamC, float voltage, float power);

    bool hasAuthenticatedClients() const;

private:
    // NimBLEServerCallbacks
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override;
    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override;

    // NimBLECharacteristicCallbacks
    void onWrite(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) override;

    void handleCommand(uint16_t connHandle, const uint8_t* data, size_t len);
    void sendAuthResponse(uint16_t connHandle, bool accepted);
    void notifyWrite(NimBLERemoteCharacteristic* pRemoteCharacteristic, uint8_t* pData, size_t length, bool isNotify);


    NimBLEServer* _server = nullptr;
    NimBLECharacteristic* _flowSensorChar = nullptr;
    NimBLECharacteristic* _commandChar = nullptr;


    NimBLEClient *_remoteClient = nullptr;
    NimBLERemoteCharacteristic* _flowMeterChar = nullptr; 

    CommandCallback _commandCallback;

    String _pin;

    // Per-connection auth state keyed by conn_handle.
    // Failure counter and lockout window thwart PIN brute-force: after
    // FS_AUTH_LOCKOUT_FAILURES consecutive failures the connection is blocked
    // from AUTH for FS_AUTH_LOCKOUT_MS; after FS_AUTH_MAX_FAILURES total
    // failures the client is force-disconnected.
    struct ClientState {
        bool authed;
        uint8_t failures;
        unsigned long blockUntilMs;
        unsigned long connectedAtMs;   // for unauthenticated-idle disconnect
    };
    std::map<uint16_t, ClientState> _clients;
    // Global auth state — survives reconnects so an attacker cycling
    // connections still progresses toward a global lockout.
    uint16_t      _globalAuthFailures = 0;
    unsigned long _globalBlockUntilMs = 0;

    // FlowStateBuffer state buffer (12 bytes)
    uint8_t _flowBuffer[12] = {0};
    bool _flowDirty = false;
    // FlowStateBuffer state buffer (13 bytes)
    uint8_t _flowMeterBuffer[13] = {0};
    bool _flowMeterDirty = false;

    unsigned long _lastFlowNotify = 0;
    unsigned long _lastFlowMeterNotify = 0;
    unsigned long _ledSwitch = 0;
    bool _ledOn = false;
    uint8_t status = 0;
};


