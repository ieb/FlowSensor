#pragma once

#include <Arduino.h>
#include "esp32-hal-adc.h"


typedef enum { STATE_AIR, STATE_STILL, STATE_FLOW } sensor_state_t;


class FlowSensor {

	public:
		FlowSensor() {};
		void begin();
		void read();
		uint8_t getState() { 
			if (state == STATE_AIR ) {
				return 0x01; 
			} 
			if (state == STATE_STILL ) {
				return 0x02; 
			} 
			if (state == STATE_FLOW ) {
				return 0x04; 
			} 
			return 0xFF;
		}
		float getFlowRate() { return flowLPM;}
		float getUpstreamC() { return upstreamTemperatureC;}
		float getDownstreamC() { return heatedTemperatureC; }
		float getVoltage() { return voltage; }
		float getPower() { return powerLevel; }

		void setUpdateHandler(void (*_UpdateHandler)(void)) {
			UpdateHandler = _UpdateHandler;
		}
	private:
		float powerLevel = 0;
		float voltage = 0;
		float upstreamTemperatureC = 0;
		float heatedTemperatureC = 0;
		float flowLPM = 0;
		float heaterDuty = 0;
		sensor_state_t state = STATE_AIR;
		float pi_integ = 0.0f;




		unsigned long lastRead = 0;
      	unsigned long alarm_toggle_time = 0;
      	unsigned long alarm_period = 0;
      	bool alarm_level = LOW;

	    void (*UpdateHandler)(void) = nullptr;


		void classify();
		void flow_lpm();
		/* NTC divider voltage -> temperature (Beta model). Vadc = Vexc*Rs/(Rs+Rntc) */
		float temp_from_divider(float vadc);

		/* ---- the control loop, called every tick (dt seconds) ---- */
		void control_tick(float dt);


};