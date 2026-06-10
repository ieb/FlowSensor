# Flow Sensor Model Explorer

An offline, single-page tool to explore the thermal behaviour of the heated-probe
flow sensor and derive a deterministic air / still-water / flow detection model for
the ESP32. It is the interactive companion to `../AlayisisPrompt.md` and the project
`../../README.md`.

## Running it

Just open `index.html` in any modern browser — no build step, no server, no network.
Everything (charts, diagram, physics) is plain HTML/CSS/JS with zero dependencies.

If your browser blocks `file://` module/resource loading, serve the folder over HTTP:

```
cd design/model-explorer
python3 -m http.server 8765
# then open http://localhost:8765/index.html
```

## What it shows

- **Sensor model diagram** — a scaled cross-section (PTC/aluminium block → PTFE-sleeved
  316 stainless shaft with central bore → wetted head → fluid). The metal is filled with
  a live temperature gradient from the model, the NTC bead is drawn at its real depth, and
  a thermal-network overlay shows `R_cond`, `R_conv`, the heat flow `Q` and the convection
  coefficient `h`.
- **Steady-state temperature profile** — temperature along the PTC→face axis, comparing the
  fast lumped analytic model (dashed) against the 1-D finite-difference solver (solid).
- **Flow calibration** — NTC temperature vs flow rate (l/min through the pipe bore), with
  the air and still-water levels drawn as reference bands. This monotonic curve is the heart
  of the flow-rate measurement. Flow rate is derived from velocity and the pipe bore
  diameter (default 19 mm; ~30 l/min is a healthy F4B pump on the D2-40).
- **Turn-on transient** — NTC vs time on a cold start with the self-regulating PTC, for
  each medium. The differing time constants are a second, independent discriminator.
- **Cool-down transient** — starting from the hot steady state, the heater is switched OFF
  and the probe decays toward fluid temperature. With no heater power the decay rate is set
  purely by convection and thermal mass, so its shape is a clean discriminator: flowing
  water drops fastest, air stays hot longest. The decay is dominated by the aluminium
  heater-block mass, so it is slow — raise **Simulation time** (up to 1800 s) for the full
  curve.
- **Flow-step response** — how fast the NTC reacts to a change in flow rate. The probe
  starts at the steady state for the "from" flow, then the flow changes to the "to" value
  over a configurable **ramp time** (0 = instantaneous step) while the heater stays on
  (self-regulating). h is recomputed continuously as the flow ramps. Because the 80 °C
  source is held, only the head/shaft re-equilibrate, so the thermal lag is small — a few
  seconds — and the total reaction is that lag plus the ramp itself. The panel reports the
  63% and 90% response times (from t=0) and the size of the NTC change. (e.g. bare 316,
  30→5 l/min instantaneous: +0.75 °C, t90 ≈ 4 s; with a 5 s ramp, t90 ≈ 8 s. Phosphor
  bronze or Al sleeve give a ~3 °C change at similar speed.) Increasing flow reacts faster
  than decreasing it (higher h ⇒ shorter time constant); approaching still water (→0) is the
  slowest case.
- **Heat flux** — power removed from the head vs velocity.
- **Sensor signal vs flow** — the actual ADC voltage (NTC + series resistor) with the ±2σ
  ADC-noise band. Shows how compressed the signal is at high flow.
- **Flow-rate accuracy (±1σ uncertainty vs flow)** — ADC noise propagated through the NTC →
  divider → calibration chain. Because the temperature (hence resistance, hence voltage)
  change per l/min is small — and shrinks as the calibration flattens — the flow uncertainty
  grows sharply with flow. With bare 316 stainless and ~5 mV effective ADC noise the 1σ
  uncertainty is ~±1 l/min at 5 l/min but ~±17 l/min at 30 l/min (effectively unusable);
  phosphor bronze or the aluminium sleeve cut this ~4–5× by widening the temperature swing.
  Tunable via the **NTC & ADC** controls (R₂₅, Beta, series resistor, supply, ADC full-scale,
  noise, averaging, INL/offset floor) and an **ADC preset** selector. This is the practical
  limit on flow-rate measurement.

  Switching the ADC preset shows how much the converter matters. With the **ESP32 12-bit**
  internal ADC (noisy, ~5 mV floor) flow resolution is good at low flow but collapses above
  ~15 l/min (±17 l/min at 30 l/min on bare 316). With an **ADS1115 16-bit** (µV-class noise,
  ~0.25 mV floor) the ADC stops being the limit: bare 316 reaches ~±0.9 l/min at 30 l/min,
  and the aluminium sleeve ~±0.15 l/min — roughly a 20–30× improvement. The full-scale range
  is separate from the divider supply because the ADS1115's PGA sets its own range.

  The effective ADC uncertainty combines, in quadrature: random repeatability noise reduced
  by averaging (÷√N), quantisation, and an **INL/offset floor that does not average away**.
  As a result the total asymptotes to the floor — beyond a point, more averaging buys
  nothing and only a bigger temperature signal (higher-conductivity probe) helps. With a
  5 mV floor, even infinite averaging leaves ~±17 l/min at 30 l/min on bare 316 stainless.
- **Thresholds vs starting water temperature** — sweeps the fluid temperature 5–30 °C and
  plots how the regime readings (air, still, flowing) and the detection thresholds move.
  The relationship is linear to within ~0.015 °C (the only nonlinearity is the small air
  radiation term), so a **linear temperature compensation is sufficient**: the ESP32 can
  read ambient by briefly switching the heater off and correct the thresholds with a simple
  slope/offset. Note each regime has a different slope (≈0.15 air, ≈0.5–0.9 still, ≈1.0
  flowing), so apply the appropriate one.
- **Detection model & ESP32 output** — computed thresholds plus copy-paste C reference
  code. The thresholds are emitted as **linear functions of the measured water temperature**
  (`AW_SLOPE*t_water + AW_OFFSET`, etc.), so `classify(t_ntc, t_water)` is temperature
  compensated. Flow rate is read via `flow_lpm(t_ntc, t_water)` using the dimensionless
  cooling ratio `theta = (t_ntc - t_water)/(T_ptc - t_water)`, which is independent of water
  temperature — so a single `theta`→l/min table works at any ambient. The firmware obtains
  `t_water` by briefly switching the heater off (see the cool-down graph).

All parameters (temperatures, geometry, conductivity, convection coefficients, flow
velocity, heater power, solver resolution) are editable; everything recomputes live.

### Probe material

A **Probe material** selector switches between **316 stainless** (k ≈ 15 W/m·K) and
**phosphor bronze** (k ≈ 75 W/m·K); the conductivity slider then lets you fine-tune. The
material is a real design lever:

| Material         | R_cond | Air | Still | Flowing | Still→flow swing |
| ---------------- | ------ | --- | ----- | ------- | ---------------- |
| 316 stainless    | ~66 K/W | ~70 °C | ~28 °C | ~20 °C | ~7 °C  |
| Phosphor bronze  | ~13 K/W | ~78 °C | ~46 °C | ~22 °C | ~24 °C |

The high-conductivity bronze runs the head much hotter, which *narrows* the air-detection
margin but *greatly widens* the still-water→flow temperature swing — i.e. much better
flow-rate resolution. Use the flow-calibration graph to see the tradeoff for your geometry.

### Construction: aluminium sleeve

A **Construction** toggle adds an optional aluminium tube over the 316 stainless shaft, in
parallel with it (good thermal contact assumed, via grease). The sleeve stops a short
distance (**seal gap**, default 3 mm) before the inner head surface to leave room for the
O-ring / PTFE seal seat. Controls: sleeve OD, seal gap, sleeve conductivity.

The model treats the shaft as two series sections: the stainless-only seal gap, then the
sleeved section where the stainless and aluminium k·A values add. Because aluminium
(~237 W/m·K) over a 10/6 mm annulus conducts ~35× better than the stainless core, the
sleeved section becomes a near-isothermal thermal short and the **seal gap dominates the
steady-state conduction resistance** (e.g. ~11 K/W total at OD10/gap3, vs 66 K/W bare).
Consequences worth exploring in the tool:

- Steady-state head temperature is set mostly by the **seal gap**, not the sleeve OD.
- Sleeve OD mainly adds **thermal mass**, so it is the lever for tuning the **transient**
  response (a larger OD warms/settles more slowly) — visible on the turn-on graph.

## The model (see `model.js`)

Heat flows from the PTC down the stainless shaft (a 1-D conduction path, since the shaft
sides are PTFE-insulated) and leaves through the head by convection into the fluid:

- **Conduction:** `R_cond = L / (k · A_shaft)`, with `A_shaft` the annular tube section.
- **Convection:** `R_conv = 1 / (h · A_head)`. The coefficient `h` is the discriminator —
  small in air, moderate in still water, large and velocity-dependent in flow.
- **Forced convection** uses the Churchill–Bernstein cylinder-in-crossflow correlation
  (`Re → Nu → h`) with seawater properties, blended with the still-water natural-convection
  floor.
- **Lumped steady state:** `Q = (T_ptc − T_fluid) / (R_cond + R_conv)`, `T_head = T_fluid + Q·R_conv`,
  and the head is treated as isothermal so `T_NTC ≈ T_head`. This is the closed form the
  firmware would run.
- **1-D nodal solver:** a finite-volume discretisation along the axis (head + shaft cells,
  convective head cells, fixed-PTC or aluminium-block boundary) solved with the Thomas
  algorithm for steady state and explicit Euler for transients. This gives the axial profile
  and accurate turn-on dynamics, and validates the lumped approximation.

### Representative results (defaults: PTC 80 °C, fluid 20 °C)

| Scenario       | NTC reading | Interpretation                    |
| -------------- | ----------- | --------------------------------- |
| Air            | ~72 °C      | head stays hot → pump dry / unprimed |
| Still seawater | ~29 °C      | immersed, no flow                 |
| Flowing water  | ~21 °C      | strong cooling, → flow rate (l/min) |

The clean separation between these regimes is what makes the single heated probe viable.

## Assumptions & limitations

- PTFE shaft sleeve is perfectly adiabatic; only the head exchanges heat with the fluid.
- The PTC is an ideal self-regulating 80 °C source (capped in the turn-on model).
- Seawater properties are fixed at ~20 °C; radiation is included only for the air case.
- This tool produces the **model and coefficients only**. Out of scope: the NTC
  voltage-divider design (note the ESP32-C ADC is only usable ~0.5–2.5 V), ADC sampling
  strategy, BLE GATT, and firmware — all downstream work.
