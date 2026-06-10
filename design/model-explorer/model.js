/*
 * model.js — Thermal model of the heated-probe flow sensor.
 *
 * Pure physics, no DOM access. All maths is done in SI units (metres, kelvin/°C,
 * watts). The UI layer (app.js) is responsible for converting mm <-> m for display.
 *
 * Physical picture (see design/AlayisisPrompt.md):
 *
 *   PTC @ 80°C ──► 316 stainless tube (6mm OD, 3mm ID, ~21mm) ──► head (Ø9.2mm × 3.4mm) ──► fluid
 *                  (shaft sides embedded in PTFE = adiabatic)        (only the head touches the fluid)
 *
 * The NTC bead sits on the axis of the head, 2mm from the wetted end face.
 *
 * Heat leaves the head by convection into the fluid. How fast it leaves (the
 * convective coefficient h) is what distinguishes:
 *    - air            : tiny h  -> head stays hot, NTC ~ near PTC temperature
 *    - still seawater : moderate h -> NTC noticeably cooler
 *    - flowing seawater: large, velocity-dependent h -> NTC close to fluid temp
 */

(function (global) {
  'use strict';

  // ----------------------------------------------------------------------------
  // Default parameters. Everything here is editable from the UI.
  // ----------------------------------------------------------------------------
  const DEFAULTS = {
    // Boundary temperatures (°C)
    T_ptc: 80, // PTC self-regulating temperature
    T_fluid: 20, // ambient fluid / sink temperature

    // Geometry (mm) — converted to m internally
    shaft_len_mm: 21.0, // stainless shaft length, PTC end -> head base
    shaft_od_mm: 6.0,
    shaft_id_mm: 3.0, // central bore for the NTC wiring
    head_dia_mm: 9.2,
    head_thick_mm: 3.4,
    ntc_from_face_mm: 2.0, // NTC depth measured from the wetted end face

    // Probe material. `material` selects a preset (see MATERIALS); the active
    // properties live in k_ss / rho_ss / cp_ss so the model maths is unchanged.
    // (Keys keep the _ss suffix for backwards compatibility.)
    material: '316ss',
    k_ss: 15.0, // W/m·K   thermal conductivity
    rho_ss: 8000.0, // kg/m³
    cp_ss: 500.0, // J/kg·K

    // Optional aluminium sleeve over the shaft, in parallel with the stainless
    // (good thermal contact assumed, via grease). It stops `sleeve_gap_mm` short
    // of the inner head surface to leave room for the O-ring / PTFE seal seat,
    // so that short stainless-only gap becomes the conduction bottleneck. Varying
    // sleeve_od_mm tunes both the conductance and the added thermal mass.
    sleeve_enabled: false,
    sleeve_od_mm: 10.0, // outer diameter of the aluminium tube (ID = shaft OD)
    sleeve_gap_mm: 3.0, // distance it stops short of the inner head surface
    sleeve_k: 237.0, // aluminium conductivity, W/m·K
    sleeve_rho: 2700.0,
    sleeve_cp: 900.0,

    // Convective coefficients for the natural-convection regimes (W/m²·K)
    h_air: 12.0, // natural convection in air (a small radiation term is added)
    h_stillwater: 500.0, // natural convection in still seawater
    emissivity: 0.3, // for the radiation term in air only

    // Seawater properties (~20°C) used for the forced-convection correlation
    water_rho: 1025.0, // kg/m³
    water_mu: 1.07e-3, // Pa·s
    water_k: 0.6, // W/m·K
    water_cp: 3990.0, // J/kg·K

    // Flow — the UI works in l/min; velocity is derived from flow rate and the
    // pipe bore for the convection correlation. (30 l/min ≈ a healthy F4B pump.)
    pipe_dia_mm: 19.0, // raw-water hose / pipe bore
    flow_lpm: 30.0, // volumetric flow rate, litres per minute
    velocity: 1.76, // m/s   derived = flow_lpm / pipe area; kept in sync by app.js

    // Flow-step response: how fast the NTC reacts to a change in flow rate (heater
    // stays on / self-regulating, so the response is the head re-equilibrating).
    step_from_lpm: 30.0, // flow rate before the step
    step_to_lpm: 5.0, // flow rate after the step
    step_ramp_time: 5.0, // s   duration of the flow change (0 = instantaneous step)
    step_time: 30.0, // s   horizon for the flow-step graph

    // Transient turn-on: a 3W aluminium block (20×5×40mm) replaces the fixed PTC
    heater_power: 3.0, // W
    al_block_mm: [20, 5, 40],
    al_rho: 2700.0,
    al_cp: 900.0,

    // NTC bead, signal-conditioning divider and ESP32 ADC — used to assess the
    // real flow-rate accuracy (the temperature swing across the flow range is
    // small, and the ADC is not very repeatable).
    ntc_r25: 10.0, // kΩ   NTC resistance at 25°C
    ntc_beta: 3950.0, // K    NTC Beta coefficient
    div_vsupply: 3.3, // V    divider / ADC reference supply
    div_rseries: 12.0, // kΩ   series resistor (NTC high-side, Rs to GND)
    adc_preset: 'esp32', // selects an ADC preset (see ADC_PRESETS)
    adc_bits: 12, // ADC resolution
    adc_fsr: 3.3, // V   ADC full-scale range (sets the LSB; for ESP32 ≈ supply,
    //      for the ADS1115 it is the PGA range, independent of the divider supply)
    adc_noise_mv: 20.0, // mV   raw per-sample RMS noise (ESP32 ADC repeatability)
    adc_averages: 16, // samples averaged per reading (noise ÷ √N)
    adc_inl_mv: 5.0, // mV   INL/offset error floor — does NOT reduce with averaging

    // Numerics
    n_nodes: 60, // finite-difference nodes along the PTC->face axis
    sim_time: 180.0, // s   transient simulation duration
  };

  const SIGMA = 5.670374419e-8; // Stefan–Boltzmann constant, W/m²·K⁴

  // Probe material presets. Values are representative; both are grade-dependent
  // and the conductivity slider lets you fine-tune. Phosphor bronze conducts
  // ~5× better than 316 stainless, so far more heat reaches the head.
  // ADC presets. The ESP32 internal ADC is 12-bit, noisy (~tens of mV) and has a
  // large INL even after eFuse calibration. The ADS1115 is a 16-bit delta-sigma
  // ADC with a PGA: ~µV-class noise and ~1 LSB INL, so the ADC essentially stops
  // being the limit. (ADS1115 single-ended uses the +half of the range; fsr is the
  // PGA full scale, here ±4.096 V to cover a 3.3 V divider.)
  const ADC_PRESETS = {
    esp32: { name: 'ESP32 12-bit', bits: 12, fsr: 3.3, noise_mv: 20, inl_mv: 5, averages: 16 },
    ads1115: { name: 'ADS1115 16-bit', bits: 16, fsr: 4.096, noise_mv: 0.05, inl_mv: 0.25, averages: 8 },
  };

  const MATERIALS = {
    '316ss': { name: '316 stainless', short: '316 SS', k: 15.0, rho: 8000.0, cp: 500.0 },
    phosphor_bronze: {
      name: 'Phosphor bronze',
      short: 'Ph. bronze',
      k: 75.0, // W/m·K (grade-dependent, ~50–80)
      rho: 8860.0,
      cp: 380.0,
    },
  };

  // ----------------------------------------------------------------------------
  // Geometry helpers
  // ----------------------------------------------------------------------------
  function shaftArea(p) {
    // Annular cross-section of the stainless tube (m²)
    const od = p.shaft_od_mm / 1000,
      id = p.shaft_id_mm / 1000;
    return (Math.PI / 4) * (od * od - id * id);
  }

  function headArea(p) {
    // Solid cross-section of the head (m²)
    const d = p.head_dia_mm / 1000;
    return (Math.PI / 4) * d * d;
  }

  function sleeveArea(p) {
    // Annular cross-section of the aluminium sleeve (ID = shaft OD) (m²)
    const od = p.sleeve_od_mm / 1000,
      id = p.shaft_od_mm / 1000;
    return (Math.PI / 4) * Math.max(0, od * od - id * id);
  }

  // Axial conduction resistance of the shaft (K/W), accounting for the optional
  // aluminium sleeve. Two series sections: the stainless-only seal gap next to
  // the head, then the sleeved section where stainless + aluminium conduct in
  // parallel (k·A values add).
  function shaftCondResistance(p) {
    const L = p.shaft_len_mm / 1000;
    const kA_ss = p.k_ss * shaftArea(p);
    if (!p.sleeve_enabled || sleeveArea(p) <= 0) return L / kA_ss;
    const gap = Math.min(p.sleeve_gap_mm / 1000, L);
    const sleeved = L - gap;
    const kA_comp = kA_ss + p.sleeve_k * sleeveArea(p);
    return gap / kA_ss + sleeved / kA_comp;
  }

  function headWettedArea(p) {
    // Convective surface of the head (m²): the whole head is in the flow, so
    //   - cylindrical side wall   π·d·t   (faces the crossflow)
    //   - front end face          π/4·d²
    //   - back shoulder ring      π/4·(d² − d_shaft²)  (annulus around the shaft)
    const d = p.head_dia_mm / 1000,
      t = p.head_thick_mm / 1000,
      ds = p.shaft_od_mm / 1000;
    return Math.PI * d * t + (Math.PI / 4) * d * d + (Math.PI / 4) * (d * d - ds * ds);
  }

  // ----------------------------------------------------------------------------
  // Flow-rate <-> velocity conversion through the pipe bore.
  //   Q[m³/s] = v · A_pipe ;  1 m³/s = 60000 l/min
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
  // Convection coefficient
  // ----------------------------------------------------------------------------

  /*
   * Forced-convection coefficient for the head treated as a short cylinder in
   * crossflow, using the Churchill–Bernstein correlation. Returns h in W/m²·K.
   * The characteristic length is the head diameter.
   */
  function forcedConvection(velocity, p) {
    const D = p.head_dia_mm / 1000;
    if (velocity <= 0) return 0;
    const Pr = (p.water_mu * p.water_cp) / p.water_k;
    const Re = (p.water_rho * velocity * D) / p.water_mu;
    const num = 0.62 * Math.sqrt(Re) * Math.cbrt(Pr);
    const den = Math.pow(1 + Math.pow(0.4 / Pr, 2 / 3), 0.25);
    const tail = Math.pow(1 + Math.pow(Re / 282000, 5 / 8), 4 / 5);
    const Nu = 0.3 + (num / den) * tail;
    return (Nu * p.water_k) / D;
  }

  /*
   * Effective convection coefficient for flowing water: the larger of the
   * natural-convection floor (still water) and the forced-convection value, so
   * the curve smoothly transitions from the still-water level at v->0 up into
   * the forced regime. Combined as (h_nat^3 + h_forced^3)^(1/3) which is the
   * usual mixed-convection blend and avoids a kink at the crossover.
   */
  function flowConvection(velocity, p) {
    const hf = forcedConvection(velocity, p);
    const hn = p.h_stillwater;
    return Math.cbrt(hn * hn * hn + hf * hf * hf);
  }

  /*
   * Convection coefficient for a named scenario. For air we add a linearised
   * radiation coefficient h_rad = εσ(Ts²+Tinf²)(Ts+Tinf), evaluated at the
   * lumped head temperature estimate.
   */
  function sceneConvection(scenario, p, headTempC) {
    switch (scenario) {
      case 'air': {
        let h = p.h_air;
        const Ts = (headTempC != null ? headTempC : p.T_ptc) + 273.15;
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
  // Lumped (analytic) steady-state model — the ESP32-friendly closed form.
  //
  //   R_cond = L / (k·A_shaft)         conduction down the shaft
  //   R_conv = 1 / (h·A_head)          convection from head into fluid
  //   Q      = (T_ptc - T_fluid) / (R_cond + R_conv)
  //   T_head = T_fluid + Q·R_conv
  //
  // The head is treated as isothermal (its internal conduction resistance is
  // negligible next to R_cond), so T_NTC ≈ T_head.
  // ----------------------------------------------------------------------------
  function lumpedSteadyState(p, scenario) {
    const R_cond = shaftCondResistance(p);

    // Iterate a couple of times because the air radiation term depends on T_head.
    let T_head = p.T_ptc;
    let h, R_conv, Q;
    for (let it = 0; it < 6; it++) {
      h = sceneConvection(scenario, p, T_head);
      R_conv = 1 / (h * headWettedArea(p));
      Q = (p.T_ptc - p.T_fluid) / (R_cond + R_conv);
      T_head = p.T_fluid + Q * R_conv;
    }
    return { Q, T_head, T_ntc: T_head, R_cond, R_conv, h };
  }

  // ----------------------------------------------------------------------------
  // 1-D finite-volume nodal model.
  //
  // The PTC->face axis is discretised into n uniform cells. Each cell carries a
  // cross-sectional area (head area or shaft area) and a convective surface area
  // (head cells only; shaft cells are PTFE-insulated). Node 0 is the wetted end
  // face; the last node is the PTC (fixed T in steady mode) or the aluminium
  // heater block (finite capacity + power, in turn-on mode).
  // ----------------------------------------------------------------------------
  function buildNodes(p) {
    const Lhead = p.head_thick_mm / 1000;
    const Lshaft = p.shaft_len_mm / 1000;
    const Ltot = Lhead + Lshaft;
    const n = Math.max(8, Math.round(p.n_nodes));
    const dx = Ltot / n;
    const Ahead = headArea(p),
      Ashaft = shaftArea(p);
    const Dhead = p.head_dia_mm / 1000;
    const backRing = (Math.PI / 4) * (Dhead * Dhead - (p.shaft_od_mm / 1000) ** 2);
    // Aluminium sleeve covers the shaft from the PTC end down to the seal gap.
    const Asleeve = sleeveArea(p);
    const sleeveOn = p.sleeve_enabled && Asleeve > 0;
    const xSleeveStart = Lhead + p.sleeve_gap_mm / 1000; // sleeve present for x >= this

    const nodes = [];
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * dx; // distance from wetted face
      const inHead = x < Lhead;
      const nextShaft = (i + 1.5) * dx >= Lhead; // next cell is in the shaft
      const A = inHead ? Ahead : Ashaft;
      // Convective surface: head side wall on every head cell; the front end
      // face on cell 0; the back shoulder ring on the last head cell.
      let S = inHead ? Math.PI * Dhead * dx : 0;
      if (i === 0) S += (Math.PI / 4) * Dhead * Dhead; // wetted end face
      if (inHead && nextShaft) S += backRing; // back shoulder around the shaft
      // Conduction k·A and heat capacity, summing the sleeve where present.
      let kA = p.k_ss * A;
      let C = p.rho_ss * p.cp_ss * A * dx;
      const sleeved = sleeveOn && !inHead && x >= xSleeveStart;
      if (sleeved) {
        kA += p.sleeve_k * Asleeve;
        C += p.sleeve_rho * p.sleeve_cp * Asleeve * dx;
      }
      nodes.push({ x, inHead, sleeved, A, kA, S, C, dx });
    }
    return { nodes, dx, n, Ltot, Lhead };
  }

  // Conductance between adjacent cells i and i+1 (series of two half-cells),
  // using each cell's effective k·A (which includes the sleeve where present).
  function conductance(a, b) {
    return 1 / (a.dx / (2 * a.kA) + b.dx / (2 * b.kA));
  }

  // Thomas algorithm for a tridiagonal system (a sub, b diag, c super, d rhs).
  function solveTridiagonal(a, b, c, d) {
    const n = b.length;
    const cp = new Array(n),
      dp = new Array(n),
      x = new Array(n);
    cp[0] = c[0] / b[0];
    dp[0] = d[0] / b[0];
    for (let i = 1; i < n; i++) {
      const m = b[i] - a[i] * cp[i - 1];
      cp[i] = c[i] / m;
      dp[i] = (d[i] - a[i] * dp[i - 1]) / m;
    }
    x[n - 1] = dp[n - 1];
    for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1];
    return x;
  }

  /*
   * Steady-state nodal solve. Returns the temperature profile (node x in mm and
   * T in °C) plus the interpolated NTC reading and the head/flux summary.
   */
  function nodalSteadyState(p, scenario) {
    const { nodes, n } = buildNodes(p);
    // Use the lumped head temperature to seed the air radiation coefficient.
    const seed = lumpedSteadyState(p, scenario).T_head;
    const h = sceneConvection(scenario, p, seed);

    const G = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) G[i] = conductance(nodes[i], nodes[i + 1]);

    const a = new Array(n).fill(0),
      b = new Array(n).fill(0),
      c = new Array(n).fill(0),
      d = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      if (i === n - 1) {
        // PTC fixed-temperature boundary
        b[i] = 1;
        d[i] = p.T_ptc;
        continue;
      }
      const hS = h * nodes[i].S;
      let diag = -hS;
      d[i] = -hS * p.T_fluid;
      if (i > 0) {
        a[i] = G[i - 1];
        diag -= G[i - 1];
      }
      c[i] = G[i];
      diag -= G[i];
      b[i] = diag;
    }

    const T = solveTridiagonal(a, b, c, d);
    return packProfile(p, nodes, T, h);
  }

  /*
   * Transient solve. Modes:
   *   boundary='fixed'    -> far end held at T_ptc, probe starts at T_fluid.
   *   boundary='heater'   -> far end is a finite-capacity aluminium block fed by
   *                          heater_power; block + probe start at T_fluid (true
   *                          cold-start turn-ON, self-regulating to T_ptc).
   *   boundary='cooldown' -> start from the hot steady state, then switch the
   *                          heater OFF: the block (starting at T_ptc, no power)
   *                          and probe decay toward T_fluid. The decay rate is
   *                          set purely by convection + thermal mass, so its
   *                          shape is a clean discriminator.
   * Returns {time:[s], T_ntc:[°C], T_head:[°C], steady} sampled at ~200 points.
   */
  function nodalTransient(p, scenario, boundary) {
    const { nodes, n } = buildNodes(p);
    const seed = lumpedSteadyState(p, scenario).T_head;
    const h = sceneConvection(scenario, p, seed);

    const G = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) G[i] = conductance(nodes[i], nodes[i + 1]);

    // Aluminium block as an extra lumped node coupled to the last shaft cell.
    const useBlock = boundary === 'heater' || boundary === 'cooldown';
    const vol = (p.al_block_mm[0] * p.al_block_mm[1] * p.al_block_mm[2]) / 1e9; // m³
    const C_al = p.al_rho * p.al_cp * vol;
    // Coupling conductance block<->last cell, through the shaft cross-section.
    const G_couple = nodes[n - 1].kA / (nodes[n - 1].dx / 2);

    // Stable explicit timestep (CFL-like): dt < min(C / (sum conductances + hS)).
    let dtMax = Infinity;
    for (let i = 0; i < n; i++) {
      let cond = h * nodes[i].S;
      if (i > 0) cond += G[i - 1];
      if (i < n - 1) cond += G[i];
      else cond += G_couple;
      dtMax = Math.min(dtMax, nodes[i].C / cond);
    }
    if (useBlock) dtMax = Math.min(dtMax, C_al / G_couple);
    const dt = 0.4 * dtMax;
    const steps = Math.ceil(p.sim_time / dt);
    const sampleEvery = Math.max(1, Math.floor(steps / 200));

    // Initial conditions.
    const T = new Array(n).fill(p.T_fluid);
    let T_al = p.T_fluid;
    if (boundary === 'cooldown') {
      const steady = nodalSteadyState(p, scenario);
      for (let i = 0; i < n; i++) T[i] = steady.profile[i].T;
      T_al = p.T_ptc; // block was being held hot, now switched off
    } else if (boundary === 'fixed') {
      T[n - 1] = p.T_ptc; // fixed hot boundary
    }

    const out = { time: [], T_ntc: [], T_head: [] };
    const Tn = new Array(n);
    for (let s = 0; s <= steps; s++) {
      if (s % sampleEvery === 0) {
        out.time.push(s * dt);
        out.T_ntc.push(interpAt(nodes, T, p.ntc_from_face_mm / 1000));
        out.T_head.push(T[0]);
      }
      // advance one explicit Euler step
      for (let i = 0; i < n; i++) {
        if (i === n - 1 && !useBlock) {
          Tn[i] = p.T_ptc; // 'fixed' mode: held fixed
          continue;
        }
        let flux = h * nodes[i].S * (p.T_fluid - T[i]);
        if (i > 0) flux += G[i - 1] * (T[i - 1] - T[i]);
        if (i < n - 1) flux += G[i] * (T[i + 1] - T[i]);
        else flux += G_couple * (T_al - T[i]); // couple last cell to the block
        Tn[i] = T[i] + (dt * flux) / nodes[i].C;
      }
      if (useBlock) {
        // Heater power: drive to T_ptc on turn-on (self-regulating clamp); zero
        // on cooldown (heater off, block free to cool).
        const power = boundary === 'heater' && T_al < p.T_ptc ? p.heater_power : 0;
        const fluxAl = power + G_couple * (T[n - 1] - T_al);
        T_al = T_al + (dt * fluxAl) / C_al;
        if (boundary === 'heater') T_al = Math.min(p.T_ptc, T_al);
      }
      for (let i = 0; i < n; i++) T[i] = Tn[i];
    }
    out.steady = out.T_ntc[out.T_ntc.length - 1];
    return out;
  }

  /*
   * Flow-step response. The probe starts at the steady state for `fromLpm`, then
   * the flow changes to `toLpm` over `step_ramp_time` seconds (0 = instantaneous
   * step). The convection coefficient is recomputed continuously as the flow
   * ramps. The PTC is self-regulating, so the shaft's far end is held at T_ptc
   * (the heater keeps the block at 80°C); only the head/shaft re-equilibrate.
   * This is the dynamic reaction time that matters for the alarm. Returns the NTC
   * time series plus before/after steady readings and the 63% / 90% response times.
   */
  function flowStepResponse(p, fromLpm, toLpm) {
    const pFrom = Object.assign({}, p, { velocity: lpmToVelocity(fromLpm, p) });
    const pTo = Object.assign({}, p, { velocity: lpmToVelocity(toLpm, p) });
    const { nodes, n } = buildNodes(p);

    const steadyFrom = nodalSteadyState(pFrom, 'flowing');
    const steadyTo = nodalSteadyState(pTo, 'flowing');
    const T = steadyFrom.profile.map((pt) => pt.T); // initial condition
    const ramp = Math.max(0, p.step_ramp_time || 0);

    // Instantaneous convection coefficient for a given flow (l/min).
    const hAt = (lpm) => flowConvection(lpmToVelocity(lpm, p), p);

    const G = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) G[i] = conductance(nodes[i], nodes[i + 1]);

    // Stable explicit timestep using the largest h seen during the ramp.
    const hMax = Math.max(hAt(fromLpm), hAt(toLpm));
    let dtMax = Infinity;
    for (let i = 0; i < n - 1; i++) {
      let cond = hMax * nodes[i].S + G[i];
      if (i > 0) cond += G[i - 1];
      dtMax = Math.min(dtMax, nodes[i].C / cond);
    }
    const dt = 0.4 * dtMax;
    const steps = Math.ceil(p.step_time / dt);
    const sampleEvery = Math.max(1, Math.floor(steps / 200));

    const fromNtc = interpAt(nodes, T, p.ntc_from_face_mm / 1000);
    const out = { time: [], T_ntc: [], fromNtc, toNtc: steadyTo.T_ntc, ramp };
    const Tn = new Array(n);
    for (let s = 0; s <= steps; s++) {
      const t = s * dt;
      if (s % sampleEvery === 0) {
        out.time.push(t);
        out.T_ntc.push(interpAt(nodes, T, p.ntc_from_face_mm / 1000));
      }
      // Flow (and hence h) ramps linearly from `from` to `to` over `ramp` seconds.
      const frac = ramp <= 0 ? 1 : Math.min(1, t / ramp);
      const h = hAt(fromLpm + (toLpm - fromLpm) * frac);
      for (let i = 0; i < n; i++) {
        if (i === n - 1) {
          Tn[i] = p.T_ptc; // self-regulating PTC holds the far end at 80°C
          continue;
        }
        let flux = h * nodes[i].S * (p.T_fluid - T[i]);
        if (i > 0) flux += G[i - 1] * (T[i - 1] - T[i]);
        flux += G[i] * (T[i + 1] - T[i]);
        Tn[i] = T[i] + (dt * flux) / nodes[i].C;
      }
      for (let i = 0; i < n; i++) T[i] = Tn[i];
    }

    // 63% / 90% response times (signed change handles either direction).
    const change = out.toNtc - out.fromNtc;
    const respTime = (frac) => {
      const target = out.fromNtc + frac * change;
      for (let i = 0; i < out.T_ntc.length; i++) {
        const v = out.T_ntc[i];
        if ((change >= 0 && v >= target) || (change < 0 && v <= target)) return out.time[i];
      }
      return null;
    };
    out.t63 = respTime(0.632);
    out.t90 = respTime(0.9);
    return out;
  }

  // Index of the node nearest the NTC depth (used as a fallback).
  function ntcNodeIndex(p, nodes) {
    const xntc = p.ntc_from_face_mm / 1000;
    let best = 0,
      bd = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = Math.abs(nodes[i].x - xntc);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // Linear interpolation of the nodal field at an arbitrary x (m from face).
  function interpAt(nodes, T, x) {
    if (x <= nodes[0].x) return T[0];
    const last = nodes.length - 1;
    if (x >= nodes[last].x) return T[last];
    for (let i = 0; i < last; i++) {
      if (x >= nodes[i].x && x <= nodes[i + 1].x) {
        const f = (x - nodes[i].x) / (nodes[i + 1].x - nodes[i].x);
        return T[i] + f * (T[i + 1] - T[i]);
      }
    }
    return T[last];
  }

  function packProfile(p, nodes, T, h) {
    const profile = nodes.map((nd, i) => ({ x_mm: nd.x * 1000, T: T[i] }));
    const T_ntc = interpAt(nodes, T, p.ntc_from_face_mm / 1000);
    // Heat flux entering the fluid = sum over head cells of h·S·(T-Tf).
    let Q = 0;
    for (let i = 0; i < nodes.length; i++) Q += h * nodes[i].S * (T[i] - p.T_fluid);
    return { profile, T_ntc, T_head: T[0], T_base: T[nodes.length - 1], Q, h };
  }

  // ----------------------------------------------------------------------------
  // Detection model — what an ESP32 would use.
  // ----------------------------------------------------------------------------

  /*
   * Builds the NTC-temperature-vs-velocity calibration curve and the regime
   * thresholds. Uses the lumped model (fast, deterministic, matches the closed
   * form the firmware would run). Returns:
   *   air, still           : steady NTC readings (°C)
   *   thr_air_water        : midpoint threshold separating air from water
   *   thr_flow             : NTC just below the still-water reading = "flow seen"
   *   curve                : [{v, T_ntc, h}] velocity sweep
   *   velocityFromTemp(T)   : inverse lookup (°C -> m/s) by interpolation
   */
  function deriveDetectionModel(p) {
    const air = lumpedSteadyState(p, 'air').T_ntc;
    const still = lumpedSteadyState(p, 'stillwater').T_ntc;

    const curve = [];
    const vmax = 3.0;
    for (let i = 0; i <= 60; i++) {
      const v = (i / 60) * vmax;
      const pv = Object.assign({}, p, { velocity: v });
      const r = lumpedSteadyState(pv, 'flowing');
      // theta = dimensionless cooling ratio (T_ntc-T_fluid)/(T_ptc-T_fluid).
      // It depends only on flow (not on fluid temperature), so it is the natural
      // temperature-compensated variable for the flow lookup.
      const theta = (r.T_ntc - p.T_fluid) / Math.max(1e-6, p.T_ptc - p.T_fluid);
      curve.push({ v, lpm: velocityToLpm(v, p), T_ntc: r.T_ntc, h: r.h, theta });
    }

    const thr_air_water = (air + still) / 2;
    // "Flow detected" when the reading falls a margin below the still-water level.
    const fluidT = p.T_fluid;
    const thr_flow = still - 0.15 * (still - fluidT);

    function velocityFromTemp(T) {
      // curve is monotonically decreasing in T as v increases
      for (let i = 0; i < curve.length - 1; i++) {
        const a = curve[i],
          b = curve[i + 1];
        if ((T <= a.T_ntc && T >= b.T_ntc) || (T >= a.T_ntc && T <= b.T_ntc)) {
          const f = (T - a.T_ntc) / (b.T_ntc - a.T_ntc || 1e-9);
          return a.v + f * (b.v - a.v);
        }
      }
      return T > curve[0].T_ntc ? 0 : vmax;
    }
    const lpmFromTemp = (T) => velocityToLpm(velocityFromTemp(T), p);

    // NTC reading at a reference "good" flow, for the thresholds table.
    const goodFlowLpm = 30;
    const tempAtGoodFlow = lumpedSteadyState(
      Object.assign({}, p, { velocity: lpmToVelocity(goodFlowLpm, p) }),
      'flowing'
    ).T_ntc;

    return {
      air,
      still,
      thr_air_water,
      thr_flow,
      curve,
      velocityFromTemp,
      lpmFromTemp,
      goodFlowLpm,
      tempAtGoodFlow,
    };
  }

  /*
   * Temperature compensation for the firmware. The thresholds move linearly with
   * the (measured) water temperature, so we fit slope/offset by evaluating the
   * detection model at two fluid temperatures. We also return a theta-based flow
   * lookup: theta = (T_ntc - T_water)/(T_ptc - T_water) is fluid-temperature
   * independent, so a single theta->flow table works at any water temperature.
   */
  function deriveTempCompensation(p, t1 = 5, t2 = 30) {
    const d1 = deriveDetectionModel(Object.assign({}, p, { T_fluid: t1 }));
    const d2 = deriveDetectionModel(Object.assign({}, p, { T_fluid: t2 }));
    const fit = (y1, y2) => {
      const slope = (y2 - y1) / (t2 - t1);
      return { slope, offset: y1 - slope * t1 };
    };
    const aw = fit(d1.thr_air_water, d2.thr_air_water);
    const fl = fit(d1.thr_flow, d2.thr_flow);
    // theta->flow table (monotonic in theta), from the current calibration curve.
    const thetaCurve = deriveDetectionModel(p).curve.map((c) => ({ theta: c.theta, lpm: c.lpm }));
    return {
      aw_slope: aw.slope,
      aw_offset: aw.offset,
      fl_slope: fl.slope,
      fl_offset: fl.offset,
      thetaCurve,
    };
  }

  // ----------------------------------------------------------------------------
  // Measurement chain: NTC -> divider -> ADC -> flow accuracy
  // ----------------------------------------------------------------------------

  // NTC resistance (ohms) at a temperature, Beta model referenced to 25°C.
  function ntcResistance(p, tempC) {
    const T = tempC + 273.15,
      T0 = 298.15;
    return p.ntc_r25 * 1000 * Math.exp(p.ntc_beta * (1 / T - 1 / T0));
  }

  // Divider output voltage seen by the ADC. NTC on the high side (to Vsupply),
  // series resistor to ground, so hotter (lower R) -> higher voltage.
  function dividerVoltage(p, rntc) {
    const rs = p.div_rseries * 1000;
    return (p.div_vsupply * rs) / (rs + rntc);
  }

  // Effective RMS measurement uncertainty at the ADC input (volts). Combines, in
  // quadrature: (1) random repeatability noise reduced by averaging (÷√N), (2)
  // quantisation, and (3) an INL/offset floor that does NOT average down — so the
  // total asymptotes to that floor however much you oversample.
  function adcSigmaVolts(p) {
    const random = p.adc_noise_mv / 1000 / Math.sqrt(Math.max(1, p.adc_averages));
    const lsb = (p.adc_fsr || p.div_vsupply) / Math.pow(2, p.adc_bits);
    const quant = lsb / Math.sqrt(12);
    const floor = (p.adc_inl_mv || 0) / 1000;
    return Math.sqrt(random * random + quant * quant + floor * floor);
  }

  /*
   * Flow-rate accuracy. Sweeps flow 0..hiLpm and at each point computes the NTC
   * temperature, resistance, divider voltage, the local sensitivity dV/dflow, and
   * the resulting 1σ flow uncertainty σ_lpm = σ_V / |dV/dflow|. Because the
   * calibration flattens at high flow, σ_lpm grows — this quantifies how usable
   * the flow reading is across the range for a given probe + ADC.
   */
  function flowAccuracy(p, hiLpm = 40) {
    const sigmaV = adcSigmaVolts(p);
    const N = 80,
      d = 0.5; // l/min step for the numerical derivative
    const tAtFlow = (lpm) =>
      lumpedSteadyState(Object.assign({}, p, { velocity: lpmToVelocity(lpm, p) }), 'flowing').T_ntc;
    const vAtFlow = (lpm) => dividerVoltage(p, ntcResistance(p, tAtFlow(lpm)));

    const curve = [];
    for (let i = 0; i <= N; i++) {
      const lpm = (hiLpm * i) / N;
      const T = tAtFlow(lpm);
      const V = vAtFlow(lpm);
      const dVdlpm = (vAtFlow(lpm + d) - V) / d;
      const sigma_lpm = Math.abs(dVdlpm) > 1e-12 ? sigmaV / Math.abs(dVdlpm) : Infinity;
      curve.push({
        lpm,
        T_ntc: T,
        R: ntcResistance(p, T),
        V,
        mV: V * 1000,
        sigma_lpm,
      });
    }
    return { curve, sigmaV, sigma_mV: sigmaV * 1000 };
  }

  // ----------------------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------------------
  global.SensorModel = {
    DEFAULTS,
    MATERIALS,
    ADC_PRESETS,
    cloneDefaults: () => JSON.parse(JSON.stringify(DEFAULTS)),
    shaftArea,
    headArea,
    headWettedArea,
    sleeveArea,
    shaftCondResistance,
    pipeArea,
    lpmToVelocity,
    velocityToLpm,
    forcedConvection,
    flowConvection,
    sceneConvection,
    lumpedSteadyState,
    nodalSteadyState,
    nodalTransient,
    flowStepResponse,
    deriveDetectionModel,
    deriveTempCompensation,
    ntcResistance,
    dividerVoltage,
    adcSigmaVolts,
    flowAccuracy,
  };
})(typeof window !== 'undefined' ? window : globalThis);
