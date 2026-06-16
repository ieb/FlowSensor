# BLE Transport Protocol

The firmware exposes two BLE GATT services: the **FlowSensor Service** for fluid flow monitoring.

## Connection

1. Scan for service UUID `0000AB00` (FlowSensor)
2. Connect GATT
3. Request MTU (64 minimum, 512 recommended)
4. Discover services
5. Enable notifications via CCC descriptor write (UUID `00002902`)
6. Auto-reconnect on disconnect after 3 seconds

Byte order is **little-endian** for all multi-byte values throughout both services.

---

## FlowSensor Service (0xAB00)

Implemented in the FlowSensor for clients to monitor

| UUID | Characteristic | Properties | Direction |
|------|---------------|-----------|-----------|
| `0000AB00-0000-1000-8000-00805f9b34fb` | Service | -- | -- |
| `0000AB01-0000-1000-8000-00805f9b34fb` | FlowSensor Characteristic | NOTIFY, READ | Firmware -> Client |
| `0000AB02-0000-1000-8000-00805f9b34fb` | Command | WRITE | Client -> Firmware |


### Authentication

FlowSensor notifications require authentication. After subscribing to notifications, write an auth command to `0xAB02`:

| Offset | Size | Type | Field | Value |
|--------|------|------|-------|-------|
| 0 | 1 | U8 | magic | `0xDD` |
| 1 | 1 | U8 | cmd | `0xF0` (AUTH) |
| 2 | 4 | char[4] | PIN | ASCII digits, e.g. `"0000"` |

The firmware responds with an auth result notification on both `0xAA01` and `0xAA03`:

| Offset | Size | Type | Field | Value |
|--------|------|------|-------|-------|
| 0 | 1 | U8 | magic | `0xDD` |
| 1 | 1 | U8 | result | `0x01` = accepted, `0x00` = denied |

### FlowSensor State (0xAB01)

Magic byte: `0xDD`. Payload: 12 bytes. Update rate: every 5 seconds or on change.

Note the NMEA2000 standard for Fluid FLow rate is L/h however, that would limit the maximum
range to 11l/m in a U16 which, so lpm is being used. If using this datapacket in a NMEA2000 context
conversions may be required at the recieving end.

| Offset | Size | Type | Field | Scale/Values |
|--------|------|------|-------|-------------|
| 0  | 1 | U8 | magic | `0xDD` |
| 1  | 1 | U8 | state | FF=UNDEFINED, 1=NO_FLUID, 2=STILL, 4=FLOWING|
| 2  | 2 | U16 | flowRateLPM | 0.01 lpm (0-650) |  
| 4  | 2 | U16 | upstreamC | 0.01 K (0-650) |
| 6  | 2 | U16 | downstreamC | 0.01 K (0-650) |
| 8  | 2 | U16 | voltage | 0.01 V (0-650) |
| 10 | 2 | U16 | power | 0.01 W (0-650) |


### Commands (0xAA02)

There are no commands other than Auth see above.


---

## FlowMeter Service (0xAC00)

The FlowMeter Service accepts messages from a FlowSensor. This firmware writes to that service.


| UUID | Characteristic | Properties | Direction |
|------|---------------|-----------|-----------|
| `0000AC00-0000-1000-8000-00805f9b34fb` | Remote FlowMeter Service | -- | -- |
| `0000AC01-0000-1000-8000-00805f9b34fb` | Remote FlowMeter Characteristic | WRITE | Firmware -> Service |


The firmware may be configured to write to a remote FlowMeter. FLow Meters require authenticaton.

### Authentication

FlowMeter writes require authentication. Before writing data, write an auth command to `0xAC01`:

| Offset | Size | Type | Field | Value |
|--------|------|------|-------|-------|
| 0 | 1 | U8 | magic | `0xDD` |
| 1 | 1 | U8 | cmd | `0xF0` (AUTH) |
| 2 | 4 | char[4] | PIN | ASCII digits, e.g. `"0000"` |

The firmware responds with an auth result notification on both `0xAA01` and `0xAA03`:

| Offset | Size | Type | Field | Value |
|--------|------|------|-------|-------|
| 0 | 1 | U8 | magic | `0xDD` |
| 1 | 1 | U8 | result | `0x01` = accepted, `0x00` = denied |

Authentication required. Only Authenticated clients receive navigation and engine data.

### FlowMeter State (0xAC01)

Write Magic byte: `0xDD`. Payload: 12 bytes. 

Note the NMEA2000 standard for Fluid FLow rate is L/h however, that would limit the maximum
range to 11l/m in a U16 which, so lpm is being used. If using this datapacket in a NMEA2000 context
conversions may be required at the recieving end.

U16 no data (aka sentinals are) 0xFFFF

| Offset | Size | Type | Field | Scale/Values |
|--------|------|------|-------|-------------|
| 0  | 1 | U8 | magic | `0xDD` |
| 1  | 1 | U8 | state | FF=UNDEFINED, 1=NO_FLUID, 2=STILL, 4=FLOWING|
| 2  | 2 | U16 | flowRateLPM | 0.01 lpm (0-650) |  
| 4  | 2 | U16 | upstreamC | 0.01 K (0-650) |
| 6  | 2 | U16 | downstreamC | 0.01 K (0-650) |
| 8  | 2 | U16 | voltage | 0.01 V (0-650) |
| 10 | 2 | U16 | power | 0.01 W (0-650) |



**Data Not Available sentinels (NMEA 2000 convention):**

| Type | Sentinel |
|------|----------|
| U16 | `0xFFFF` |
| S16 | `0x7FFF` |
| U32 | `0xFFFFFFFF` |
| S32 | `0x7FFFFFFF` |

### Example payloads

TODO






