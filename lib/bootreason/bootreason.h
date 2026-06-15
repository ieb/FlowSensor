#pragma once
#include <Arduino.h>


#include "esp_system.h"


class BootReason {
public: 
	void recordBootReason();
	void clearBootReasons();
	void reportBootReason();

private:
	esp_reset_reason_t _bootResetReason = ESP_RST_UNKNOWN;
	uint32_t _bootResetCounts[16] = {0};

	const char* resetReasonName(esp_reset_reason_t r);



};