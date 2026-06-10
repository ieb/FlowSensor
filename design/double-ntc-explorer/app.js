/*
 * app.js — wires the controls to the DoubleNTC model and renders the diagram,
 * charts and detection panel. Recomputes everything whenever a parameter changes.
 */

(function () {
  'use strict';

  const M = window.DoubleNTCModel;
  let params = M.cloneDefaults();
  let scenario = 'flowing';

  const SCENE_COLOR = { air: '#e15554', stillwater: '#2d7dd2', flowing: '#3bb273' };
  const SCENE_LABEL = { air: 'Air', stillwater: 'Still water', flowing: 'Flowing water' };

  const charts = {
    power: new LineChart(document.getElementById('chartPower'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'power to hold ΔT (W)',
      xMin: 0,
    }),
    drive: new LineChart(document.getElementById('chartDrive'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'heater duty cycle (%)',
      xMin: 0,
      yMin: 0,
      yMax: 110,
    }),
    levels: new LineChart(document.getElementById('chartLevels'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'power (W)',
      xMin: 0,
      yMin: 0,
    }),
    compare: new LineChart(document.getElementById('chartCompare'), {
      xLabel: 'flow rate (l/min)',
      yLabel: '±1σ flow uncertainty (l/min)',
      xMin: 0,
      xMax: 40,
      yMin: 0,
    }),
    accuracy: new LineChart(document.getElementById('chartAccuracy'), {
      xLabel: 'flow rate (l/min)',
      yLabel: '±1σ flow uncertainty (l/min)',
      xMin: 0,
      xMax: 40,
      yMin: 0,
    }),
    deltaT: new LineChart(document.getElementById('chartDeltaT'), {
      xLabel: 'held ΔT (°C)',
      yLabel: 'relative (0–1)',
      xMin: 2,
      yMin: 0,
    }),
    tempcomp: new LineChart(document.getElementById('chartTempComp'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'power to hold ΔT (W)',
      xMin: 0,
    }),
    turnon: new LineChart(document.getElementById('chartTurnon'), {
      xLabel: 'time (s)',
      yLabel: 'element temperature (°C)',
      xMin: 0,
    }),
    step: new LineChart(document.getElementById('chartStep'), {
      xLabel: 'time after flow step (s)',
      yLabel: 'power (W)',
      xMin: 0,
    }),
    vbus: new LineChart(document.getElementById('chartVbus'), {
      xLabel: 'flow rate (l/min)',
      yLabel: 'worst-case power error (%)',
      xMin: 0,
      xMax: 40,
      yMin: 0,
    }),
  };

  // ---- build slider/number controls ----
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
    document.querySelectorAll('#scenarios button').forEach((b) => b.classList.toggle('active', b === btn));
    recompute();
  });

  // ---- element buttons (tube vs bead) ----
  function buildElements() {
    document.getElementById('elements').innerHTML = Object.entries(M.ELEMENTS)
      .map(
        ([key, e]) =>
          `<button data-el="${key}"${key === params.element ? ' class="active"' : ''}>${e.name}</button>`
      )
      .join('');
  }
  document.getElementById('elements').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    params.element = btn.dataset.el;
    document.querySelectorAll('#elements button').forEach((b) => b.classList.toggle('active', b === btn));
    recompute();
  });

  // ---- ADC preset buttons ----
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
    document.querySelectorAll('#adcpresets button').forEach((b) => b.classList.toggle('active', b.dataset.adc === key));
    recompute();
  }
  document.getElementById('adcpresets').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) applyAdcPreset(btn.dataset.adc);
  });

  document.getElementById('reset').addEventListener('click', () => {
    params = M.cloneDefaults();
    buildControls();
    buildElements();
    buildAdcPresets();
    recompute();
  });

  // ---- helpers ----
  const fmtW = (P) => (P >= 1 ? `${P.toFixed(2)} W` : `${(P * 1000).toFixed(0)} mW`);
  let lastResult = null;

  function recompute() {
    params.velocity = M.lpmToVelocity(params.flow_lpm, params);
    const result = M.heatedElementSteady(params, scenario);
    lastResult = result;

    DoubleNTCDiagram.drawDiagram(document.getElementById('diagram'), params, result, scenario);
    DoubleNTCDiagram.drawCircuit(document.getElementById('circuit'), params, result);
    renderReadout(result);
    renderPower();
    renderDrive();
    renderLevels();
    renderCompare();
    renderAccuracy();
    renderDeltaT();
    renderTempComp();
    renderTurnon();
    renderStep();
    renderVbus();
    renderDetection();
  }

  function renderReadout(result) {
    const dutyStr = result.duty >= 1 ? '⚠ 100 %' : `${(result.duty * 100).toFixed(0)} %`;
    const heaterStr = result.heat_ok
      ? `${result.T_heater.toFixed(0)} °C`
      : `⚠ ${result.T_heater.toFixed(0)} °C`;
    const cards = [
      ['Hold ΔT', `${params.delta_T.toFixed(0)} °C`],
      ['Heater power', fmtW(result.P_report)],
      ['Duty (commanded)', dutyStr],
      ['Heater temp', heaterStr],
      ['h (convection)', `${result.h.toFixed(0)} W/m²K`],
    ];
    if (scenario === 'flowing') cards.push(['Flow rate', `${params.flow_lpm.toFixed(0)} l/min`]);
    else cards.push(['Element', M.ELEMENTS[params.element].name]);
    document.getElementById('readout').innerHTML = cards
      .map((c) => `<div class="r"><div class="k">${c[0]}</div><div class="v">${c[1]}</div></div>`)
      .join('');
  }

  function renderPower() {
    const det = M.deriveDetectionModel(params);
    const cal = det.cal;
    const pts = cal.curve.map((c) => ({ x: c.lpm, y: c.P }));
    const fit = cal.curve.map((c) => ({ x: c.lpm, y: cal.kings.a + cal.kings.b * Math.sqrt(c.v) }));
    const cur = M.heatedElementSteady(params, 'flowing').P;
    charts.power.opts.xMax = M.velocityToLpm(cal.vmax, params);
    charts.power.setData(
      [
        { name: 'flowing water', color: SCENE_COLOR.flowing, points: pts },
        { name: 'King fit a+b√v', color: '#9aa6bd', points: fit, dashed: true },
      ],
      [
        { y: det.air, label: `air ${fmtW(det.air)}`, color: SCENE_COLOR.air },
        { y: det.still, label: `still ${fmtW(det.still)}`, color: SCENE_COLOR.stillwater },
      ],
      [{ x: params.flow_lpm, y: cur, label: `${params.flow_lpm.toFixed(0)} l/min`, color: '#33405a' }]
    );
    const r = M.heatedElementSteady(params, 'flowing');
    let info =
      `${M.ELEMENTS[params.element].name}, ΔT=${params.delta_T.toFixed(0)}°C. ` +
      `Power: air ${fmtW(det.air)}, still ${fmtW(det.still)}, ${det.goodFlowLpm} l/min ${fmtW(det.flowGood)}. `;
    if (M.isProbe(params) && r.R_fn > 0) {
      const cap = params.delta_T / r.R_fn;
      const Lexp = M.headSideExposed(params);
      info +=
        `Only ${Lexp.toFixed(1)} mm of the ${params.probe_head_thick_mm.toFixed(1)} mm side is wetted, so the NTC is ` +
        `partly buried (R_fn=${r.R_fn.toFixed(1)} K/W). That caps the power at ΔT/R_fn ≈ ${fmtW(cap)} and ` +
        `flattens the curve at high flow. More side exposure raises the wetted area (steeper slope) ` +
        `and lifts the cap; full exposure removes the saturation.`;
    } else {
      info +=
        `King's-law fit P = ${cal.kings.a.toFixed(3)} + ${cal.kings.b.toFixed(3)}·√v (W, v in m/s). ` +
        `The √v term means sensitivity persists across the whole flow range.`;
    }
    document.getElementById('powerInfo').textContent = info;
  }

  function renderDrive() {
    const cal = M.deriveCalibration(params);
    const dutyPts = cal.curve.map((c) => ({ x: c.lpm, y: Math.min(110, c.duty * 100) }));
    charts.drive.opts.xMax = M.velocityToLpm(cal.vmax, params);
    charts.drive.setData(
      [{ name: 'heater duty cycle', color: '#f26419', points: dutyPts }],
      [{ y: 100, label: '100% — heater saturated (can\'t hold ΔT)', color: '#b23' }],
      [
        {
          x: params.flow_lpm,
          y: Math.min(110, M.heatedElementSteady(params, 'flowing').duty * 100),
          label: `${(M.heatedElementSteady(params, 'flowing').duty * 100).toFixed(0)}%`,
          color: '#33405a',
        },
      ]
    );
  }

  function renderLevels() {
    const det = M.deriveDetectionModel(params);
    const cal = det.cal;
    const pts = cal.curve.map((c) => ({ x: c.lpm, y: c.P }));
    charts.levels.opts.xMax = M.velocityToLpm(cal.vmax, params);
    charts.levels.setData(
      [{ name: 'flowing power', color: SCENE_COLOR.flowing, points: pts }],
      [
        { y: det.air, label: `air ${fmtW(det.air)}`, color: SCENE_COLOR.air },
        { y: det.thr_air_water, label: `air↔water thr`, color: '#9aa6bd' },
        { y: det.still, label: `still ${fmtW(det.still)}`, color: SCENE_COLOR.stillwater },
        { y: det.thr_flow, label: `flow thr`, color: '#7768ae' },
      ]
    );
  }

  function clipCurve(curve, clip) {
    return curve.map((c) => ({ x: c.lpm, y: Math.min(c.sigma_lpm, clip) }));
  }

  function renderCompare() {
    const CLIP = 30;
    const ctd = M.flowAccuracy(params, 40);
    const sp = M.singleProbeAccuracy(params, 40);
    charts.compare.setData(
      [
        { name: 'DoubleNTC (CTD power)', color: '#3bb273', points: clipCurve(ctd.curve, CLIP) },
        { name: 'single heated probe', color: '#e15554', points: clipCurve(sp.curve, CLIP) },
      ],
      []
    );
    const at = (arr, lpm) => {
      const c = arr.reduce((b, x) => (Math.abs(x.lpm - lpm) < Math.abs(b.lpm - lpm) ? x : b));
      return c.sigma_lpm > CLIP ? '>±30' : '±' + c.sigma_lpm.toFixed(2);
    };
    document.getElementById('compareInfo').textContent =
      `1σ flow resolution, same ADC. DoubleNTC: ${at(ctd.curve, 5)} @5, ${at(ctd.curve, 15)} @15, ` +
      `${at(ctd.curve, 30)} @30 l/min. Single probe: ${at(sp.curve, 5)} @5, ${at(sp.curve, 15)} @15, ` +
      `${at(sp.curve, 30)} @30 l/min. The CTD signal keeps rising with flow, so its resolution ` +
      `stays usable where the single probe's collapses.`;
  }

  function renderAccuracy() {
    const CLIP = 30;
    const a = M.flowAccuracy(params, 40);
    const pts = clipCurve(a.curve, CLIP);
    const nearest = (lpm) => a.curve.reduce((b, c) => (Math.abs(c.lpm - lpm) < Math.abs(b.lpm - lpm) ? c : b));
    const cur = nearest(params.flow_lpm);
    charts.accuracy.setData(
      [{ name: '±1σ flow uncertainty', color: '#f26419', points: pts }],
      [],
      [
        {
          x: cur.lpm,
          y: Math.min(cur.sigma_lpm, CLIP),
          label: cur.sigma_lpm > CLIP ? '>±30' : `±${cur.sigma_lpm.toFixed(2)}`,
          color: '#33405a',
        },
      ]
    );
    const at = (lpm) => {
      const s = nearest(lpm).sigma_lpm;
      return s > CLIP ? '>±30' : '±' + s.toFixed(2);
    };
    document.getElementById('accInfo').textContent =
      `${params.adc_bits}-bit ADC, ${a.sigma_mV.toFixed(2)} mV effective noise on each NTC divider (after ` +
      `${params.adc_averages}× averaging) → σ_ΔT ≈ ${(a.sigma_dT * 1000).toFixed(1)} m°C on the held ΔT. ` +
      `1σ flow resolution: ${at(5)} @5, ${at(15)} @15, ${at(30)} @30, ${at(40)} @40 l/min. ` +
      `Raise ΔT, average harder (the plant is slow), or pick a lower-noise ADC to tighten it.`;
  }

  function renderDeltaT() {
    const lo = 2,
      hi = 40,
      N = 40;
    const Ps = [],
      sigs = [];
    for (let i = 0; i <= N; i++) {
      const dT = lo + ((hi - lo) * i) / N;
      const pp = Object.assign({}, params, { delta_T: dT });
      const P = M.heatedElementSteady(pp, 'flowing').P;
      const acc = M.flowAccuracy(pp, 40);
      const cur = acc.curve.reduce((b, c) =>
        Math.abs(c.lpm - params.flow_lpm) < Math.abs(b.lpm - params.flow_lpm) ? c : b
      );
      Ps.push({ x: dT, y: P });
      sigs.push({ x: dT, y: Math.min(cur.sigma_lpm, 30) });
    }
    const pMax = Math.max(...Ps.map((p) => p.y)) || 1;
    const sMax = Math.max(...sigs.map((s) => s.y)) || 1;
    charts.deltaT.opts.xMax = hi;
    charts.deltaT.setData(
      [
        { name: 'power (rel)', color: '#7768ae', points: Ps.map((p) => ({ x: p.x, y: p.y / pMax })) },
        {
          name: '±1σ resolution (rel)',
          color: '#f26419',
          points: sigs.map((s) => ({ x: s.x, y: s.y / sMax })),
        },
      ],
      [],
      [{ x: params.delta_T, y: 0, color: '#33405a', label: `ΔT ${params.delta_T.toFixed(0)}°C` }]
    );
  }

  function renderTempComp() {
    const temps = [5, 12, 20, 30];
    const colors = ['#2d7dd2', '#3bb273', '#e1bc29', '#e15554'];
    const cal0 = M.deriveCalibration(params);
    const series = temps.map((Tf, i) => {
      const pp = Object.assign({}, params, { T_fluid: Tf });
      const cal = M.deriveCalibration(pp);
      return {
        name: `${Tf}°C`,
        color: colors[i],
        points: cal.curve.map((c) => ({ x: c.lpm, y: c.P })),
      };
    });
    charts.tempcomp.opts.xMax = M.velocityToLpm(cal0.vmax, params);
    charts.tempcomp.setData(series);
  }

  function renderTurnon() {
    const series = ['air', 'stillwater', 'flowing'].map((sc) => {
      const t = M.turnOnTransient(params, sc);
      return {
        name: SCENE_LABEL[sc],
        color: SCENE_COLOR[sc],
        points: t.time.map((tt, i) => ({ x: tt, y: t.T[i] })),
      };
    });
    charts.turnon.opts.xMax = params.sim_time;
    charts.turnon.setData(series, [
      { y: params.T_fluid + params.delta_T, label: `set-point ${(params.T_fluid + params.delta_T).toFixed(0)}°C`, color: '#9aa6bd' },
    ]);
  }

  function renderStep() {
    const r = M.flowStepResponse(params, params.step_from_lpm, params.step_to_lpm);
    const pts = r.time.map((t, i) => ({ x: t, y: r.P[i] }));
    charts.step.opts.xMax = params.step_time;
    const change = r.toP - r.fromP;
    charts.step.setData(
      [{ name: `${params.step_from_lpm.toFixed(0)} → ${params.step_to_lpm.toFixed(0)} l/min`, color: '#f26419', points: pts }],
      [
        { y: r.fromP, label: `${params.step_from_lpm.toFixed(0)} l/min`, color: '#9aa6bd' },
        { y: r.toP, label: `${params.step_to_lpm.toFixed(0)} l/min`, color: '#9aa6bd' },
      ],
      r.t63 != null ? [{ x: r.t63, y: r.fromP + 0.632 * change, label: '63%', color: '#33405a' }] : []
    );
    document.getElementById('stepInfo').textContent =
      `Power moves ${fmtW(r.fromP)} → ${fmtW(r.toP)}. Simulated with the actual software PI on the ` +
      `two-node plant (Al block + element through R_cond): open-loop τ = ${r.tauOpen.toFixed(1)} s, ` +
      `closed-loop t63 = ${r.t63.toFixed(1)} s, t90 = ${r.t90.toFixed(1)} s. The slow ~8.5 s thermal ` +
      `pole dominates — this sensor responds over seconds, not instantly.`;
  }

  function renderVbus() {
    const v = M.vbusCompBenefit(params, 40);
    charts.vbus.setData(
      [
        {
          name: `without comp (±${v.without_pct.toFixed(1)}%)`,
          color: '#e15554',
          points: v.curve.map((c) => ({ x: c.lpm, y: c.without_pct })),
        },
        {
          name: `with Vbus comp (±${v.with_pct.toFixed(2)}%)`,
          color: '#3bb273',
          points: v.curve.map((c) => ({ x: c.lpm, y: c.with_pct })),
        },
      ],
      []
    );
    document.getElementById('vbusInfo').textContent =
      `Power ∝ V². If firmware assumes a nominal ${params.v_drive.toFixed(1)} V but the marine bus ` +
      `swings ${params.v_drive_min.toFixed(0)}–${params.v_drive_max.toFixed(0)} V (±${v.dV.toFixed(1)} V), ` +
      `the power error WITHOUT compensation is ±${v.without_pct.toFixed(1)}% (= 2·ΔV/V). Reading Vbus on ` +
      `ADC2 cuts this to ±${v.with_pct.toFixed(2)}% (limited only by the Vbus-ADC accuracy, ` +
      `~${(v.sigma_vbus * 1000).toFixed(0)} mV). This is why the third ADC channel exists.`;
  }

  function renderDetection() {
    const det = M.deriveDetectionModel(params);
    const rows = [
      ['air (dry)', fmtW(det.air), SCENE_COLOR.air, 'near parasitic floor — pump dry → ALARM'],
      ['air ↔ water threshold', fmtW(det.thr_air_water), '#9aa6bd', 'power below ⇒ AIR'],
      ['still water', fmtW(det.still), SCENE_COLOR.stillwater, 'immersed, no flow'],
      ['flow threshold', fmtW(det.thr_flow), '#7768ae', 'power above ⇒ FLOWING'],
      [`good flow (${det.goodFlowLpm} l/min)`, fmtW(det.flowGood), SCENE_COLOR.flowing, 'healthy F4B pump'],
    ];
    document.getElementById('thresholds').innerHTML =
      '<tr><th>state</th><th>power</th><th></th></tr>' +
      rows
        .map(
          (r) =>
            `<tr><td><span class="pill" style="background:${r[2]}"></span>${r[0]}</td><td><b>${r[1]}</b></td><td style="color:var(--muted);font-size:11.5px">${r[3]}</td></tr>`
        )
        .join('');

    document.getElementById('adcNote').textContent =
      'The ESP32 runs the whole loop in software: it reads both NTC dividers + Vbus on three ADCs, ' +
      'holds the downstream NTC at ΔT above the upstream one with a software PI, and LEDC-PWMs the ' +
      'heater. Flow comes from the KNOWN duty and the MEASURED bus: P = duty·Vbus²/R (no current ' +
      'sense). A hardware watchdog forces the gate OFF and a thermal cutout on the block backs it up.';

    // ESP32 reference: full software loop + power thresholds + power→l/min LUT.
    const lut = det.cal.curve.filter((_, i) => i % 6 === 0).map((c) => ({ P: c.P, lpm: c.lpm }));
    const lutStr = lut.map((c) => `  {${c.P.toFixed(4)}f, ${c.lpm.toFixed(2)}f}`).join(',\n');
    document.getElementById('esp32').textContent =
`/* Auto-derived from the model — ${M.ELEMENTS[params.element].name}, ΔT=${params.delta_T}C,
   ${params.heater_R}ohm heater @ ${params.v_drive}V (Pmax=${(params.v_drive*params.v_drive/params.heater_R).toFixed(0)}W),
   pipe bore=${params.pipe_dia_mm}mm. FULLY-DIGITAL loop: the ESP32 reads two NTC dividers
   (ADC0/1) + Vbus (ADC2), runs a software PI to hold T_dn at T_up+ΔT, and LEDC-PWMs the
   heater. Flow = duty*Vbus^2/R. Oversample the ADC (the plant is slow); calibrate the ADC
   with the eFuse Vref / two-point. A hardware watchdog forces the gate OFF on a hang and a
   thermal cutout on the Al block is the final backstop (software now owns 40 W). */
#define R_HEATER   ${params.heater_R.toFixed(2)}f   /* heater resistance (ohm) */
#define V_EXC      ${params.ntc_vexc.toFixed(2)}f   /* NTC divider rail (V) = ADC ref */
#define R_SERIES   ${params.ntc_rseries.toFixed(0)}f /* NTC divider series R (ohm) */
#define NTC_R25    ${(params.ntc_r25*1000).toFixed(0)}f /* NTC R at 25C (ohm) */
#define NTC_BETA   ${params.ntc_beta.toFixed(0)}f   /* NTC Beta (K) */
#define DELTA_T    ${params.delta_T.toFixed(2)}f    /* held rise (degC) */
#define VBUS_DIV   ${((params.v_drive)/(params.adc_fsr*0.95)).toFixed(3)}f /* Vbus divider ratio (set to keep <ADC FSR) */
#define KP         ${params.pi_kp.toFixed(4)}f      /* software-PI proportional gain (duty/degC) */
#define KI         ${params.pi_ki.toFixed(4)}f      /* software-PI integral gain (duty/(degC*s)) */
#define OVERSAMPLE ${params.adc_averages}           /* ADC samples averaged (slow plant -> average hard) */
#define P_AIR_THR  ${det.thr_air_water.toFixed(4)}f /* W: below => AIR (dry, ALARM) */
#define P_FLOW_THR ${det.thr_flow.toFixed(4)}f      /* W: above => FLOWING */

typedef enum { STATE_AIR, STATE_STILL, STATE_FLOW } sensor_state_t;

/* averaged ADC read in volts (oversample: the thermal plant is seconds-slow) */
static float adc_volts(int ch) {
  uint32_t acc = 0;
  for (int i = 0; i < OVERSAMPLE; i++) acc += adc_read_raw(ch); /* eFuse/2-pt calibrated */
  return adc_raw_to_volts(acc / OVERSAMPLE);                    /* uses eFuse Vref */
}
/* NTC divider voltage -> temperature (Beta model). Vadc = Vexc*Rs/(Rs+Rntc) */
static float temp_from_divider(float vadc) {
  float rntc = R_SERIES * vadc / (V_EXC - vadc);
  float invT = 1.0f/298.15f + logf(rntc / NTC_R25) / NTC_BETA;
  return 1.0f/invT - 273.15f;
}

/* ---- the control loop, called every tick (dt seconds) ---- */
static float pi_integ = 0.0f;
float control_tick(float dt, float *out_power, float *out_tup) {
  float t_up = temp_from_divider(adc_volts(ADC0));   /* upstream / fluid ref */
  float t_dn = temp_from_divider(adc_volts(ADC1));   /* downstream element   */
  float vbus = adc_volts(ADC2) * VBUS_DIV;           /* measured 12V bus (P ~ V^2!) */
  float err  = (t_up + DELTA_T) - t_dn;              /* T_target - T_dn */
  float u    = KP*err + KI*pi_integ;                 /* software PI */
  float duty = u < 0 ? 0 : (u > 1 ? 1 : u);          /* clamp 0..1 */
  pi_integ  += (err + (duty - u)/KI) * dt;           /* back-calculation anti-windup */
  ledcWrite(HEATER_CH, (uint32_t)(duty * ((1<<LEDC_BITS)-1)));
  *out_power = duty * vbus * vbus / R_HEATER;        /* flow signal: P = duty*Vbus^2/R */
  *out_tup   = t_up;
  feed_watchdog();                                   /* hang -> gate forced OFF */
  return duty;
}

sensor_state_t classify(float P) {
  if (P < P_AIR_THR)  return STATE_AIR;   /* dry -> ALARM */
  if (P > P_FLOW_THR) return STATE_FLOW;  /* good flow    */
  return STATE_STILL;                     /* no flow      */
}

/* flow rate from heater power (monotonic increasing) */
static const float flow_lut[][2] = {   /* {power W, l/min} */
${lutStr}
};
float flow_lpm(float P) {
  const int N = sizeof(flow_lut)/sizeof(flow_lut[0]);
  if (P <= flow_lut[0][0]) return 0.0f;
  for (int i = 0; i < N-1; i++) {
    if (P >= flow_lut[i][0] && P <= flow_lut[i+1][0]) {
      float f = (P - flow_lut[i][0]) / (flow_lut[i+1][0] - flow_lut[i][0]);
      return flow_lut[i][1] + f * (flow_lut[i+1][1] - flow_lut[i][1]);
    }
  }
  return flow_lut[N-1][1];
}`;
  }

  // ---- go ----
  buildControls();
  buildElements();
  buildAdcPresets();
  document.querySelectorAll('#scenarios button').forEach((b) => b.classList.toggle('active', b.dataset.scene === scenario));
  recompute();

  // On resize, only redraw the diagram (charts redraw via their own listeners).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastResult) {
        DoubleNTCDiagram.drawDiagram(document.getElementById('diagram'), params, lastResult, scenario);
        DoubleNTCDiagram.drawCircuit(document.getElementById('circuit'), params, lastResult);
      }
    }, 150);
  });
})();
