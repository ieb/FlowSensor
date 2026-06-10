/*
 * model.js — Thermal model of the TWO-NTC constant-temperature-difference (CTD)
 * flow sensor (the "DoubleNTC" topology in design/DoubleNTC.md).
 *
 * Pure physics, no DOM access. SI units throughout (metres, kelvin/°C, watts,
 * volts, amps). The UI layer (app.js) converts mm <-> m for display.
 *
 * Physical picture:
 *
 *   flow ──►  [ upstream NTC ]  ........  [ downstream HEATED element ]
 *              reads T_up                  held at  T_up + ΔT
 *              (cold reference)            by the ESP32 software loop
 *
 * The upstream NTC measures the undisturbed stream temperature T_up. The
 * downstream element (a probe head on an aluminium heater block, a 316 tube OR a
 * glass-bead NTC) is warmed by a SEPARATE 40 W ceramic heater. The control loop
 * runs ENTIRELY IN ESP32 SOFTWARE: the firmware reads both NTC dividers on two ADC
 * channels, computes T_up and T_dn (Beta equation), sets T_target = T_up + ΔT,
 * runs a software PI (clamped 0..1, anti-windup) and outputs hardware PWM (LEDC)
 * to a gate driver + low-side MOSFET that switches the heater. In steady state the
 * electrical power that must be delivered to hold ΔT equals the heat the fluid
 * carries away:
 *
 *      P = ( h(v)·A_wet + G_para ) · ΔT
 *
 * h(v) is the convection coefficient — small in air, moderate in still water, and
 * large & velocity-dependent in flow (King's law:  h ∝ a + b·√v). So unlike the
 * single heated probe (whose head→fluid ΔT *shrinks* with flow and saturates),
 * here the measured POWER keeps rising with flow and never saturates. And because
 * ΔT is referenced to the measured fluid temperature, the calibration is
 * intrinsically temperature-compensated.
 *
 * THE FLOW SIGNAL is the heater power, computed in firmware from the commanded
 * duty and the MEASURED bus voltage:  P = duty · V_drive² / R_heater.  The duty is
 * known (the firmware sets it) — there is NO analog current sense. Because power
 * ∝ V_drive² and the 12 V marine bus swings ~11–15 V, the firmware reads V_drive
 * on a third ADC channel and uses the measured value (without it, a ±ΔV swing
 * gives a ±2·ΔV/V power error).
 *
 * This file also re-implements a compact single-heated-probe model so the app can
 * draw a direct head-to-head performance comparison (see singleProbe* below).
 */

(function (global) {
  'use strict';

  // ----------------------------------------------------------------------------
  // Default parameters. Everything here is editable from the UI.
  // ----------------------------------------------------------------------------
  const DEFAULTS = {
    // Control set-point and reference
    delta_T: 10.0, // °C   held temperature rise of the downstream element
    T_fluid: 20.0, // °C   stream temperature (read by the upstream NTC)

    // Which downstream heated element. `element` selects a preset (see ELEMENTS).
    element: 'probe',

    // Probe element — head + aluminium heater block, both NTCs in this same housing.
    // Only the Ø9.2 × 3.4 head is wetted; a short 3 mm metal neck connects it to a
    // Ø15 × 5 aluminium block (behind the wall) that holds the cartridge heater in
    // one Ø6 hole and the NTC leads in the other. The block is a near-isothermal
    // spreader, so the heater→head conduction path is just the 3 mm neck — far lower
    // resistance than a long thin shaft.
    probe_head_dia_mm: 9.2,
    probe_head_thick_mm: 3.4, // only this protrudes into the flow (wetted)
    probe_gap_mm: 3.0, // aluminium-block face -> head: the short conduction neck
    probe_ntc_from_face_mm: 2.0,
    probe_k: 15.0, // neck/head conductivity (316 SS ~15; bronze ~75; titanium ~22)
    probe_rho: 8000.0,
    probe_cp: 500.0,
    // How much of the head SIDE WALL is exposed to the water (mm of the head's
    // thickness, 0..probe_head_thick_mm); the rest of the side is embedded in PTFE.
    // The front face is always wetted. Larger exposure ⇒ more wetted area, so the
    // power-vs-flow slope is steeper; it also couples the NTC to the fluid more
    // directly, so the buried-NTC series resistance (and its high-flow saturation)
    // fades to zero at full exposure. 0 = front face only.
    head_side_exposed_mm: 3.4,
    // Aluminium heater block (Ø15 × 5 mm, two Ø6 holes).
    al_dia_mm: 15.0,
    al_thick_mm: 5.0,
    al_hole_mm: 6.0,
    al_k: 237.0,
    al_rho: 2700.0,
    al_cp: 900.0,

    // 316 tube element (closed tip, NTC bead inside). 5 mm OD, 3 mm ID => 1 mm wall.
    tube_od_mm: 5.0,
    tube_id_mm: 3.0,
    active_len_mm: 10.0, // wetted/heated active length of the tube tip in the flow
    support_len_mm: 15.0, // conduction path from the active tip back to the mount
    tube_k: 15.0, // W/m·K   316 stainless
    tube_rho: 8000.0, // kg/m³
    tube_cp: 500.0, // J/kg·K

    // Glass-bead NTC element (encapsulated; only a fraction is wetted).
    bead_dia_mm: 2.5,
    bead_exposed_frac: 0.5, // 50% of the bead exposed to the fluid
    bead_rho: 2500.0, // kg/m³  (glass / ceramic bead)
    bead_cp: 800.0, // J/kg·K

    // Parasitic heat leak through the lead wires (W/K). Sets, with the tube-wall
    // conduction, the zero-flow / air power floor (the "a" in King's law).
    G_lead: 0.0015,

    // Heater drive — a SEPARATE ceramic heater (no longer the NTC itself). Defined
    // by its resistance and the rail; P_max = v_drive²/heater_R (3.6 Ω @ 12 V ≈
    // 40 W). The ESP32 software loop sets a PWM duty (LEDC → gate driver → low-side
    // MOSFET). The FLOW SIGNAL is the heater power computed in firmware from the
    // KNOWN duty and the MEASURED bus voltage: P = duty · v_drive² / heater_R.
    // There is NO analog current sense. The 12 V marine bus swings, so the firmware
    // reads v_drive on a third ADC channel (P ∝ V², a ±ΔV swing would otherwise give
    // a ±2·ΔV/V power error). v_drive_min/max bound that swing for the comp chart.
    heater_R: 3.6, // Ω   ceramic heater resistance (3.6 Ω @ 12 V ≈ 40 W)
    v_drive: 12.0, // V   heater supply rail (nominal marine bus)
    v_drive_min: 11.0, // V   low end of the bus swing (engine off / discharged battery)
    v_drive_max: 15.0, // V   high end of the bus swing (alternator charging)
    // Cartridge heater seated in one Ø6 hole of the aluminium block (its geometry is
    // taken from the block — Ø al_hole × al_thick). Sets its thermal mass and a
    // maximum surface temperature beyond which it cannot push more power into the head.
    heater_rho: 3800.0, // kg/m³  (ceramic cartridge)
    heater_cp: 850.0, // J/kg·K
    heater_tmax_c: 250.0, // °C   max heater surface temperature (feasibility limit)

    // Sensing NTCs — low-power temperature sensors, each on a 3.3 V divider read by
    // an ESP32 ADC channel (NOT self-heated; see senseSelfHeating). The firmware
    // converts the divider voltage to temperature via the Beta equation.
    ntc_vexc: 3.3, // V    NTC divider excitation (the 3.3 V rail the ADC references)
    ntc_rseries: 10000.0, // Ω    divider series resistor for each sensing NTC
    ntc_diss_mw_c: 5.0, // mW/°C NTC dissipation constant (in water) for the self-heat estimate

    // Software PI gains (run in the ESP32). Output is the duty demand, clamped 0..1
    // with back-calculation anti-windup. Tuned for the slow plant (dominant thermal
    // time constant ~8.5 s): a modest Kp with an integral time of a few seconds.
    pi_kp: 0.03, // duty per °C of error (proportional gain)
    pi_ki: 0.006, // duty per (°C·s) (integral gain)

    // Sensor spacing (upstream <-> downstream), for the diagram / wake note only.
    spacing_mm: 10.0,

    // Convective coefficients for the natural-convection regimes (W/m²·K)
    h_air: 12.0, // natural convection in air (a small radiation term is added)
    h_stillwater: 600.0, // natural convection floor in still seawater
    emissivity: 0.3, // radiation term, air only

    // Seawater properties (~20 °C) for the forced-convection correlations
    water_rho: 1025.0, // kg/m³
    water_mu: 1.07e-3, // Pa·s
    water_k: 0.6, // W/m·K
    water_cp: 3990.0, // J/kg·K

    // Flow — UI works in l/min; velocity is derived from the pipe bore.
    pipe_dia_mm: 19.0,
    flow_lpm: 30.0,
    velocity: 1.76, // m/s  derived = flow_lpm / pipe area; kept in sync by app.js

    // Flow-step response (heater loop stays active, ΔT held).
    step_from_lpm: 30.0,
    step_to_lpm: 5.0,
    step_time: 8.0, // s   horizon for the flow-step graph

    // Sensing-NTC Beta model — used for both upstream and downstream sensing NTCs
    // and for the single-probe comparison. (Heating is done by the separate heater.)
    ntc_r25: 10.0, // kΩ
    ntc_beta: 3950.0, // K

    // ADC sensing chain — now applied to the two NTC DIVIDER voltages (the firmware
    // reads them, converts to T_up/T_dn, and the noise propagates to the held ΔT and
    // hence to flow). The plant is slow (seconds), so heavy averaging is available.
    adc_preset: 'esp32',
    adc_bits: 12,
    adc_fsr: 3.3, // V   ADC full-scale (sets LSB; also the NTC divider rail)
    adc_noise_mv: 20.0, // mV  raw per-sample RMS noise
    adc_averages: 64, // samples averaged (÷√N) — the slow plant allows heavy oversampling
    adc_inl_mv: 5.0, // mV  INL/offset floor (does NOT average away)

    // Single-heated-probe comparison (the model-explorer M6 probe), for the
    // "why two sensors" chart. Representative bare-316 values.
    sp_R_cond: 66.0, // K/W   shaft conduction resistance
    sp_T_ptc: 80.0, // °C    PTC source temperature
    sp_head_dia_mm: 9.2,
    sp_head_thick_mm: 3.4,
    sp_shaft_od_mm: 6.0,
    sp_div_rseries: 12.0, // kΩ  single-probe divider series resistor
    sp_div_vsupply: 3.3, // V

    // Numerics
    sim_time: 30.0, // s   turn-on transient duration
  };

  const SIGMA = 5.670374419e-8; // Stefan–Boltzmann, W/m²·K⁴

  // Heated-element presets.
  //  - probe : the single-NTC structure — a PTFE-sleeved 316 shaft with only the
  //            head wetted, the heater driving it through the shaft (R_cond matters).
  //  - tube  : a 316 cylinder in crossflow (whole tube wetted & heated).
  //  - bead  : a small wetted sphere, heater bonded directly (no conduction path).
  const ELEMENTS = {
    probe: { name: 'Probe (head+shaft)', short: 'probe', shape: 'head' },
    tube: { name: '316 tube (5mm)', short: 'tube', shape: 'cylinder' },
    bead: { name: 'Glass bead', short: 'bead', shape: 'sphere' },
  };

  // ADC presets. ESP32 internal ADC is noisy but the slow plant lets us average
  // heavily; the ADS1115 is a 16-bit delta-sigma part with a PGA (µV-class noise).
  const ADC_PRESETS = {
    esp32: { name: 'ESP32 12-bit', bits: 12, fsr: 3.3, noise_mv: 20, inl_mv: 5, averages: 64 },
    ads1115: { name: 'ADS1115 16-bit', bits: 16, fsr: 4.096, noise_mv: 0.05, inl_mv: 0.25, averages: 16 },
  };

  // ----------------------------------------------------------------------------
  // Geometry helpers (heated downstream element)
  // ----------------------------------------------------------------------------
  function isBead(p) {
    return p.element === 'bead';
  }
  function isProbe(p) {
    return p.element === 'probe';
  }
  // Wetted length of the head side wall (mm), clamped to [0, head thickness].
  function headSideExposed(p) {
    return Math.max(0, Math.min(p.head_side_exposed_mm, p.probe_head_thick_mm));
  }
  // Fraction of the side wall exposed (0..1).
  function headExposedFrac(p) {
    return p.probe_head_thick_mm > 0 ? headSideExposed(p) / p.probe_head_thick_mm : 0;
  }

  // Characteristic length for the convection correlation (m).
  function elementCharLength(p) {
    if (isProbe(p)) return p.probe_head_dia_mm / 1000;
    return (isBead(p) ? p.bead_dia_mm : p.tube_od_mm) / 1000;
  }

  // Wetted (convective) surface of the heated element (m²).
  function wettedArea(p) {
    if (isProbe(p)) {
      const d = p.probe_head_dia_mm / 1000;
      const face = (Math.PI / 4) * d * d; // front face: always wetted
      const L = headSideExposed(p) / 1000; // exposed length of the side wall
      return face + Math.PI * d * L;
    }
    if (isBead(p)) {
      const d = p.bead_dia_mm / 1000;
      return p.bead_exposed_frac * Math.PI * d * d; // fraction of a full sphere
    }
    const d = p.tube_od_mm / 1000,
      L = p.active_len_mm / 1000;
    return Math.PI * d * L + (Math.PI / 4) * d * d; // side wall + end cap
  }

  // Heater→NTC conduction resistance (K/W), used for the required heater temperature.
  // The aluminium block is a near-isothermal spreader, so for the probe the path is:
  //  - sides wetted: the short 3 mm neck between block face and head;
  //  - sides insulated: the block is bonded to the back face, so it is the (thick −
  //    ntc_depth) of head between the back and the buried NTC.
  // The tube/bead are heated directly, so it is ~0.
  function shaftCondResistance(p) {
    if (!isProbe(p)) return 0;
    const d = p.probe_head_dia_mm / 1000;
    const A = (Math.PI / 4) * d * d;
    // block → (gap neck) → head → NTC. The back-face-to-NTC head conduction matters
    // when the head is not isothermal (low side exposure) and fades out as the sides
    // become fully wetted. The gap is adjustable (0 = block touching the head).
    const gap = p.probe_gap_mm / 1000;
    const back = (Math.max(0, p.probe_head_thick_mm - p.probe_ntc_from_face_mm) / 1000) * (1 - headExposedFrac(p));
    return (gap + back) / (p.probe_k * A);
  }

  // Series conduction resistance from the buried NTC to the wetted front face (K/W).
  // Only present when the head sides are insulated (then the NTC sits behind the only
  // wetted surface). This is what caps the power at ΔT/R_fn and saturates the curve.
  function headSeriesResistance(p) {
    if (!isProbe(p)) return 0;
    const frac = headExposedFrac(p);
    if (frac >= 1) return 0; // sides fully wetted: head ~isothermal, NTC at surface
    const d = p.probe_head_dia_mm / 1000;
    const A = (Math.PI / 4) * d * d;
    // buried-NTC → wetted-face conduction, fading out as the sides get wetted
    return (p.probe_ntc_from_face_mm / 1000 / (p.probe_k * A)) * (1 - frac);
  }

  // Thermal mass of the part the NTC tracks (J/K) — drives the flow-step response.
  function elementHeatCapacity(p) {
    if (isProbe(p)) {
      const d = p.probe_head_dia_mm / 1000,
        t = p.probe_head_thick_mm / 1000;
      return p.probe_rho * p.probe_cp * (Math.PI / 4) * d * d * t; // the head
    }
    if (isBead(p)) {
      const d = p.bead_dia_mm / 1000;
      return p.bead_rho * p.bead_cp * (Math.PI / 6) * d * d * d;
    }
    const od = p.tube_od_mm / 1000,
      id = p.tube_id_mm / 1000,
      L = p.active_len_mm / 1000;
    return p.tube_rho * p.tube_cp * (Math.PI / 4) * (od * od - id * id) * L; // stainless annulus
  }

  // Whole-assembly thermal mass (J/K) — drives the cold-start turn-on. For the
  // probe it adds the shaft and the cartridge heater to the head.
  function systemHeatCapacity(p) {
    let C = elementHeatCapacity(p); // the head
    if (isProbe(p)) {
      const dh = p.probe_head_dia_mm / 1000;
      C += p.probe_rho * p.probe_cp * (Math.PI / 4) * dh * dh * (p.probe_gap_mm / 1000); // neck
      const dB = p.al_dia_mm / 1000,
        tB = p.al_thick_mm / 1000,
        dH = p.al_hole_mm / 1000;
      const Vblock = (Math.PI / 4) * (dB * dB - 2 * dH * dH) * tB; // block minus 2 holes
      C += p.al_rho * p.al_cp * Vblock; // aluminium block (the dominant mass)
      C += p.heater_rho * p.heater_cp * (Math.PI / 4) * dH * dH * tB; // cartridge in a hole
    }
    return C;
  }

  // Parasitic conductance into the (fluid-temperature) mount: lead wires, plus the
  // tube-wall axial conduction for the tube element. The probe's shaft is the
  // intended delivery path (modelled as R_cond), not a parasitic loss, and its PTFE
  // block is treated as adiabatic — so the probe only leaks through the leads.
  function parasiticConductance(p) {
    let G = p.G_lead;
    if (p.element === 'tube') {
      const od = p.tube_od_mm / 1000,
        id = p.tube_id_mm / 1000;
      const Awall = (Math.PI / 4) * (od * od - id * id);
      G += (p.tube_k * Awall) / (p.support_len_mm / 1000);
    }
    return G;
  }

  // ----------------------------------------------------------------------------
  // Flow-rate <-> velocity through the pipe bore.
  // ----------------------------------------------------------------------------
  function pipeArea(p) {
    const d = p.pipe_dia_mm / 1000;
    return (Math.PI / 4) * d * d;
  }
  function lpmToVelocity(lpm, p) {
    return lpm / 60000 / pipeArea(p);
  }
  function velocityToLpm(v, p) {
    return v * pipeArea(p) * 60000;
  }

  // ----------------------------------------------------------------------------
  // Convection coefficients. Both correlations take an explicit characteristic
  // length D so they can serve the tube, the bead, and the single-probe head.
  // ----------------------------------------------------------------------------

  // Churchill–Bernstein cylinder-in-crossflow. Returns h (W/m²·K).
  function forcedConvectionCyl(velocity, D, p) {
    if (velocity <= 0) return 0;
    const Pr = (p.water_mu * p.water_cp) / p.water_k;
    const Re = (p.water_rho * velocity * D) / p.water_mu;
    const num = 0.62 * Math.sqrt(Re) * Math.cbrt(Pr);
    const den = Math.pow(1 + Math.pow(0.4 / Pr, 2 / 3), 0.25);
    const tail = Math.pow(1 + Math.pow(Re / 282000, 5 / 8), 4 / 5);
    const Nu = 0.3 + (num / den) * tail;
    return (Nu * p.water_k) / D;
  }

  // Whitaker sphere correlation. Returns h (W/m²·K).
  function forcedConvectionSphere(velocity, D, p) {
    if (velocity <= 0) return 0;
    const Pr = (p.water_mu * p.water_cp) / p.water_k;
    const Re = (p.water_rho * velocity * D) / p.water_mu;
    const Nu = 2 + (0.4 * Math.sqrt(Re) + 0.06 * Math.pow(Re, 2 / 3)) * Math.pow(Pr, 0.4);
    return (Nu * p.water_k) / D;
  }

  // Forced-convection h for the heated element (shape-aware).
  function elementForcedConvection(velocity, p) {
    const D = elementCharLength(p);
    return isBead(p) ? forcedConvectionSphere(velocity, D, p) : forcedConvectionCyl(velocity, D, p);
  }

  // Flowing-water h: blend the still-water natural floor with forced convection,
  // (h_nat³ + h_forced³)^(1/3), so the curve eases out of the still level at v→0.
  function flowConvection(velocity, p) {
    const hf = elementForcedConvection(velocity, p);
    const hn = p.h_stillwater;
    return Math.cbrt(hn * hn * hn + hf * hf * hf);
  }

  // Convection coefficient for a named scenario (air adds linearised radiation).
  function sceneConvection(scenario, p) {
    switch (scenario) {
      case 'air': {
        let h = p.h_air;
        const Ts = p.T_fluid + p.delta_T + 273.15;
        const Tinf = p.T_fluid + 273.15;
        h += p.emissivity * SIGMA * (Ts * Ts + Tinf * Tinf) * (Ts + Tinf);
        return h;
      }
      case 'stillwater':
        return p.h_stillwater;
      case 'flowing':
        return flowConvection(p.velocity, p);
      default:
        return p.h_air;
    }
  }

  // ----------------------------------------------------------------------------
  // Steady-state power balance with a SEPARATE ceramic heater, FULLY-DIGITAL loop.
  //   P = (h·A_wet + G_para)·ΔT      (power the heater must deliver to hold ΔT)
  // The ESP32 software PI commands a PWM duty into the resistive heater off the
  // (measured) v_drive rail: duty = P / P_max, with P_max = v_drive²/heater_R. The
  // FLOW SIGNAL is the firmware-computed power P = duty·v_drive²/heater_R (the duty
  // is known; there is no current sense). The heater can hold ΔT only while P ≤ P_max.
  // ----------------------------------------------------------------------------
  function heatedElementSteady(p, scenario) {
    const dT = p.delta_T;
    const A = wettedArea(p);
    const h = sceneConvection(scenario, p);
    const G_fluid = h * A;
    // If the head sides are insulated the heat must also conduct from the buried NTC
    // out to the wetted front face — a resistance R_fn in series with convection.
    const R_fn = headSeriesResistance(p);
    const G_through = R_fn > 0 ? 1 / (1 / G_fluid + R_fn) : G_fluid;
    const G_para = parasiticConductance(p);
    const P = (G_through + G_para) * dT;

    // Heater→head conduction: to push P through the neck the heater must run a step
    // P·R_cond hotter than the head. For the probe this is the bottleneck; for
    // tube/bead R_cond≈0 so the heater sits at the element temperature.
    const R_cond = shaftCondResistance(p);
    const T_element = p.T_fluid + dT; // the NTC/head temperature (held by the loop)
    const T_heater = T_element + P * R_cond; // temperature the heater must reach

    const P_max = (p.v_drive * p.v_drive) / p.heater_R; // full-on heater power
    const I_full = p.v_drive / p.heater_R; // peak (switch-on) current
    const duty = Math.max(0, Math.min(1, P / P_max)); // PWM duty the firmware commands
    // Power the firmware reports as the flow signal: known duty × measured-bus power.
    const P_report = duty * P_max;
    const heat_ok = T_heater <= p.heater_tmax_c; // heater hot enough to deliver P?
    return {
      P,
      P_report,
      h,
      G_fluid,
      G_para,
      R_fn,
      R_cond,
      T_element,
      T_heater,
      P_max,
      I_full,
      duty,
      heat_ok,
      power_ok: P <= P_max && heat_ok,
    };
  }

  // Self-heating of a sensing NTC on its 3.3 V divider — should be negligible,
  // which is the point of separating the heater from the sensors.
  function senseSelfHeating(p) {
    const R = ntcResistance(p, p.T_fluid); // Ω at fluid temperature
    const I = p.ntc_vexc / (p.ntc_rseries + R);
    const P = I * I * R; // W dissipated in the NTC
    const dT = (P * 1000) / Math.max(1e-6, p.ntc_diss_mw_c); // °C rise
    return { P_mw: P * 1000, dT, R, I_ua: I * 1e6 };
  }

  // ----------------------------------------------------------------------------
  // Flow calibration: sweep velocity and report the power/current the loop needs.
  // Also returns a least-squares King's-law fit  P ≈ a + b·√v_pipe  for overlay.
  // ----------------------------------------------------------------------------
  function deriveCalibration(p, vmax) {
    vmax = vmax || 3.0;
    const curve = [];
    let sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0,
      n = 0;
    for (let i = 0; i <= 60; i++) {
      const v = (i / 60) * vmax;
      const r = heatedElementSteady(Object.assign({}, p, { velocity: v }), 'flowing');
      curve.push({ v, lpm: velocityToLpm(v, p), P: r.P, P_report: r.P_report, duty: r.duty, h: r.h });
      const sq = Math.sqrt(v);
      sx += sq;
      sy += r.P;
      sxx += sq * sq;
      sxy += sq * r.P;
      n++;
    }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a = (sy - b * sx) / n;
    return { curve, kings: { a, b }, vmax }; // P_fit(v) = a + b·√v
  }

  // ----------------------------------------------------------------------------
  // Transients.
  // ----------------------------------------------------------------------------

  /*
   * TWO-NODE thermal plant for the digital loop. The heater + aluminium block is one
   * lumped node (C_hs) coupled through R_cond to the element/NTC node (C_el), which
   * loses heat to the fluid through G = h·A + G_para. The heater power lands on the
   * block node; the held/measured temperature is the element node. This reproduces
   * the dominant ~8.5 s thermal time constant (verified in doublentc_ctd_components
   * .cir: C_hs≈2.0 J/K, C_el≈1.6 J/K, R_cond≈3 K/W). For tube/bead R_cond≈0 so the
   * two nodes collapse to one. Explicit Euler, kept stable by a small dt.
   *
   * Returns the two heat capacities and conductance so the transient drivers share
   * exactly the same plant.
   */
  function twoNodePlant(p, scenario, velocity) {
    const pv = velocity != null ? Object.assign({}, p, { velocity }) : p;
    const A = wettedArea(pv);
    const h = scenario === 'flowing' ? flowConvection(pv.velocity, pv) : sceneConvection(scenario, pv);
    const R_fn = headSeriesResistance(pv);
    const G_fluid = h * A;
    const G_through = R_fn > 0 ? 1 / (1 / G_fluid + R_fn) : G_fluid;
    const G = G_through + parasiticConductance(pv); // element → fluid
    // Split the system mass into the block node and the element node.
    const C_el = elementHeatCapacity(pv); // the head/NTC node the loop holds
    const C_hs = Math.max(1e-4, systemHeatCapacity(pv) - C_el); // heater + Al block node
    const R_cond = Math.max(1e-4, shaftCondResistance(pv)); // block ↔ element coupling
    return { G, C_el, C_hs, R_cond, h, A };
  }

  /*
   * Turn-on: the assembly starts at T_fluid and the ESP32 software PI drives the
   * heater toward the set-point T_up+ΔT. The PI output is a duty clamped 0..1 with
   * back-calculation anti-windup; a cold start (large error) saturates the duty to
   * 100 % for EVERY scenario, so they all start at P_max. The medium that loses the
   * least heat (air) reaches the set-point first; a medium whose loss exceeds P_max
   * never reaches ΔT. Two-node explicit Euler. Returns {time,T,P,steadyP}.
   */
  function turnOnTransient(p, scenario) {
    const plant = twoNodePlant(p, scenario);
    const setpoint = p.T_fluid + p.delta_T;
    const Pmax = (p.v_drive * p.v_drive) / p.heater_R;
    const { G, C_el, C_hs, R_cond } = plant;
    // Stable step for the fastest pole (block node through R_cond).
    const dt = Math.min(0.2 * Math.min(C_el, C_hs) * R_cond, p.sim_time / 600) || 1e-3;
    const steps = Math.max(50, Math.ceil(p.sim_time / dt));
    const sampleEvery = Math.max(1, Math.floor(steps / 200));
    const out = { time: [], T: [], P: [] };
    let Tel = p.T_fluid,
      Ths = p.T_fluid,
      integ = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s * dt;
      const err = setpoint - Tel; // firmware error = T_target − T_dn
      const unclamped = p.pi_kp * err + p.pi_ki * integ;
      const duty = Math.max(0, Math.min(1, unclamped));
      // back-calculation anti-windup: integrate the error, but unwind when clamped
      integ += (err + (duty - unclamped) / Math.max(1e-6, p.pi_ki)) * dt;
      const P = duty * Pmax; // heater power onto the block node
      if (s % sampleEvery === 0) {
        out.time.push(t);
        out.T.push(Tel);
        out.P.push(P);
      }
      const q_cond = (Ths - Tel) / R_cond; // block → element
      Ths += (dt * (P - q_cond)) / C_hs;
      Tel += (dt * (q_cond - G * (Tel - p.T_fluid))) / C_el;
    }
    out.steadyP = G * p.delta_T;
    return out;
  }

  /*
   * Flow-step response of the POWER signal. The software PI re-settles the element
   * to ΔT after a flow change; the measured power moves from the "from" value to the
   * "to" value over the closed-loop dynamics of the two-node plant. We simulate the
   * actual digital loop (same PI + two-node plant as turn-on) so the ~8.5 s dominant
   * pole and the loop bandwidth both show. Reports t63 / t90 of the power signal.
   */
  function flowStepResponse(p, fromLpm, toLpm) {
    const vFrom = lpmToVelocity(fromLpm, p);
    const vTo = lpmToVelocity(toLpm, p);
    const Pfrom = heatedElementSteady(Object.assign({}, p, { velocity: vFrom }), 'flowing').P;
    const Pto = heatedElementSteady(Object.assign({}, p, { velocity: vTo }), 'flowing').P;
    const setpoint = p.T_fluid + p.delta_T;
    const Pmax = (p.v_drive * p.v_drive) / p.heater_R;
    // Open-loop τ of the dominant (element) node, for the readout.
    const pl0 = twoNodePlant(p, 'flowing', vFrom);
    const tauOpen = (pl0.C_el + pl0.C_hs) / pl0.G;

    // Pre-settle at the "from" flow so we start from the held steady state.
    const settle = (plant, T0) => {
      let Tel = T0.Tel,
        Ths = T0.Ths,
        integ = T0.integ;
      const { G, C_el, C_hs, R_cond } = plant;
      const dt = Math.min(0.2 * Math.min(C_el, C_hs) * R_cond, 0.05);
      for (let i = 0; i < Math.ceil(120 / dt); i++) {
        const err = setpoint - Tel;
        const unclamped = p.pi_kp * err + p.pi_ki * integ;
        const duty = Math.max(0, Math.min(1, unclamped));
        integ += (err + (duty - unclamped) / Math.max(1e-6, p.pi_ki)) * dt;
        const P = duty * Pmax;
        const q_cond = (Ths - Tel) / R_cond;
        Ths += (dt * (P - q_cond)) / C_hs;
        Tel += (dt * (q_cond - G * (Tel - p.T_fluid))) / C_el;
      }
      return { Tel, Ths, integ };
    };

    const plantFrom = twoNodePlant(p, 'flowing', vFrom);
    const plantTo = twoNodePlant(p, 'flowing', vTo);
    let st = settle(plantFrom, { Tel: setpoint, Ths: setpoint + Pfrom * plantFrom.R_cond, integ: Pfrom / Pmax / Math.max(1e-6, p.pi_ki) });

    const { G, C_el, C_hs, R_cond } = plantTo;
    const dt = Math.min(0.2 * Math.min(C_el, C_hs) * R_cond, p.step_time / 600) || 1e-3;
    const steps = Math.max(50, Math.ceil(p.step_time / dt));
    const sampleEvery = Math.max(1, Math.floor(steps / 200));
    const out = { time: [], P: [], fromP: Pfrom, toP: Pto, tauOpen };
    let Tel = st.Tel,
      Ths = st.Ths,
      integ = st.integ;
    let t63 = null;
    const change = Pto - Pfrom;
    for (let s = 0; s <= steps; s++) {
      const t = s * dt;
      const err = setpoint - Tel;
      const unclamped = p.pi_kp * err + p.pi_ki * integ;
      const duty = Math.max(0, Math.min(1, unclamped));
      integ += (err + (duty - unclamped) / Math.max(1e-6, p.pi_ki)) * dt;
      const P = duty * Pmax;
      if (t63 == null && change !== 0 && (P - Pfrom) / change >= 0.632) t63 = t;
      if (s % sampleEvery === 0) {
        out.time.push(t);
        out.P.push(P);
      }
      const q_cond = (Ths - Tel) / R_cond;
      Ths += (dt * (P - q_cond)) / C_hs;
      Tel += (dt * (q_cond - G * (Tel - p.T_fluid))) / C_el;
    }
    out.t63 = t63 != null ? t63 : tauOpen;
    out.t90 = out.t63 * Math.log(10);
    return out;
  }

  // ----------------------------------------------------------------------------
  // Measurement chain: heater current -> sense resistor -> ADC -> flow accuracy.
  // ----------------------------------------------------------------------------

  // Effective RMS measurement uncertainty at the ADC input (volts). Random noise
  // averaged ÷√N, ⊕ quantisation, ⊕ an INL/offset floor that does not average.
  function adcSigmaVolts(p) {
    const random = p.adc_noise_mv / 1000 / Math.sqrt(Math.max(1, p.adc_averages));
    const lsb = (p.adc_fsr || p.v_drive) / Math.pow(2, p.adc_bits);
    const quant = lsb / Math.sqrt(12);
    const floor = (p.adc_inl_mv || 0) / 1000;
    return Math.sqrt(random * random + quant * quant + floor * floor);
  }

  /*
   * Flow-rate accuracy for the FULLY-DIGITAL CTD sensor. The firmware reads two NTC
   * dividers and a Vbus divider, so the error sources are now:
   *
   *  (a) ADC NOISE ON THE TWO NTC READINGS. Each divider reading carries σ_V (after
   *      averaging); the temperature error is σ_T = σ_V / |dV_divider/dT|. The loop
   *      holds the MEASURED ΔT = T_dn − T_up, so σ_ΔT = √(σ_Tup² + σ_Tdn²). Since the
   *      delivered power is P ≈ (h·A+G_para)·ΔT, an error δΔT scales the power (and
   *      hence the inferred flow) by δΔT/ΔT: σP_a = P·σ_ΔT/ΔT.
   *  (b) DUTY/POWER RESOLUTION + Vbus SENSE. The reported power P = duty·Vbus²/R has
   *      a PWM-duty quantisation (1 LSB of the LEDC counter) and a Vbus-ADC term
   *      (∂P/∂Vbus = 2P/Vbus): σP_b = P·√((LSB_duty/duty)² + (2·σ_Vbus/Vbus)²).
   *
   * Convert the total power 1σ to a flow 1σ through the local calibration slope
   * dP/dflow. Because P ∝ √v that slope falls only as 1/√v — never to zero — so the
   * resolution degrades gracefully (cf. the single probe, which saturates).
   */
  function flowAccuracy(p, hiLpm) {
    hiLpm = hiLpm || 40;
    const sigmaV = adcSigmaVolts(p); // per-NTC divider reading, after averaging
    // ΔT measurement noise: both NTC reads sit near T_fluid / T_fluid+ΔT.
    const sTup = sigmaV / Math.max(1e-9, Math.abs(ntcDividerSensitivity(p, p.T_fluid)));
    const sTdn = sigmaV / Math.max(1e-9, Math.abs(ntcDividerSensitivity(p, p.T_fluid + p.delta_T)));
    const sigma_dT = Math.sqrt(sTup * sTup + sTdn * sTdn);
    // Vbus sense noise and PWM duty LSB.
    const sigma_vbus = adcSigmaVolts(Object.assign({}, p, { adc_fsr: p.v_drive_max })) * (p.v_drive_max / p.adc_fsr);
    const lsb_duty = 1 / Math.pow(2, p.adc_bits); // LEDC duty resolution (≈ ADC bits)
    const N = 80,
      d = 0.5;
    const Pat = (lpm) => heatedElementSteady(Object.assign({}, p, { velocity: lpmToVelocity(lpm, p) }), 'flowing').P;
    const curve = [];
    for (let i = 0; i <= N; i++) {
      const lpm = (hiLpm * i) / N;
      const P = Pat(lpm);
      const dPdf = (Pat(lpm + d) - P) / d; // calibration slope (W per l/min)
      const duty = P / ((p.v_drive * p.v_drive) / p.heater_R);
      // (a) ΔT-noise → power; (b) duty/Vbus → power. Combined in quadrature.
      const sP_a = P * (sigma_dT / Math.max(1e-6, p.delta_T));
      const sP_b =
        P * Math.sqrt(Math.pow(lsb_duty / Math.max(1e-6, duty), 2) + Math.pow((2 * sigma_vbus) / p.v_drive, 2));
      const sP = Math.sqrt(sP_a * sP_a + sP_b * sP_b);
      const sigma_lpm = Math.abs(dPdf) > 1e-12 ? sP / Math.abs(dPdf) : Infinity;
      curve.push({ lpm, P, sigma_lpm });
    }
    return { curve, sigmaV, sigma_mV: sigmaV * 1000, sigma_dT, sTup, sTdn };
  }

  /*
   * Vbus-compensation benefit. The reported power P = duty·Vbus²/R. WITHOUT
   * compensation the firmware assumes the nominal Vbus, so when the real bus sits at
   * the extremes of its swing (v_drive_min..v_drive_max) the power error is
   * 2·ΔV/V_nom (the V² law). WITH compensation the firmware reads Vbus, so the
   * residual error is just the Vbus-ADC accuracy (2·σ_Vbus/V_nom). Returns, vs flow,
   * the worst-case |power error| (% of reading) for both cases.
   */
  function vbusCompBenefit(p, hiLpm) {
    hiLpm = hiLpm || 40;
    const Vnom = p.v_drive;
    const dV = Math.max(Math.abs(p.v_drive_max - Vnom), Math.abs(Vnom - p.v_drive_min));
    const sigma_vbus = adcSigmaVolts(Object.assign({}, p, { adc_fsr: p.v_drive_max })) * (p.v_drive_max / p.adc_fsr);
    const without_pct = (2 * dV) / Vnom * 100; // ±2ΔV/V, flow-independent
    const with_pct = (2 * sigma_vbus) / Vnom * 100; // limited by Vbus-ADC accuracy
    const N = 60;
    const curve = [];
    for (let i = 0; i <= N; i++) {
      const lpm = (hiLpm * i) / N;
      curve.push({ lpm, without_pct, with_pct });
    }
    return { curve, without_pct, with_pct, dV, sigma_vbus };
  }

  // ----------------------------------------------------------------------------
  // Detection model — air / still / flowing by POWER, plus an ESP32 lookup.
  // ----------------------------------------------------------------------------
  function deriveDetectionModel(p) {
    const air = heatedElementSteady(p, 'air').P;
    const still = heatedElementSteady(p, 'stillwater').P;
    const cal = deriveCalibration(p);
    const goodFlowLpm = 30;
    const flowGood = heatedElementSteady(
      Object.assign({}, p, { velocity: lpmToVelocity(goodFlowLpm, p) }),
      'flowing'
    ).P;

    // air has the LOWEST power, still moderate, flowing highest.
    const thr_air_water = (air + still) / 2; // below -> AIR (dry -> ALARM)
    const thr_flow = still + 0.2 * (flowGood - still); // above -> FLOWING

    function lpmFromPower(P) {
      const c = cal.curve;
      if (P <= c[0].P) return 0;
      for (let i = 0; i < c.length - 1; i++) {
        if (P >= c[i].P && P <= c[i + 1].P) {
          const f = (P - c[i].P) / (c[i + 1].P - c[i].P || 1e-9);
          return c[i].lpm + f * (c[i + 1].lpm - c[i].lpm);
        }
      }
      return c[c.length - 1].lpm;
    }

    return { air, still, flowGood, thr_air_water, thr_flow, goodFlowLpm, cal, lpmFromPower };
  }

  // ----------------------------------------------------------------------------
  // Single-heated-probe comparison (compact re-implementation of model-explorer).
  // Used only to draw the "why two sensors" performance contrast.
  // ----------------------------------------------------------------------------

  // NTC resistance (Beta model, ref 25 °C).
  function ntcResistance(p, tempC) {
    const T = tempC + 273.15,
      T0 = 298.15;
    return p.ntc_r25 * 1000 * Math.exp(p.ntc_beta * (1 / T - 1 / T0));
  }

  // Sensing-NTC divider voltage the ADC reads (NTC high side to ntc_vexc, series R
  // to ground): V = vexc·Rs/(Rs+R_ntc). This is the digital loop's temperature read.
  function ntcDividerVoltage(p, tempC) {
    const R = ntcResistance(p, tempC);
    const Rs = p.ntc_rseries;
    return (p.ntc_vexc * Rs) / (Rs + R);
  }

  // Sensitivity of the divider voltage to temperature (V per °C), evaluated locally.
  function ntcDividerSensitivity(p, tempC, d) {
    d = d || 0.05;
    return (ntcDividerVoltage(p, tempC + d) - ntcDividerVoltage(p, tempC - d)) / (2 * d);
  }

  // Wetted head area of the single probe (same formula as model-explorer).
  function spHeadArea(p) {
    const d = p.sp_head_dia_mm / 1000,
      t = p.sp_head_thick_mm / 1000,
      ds = p.sp_shaft_od_mm / 1000;
    return Math.PI * d * t + (Math.PI / 4) * d * d + (Math.PI / 4) * (d * d - ds * ds);
  }

  // Single-probe head temperature (= NTC reading) at a flow velocity. Lumped:
  // Q=(T_ptc-T_fluid)/(R_cond+R_conv), T_head=T_fluid+Q·R_conv.
  function singleProbeHeadTemp(p, velocity) {
    const D = p.sp_head_dia_mm / 1000;
    const hf = forcedConvectionCyl(velocity, D, p);
    const h = Math.cbrt(p.h_stillwater ** 3 + hf ** 3);
    const R_conv = 1 / (h * spHeadArea(p));
    const Q = (p.sp_T_ptc - p.T_fluid) / (p.sp_R_cond + R_conv);
    return p.T_fluid + Q * R_conv;
  }

  // Single-probe divider voltage (NTC high side to Vsupply, Rs to ground).
  function spDividerVoltage(p, tempC) {
    const rntc = ntcResistance(p, tempC);
    const rs = p.sp_div_rseries * 1000;
    return (p.sp_div_vsupply * rs) / (rs + rntc);
  }

  /*
   * Single-probe flow accuracy, measured the same way (ADC on the divider voltage),
   * so the comparison with the CTD sensor is apples-to-apples on the same ADC.
   */
  function singleProbeAccuracy(p, hiLpm) {
    hiLpm = hiLpm || 40;
    const sigmaV = adcSigmaVolts(p);
    const N = 80,
      d = 0.5;
    const vAt = (lpm) => spDividerVoltage(p, singleProbeHeadTemp(p, lpmToVelocity(lpm, p)));
    const curve = [];
    for (let i = 0; i <= N; i++) {
      const lpm = (hiLpm * i) / N;
      const V = vAt(lpm);
      const dV = (vAt(lpm + d) - V) / d;
      const sigma_lpm = Math.abs(dV) > 1e-12 ? sigmaV / Math.abs(dV) : Infinity;
      curve.push({ lpm, T: singleProbeHeadTemp(p, lpmToVelocity(lpm, p)), sigma_lpm });
    }
    return { curve, sigmaV };
  }

  // ----------------------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------------------
  global.DoubleNTCModel = {
    DEFAULTS,
    ELEMENTS,
    ADC_PRESETS,
    cloneDefaults: () => JSON.parse(JSON.stringify(DEFAULTS)),
    isBead,
    isProbe,
    headSideExposed,
    headExposedFrac,
    elementCharLength,
    wettedArea,
    shaftCondResistance,
    headSeriesResistance,
    elementHeatCapacity,
    systemHeatCapacity,
    parasiticConductance,
    pipeArea,
    lpmToVelocity,
    velocityToLpm,
    forcedConvectionCyl,
    forcedConvectionSphere,
    elementForcedConvection,
    flowConvection,
    sceneConvection,
    heatedElementSteady,
    senseSelfHeating,
    deriveCalibration,
    twoNodePlant,
    turnOnTransient,
    flowStepResponse,
    adcSigmaVolts,
    flowAccuracy,
    vbusCompBenefit,
    deriveDetectionModel,
    ntcResistance,
    ntcDividerVoltage,
    ntcDividerSensitivity,
    singleProbeHeadTemp,
    singleProbeAccuracy,
  };
})(typeof window !== 'undefined' ? window : globalThis);
