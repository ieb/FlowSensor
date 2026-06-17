#include <Arduino.h>

#include "sensor.h"
#include "driver/adc.h"
#include "esp_adc_cal.h"
#include "esp_log.h"

#ifndef ADC_ATTEN_DB_12
#define ADC_ATTEN_DB_12 ADC_ATTEN_DB_11
#endif


/* Auto-derived from the model — Probe (head+shaft), ΔT=10C,
   3.6ohm heater @ 12V (Pmax=40W),
   pipe bore=19mm. FULLY-DIGITAL loop: the ESP32 reads two NTC dividers
   (ADC0/1) + Vbus (ADC2), runs a software PI to hold T_dn at T_up+ΔT, and LEDC-PWMs the
   heater. Flow = duty*Vbus^2/R. Oversample the ADC (the plant is slow); calibrate the ADC
   with the eFuse Vref / two-point. A hardware watchdog forces the gate OFF on a hang and a
   thermal cutout on the Al block is the final backstop (software now owns 40 W). */
#define R_HEATER   3.60f   /* heater resistance (ohm) */
#define V_EXC      3.30f   /* NTC divider rail (V) = ADC ref */
#define R_SERIES   10000.0f /* NTC divider series R (ohm) */
#define NTC_R25    10000.0f /* NTC R at 25C (ohm) */
#define NTC_BETA   3950.0f   /* NTC Beta (K) */
#define DELTA_T    10.00f    /* held rise (degC) */
#define VBUS_DIV   3.828f /* Vbus divider ratio (set to keep <ADC FSR) */
#define KP         0.0300f      /* software-PI proportional gain (duty/degC) */
#define KI         0.0060f      /* software-PI integral gain (duty/(degC*s)) */
#define OVERSAMPLE 64           /* ADC samples averaged (slow plant -> average hard) */
#define P_AIR_THR  0.5206f /* W: below => AIR (dry, ALARM) */
#define P_FLOW_THR 4.2969f      /* W: above => FLOWING */



/* flow rate from heater power (monotonic increasing) */
static const float flow_lut[][2] = {   /* {power W, l/min} */
  {1.0035f, 0.00f},
  {6.6945f, 5.10f},
  {9.6493f, 10.21f},
  {12.0134f, 15.31f},
  {14.0742f, 20.41f},
  {15.9427f, 25.52f},
  {17.6755f, 30.62f},
  {19.3062f, 35.72f},
  {20.8564f, 40.83f},
  {22.3413f, 45.93f},
  {23.7718f, 51.04f}
};


#ifndef REFERENCE_NTC_ADC
#define REFERENCE_NTC_ADC ADC1_CHANNEL_0
#endif
#ifndef HEATED_NTC_ADC
#define HEATED_NTC_ADC ADC1_CHANNEL_1
#endif
#ifndef VOLTAGE_ADC
#define VOLTAGE_ADC ADC1_CHANNEL_3
#endif


#ifndef HEATER_PWM_PIN
#define HEATER_PWM_PIN GPIO_NUM_10
#endif
#define HEATER_PWM_CH 0          /* LEDC channel the heater is attached to */
#define PWM_BITS 10
#define PWM_FREQUENCY 500

#ifndef AIR_PIN
#define AIR_PIN GPIO_NUM_6
#endif
#ifndef FLOW_PIN
#define FLOW_PIN GPIO_NUM_7
#endif
#ifndef STILL_PIN
#define STILL_PIN GPIO_NUM_9
#endif
#ifndef ALARM_PIN
#define ALARM_PIN GPIO_NUM_4
#endif





#define TAG "flowsensor"

static esp_adc_cal_characteristics_t adc1_chars;
static bool cali_enable = false;

static void adc_init() {
  esp_err_t ret;
  cali_enable = false;

  ret = esp_adc_cal_check_efuse(ESP_ADC_CAL_VAL_EFUSE_TP);
  if (ret == ESP_ERR_NOT_SUPPORTED) {
      ESP_LOGW(TAG, "Calibration scheme not supported, skip software calibration");
  } else if (ret == ESP_ERR_INVALID_VERSION) {
      ESP_LOGW(TAG, "eFuse not burnt, skip software calibration");
  } else if (ret == ESP_OK) {
      cali_enable = true;
      esp_adc_cal_characterize(ADC_UNIT_1, ADC_ATTEN_DB_12, ADC_WIDTH_BIT_12, 0, &adc1_chars);
  } else {
      ESP_LOGE(TAG, "Invalid arg");
  }


  ESP_ERROR_CHECK(adc1_config_width(ADC_WIDTH_BIT_12));
  ESP_ERROR_CHECK(adc1_config_channel_atten(REFERENCE_NTC_ADC, ADC_ATTEN_DB_12));
  ESP_ERROR_CHECK(adc1_config_channel_atten(HEATED_NTC_ADC, ADC_ATTEN_DB_12));
  ESP_ERROR_CHECK(adc1_config_channel_atten(VOLTAGE_ADC, ADC_ATTEN_DB_12));
}

static float adc_volts(adc1_channel_t ch) {
  uint32_t acc = 0;
  for (int i = 0; i < OVERSAMPLE; i++) acc += adc1_get_raw(ch); /* eFuse/2-pt calibrated */
  uint32_t raw = acc / OVERSAMPLE;
  uint32_t mv;
  if (cali_enable) {
    mv = esp_adc_cal_raw_to_voltage(raw, &adc1_chars);          /* uses eFuse Vref */
  } else {
    /* No calibration eFuse: adc1_chars is uninitialised, so approximate with the
       nominal full-scale for 12 dB attenuation (~3.3 V over the 12-bit range). */
    mv = (uint32_t)((raw / 4095.0f) * 3300.0f);
  }
  return 0.001f * mv;
}

/* NTC divider voltage -> temperature (Beta model). Vadc = Vexc*Rs/(Rs+Rntc) */
float FlowSensor::temp_from_divider(float vadc) {
  /* Clamp away from the rails so an open (vadc->V_EXC) or shorted (vadc->0) NTC
     can't divide by zero / take log of zero and yield inf/NaN temperatures. */
  const float eps = 1e-3f;
  if (vadc < eps)          vadc = eps;
  if (vadc > V_EXC - eps)  vadc = V_EXC - eps;
  float rntc = R_SERIES * vadc / (V_EXC - vadc);
  float invT = 1.0f/298.15f + logf(rntc / NTC_R25) / NTC_BETA;
  return 1.0f/invT - 273.15f;
}


/* ---- the control loop, called every tick (dt seconds) ---- */
void FlowSensor::control_tick(float dt) {
  float t_up = temp_from_divider(adc_volts(REFERENCE_NTC_ADC));   /* upstream / fluid ref */
  float t_dn = temp_from_divider(adc_volts(HEATED_NTC_ADC));   /* downstream element   */
  voltage = VBUS_DIV * adc_volts(VOLTAGE_ADC);                 /* measured 12V bus (P ~ V^2!) — adc_volts() already returns volts */
  float err  = (t_up + DELTA_T) - t_dn;              /* T_target - T_dn */
  float u    = KP*err + KI*pi_integ;                 /* software PI */
  heaterDuty = u < 0 ? 0 : (u > 1 ? 1 : u);          /* clamp 0..1 */
  pi_integ  += (err + (heaterDuty - u)/KI) * dt;           /* back-calculation anti-windup */
  ledcWrite(HEATER_PWM_CH, (uint32_t)(heaterDuty * ((1<<PWM_BITS)-1)));
  powerLevel = heaterDuty * voltage * voltage / R_HEATER;        /* flow signal: P = duty*Vbus^2/R */
  upstreamTemperatureC = t_up;
  heatedTemperatureC = t_dn;
}

void FlowSensor::classify() {
  if (powerLevel < P_AIR_THR)  {
    state = STATE_AIR; /* dry -> ALARM */
    digitalWrite(AIR_PIN, HIGH);
    digitalWrite(FLOW_PIN, LOW);
    digitalWrite(STILL_PIN, LOW);
    alarm_period = 500;
  }  else if (powerLevel > P_FLOW_THR) {
    state = STATE_FLOW;  /* good flow    */
    digitalWrite(AIR_PIN, LOW);
    digitalWrite(FLOW_PIN, HIGH);
    digitalWrite(STILL_PIN, LOW);
    alarm_period = 0;
  } else {
    state = STATE_STILL;                     /* no flow      */
    digitalWrite(AIR_PIN, LOW);
    digitalWrite(FLOW_PIN, LOW);
    digitalWrite(STILL_PIN, HIGH);
    alarm_period = 1000;
  }
}

void FlowSensor::flow_lpm() {
  const int N = sizeof(flow_lut)/sizeof(flow_lut[0]);
  if (powerLevel <= flow_lut[0][0]) {
    flowLPM = 0.0f;
    return;
  }
  for (int i = 0; i < N-1; i++) {
    if (powerLevel >= flow_lut[i][0] && powerLevel <= flow_lut[i+1][0]) {
      float f = (powerLevel - flow_lut[i][0]) / (flow_lut[i+1][0] - flow_lut[i][0]);
      flowLPM = flow_lut[i][1] + f * (flow_lut[i+1][1] - flow_lut[i][1]);
      return;
    }
  }
  flowLPM = flow_lut[N-1][1];
}

void FlowSensor::begin() {

  pinMode(AIR_PIN, OUTPUT);
  pinMode(FLOW_PIN, OUTPUT);
  pinMode(STILL_PIN, OUTPUT);
  pinMode(ALARM_PIN, OUTPUT);
  digitalWrite(AIR_PIN, LOW);
  digitalWrite(FLOW_PIN, LOW);
  digitalWrite(STILL_PIN, LOW);
  digitalWrite(ALARM_PIN, LOW);


  // setup adc1
  adc_init();
  // setup ledc
  ledcSetup(HEATER_PWM_CH, PWM_FREQUENCY, PWM_BITS);
  ledcAttachPin(HEATER_PWM_PIN, HEATER_PWM_CH);
  ESP_LOGI(TAG, "Flow Sensor setup");
}

void FlowSensor::read() {
  unsigned long now = millis();
  if ( now-lastRead > (1000) ) {
    float period = (now-lastRead)/1000.0f;   /* seconds, keep fractional part */
    lastRead = now;
    control_tick(period);
    classify();
    flow_lpm();
    if ( UpdateHandler != nullptr ) {
      UpdateHandler();
    }
  }


  if ( alarm_period > 0 ) {
    if ( now-alarm_toggle_time > (alarm_period) ) {
      alarm_toggle_time = now;
      if ( alarm_level == HIGH) {
        alarm_level = LOW;
      } else {
        alarm_level = HIGH;
      }
      digitalWrite(ALARM_PIN, alarm_level);
    }
  } else {
    alarm_level = LOW;
    digitalWrite(ALARM_PIN, alarm_level);
  }
}


