/*
 * app.js — wires the controls to the model and renders the diagram, charts and
 * detection panel. Recomputes everything whenever a parameter changes.
 */

(function () {
  'use strict';

  const M = window.SensorModel;
  let params = M.cloneDefaults();
  let scenario = 'air';

  const SCENE_COLOR = { air: '#e15554', stillwater: '#2d7dd2', flowing: '#3bb273' };
  const SCENE_LABEL = { air: 'Air', stillwater: 'Still water', flowing: 'Flowing water' };

  // ---- charts ----
  const charts = {
    profile: new LineChart(document.getElementById('chartProfile'), {
      xLabel: 'distance from wetted face (mm)',
      yLabel: 'temperature (°C)',
    }),
    flow: new LineChart(document.getElementById('chartFlow'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'NTC temperature (°C)',
      xMin: 0,
    }),
    transient: new LineChart(document.getElementById('chartTransient'), {
      xLabel: 'time (s)',
      yLabel: 'NTC temperature (°C)',
      xMin: 0,
    }),
    cooldown: new LineChart(document.getElementById('chartCooldown'), {
      xLabel: 'time (s)',
      yLabel: 'NTC temperature (°C)',
      xMin: 0,
    }),
    step: new LineChart(document.getElementById('chartStep'), {
      xLabel: 'time after flow step (s)',
      yLabel: 'NTC temperature (°C)',
      xMin: 0,
    }),
    flux: new LineChart(document.getElementById('chartFlux'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'heat removed Q (W)',
      xMin: 0,
    }),
    tempsweep: new LineChart(document.getElementById('chartTempSweep'), {
      xLabel: 'starting water temperature (°C)',
      yLabel: 'NTC temperature (°C)',
      xMin: 5,
      xMax: 30,
    }),
    signal: new LineChart(document.getElementById('chartSignal'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'ADC voltage (mV)',
      xMin: 0,
      xMax: 40,
    }),
    resolution: new LineChart(document.getElementById('chartResolution'), {
      xLabel: 'flow rate (l/min)',
      yLabel: '±1σ flow uncertainty (l/min)',
      xMin: 0,
      xMax: 40,
      yMin: 0, // yMax auto-scales so it works for both noisy and precise ADCs
    }),
  };

  // ---- build slider/number controls from the markup ----
  function buildControls() {
    document.querySelectorAll('.ctrl').forEach((el) => {
      const key = el.dataset.key;
      const min = +el.dataset.min,
        max = +el.dataset.max,
        step = +el.dataset.step;
      const unit = el.dataset.unit || '';
      const val = params[key];

      el.innerHTML = `
        <span class="lbl">${el.dataset.label}</span>
        <span class="valbox"><input type="number" min="${min}" max="${max}" step="${step}" value="${val}"><span>${unit}</span></span>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${val}">`;

      const num = el.querySelector('input[type=number]');
      const rng = el.querySelector('input[type=range]');
      const apply = (v) => {
        v = Math.min(max, Math.max(min, +v));
        params[key] = v;
        num.value = v;
        rng.value = v;
        recompute();
      };
      num.addEventListener('input', () => apply(num.value));
      rng.addEventListener('input', () => apply(rng.value));
    });
  }

  // ---- scenario buttons ----
  document.getElementById('scenarios').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    scenario = btn.dataset.scene;
    document
      .querySelectorAll('#scenarios button')
      .forEach((b) => b.classList.toggle('active', b === btn));
    recompute();
  });

  // ---- material buttons ----
  function buildMaterials() {
    const host = document.getElementById('materials');
    host.innerHTML = Object.entries(M.MATERIALS)
      .map(
        ([key, m]) =>
          `<button data-mat="${key}"${key === params.material ? ' class="active"' : ''}>${m.name}</button>`
      )
      .join('');
  }
  function applyMaterial(key) {
    const m = M.MATERIALS[key];
    if (!m) return;
    params.material = key;
    params.k_ss = m.k;
    params.rho_ss = m.rho;
    params.cp_ss = m.cp;
    // reflect the new conductivity in its slider
    const kctrl = document.querySelector('.ctrl[data-key="k_ss"]');
    if (kctrl) {
      kctrl.querySelector('input[type=number]').value = m.k;
      kctrl.querySelector('input[type=range]').value = m.k;
    }
    document
      .querySelectorAll('#materials button')
      .forEach((b) => b.classList.toggle('active', b.dataset.mat === key));
    recompute();
  }
  document.getElementById('materials').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) applyMaterial(btn.dataset.mat);
  });

  // ---- construction toggle (bare shaft vs aluminium sleeve) ----
  function syncConstruction() {
    const key = params.sleeve_enabled ? 'sleeve' : 'bare';
    document
      .querySelectorAll('#construction button')
      .forEach((b) => b.classList.toggle('active', b.dataset.constr === key));
  }
  document.getElementById('construction').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    params.sleeve_enabled = btn.dataset.constr === 'sleeve';
    syncConstruction();
    recompute();
  });

  // ---- ADC preset buttons (ESP32 internal vs ADS1115 etc.) ----
  function setCtrlValue(key, val) {
    const el = document.querySelector(`.ctrl[data-key="${key}"]`);
    if (!el) return;
    const num = el.querySelector('input[type=number]');
    const rng = el.querySelector('input[type=range]');
    if (num) num.value = val;
    if (rng) rng.value = val;
  }
  function buildAdcPresets() {
    document.getElementById('adcpresets').innerHTML = Object.entries(M.ADC_PRESETS)
      .map(
        ([key, a]) =>
          `<button data-adc="${key}"${key === params.adc_preset ? ' class="active"' : ''}>${a.name}</button>`
      )
      .join('');
  }
  function applyAdcPreset(key) {
    const a = M.ADC_PRESETS[key];
    if (!a) return;
    params.adc_preset = key;
    params.adc_bits = a.bits;
    params.adc_fsr = a.fsr;
    params.adc_noise_mv = a.noise_mv;
    params.adc_inl_mv = a.inl_mv;
    params.adc_averages = a.averages;
    ['adc_fsr', 'adc_noise_mv', 'adc_inl_mv', 'adc_averages'].forEach((k) => setCtrlValue(k, params[k]));
    document
      .querySelectorAll('#adcpresets button')
      .forEach((b) => b.classList.toggle('active', b.dataset.adc === key));
    recompute();
  }
  document.getElementById('adcpresets').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) applyAdcPreset(btn.dataset.adc);
  });

  document.getElementById('reset').addEventListener('click', () => {
    params = M.cloneDefaults();
    buildControls();
    buildMaterials();
    buildAdcPresets();
    syncConstruction();
    recompute();
  });

  // ---- the main recompute / render ----
  let lastResult = null; // kept for cheap redraws (e.g. on window resize)

  function recompute() {
    // Keep the velocity used by the convection correlation in sync with the
    // user-facing flow rate (l/min) and the pipe bore.
    params.velocity = M.lpmToVelocity(params.flow_lpm, params);

    // Steady state for the active scenario: nodal field + lumped resistances.
    const nodal = M.nodalSteadyState(params, scenario);
    const lumped = M.lumpedSteadyState(params, scenario);
    const result = Object.assign({}, nodal, {
      R_cond: lumped.R_cond,
      R_conv: lumped.R_conv,
    });
    lastResult = result;

    SensorDiagram.drawDiagram(document.getElementById('diagram'), params, result, scenario);
    renderReadout(result, lumped);
    renderProfile(nodal, lumped);
    renderFlow();
    renderTransient();
    renderCooldown();
    renderStep();
    renderFlux();
    renderTempSweep();
    renderAccuracy();
    renderDetection();
  }

  function renderReadout(result, lumped) {
    const el = document.getElementById('readout');
    const cards = [
      ['NTC reading', `${result.T_ntc.toFixed(1)} °C`],
      ['Head temp', `${result.T_head.toFixed(1)} °C`],
      ['Heat removed', `${result.Q.toFixed(3)} W`],
      ['h (convection)', `${result.h.toFixed(0)} W/m²K`],
    ];
    if (scenario === 'flowing') {
      cards.push(['Flow rate', `${params.flow_lpm.toFixed(0)} l/min`]);
      cards.push(['= velocity', `${params.velocity.toFixed(2)} m/s`]);
    }
    el.innerHTML = cards
      .map((c) => `<div class="r"><div class="k">${c[0]}</div><div class="v">${c[1]}</div></div>`)
      .join('');
  }

  // Steady-state profile: nodal (solid) vs lumped piecewise approximation (dashed).
  function renderProfile(nodal, lumped) {
    const nodalPts = nodal.profile.map((p) => ({ x: p.x_mm, y: p.T }));

    // Lumped: head isothermal at T_head; shaft linear T_head -> T_ptc.
    const headT = params.head_thick_mm;
    const total = params.shaft_len_mm + headT;
    const lumpedPts = [
      { x: 0, y: lumped.T_head },
      { x: headT, y: lumped.T_head },
      { x: total, y: params.T_ptc },
    ];

    const ntcX = params.ntc_from_face_mm;
    charts.profile.opts.xMin = 0;
    charts.profile.opts.xMax = total;
    charts.profile.setData(
      [
        { name: '1-D nodal', color: SCENE_COLOR[scenario], points: nodalPts },
        { name: 'lumped', color: '#9aa6bd', points: lumpedPts, dashed: true },
      ],
      [],
      [{ x: ntcX, y: nodal.T_ntc, label: `NTC ${nodal.T_ntc.toFixed(1)}°C`, color: '#1a6' }]
    );
  }

  function renderFlow() {
    const det = M.deriveDetectionModel(params);
    const pts = det.curve.map((c) => ({ x: c.lpm, y: c.T_ntc }));
    const cur = M.lumpedSteadyState(params, 'flowing').T_ntc;
    charts.flow.opts.xMax = M.velocityToLpm(3, params);
    charts.flow.setData(
      [{ name: 'flowing water', color: SCENE_COLOR.flowing, points: pts }],
      [
        { y: det.air, label: `air ${det.air.toFixed(1)}°C`, color: SCENE_COLOR.air },
        { y: det.still, label: `still water ${det.still.toFixed(1)}°C`, color: SCENE_COLOR.stillwater },
      ],
      [
        {
          x: params.flow_lpm,
          y: cur,
          label: `${params.flow_lpm.toFixed(0)} l/min`,
          color: '#33405a',
        },
      ]
    );
  }

  function renderTransient() {
    const series = ['air', 'stillwater', 'flowing'].map((sc) => {
      const t = M.nodalTransient(params, sc, 'heater');
      return {
        name: SCENE_LABEL[sc],
        color: SCENE_COLOR[sc],
        points: t.time.map((tt, i) => ({ x: tt, y: t.T_ntc[i] })),
      };
    });
    charts.transient.opts.xMax = params.sim_time;
    charts.transient.setData(series);
  }

  function renderCooldown() {
    const series = ['air', 'stillwater', 'flowing'].map((sc) => {
      const t = M.nodalTransient(params, sc, 'cooldown');
      return {
        name: SCENE_LABEL[sc],
        color: SCENE_COLOR[sc],
        points: t.time.map((tt, i) => ({ x: tt, y: t.T_ntc[i] })),
      };
    });
    charts.cooldown.opts.xMax = params.sim_time;
    charts.cooldown.setData(series);
  }

  function renderStep() {
    const r = M.flowStepResponse(params, params.step_from_lpm, params.step_to_lpm);
    const pts = r.time.map((t, i) => ({ x: t, y: r.T_ntc[i] }));
    const change = r.toNtc - r.fromNtc;
    const ramp = params.step_ramp_time;
    const markers = [];
    if (r.t63 != null) markers.push({ x: r.t63, y: r.fromNtc + 0.632 * change, label: '63%', color: '#33405a' });
    if (ramp > 0 && ramp <= params.step_time) {
      // NTC value at the moment the flow finishes ramping
      let yEnd = r.toNtc;
      for (let i = 0; i < r.time.length; i++) if (r.time[i] >= ramp) { yEnd = r.T_ntc[i]; break; }
      markers.push({ x: ramp, y: yEnd, label: 'ramp end', color: '#8a5cd0' });
    }
    charts.step.opts.xMax = params.step_time;
    charts.step.setData(
      [
        {
          name: `${params.step_from_lpm.toFixed(0)} → ${params.step_to_lpm.toFixed(0)} l/min`,
          color: '#f26419',
          points: pts,
        },
      ],
      [
        { y: r.fromNtc, label: `${params.step_from_lpm.toFixed(0)} l/min`, color: '#9aa6bd' },
        { y: r.toNtc, label: `${params.step_to_lpm.toFixed(0)} l/min`, color: '#9aa6bd' },
      ],
      markers
    );

    const fmt = (t) => (t == null ? `> ${params.step_time.toFixed(0)} s` : `${t.toFixed(1)} s`);
    const rampTxt =
      ramp > 0 ? `ramped over ${ramp.toFixed(1)} s` : 'instantaneous step';
    document.getElementById('stepInfo').textContent =
      `${params.step_from_lpm.toFixed(0)} → ${params.step_to_lpm.toFixed(0)} l/min (${rampTxt}): ` +
      `NTC moves ${change >= 0 ? '+' : ''}${change.toFixed(2)} °C ` +
      `(${r.fromNtc.toFixed(1)} → ${r.toNtc.toFixed(1)} °C). ` +
      `Reaction time t63 = ${fmt(r.t63)}, t90 = ${fmt(r.t90)} (measured from t=0). ` +
      `The thermal lag is set by the head's mass; the total reaction is that lag plus the ` +
      `flow ramp itself.`;
  }

  function renderFlux() {
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const v = (i / 60) * 3;
      const r = M.lumpedSteadyState(Object.assign({}, params, { velocity: v }), 'flowing');
      pts.push({ x: M.velocityToLpm(v, params), y: r.Q });
    }
    charts.flux.opts.xMax = M.velocityToLpm(3, params);
    charts.flux.setData([{ name: 'Q removed', color: '#7768ae', points: pts }]);
  }

  // Sweep the starting fluid temperature 5–30 °C and plot how the regime readings
  // and the detection thresholds move — to check whether linear compensation works.
  function renderTempSweep() {
    const lo = 5,
      hi = 30,
      N = 50;
    const air = [],
      still = [],
      flowing = [],
      thrAW = [],
      thrFlow = [];
    for (let i = 0; i <= N; i++) {
      const Tf = lo + ((hi - lo) * i) / N;
      const pt = Object.assign({}, params, { T_fluid: Tf });
      const det = M.deriveDetectionModel(pt);
      air.push({ x: Tf, y: det.air });
      still.push({ x: Tf, y: det.still });
      flowing.push({ x: Tf, y: M.lumpedSteadyState(pt, 'flowing').T_ntc });
      thrAW.push({ x: Tf, y: det.thr_air_water });
      thrFlow.push({ x: Tf, y: det.thr_flow });
    }
    charts.tempsweep.setData(
      [
        { name: 'air', color: SCENE_COLOR.air, points: air },
        { name: 'air/water thr', color: '#9aa6bd', points: thrAW, dashed: true },
        { name: 'still water', color: SCENE_COLOR.stillwater, points: still },
        { name: 'flow thr', color: '#7768ae', points: thrFlow, dashed: true },
        { name: 'flowing', color: SCENE_COLOR.flowing, points: flowing },
      ],
      [],
      [
        {
          x: params.T_fluid,
          y: M.lumpedSteadyState(params, 'stillwater').T_ntc,
          color: '#33405a',
        },
      ]
    );
  }

  function renderAccuracy() {
    const hi = 40;
    const a = M.flowAccuracy(params, hi);
    const sig = a.sigma_mV;

    // signal: voltage curve with ±2σ noise band
    const signalPts = a.curve.map((c) => ({ x: c.lpm, y: c.mV }));
    const hiPts = a.curve.map((c) => ({ x: c.lpm, y: c.mV + 2 * sig }));
    const loPts = a.curve.map((c) => ({ x: c.lpm, y: c.mV - 2 * sig }));
    const nearest = (lpm) =>
      a.curve.reduce((b, c) => (Math.abs(c.lpm - lpm) < Math.abs(b.lpm - lpm) ? c : b));
    const cur = nearest(params.flow_lpm);
    charts.signal.setData(
      [
        { name: 'ADC voltage', color: '#2d7dd2', points: signalPts },
        { name: '±2σ noise', color: '#e15554', points: hiPts, dashed: true },
        { name: '', color: '#e15554', points: loPts, dashed: true },
      ],
      [],
      [{ x: cur.lpm, y: cur.mV, label: `${params.flow_lpm.toFixed(0)} l/min`, color: '#33405a' }]
    );

    // resolution: ±1σ flow uncertainty. Clip extreme (unusable) values so the
    // y-axis stays readable; the axis itself auto-scales to suit the ADC.
    const CLIP = 30;
    const resPts = a.curve.map((c) => ({ x: c.lpm, y: Math.min(c.sigma_lpm, CLIP) }));
    charts.resolution.setData(
      [{ name: '±1σ flow uncertainty', color: '#f26419', points: resPts }],
      [],
      [
        {
          x: cur.lpm,
          y: Math.min(cur.sigma_lpm, CLIP),
          label: cur.sigma_lpm > CLIP ? '> ±30' : `±${cur.sigma_lpm.toFixed(1)}`,
          color: '#33405a',
        },
      ]
    );

    const at = (lpm) => {
      const s = nearest(lpm).sigma_lpm;
      return s > CLIP ? '>±30' : '±' + s.toFixed(1);
    };
    const mV5 = nearest(5).mV,
      mV40 = nearest(40).mV;
    const floorMv = (params.adc_noise_mv / Math.sqrt(Math.max(1, params.adc_averages)));
    document.getElementById('accInfo').textContent =
      `${params.adc_bits}-bit ADC (FSR ${params.adc_fsr.toFixed(3)} V). ` +
      `Effective noise ${sig.toFixed(2)} mV = ${floorMv.toFixed(2)} mV random ` +
      `(raw ${params.adc_noise_mv.toFixed(2)} ÷ √${params.adc_averages.toFixed(0)}) ⊕ ` +
      `${params.adc_inl_mv.toFixed(2)} mV INL/offset floor (⊕ = quadrature; the floor does not ` +
      `average away). The signal moves only ${Math.abs(mV5 - mV40).toFixed(0)} mV across 5→40 l/min. ` +
      `1σ flow resolution: ${at(5)} @5, ${at(15)} @15, ${at(30)} @30, ${at(40)} @40 l/min. ` +
      `Improve it with a higher-conductivity probe, a matched series resistor, or more averaging ` +
      `(until the INL floor dominates).`;
  }

  function renderDetection() {
    const det = M.deriveDetectionModel(params);

    // thresholds table
    const rows = [
      ['air', det.air.toFixed(1) + ' °C', SCENE_COLOR.air, 'head near PTC — almost no heat removed'],
      [
        'air ↔ water threshold',
        det.thr_air_water.toFixed(1) + ' °C',
        '#9aa6bd',
        'NTC above ⇒ AIR (pump dry / not primed)',
      ],
      ['still water', det.still.toFixed(1) + ' °C', SCENE_COLOR.stillwater, 'immersed, no flow'],
      [
        'flow threshold',
        det.thr_flow.toFixed(1) + ' °C',
        '#9aa6bd',
        'NTC below ⇒ FLOWING (cooling beyond still water)',
      ],
      [
        `good flow (${det.goodFlowLpm} l/min)`,
        det.tempAtGoodFlow.toFixed(1) + ' °C',
        SCENE_COLOR.flowing,
        'healthy F4B pump — reference operating point',
      ],
    ];
    document.getElementById('thresholds').innerHTML =
      '<tr><th>state</th><th>NTC</th><th></th></tr>' +
      rows
        .map(
          (r) =>
            `<tr><td><span class="pill" style="background:${r[2]}"></span>${r[0]}</td><td><b>${r[1]}</b></td><td style="color:var(--muted);font-size:11.5px">${r[3]}</td></tr>`
        )
        .join('');

    document.getElementById('adcNote').textContent =
      'Note: the ESP32-C ADC is only usable ~0.5–2.5 V, so the NTC divider must be sized to keep ' +
      'the 20–80 °C range inside that window. Divider design is downstream of this tool.';

    // ESP32 C reference — thresholds linear in measured water temperature, and a
    // temperature-independent theta-based flow lookup.
    const tc = M.deriveTempCompensation(params);
    const lut = tc.thetaCurve.filter((_, i) => i % 6 === 0); // ~11 points
    const lutStr = lut
      .map((c) => `  {${c.theta.toFixed(4)}f, ${c.lpm.toFixed(2)}f}`)
      .join(',\n');
    document.getElementById('esp32').textContent =
`/* Auto-derived from the model — ${(M.MATERIALS[params.material] || {}).name || 'custom'} probe,
   T_ptc=${params.T_ptc}C, pipe bore=${params.pipe_dia_mm}mm.
   Thresholds are LINEAR in the measured water temperature t_water (read it by
   switching the heater OFF and letting the head settle to ambient). */
#define T_PTC_C    ${params.T_ptc.toFixed(1)}f
#define AW_SLOPE   ${tc.aw_slope.toFixed(3)}f
#define AW_OFFSET  ${tc.aw_offset.toFixed(2)}f   /* air<->water thr = AW_SLOPE*t_water + AW_OFFSET */
#define FL_SLOPE   ${tc.fl_slope.toFixed(3)}f
#define FL_OFFSET  ${tc.fl_offset.toFixed(2)}f   /* still<->flow thr = FL_SLOPE*t_water + FL_OFFSET */

typedef enum { STATE_AIR, STATE_STILL, STATE_FLOW } sensor_state_t;

sensor_state_t classify(float t_ntc, float t_water) {
  if (t_ntc > AW_SLOPE*t_water + AW_OFFSET) return STATE_AIR;  /* dry -> ALARM */
  if (t_ntc < FL_SLOPE*t_water + FL_OFFSET) return STATE_FLOW; /* good flow    */
  return STATE_STILL;                                          /* no flow      */
}

/* Flow rate from the temperature-normalised cooling ratio
   theta = (t_ntc - t_water)/(T_PTC_C - t_water), independent of water temp.
   theta DECREASES as flow increases. */
static const float flow_lut[][2] = {   /* {theta, l/min} */
${lutStr}
};
float flow_lpm(float t_ntc, float t_water) {
  float theta = (t_ntc - t_water) / (T_PTC_C - t_water);
  const int N = sizeof(flow_lut)/sizeof(flow_lut[0]);
  if (theta >= flow_lut[0][0]) return 0.0f;
  for (int i = 0; i < N-1; i++) {
    if (theta <= flow_lut[i][0] && theta >= flow_lut[i+1][0]) {
      float f = (theta - flow_lut[i][0]) / (flow_lut[i+1][0] - flow_lut[i][0]);
      return flow_lut[i][1] + f * (flow_lut[i+1][1] - flow_lut[i][1]);
    }
  }
  return flow_lut[N-1][1];
}`;
  }

  // ---- go ----
  buildControls();
  buildMaterials();
  buildAdcPresets();
  syncConstruction();
  recompute();

  // On resize, only redraw the diagram (the charts redraw themselves via their
  // own listeners). Debounced, and crucially NOT a full recompute — re-running
  // the transient simulations on every scrollbar-induced resize froze the page.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastResult) {
        SensorDiagram.drawDiagram(
          document.getElementById('diagram'),
          params,
          lastResult,
          scenario
        );
      }
    }, 150);
  });
})();
