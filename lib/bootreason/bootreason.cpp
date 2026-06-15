#include "bootreason.h"

#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include <Preferences.h>

#define TAG "bootreason"

// Capture reset reason in NVS *before* any heavy init so a silent brownout
// loop still leaves an audit trail readable on the next clean boot.
// Counters are keyed by esp_reset_reason_t (small ints, stable across SDKs).

const char* BootReason::resetReasonName(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_EXT:       return "EXT";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_WDT:       return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_SDIO:      return "SDIO";
    default:                return "UNKNOWN";
  }
}



void BootReason::recordBootReason() {
  _bootResetReason = esp_reset_reason();
  Preferences p;
  if (!p.begin("boot", false)) return;
  char key[8];
  snprintf(key, sizeof(key), "r%d", (int)_bootResetReason);
  uint32_t n = p.getUInt(key, 0) + 1;
  p.putUInt(key, n);
  for (int i = 0; i < 16; i++) {
    snprintf(key, sizeof(key), "r%d", i);
    _bootResetCounts[i] = p.getUInt(key, 0);
  }
  p.end();
}

void BootReason::clearBootReasons() {
  Preferences p;
  if (!p.begin("boot", false)) return;
  char key[8];
  for (int i = 0; i < 16; i++) {
    snprintf(key, sizeof(key), "r%d", i);
    p.putUInt(key, 0);
    _bootResetCounts[i] = 0;
  }
  p.end();
}


void BootReason::reportBootReason() {
  ESP_LOGW(TAG, "Boot reason: %s (%d)",
           resetReasonName(_bootResetReason), (int)_bootResetReason);
  for (int i = 0; i < 16; i++) {
    if (_bootResetCounts[i] > 0) {
      ESP_LOGW(TAG, "  %-10s count=%u",
               resetReasonName((esp_reset_reason_t)i),
               (unsigned)_bootResetCounts[i]);
    }
  }    
}