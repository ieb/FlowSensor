# BLE Transport Protocol

The firmware exposes the **FlowSensor Service** (`0xAB00`) for clients to monitor fluid
flow, and additionally acts as a BLE client of a remote **FlowMeter Service** (`0xAC00`,
hosted by the NMEABridge firmware) to which it forwards its readings.

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
| 0 | 1 | U8 | magic | `0xEE` |
| 1 | 1 | U8 | cmd | `0xF0` (AUTH) |
| 2 | 4 | char[4] | PIN | ASCII digits, e.g. `"0000"` |

The firmware responds with an auth result notification on `0xAB01`:

| Offset | Size | Type | Field | Value |
|--------|------|------|-------|-------|
| 0 | 1 | U8 | magic | `0xAF` |
| 1 | 1 | U8 | result | `0x01` = accepted, `0x00` = denied |

### FlowSensor State (0xAB01)

Magic byte: `0xEE`. Payload: 12 bytes. Update rate: every 5 seconds or on change.

Note the NMEA2000 standard for Fluid FLow rate is L/h however, that would limit the maximum
range to 11l/m in a U16 which, so lpm is being used. If using this datapacket in a NMEA2000 context
conversions may be required at the recieving end.

| Offset | Size | Type | Field | Scale/Values |
|--------|------|------|-------|-------------|
| 0  | 1 | U8 | magic | `0xEE` |
| 1  | 1 | U8 | state | status see below |
| 2  | 2 | U16 | flowRateLPM | 0.01 lpm (0-650) |  
| 4  | 2 | U16 | upstreamC | 0.01 K (0-650) |
| 6  | 2 | U16 | downstreamC | 0.01 K (0-650) |
| 8  | 2 | U16 | voltage | 0.01 V (0-650) |
| 10 | 2 | U16 | power | 0.01 W (0-650) |

## State U8

	Bitmap bits 0-1
	0x01=NO_FLUID 
	0x02=STILL
	0x03=FLOWING
	bit 2 FlowMeter Confgigured (address + pin)
	bit 3 FlowMeter Paired (address exists)
	bit 4 FlowMeter authenticated (pin valid)



### Commands (0xAB02)

Magic byte: `0xEE`. All commands require prior authentication.

**Flowmeter configuration commands (2 bytes):**

| Cmd | Name | Payload | Unit |
|-----|------|---------|------|
| `0x01` | Set FlowMeter Mac Address | byte[6] | BLE MAC Address |
| `0x02` | Set FlowMeter Pin | byte[4] | PIN |

When both the FlowMeter Mac Address and pin are set, the FlowSensor will try and connect reporting status in the status field of `0xAB01`



---

## FlowMeter Service (0xAC00)

The FlowMeter Service is hosted by the FlowMeter / NMEABridge host firmware. A FlowSensor
connects as a BLE client and writes flow measurement frames to it. The host returns the
authentication result to the FlowSensor on the same characteristic (notify).

| UUID | Characteristic | Properties | Direction |
|------|---------------|-----------|-----------|
| `0000AC00-0000-1000-8000-00805f9b34fb` | Remote FlowMeter Service | -- | -- |
| `0000AC01-0000-1000-8000-00805f9b34fb` | Remote FlowMeter Characteristic | WRITE, NOTIFY | FlowSensor -> Host (data); Host -> FlowSensor (auth result) |

### Authentication

FlowMeter writes require authentication. Before writing data, the FlowSensor writes an auth
command to `0xAC01`:

| Offset | Size | Type | Field | Value |
|--------|------|------|-------|-------|
| 0 | 1 | U8 | magic | `0xEE` |
| 1 | 1 | U8 | cmd | `0xF0` (AUTH) |
| 2 | 4 | char[4] | PIN | ASCII digits, e.g. `"0000"` |

The host responds with an auth result notification on `0xAC01`:

| Offset | Size | Type | Field | Value |
|--------|------|------|-------|-------|
| 0 | 1 | U8 | magic | `0xAF` |
| 1 | 1 | U8 | result | `0x01` = accepted, `0x00` = denied |

Only data frames from authenticated clients are accepted.

### FlowMeter State (0xAC01)

Write magic byte: `0xEE`. Write command byte: `0x50`. Payload: 13 bytes.

Note the NMEA2000 standard for Fluid Flow rate is L/h however, that would limit the maximum
range to 11 l/m in a U16, so lpm is being used. If using this data packet in a NMEA2000 context
conversions may be required at the receiving end.

| Offset | Size | Type | Field | Scale/Values |
|--------|------|------|-------|-------------|
| 0  | 1 | U8 | magic | `0xEE` |
| 1  | 1 | U8 | cmd | `0x50` |
| 2  | 1 | U8 | status | See Status U8 |
| 3  | 2 | U16 | flowRateLPM | 0.01 lpm (0-650) |  
| 5  | 2 | U16 | upstreamC | 0.01 K (0-650) |
| 7  | 2 | U16 | downstreamC | 0.01 K (0-650) |
| 9  | 2 | U16 | voltage | 0.01 V (0-650) |
| 11 | 2 | U16 | power | 0.01 W (0-650) |

## Status U8

	Bitmap bits 0-1
	0x01=NO_FLUID
	0x02=STILL
	0x03=FLOWING
	bit 2 FlowMeter Configured (address + pin)
	bit 3 FlowMeter Paired (address exists)
	bit 4 FlowMeter authenticated (pin valid)

**Data Not Available sentinels (NMEA 2000 convention):**

| Type | Sentinel |
|------|----------|
| U16 | `0xFFFF` |
| S16 | `0x7FFF` |
| U32 | `0xFFFFFFFF` |
| S32 | `0x7FFFFFFF` |

Note: the FlowSensor firmware currently emits the S16 sentinel `0x7FFF` for the temperature
fields (`upstreamC`, `downstreamC`) and `0xFFFF` for `flowRateLPM`, `voltage` and `power`.

### Example payloads

All multi-byte values are little-endian. Temperatures are sent in Kelvin
(`degC + 273.15`) scaled by 100.

**Data frame write to `0xAC01`** — flowing, 12.50 lpm, upstream 21.00 degC,
downstream 35.50 degC, 3.30 V, 1.50 W, link configured + paired + authenticated:

```
hex: EE 50 1F E2 04 E7 72 91 78 4A 01 96 00
```

| Offset | Bytes | Field | Raw | Decoded |
|--------|-------|-------|-----|---------|
| 0  | `EE`    | magic       | --    | -- |
| 1  | `50`    | cmd         | --    | -- |
| 2  | `1F`    | status      | 0x1F  | FLOWING + configured + paired + authenticated |
| 3  | `E2 04` | flowRateLPM | 1250  | 12.50 lpm |
| 5  | `E7 72` | upstreamC   | 29415 | 294.15 K = 21.00 degC |
| 7  | `91 78` | downstreamC | 30865 | 308.65 K = 35.50 degC |
| 9  | `4A 01` | voltage     | 330   | 3.30 V |
| 11 | `96 00` | power       | 150   | 1.50 W |

Status `0x1F` = `0b0001_1111`: bits 0-1 = `0b11` FLOWING; bit 2 configured;
bit 3 paired; bit 4 authenticated.

**Data frame with no-data sentinels** — flowing, flow rate and both temperatures
unavailable, voltage and power present:

```
hex: EE 50 03 FF FF FF 7F FF 7F 4A 01 96 00
```

(`flowRateLPM` = `0xFFFF`; `upstreamC` / `downstreamC` = `0x7FFF`; voltage/power present.)

**Authentication handshake**

Auth command write to `0xAC01` with PIN `"0000"` (ASCII `30 30 30 30`):

```
hex: EE F0 30 30 30 30
```

Auth result notification on `0xAC01`:

```
accepted: AF 01
denied:   AF 00
```

The **FlowSensor State** notification on `0xAB01` uses the same field layout but
omits the `cmd` byte (12 bytes total). The first data frame above without the `50`
at offset 1 is the equivalent `0xAB01` payload:

```
hex: EE 1F E2 04 E7 72 91 78 4A 01 96 00
```






