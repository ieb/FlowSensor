# Flow Sensor

## Status

This project has got to the state of building a prototype sensor, but testing has indicated that measuring the temperature and rate of change of temperature of the exaust elbow on a water cooled exhaust relative to the engine coolant temperature is a very effective early warning system. The heat source, engine exhaust is in the kw range. The cooling source is the same, when the cooling source reduces the temperature of the water cooled elbo rises rapidly triggering an alarm within 5s, evidenced by live data recorded from 2 engine overheats, one slow and one fast. On that basis, I am not taking this project further. See N2KEngine project for more details.

## Intro

The aim is to build a simple temperature difussion flow sensor to monitor and warn about conditions that would permanently damage a impeller pump as used on raw water cooling for marine engines. In my case a Volvo Penta D2-40 which has a F4B-9 pump prone to running dry as a result of suction caused by the boat when sailing. If these pumps run dry for more than 30s as can happend on startup, they overhead and fail with broken vanes and damaged sealing. When they are unable to overcome the back pressure from the wet exaust system, the engine rapidly overheats within a few miniutes. The F4B pumps are more susceptable than the larger models becuase they only have 6 impeller vanes so if only 1 fails the seal is broken and they suck dry when sailing above 8kn. The service life is less than 50h although the manual states 500h or once yearly. Failure can happen at any time, typically preceded by lower flow levels when running.

* Minimal reduction in flow
* Able to operate in salt water.
* Able to sense, air, still salt water and measure flow
* Sounds an alarms when the pump is dry and will likely not self prime, ideally before the engine is started.
* Sounds an alarm when flow is low and the engine is running.
* Ideally standalone and not reliant on engine monitoring

# Design options

* In flow vane (rejected, only on-off, cant detect still water vs air, prone to blockages)
* Paddle wheel (rejected, cant detect still water vs air, too much flow restriction and prone to being blocked by debris)
* Untrasonic (needs 1MHz ultrasonics, complex needing specialist silicon, may not detect air)
* Heated probe (selected, simple, but commercial options v expensive)
* Heated probe and upstream fluid reference temperature sensor. (may be considered later)

# Chosen design

* PTC heated thin wall probe in contact with the flow, temperature measured by a ceramic bead NTC.
* Probe is about the size of a M6x30 bolt with the head in the flow and a 3mm hole down the center for the NTC. 
* Heater on the outer end is a 12V 80C 3-6W self regulating ceramic heater.

# Control

* The single probe is probably too complex to sense the flow rate without a micro controller expecially, so a ESP32-C will be used, noting that the ADCs are only usable between 0.5V and 2.5V, and need carefull sampling.
* Will expose data on a BLE GATT for an android app to monitor.
* Will support an external indicator and alarm
* May run continuously if possible.
* Will be able to control (on/off only) the PTC heater to observe reference fluid temperature.