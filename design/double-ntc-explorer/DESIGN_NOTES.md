# DoubleNTC CTD Flow Sensor — Design Notes & Findings

> A running log of everything worked out while modelling the two-NTC constant-temperature-difference
> (CTD) thermal flow sensor for the Volvo Penta D2-40 / F4B raw-water cooling alarm.
> Companion to the interactive explorer in this folder (`index.html`) and its `README.md`.
> This file is the "why" and the conclusions; the README is the "what each control/graph does".

---

## 1. The problem being solved

The **single heated probe** (explored in `design/model-explorer`) works as a *presence* detector
(air / stagnant water / flowing water) but is a **poor flow-rate meter**:

- It holds (roughly) constant power and measures the head temperature.
- As flow rises, convection carries heat away faster, so the head→fluid temperature difference
  **shrinks**. Sensitivity `d(ΔT)/d(flow)` collapses at high flow → resolution dies exactly where
  we want to read ~30 l/min.
- It also needs a heater-off ambient measurement to know the water temperature (no built-in
  temperature compensation).

The **DoubleNTC** topology fixes both by flipping the measurement around: instead of holding power
and measuring temperature, **hold the temperature difference and measure the power**.

---

## 2. The CTD principle (constant temperature difference)

- **Upstream NTC** sits in the stream and reads the raw-water temperature `T_fluid` (the cold
  reference). It is *not* heated.
- **Downstream element** is heated by a feedback loop that holds it at a fixed rise **ΔT** (e.g.
  10 °C) *above the upstream reading*.
- The **electrical power P needed to maintain ΔT is the flow signal.**

By King's law for a heated body in crossflow:

```
P ≈ (a + b·√v) · ΔT
```

- `a` = the zero-flow / parasitic floor (conduction into the mount + natural convection).
- `b·√v` = forced convection; **keeps rising with flow — no saturation.**
- Because ΔT is referenced to the *measured* fluid temperature, the calibration is
  **intrinsically temperature compensated** — the power-vs-flow curve barely moves as raw-water
  temperature changes (verified in the explorer's temp-comp chart: curves at 5–30 °C nearly
  coincide, drifting only through fluid-property changes).

**Why it's better:** sensitivity of the power signal falls only as `1/√v`, versus the single
probe's temperature signal that collapses much faster. The "Why two sensors" comparison chart in
the app shows the single-probe ±1σ resolution blowing up at high flow while the CTD stays bounded.

---

## 3. Convection / heat-transfer model

| Element geometry | Correlation used |
|---|---|
| Tube / probe head (cylinder & head in crossflow) | **Churchill–Bernstein** |
| Glass bead (sphere) | **Whitaker:** `Nu = 2 + (0.4·Re^0.5 + 0.06·Re^(2/3))·Pr^0.4` |

- A **natural-convection floor** is blended in so still water doesn't read zero forced convection.
- The **air** scenario adds a linearised **radiation** term (matters only when h is tiny).
- Power balance at the held element: `P = (h·A_wetted + G_parasitic)·ΔT`, with `T_heated = T_fluid + ΔT`.

Geometry knobs that matter:
- **Wetted area** `A` sets `b` (forced-convection slope). For the probe head, `A = face + π·d·L`
  where `L` is the *exposed* side-wall height — see §6.
- **Parasitic conductance** `G_para` (conduction into the mount/leads) sets `a`, the air/zero-flow floor.

---

## 4. The big architectural turn: separate the heater from the NTCs

### 4.1 Why the "self-heated NTC" idea was abandoned

Originally the NTC itself was the heater (pass current through it). The model exposed this as
**infeasible**:

- A self-heated **tube** needed ~34 V of drive.
- A self-heated **probe** needed a heater temperature of ~1450 °C to push the power through the
  conduction path — physically absurd.

Root cause: the **conduction bottleneck**. `R_cond = L/(k·A)`. A long thin 316 stainless shaft is
~66 K/W; to drive tens of watts through it the source has to sit hundreds of degrees hot.

### 4.2 The architecture that works (current design)

**Separate the sensing NTCs from the heating element:**

1. **Sensing NTCs** (upstream + downstream) run on a constant **~5 V** low-power excitation. They
   only *sense* temperature — negligible self-heating (`ntc_diss_mw_c` watched in the model).
2. A **separate 40 W / 12 V ceramic heater** (≈ 3.6 Ω) does the heating.
3. The analog loop's output drives the heater through a **PWM MOSFET**, not the NTC.
4. **Aluminium heat-spreader block** thermally couples heater → downstream NTC, dropping `R_cond`
   from ~66 K/W (thin shaft) to **~3 K/W** → heater sits at a feasible ~83 °C.

The original revision closed this loop in **analog hardware** with the ESP32 as monitor only. The
**chosen design now runs the entire loop in ESP32 software** (see §7) — the analog variant is
retained as a reference / fallback (it is what the LTspice netlists in §9 model).

### 4.3 Physical construction (as specified by the user)

- Downstream sensor mirrors the single-NTC probe: a **tube with a head, only the head exposed**
  to the flow (3.4 mm, same as the single-NTC model). Both NTCs are on the **pipe wall**, not centred.
- Both NTCs use the **same housing**.
- Heater lives in a **15 mm-diameter × 5 mm-thick aluminium cylinder** with **two 6 mm holes**
  (one for the cartridge heater, one for the sensing NTC).
- The aluminium block's surface is nominally **3 mm from the head**, through a PTFE block that
  insulates it from the water.
- **Adjustable gap** block→head: 0 (direct contact) up to a distance — see §5.
- **Adjustable side-wall exposure** of the head: 0 (front face only) up to the full head thickness
  — see §6.

---

## 5. The block→head gap (and the bug it surfaced)

**User feedback:** *"the block to head setting does nothing with the sides in PTFE."*

- **Bug:** `shaftCondResistance` hard-coded the insulated conduction path to the NTC's
  back-face distance and **ignored `probe_gap_mm`**.
- **Fix:** insulated `R_cond = (gap + back) / (k·A)`, where `back = (head_thick − ntc_from_face)·(1 − exposedFrac)`.
- **Effect:** the gap now correctly raises the **heater temperature** (more conduction resistance to
  push P through) but **not the power** — because the gap is *upstream* of the held NTC node, it
  doesn't change how much heat the water steals. This is the right physics: power is set by the
  fluid side, the gap just makes the heater work harder/hotter.

---

## 6. Head side-wall exposure → curve slope (and the saturation cap)

**User insight (correct):** exposing more of the head's *sides* to the water increases the wetted
area, increasing dissipation and therefore the **slope of the power-vs-flow curve**.

Two coupled effects, both implemented:

1. **Wetted area:** `A = face + π·d·L`, with `L = head_side_exposed_mm` (clamped 0…head_thick).
   More side exposure → larger `b` → steeper, more sensitive calibration.
2. **Buried-NTC series resistance** `R_fn = ntc_depth/(k·A)·(1 − exposedFrac)`:
   - When the NTC is buried behind an unexposed front face, heat must conduct through that face.
   - This caps the deliverable power at `ΔT/R_fn` → **high-flow saturation** (the curve flattens
     when flow demands more power than the buried path can pass).
   - As side exposure → full, `R_fn → 0` and the saturation disappears.
   - The app shows a saturation-info note when `R_fn > 0`.

So side exposure is the main lever to trade **sensitivity slope** vs **conduction headroom**.

---

## 7. The control loop — FULLY DIGITAL (chosen design)

**The ESP32 runs the entire ΔT loop in software.** No analog op-amps, no Wheatstone bridge, no
analog current-sense amplifier. Signal chain:

```
upstream NTC divider ──► ADC0 ─┐
downstream NTC divider ─► ADC1 ─┤  T_up, T_dn ← Beta(Vadc)
V_bus divider ─────────► ADC2 ─┘  V_drive ← Vadc·div
                                   │
                                   ▼
                  T_target = T_up + ΔT ;  err = T_target − T_dn
                                   │
                                   ▼
                  software PI (clamp 0..1, back-calc anti-windup) → duty
                                   │
                                   ▼
                  LEDC PWM → gate driver → low-side MOSFET → 40 W heater (12 V bus)
                                   │
                  flow signal:  P = duty · V_drive² / R_heater   (duty is KNOWN)
```

- **Two NTC dividers** (NTC + series R on the 3.3 V rail), read on two ADC channels; firmware
  computes `T_up`/`T_dn` from the divider voltages via the Beta equation.
- **Software PI** holds `T_dn = T_up + ΔT` — ΔT is an explicit number, so it is **exact at every
  fluid temperature** (no Beta-ratio drift, unlike the analog bridge below). Output is a duty
  clamped 0..1 with back-calculation anti-windup (so a cold-start error doesn't wind up).
- **LEDC hardware PWM** → gate driver → low-side MOSFET switches the heater off the 12 V bus.
- **Flow = heater power = duty × V_drive² / R_heater.** The duty is commanded by firmware (known),
  so there is **no current sense**.

### Three gotchas the digital design forces

1. **V_drive compensation (P ∝ V²).** The 12 V marine bus swings ~**11–15 V**. Since
   `P = duty·V_bus²/R`, a ±ΔV swing gives a **±2·ΔV/V** power error (±50 % at the extremes) if the
   firmware assumes a nominal bus. So it reads `V_bus` on a **third ADC channel** and uses the
   measured value → residual error is just the V_bus-ADC accuracy (~±0.4 %). Quantified in the
   explorer's *V_drive compensation* chart (`vbusCompBenefit`).
2. **Heater fail-safe.** Software now owns 40 W, so a **hardware watchdog** forces the gate OFF on
   a firmware hang, and a **thermal cutout** on the aluminium block is the final backstop. (The
   analog loop regulated even with the MCU asleep; the digital design trades that away, so the
   fail-safe is mandatory.)
3. **ADC oversampling + calibration.** The held ΔT is now limited by ADC noise on the two NTC
   reads: σ_ΔT = √(σ_Tup² + σ_Tdn²), each σ_T = σ_V/|dV_divider/dT|. The plant is slow (dominant
   pole ~8.5 s), so the firmware **oversamples heavily** (~64×) to push that down, and uses
   **eFuse-Vref / two-point ADC calibration** for an accurate NTC→temperature conversion.

**Trade-off vs analog:** simpler hardware + programmable + **true** constant ΔT + power-for-free,
at the cost of an **ADC-noise-limited ΔT** and **dependence on MCU uptime**.

---

## 7a. The analog control loop (reference / fallback)

The original revision kept **all of the ΔT regulation analog and external to the ESP32**, with
the micro as monitor only. It is retained as a fallback and is what the LTspice netlists (§9)
model. Signal chain:

```
upstream NTC ─┐
              ├─ difference / instrumentation amp ──► error (Tgt − Tdn)
downstream NTC┘                                         │
                                                        ▼
                              PI integrator (with anti-windup)
                                                        │  duty demand (0..1)
                                                        ▼
                          sawtooth oscillator + comparator  ──►  PWM gate
                                                        │
                                                        ▼
                              MOSFET ──► 40 W / 12 V ceramic heater
                                                        │
                              current-sense resistor ───┴──► averaged ──► ESP32 ADC
```

- **Difference amp:** error = (T_fluid + ΔT) − T_downstream.
- **PI integrator:** holds a *steady non-zero* output at zero error (this resolved a misconception —
  an op-amp's output is **not** zero at balance; the integrator parks at whatever duty holds ΔT).
  Anti-windup (back-calculation) keeps the integrator from saturating during turn-on.
- **PWM:** sawtooth + comparator turns the duty demand into a gate signal; duty = P/Pmax.
- **Power/sense:** `I_avg = P/V_drive`; `V_sense = I_avg · r_sense` (transresistance V per A).

**ESP32 role = monitor only:** reads the averaged current-sense → power → flow (via calibration),
reads the upstream NTC for raw-water temperature, raises the alarm, does BLE. **It does not close
the ΔT loop.** This makes the alarm robust even if the micro hangs.

### Bridge topology gotcha (resolved)

In an earlier Wheatstone-bridge version, the two NTCs were on **opposite arms**, which holds the
**product** `R_up·R_dn` constant — catastrophic ΔT drift (~43 °C error at 5 °C water). Putting both
NTCs on the **same arm side** holds the **ratio** `R_dn/R_up`, which (given the exponential Beta
model) tracks a near-constant ΔT. The separated-heater redesign later superseded the bridge entirely,
but the lesson stands: *same-side = ratio = good.*

### NTC ratio drift (the thing we chose to accept)

For a 10 K / 3950 pair, a fixed resistor ratio does **not** give a perfectly constant ΔT — the Beta
model `R(T)=R25·exp(B(1/T−1/T0))` is exponential in 1/T, so ΔT drifts ~±10 % over 5–30 °C. Decision:
**accept the drift and calibrate the flow curve around it** (it's small and smooth).

---

## 8. Turn-on transient bug (and fix)

**User feedback:** *"why does the turn-on transient for Air not rise fastest… looks like it's being
heated by the power required for each scenario, but that's only known once ΔT is achieved."*

- **Bug:** the controller gain was `Kp = loop_gain · G` — i.e. drive was scaled by the *scenario's*
  conductance. Air has tiny G, so air got tiny drive and rose slowly. Wrong: at turn-on the error is
  large and the loop should slam to **full power regardless of medium**.
- **Fix:** make the gain **medium-independent**: `Kp = (loop_gain · Pmax) / max(0.1, ΔT)`, plus a
  stable explicit-Euler step `dt = min(0.4·C/(Kp+G), sim_time/300)`.
- **Verified (probe):** all scenarios start at **40 W**; t90 = air 0.85 s, still 0.85 s, flowing
  1.12 s. Air now rises fastest (least mass-loaded), as physics demands.

---

## 9. LTspice verification model

> These netlists model the **analog control variant** (op-amp bridge + PI + PWM + current sense),
> retained as the analog reference / fallback. The chosen digital design runs the same loop in
> ESP32 software; the thermal plant, constant-ΔT behaviour and King's-law power signal verified
> here carry over unchanged.

File: **`ltspice/doublentc_ctd_loop.cir`** — a behavioural **electrothermal** netlist (all B-sources,
**no external libraries**). Uses the thermal↔electrical analogy:

| Thermal | Electrical |
|---|---|
| temperature (°C) | node voltage (V) |
| heat flow (W) | B-source current (A) |
| thermal R (K/W) | resistance (Ω) |
| thermal mass (J/K) | capacitance (F) |

Models the full chain: one-node thermal plant (`Cel`/`Bloss`/`Bheat`) → difference amp (`Berr`) →
PI + anti-windup (`Bpi`/`Bctrl`/`Bint`/`Cint`) → PWM (`Bsaw`/`Bgate`) → power stage (`Bp`/`Rpf`/`Cpf`).
A **flow step at t = 3 s** (G: 1.0 → 1.746 W/K) is built in.

**How to run:** open in LTspice (File → Open), Run. Plot:
- `V(Tdn)` — element temperature: holds at fluid + ΔT = **30 °C**.
- `V(Pavg)` — delivered power: steps **~10 W → ~17.5 W** (= G·ΔT) at the flow step.
- `V(ctrl)`/`V(gate)` — duty demand and PWM waveform.

**Tunable `.param`s:** `dT`, `Cmass`, `Pmax`, `fpwm`, `Kp`, `Ki`, `Kaw`. Commented alternatives:
skip-PWM continuous check, fixed-flow calibration sweep, change fluid temp for the temp-comp check.

**Validated numerically in Python** (same equations/gains): loop stable, holds Tdn ≈ 30, full power
on cold start, power steps 10→17.5 W. Gains tuned to **Ki = 0.4, Kaw = 8** (from 0.25/4) for crisper
settling.

### Component-level model — `ltspice/doublentc_ctd_components.cir`

The follow-up component model is now built. It constructs the **actual analog circuit** rather than
abstracting it, to verify the real hardware behaves:

- **NTC thermistors** as Beta-model behavioural resistors `R = R25·exp(B(1/(V(T)+273.15) − 1/298.15))`
  driven by the thermal node voltages, in a **Wheatstone bridge** (heated arm `Vexc–NTCdn–nodeL–Ra`,
  reference arm `Vexc–NTCup–nodeR–Rb`).
- **Difference amp** (4-resistor op-amp, gain 10), **PI integrator** (op-amp, Rfp∥Cint) with **diode
  output clamp = anti-windup**, **PWM comparator** (op-amp open-loop).
- **Power MOSFET** — inline `VDMOS` model, low-side switch, 3.6 Ω heater off the 12 V rail.
- **Current-sense shunt (0.1 Ω) + ×10 op-amp** → `V(vadc)` = I_avg numerically (1 V/A transresistance,
  matching the explorer's `r_sense = 1.0`).
- **Self-contained:** op-amp is a single-pole macromodel (`.subckt OPAMP`, rails clamped by diodes);
  no external LTspice libraries needed. Only the thermal plant (physics) and the PWM carrier (a 555 /
  op-amp-oscillator stand-in; component oscillator given in comments) stay behavioural.

**Verified analytically** (bridge math, Python): at the 20 °C design point the bridge balances at
**Tdn = 30.01 °C (ΔT = 10.0)**; the diff-amp error is −5.27 V when cold (drives power up) and ≈ 0 at
balance. Running at other fluid temps reproduces the documented **Beta-ratio drift**: ΔT = 8.99 °C at
5 °C fluid, 10.71 °C at 30 °C — i.e. the ±10 % drift §7 says we accept and calibrate out, now
emerging from the real bridge components. `Ra/Rb = 0.641` is the ratio a 10K/3950 pair shows for a
10 °C rise.

**Drawn schematic:** `ltspice/doublentc_ctd_components.asc` is the same circuit as an LTspice
schematic (generated from the validated component list with exact symbol pin coordinates; open it
in the GUI). The op-amp uses the stock `opamp2` symbol bound to the embedded `OPAMP` subckt.

**Verified in LTspice 17.2.4** (ran the `.cir` in batch, parsed the `.raw`): the component loop
**holds Tdn ≈ 30 °C** (29.8 still / 30.0 flow), **Th ≈ 59 °C still / 82 °C flow** (feasible), and the
current-sense **I_avg steps 0.9 → 1.5 A** at the flow step — genuine constant-ΔT regulation.

Bugs the live LTspice run caught that the DC bridge-check alone missed (each fixed):
1. **Lossy integrator** (R∥C) → steady-state error. Fixed: R in *series* with C (true PI, ∞ DC gain).
2. **Op-amp output not rail-limited** (gate hit ±hundreds of V as a comparator). Fixed: behavioural
   output clamp + finite output impedance in the macromodel.
3. **Anti-windup on the output only** → integrator kept winding → +6 °C overshoot. Fixed: back-to-back
   **zeners across the feedback** (true anti-windup; clamps the cap, ~±1.5 V).
4. **Diff-amp loaded the bridge** (10 kΩ inputs on ~3.5 kΩ midpoints) → ~1 °C offset. Fixed: 1 MΩ/10 MΩ
   inputs (high input impedance) → settles to 30 °C.
5. Slow **8.5 s dominant thermal pole** (Al block + element through Rcond) → retuned for damping
   (Kp≈2, integral time ≈5 s); realistic ~10–30 s settling.

> The three artifacts are complementary: **`doublentc_ctd_loop.cir`** = fast loop-dynamics check
> (behavioural); **`doublentc_ctd_components.cir`** = faithful circuit check (real op-amps/bridge/
> MOSFET/sense amp), verified above; **`doublentc_ctd_components.asc`** = the same circuit drawn as a
> GUI schematic. (macOS LTspice can batch-run `.cir` via `-b` but cannot batch-netlist `.asc` — even
> stock `.asc` files fail that way — so open the schematic in the GUI.)

---

## 10. Key numbers & defaults (current)

| Quantity | Value | Note |
|---|---|---|
| ΔT setpoint | 10 °C | tunable; SNR vs boiling-margin tradeoff |
| Heater | 40 W / 12 V, ≈ 3.6 Ω | ceramic cartridge |
| Aluminium block | 15 mm dia × 5 mm, 2 × 6 mm holes | k ≈ 237 W/m·K |
| R_cond (thin shaft → block) | ~66 → ~3 K/W | the enabling fix |
| Heater temp (block design) | ~83 °C | feasible (vs 1450 °C self-heated) |
| Head exposed | 3.4 mm dia, side exposure 0…3.4 mm | sets slope + saturation |
| Block→head gap | 0…N mm | affects heater temp, not power |
| Sensing dividers | 3.3 V, R_series 10 kΩ | two NTC dividers → ADC0/ADC1; self-heat negligible |
| NTC pair | 10 K / 3950 | held ΔT exact in software (no bridge ratio drift) |
| Flow signal | duty × V_bus² / R | duty known (commanded); V_bus read on ADC2 (P ∝ V²) |
| V_bus swing | 11–15 V (nom 12) | must measure → ±2ΔV/V error without comp |
| Software PI | Kp≈0.03, Ki≈0.006 | duty out, clamp 0..1 + anti-windup; tuned for ~8.5 s pole |
| Two-node plant | C_hs≈2.0, C_el≈1.6 J/K, R_cond≈3 K/W | dominant thermal pole ~8.5 s |
| Probe turn-on t90 | seconds (block warms from cold) | all start at 100 % duty |

---

## 11. The app itself

`design/double-ntc-explorer/` — offline single-page app, vanilla JS, zero dependencies, runs from
`file://`. Mirrors `design/model-explorer`'s structure (`index.html`, `styles.css`, `charts.js`,
`diagram.js`, `model.js`, `app.js`) + `README.md` + `ltspice/`.

- **`model.js`** — `DoubleNTCModel`: pure physics + the digital readout. `heatedElementSteady`
  (returns `duty` and `P_report = duty·Pmax`), `deriveCalibration` (King's `a+b√v` fit),
  `flowAccuracy` (NTC-divider ADC noise → σ_ΔT → ±1σ lpm, ⊕ duty/V_bus term), `vbusCompBenefit`
  (V_drive-comp benefit), `twoNodePlant` + `turnOnTransient`/`flowStepResponse` (software PI on the
  two-node plant), `ntcDividerVoltage`/`ntcDividerSensitivity`, `deriveDetectionModel`, temp-comp
  sweep, and a self-contained single-probe comparison.
- **`diagram.js`** — `drawDiagram`: pipe cross-section with both wall-mounted NTCs, the probe head,
  the 3 mm neck/gap, the aluminium block with heater + sensor holes, PTFE collar (UNCHANGED).
  `drawCircuit`: the **digital block diagram** — two NTC dividers + V_bus divider → ADC0/1/2, an
  ESP32 block (T_up/T_dn, T_target, software PI, LEDC PWM), gate driver → MOSFET → 40 W heater,
  flow = duty·V_bus²/R, and a hardware fail-safe note.
- **Charts:** power-vs-flow (calibration), drive/duty vs flow, detection levels, ±1σ accuracy,
  CTD-vs-single-probe comparison, ΔT sweep, temperature-compensation overlay, turn-on/flow-step,
  and V_drive compensation.
- Verified throughout via Playwright MCP + `python3 -m http.server` (no real console errors beyond a
  favicon 404).

---

## 12. Conclusions

1. **CTD beats the single probe for flow-rate metering** — non-saturating `a+b√v` power signal,
   `1/√v` sensitivity decay, and intrinsic temperature compensation.
2. **Separate the heater from the NTCs.** Self-heated NTC is infeasible (conduction bottleneck).
3. **The aluminium heat-spreader block is the enabler** — drops R_cond ~66→3 K/W, heater ~83 °C.
4. **Side-wall exposure is the main design lever** — sets sensitivity slope and conduction headroom
   (buried-NTC saturation cap).
5. **The ΔT loop is fully digital (ESP32 software): read 2 NTCs + V_bus, software PI, LEDC PWM,
   flow = duty·V_bus²/R.** True constant ΔT (no Beta-ratio drift) and power-for-free, at the cost
   of an ADC-noise-limited ΔT and MCU-uptime dependence — so a **hardware watchdog + thermal
   cutout** fail-safe is mandatory, and **V_bus must be measured** (P ∝ V², 11–15 V bus). The
   analog loop is kept as a reference / fallback.
6. **Beta-ratio drift is now gone** (ΔT is held in software as a number); the old analog bridge's
   ~±10 % drift was a bridge artefact. Residual temperature dependence is only fluid-property drift.
7. **Verified** in JS (live), Python (numerics), and LTspice (electrothermal loop — analog variant).
