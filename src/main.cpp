
#include "version.h"
#include <Arduino.h>
#include "bootreason.h"
#include "sensor.h"
#include "flowsensor_ble.h"


FlowSensor sensor;
BootReason bootReason;
FlowSensorBLE bleServer;

void sensorUpdate() {
	bleServer.setFlowState(
		sensor.getState(), 
		sensor.getFlowRate(),
		sensor.getUpstreamC(),
		sensor.getDownstreamC(),
		sensor.getVoltage(),
		sensor.getPower());
}


void setup() {
  bootReason.recordBootReason();
  Serial.begin(115200);
  delay(1000); // to avoid boot loops.
  bootReason.reportBootReason();
  sensor.setUpdateHandler(sensorUpdate);
  sensor.begin();
  bleServer.begin("FlowSensor");

}



void loop() {
	sensor.read();
	bleServer.notify();
	bleServer.notifyMeter();
}


