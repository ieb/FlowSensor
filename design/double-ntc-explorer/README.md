# DoubleNTC Flow Sensor Explorer

An offline, single-page tool to explore the **two-NTC constant-temperature-difference (CTD)**
flow sensor proposed in `../DoubleNTC.md`, and to quantify how it performs against the single
heated probe explored in `../model-explorer/`. It is the interactive companion to
`../DoubleNTC.md` and the project `../../README.md`.

## Running it

Open `index.html` in any modern browser — no build step, no server, no network. Everything
(charts, diagram, physics) is plain HTML/CSS/JS with zero dependencies.

If your browser blocks `file://` resource loading, serve the folder over HTTP:

```
cd design/double-ntc-explorer
python3 -m http.server 8770
# then open http://localhost:8770/index.html
```

## The idea

The single heated probe (model-explorer) cleanly separates air / still water / flow, but
measures *flow rate* poorly: the head→fluid temperature difference shrinks as flow rises, so
above ~15 l/min the reading flattens and the flow resolution collapses.

The DoubleNTC topology fixes this by inverting what is held constant and what is measured, and
the control loop now runs **entirely in ESP32 software** (the chosen design):

```
flow ──►  [ upstream NTC ]  ........  [ downstream NTC + HEATER ]
           reads T_up                   held at T_up + ΔT by the
           (cold reference)             ESP32 software PI loop
```

- The **upstream NTC** reads the undisturbed stream temperature `T_up`.
- The **downstream NTC** sits in a small element warmed by a **separate 40 W ceramic heater**.
  Both NTCs are low-power *sensors* on **3.3 V dividers**, each read by an ESP32 ADC channel (no
  self-heating). (Earlier revisions self-heated the downstream NTC directly, which forced an
  impractically low-resistance NTC — separating the heater removes that constraint.)
- The **ESP32 firmware closes the loop**: it converts the two divider voltages to `T_up`/`T_dn`
  (Beta equation), sets `T_target = T_up + ΔT`, runs a **software PI** (output clamped 0..1 with
  back-calculation anti-windup) and writes a **hardware PWM (LEDC)** duty to a gate driver +
  low-side MOSFET that switches the heater off the 12 V bus.
- The flow signal is the **electrical power** `P` the loop delivers to hold ΔT, computed in
  firmware from the **known duty** and the **measured bus voltage**: `P = duty · V_bus² / R`.
  There is **no analog op-amp, no Wheatstone bridge and no current-sense amplifier**.

In steady state the delivered power equals the heat the fluid removes:

```
P = ( h(v)·A_wet + G_para ) · ΔT
```

where `h(v)` is the convection coefficient (King's law: `h ∝ a + b·√v`), `A_wet` the wetted
area and `G_para` the parasitic conduction into the mount/leads. Two consequences make this a
better flow meter:

1. **No saturation.** Because `P ∝ √v`, the signal keeps climbing with flow — sensitivity
   degrades only as `1/√v`, never to zero.
2. **True temperature compensation.** ΔT is referenced to the *measured* fluid temperature, so
   the calibration barely moves with fluid temperature — no heater-off ambient measurement is
   needed (the single probe needs one). Because the digital loop holds ΔT as an explicit number
   (not a fixed resistor ratio), there is **no Beta-ratio drift** — the held ΔT is exact at every
   fluid temperature (the ~±10 % drift that the old analog *bridge* suffered is gone; the
   remaining spread is only fluid-property drift). The old analog variant is retained as a
   reference / fallback (see the LTspice section).

### Three gotchas the digital architecture forces you to handle

1. **V_drive compensation (P ∝ V²).** The flow signal is `duty · V_bus² / R`, quadratic in the
   bus voltage. A 12 V marine bus swings ~**11–15 V** (engine off vs alternator charging), so
   without measuring it a ±ΔV swing injects a **±2·ΔV/V** power error (±50 % at the extremes).
   The firmware therefore reads `V_bus` on a **third ADC channel** and uses the measured value,
   cutting the error to the V_bus-ADC accuracy (~±0.4 %). See the *V_drive compensation* chart.
2. **Heater fail-safe.** Software now owns 40 W, so a stuck loop could cook the block. A
   **hardware watchdog** forces the gate OFF if the firmware hangs, and a **thermal cutout** on
   the aluminium block is the final backstop. (With the old analog loop the regulation survived
   an MCU hang; the digital design trades that for programmability, so the fail-safe is mandatory.)
3. **ADC oversampling + calibration.** The held ΔT is now limited by ADC noise on the two NTC
   reads (σ_ΔT = √(σ_Tup²+σ_Tdn²) → flow error). The plant is slow (dominant thermal pole
   ~8.5 s), so the firmware can **oversample heavily** (≈64×) to drive that noise down, and should
   use the **eFuse Vref / two-point ADC calibration** so the NTC→temperature conversion is accurate.

## What it shows

All parameters are editable and everything recomputes live.

- **Sensor diagram** — the pipe bore with both NTCs **wall-mounted** (not centred) in the **same
  housing**, each protruding only the 3.4 mm head into the flow. For the **probe** it draws the
  full structure: the wetted head (NTC inside), the 3 mm neck, and the Ø15 × 5 aluminium block
  behind the wall with its two Ø6 holes (heater + NTC leads), coloured by temperature. The
  upstream housing is identical with its heater unpowered (cold reference). The readout shows the
  required heater power, duty cycle and the **heater temperature**, and **flags when the heater
  would have to exceed its max temperature (or 100 % duty) to hold ΔT**.
- **How the constant-ΔT loop works (fully digital)** — a block diagram with a step-by-step
  walkthrough: three ADC channels (ADC0 = upstream NTC divider, ADC1 = downstream NTC divider,
  ADC2 = divided-down V_bus); the firmware computing `T_up`/`T_dn` (Beta), `T_target = T_up + ΔT`
  and the error; the **software PI** (clamp 0..1 + anti-windup) → **LEDC PWM** → gate driver →
  low-side MOSFET → 40 W heater; the flow signal `P = duty · V_bus² / R`; and the **hardware
  fail-safe** (watchdog forces gate OFF, thermal cutout on the block).
- **Flow calibration — power vs flow** — the core curve, with air/still reference bands and the
  King's-law `a + b·√v` fit overlaid. Monotonic and non-saturating.
- **Heater duty cycle vs flow** — the fraction of the 40 W heater the PWM driver uses to hold ΔT;
  a 100 % band marks where the heater saturates and can no longer hold ΔT.
- **Detection levels — power by regime** — air sits at the parasitic floor, still water above
  it, flowing higher still; the air↔water and flow thresholds are drawn as bands.
- **Why two sensors — ±1σ resolution vs the single probe** — both signals read through the
  *same* ADC. The single probe's resolution blows up at high flow; the CTD's stays bounded.
- **Flow-rate accuracy — ±1σ vs flow (CTD)** — ADC noise on the two NTC dividers → σ_ΔT on the
  held ΔT, propagated through the calibration slope; a duty/V_bus-resolution term adds in
  quadrature.
- **V_drive compensation** — worst-case power error vs flow: without measuring V_bus (±2·ΔV/V
  over the 11–15 V swing) vs with V_bus compensation (limited by the V_bus-ADC accuracy).
- **ΔT trade-off** — power and resolution vs the chosen ΔT (bigger ΔT = stronger signal but
  more power and less boiling margin in water).
- **Temperature compensation** — power-vs-flow at 5–30 °C fluid temperature; the curves nearly
  coincide, demonstrating the built-in compensation.
- **Turn-on transient** — the loop driving the element to the ΔT set-point on a cold start. The
  controller doesn't know the medium, so the full-ΔT error saturates the drive to P_max for every
  scenario: they all heat at the same initial rate (P_max/C) and the medium that loses the least
  heat (air) reaches ΔT first, flowing last (and a medium whose loss exceeds P_max never reaches
  ΔT). Lower **Sim time** to zoom in — with a small element the rise is sub-second.
- **Flow-step response** — simulated with the actual software PI on the **two-node** thermal
  plant (heater block + element coupled through R_cond), so the slow ~8.5 s dominant pole shows;
  the sensor responds over seconds.
- **Detection model & ESP32 output** — power thresholds plus copy-paste C for the **full digital
  loop**: `adc_volts()` (oversampled), `temp_from_divider()` (Beta), `control_tick()` (reads
  ADC0/1/2, software PI with anti-windup, `ledcWrite()`, `P = duty·V_bus²/R`, feeds the watchdog),
  `classify()` by power, and a `flow_lpm(P)` lookup table.

### Heated element: probe vs tube vs bead

A selector switches the downstream element:

- **Probe (head + Al block)** — both NTCs share this housing: only the Ø9.2 × 3.4 head is wetted
  (NTC inside), connected by a short **3 mm metal neck** to a **Ø15 × 5 mm aluminium block** behind
  the wall that holds the cartridge heater in one Ø6 hole and the NTC leads in the other. The
  upstream reference is the identical housing with its heater unpowered.
- **316 tube** — a 5 mm tube whose whole active length is wetted and heated directly.
- **Glass bead** — a small wetted sphere, heater bonded directly to it.

| Element            | Air   | Still | 30 l/min flow | Heater temp @ 30 l/min (ΔT 10 °C) |
| ------------------ | ----- | ----- | ------------- | --------------------------------- |
| Probe (Al block)   | ~40 mW | ~1.0 W | **~17.5 W**  | **~83 °C → feasible, ~44 % duty** |
| 316 tube (5 mm)    | ~165 mW | ~1.2 W | ~24.6 W      | n/a (heated directly), ~62 % duty |
| Glass bead (2.5 mm)| ~16 mW  | ~74 mW | ~2.2 W       | n/a (heated directly), ~5.5 % duty |

**Why the aluminium block matters:** an earlier revision put the heater at the end of a long thin
316 shaft, which re-introduced the *conduction bottleneck* that crippled the single probe — to
hold the head at ΔT = 10 °C in fast seawater needed ~21 W through a ~66 K/W shaft, demanding an
impossible **~1450 °C** heater. Replacing the shaft with a **near-isothermal aluminium block only
3 mm from the head** collapses the path resistance to **R_cond ≈ 3 K/W**, so the heater now runs
at just **~83 °C at 30 l/min** — comfortably feasible across the whole flow range. The neck length
and conductivity (and the block) are editable, so you can see how `R_cond = gap / (k · A_head)`
sets the required heater temperature. The **bead** is still the most power-efficient option; the
**probe** is the chosen mechanical design and is now viable thanks to the heat-spreader block.

A **Side wall wetted** control (probe only) sets how much of the head's side wall is exposed to
the water, from 0 (front face only, sides in PTFE) up to the full head thickness. It is the
direct lever on the **slope** of the power-vs-flow curve, because the wetted area is
`A_wet = π/4·d² + π·d·L_side` and `P ≈ ΔT·h(v)·A_wet ∝ A_wet·√v`. Sweeping the side exposure on
the default head (NTC 2 mm deep, 316):

| Side wetted | P @ 30 l/min | slope @ 30 (W per l/min) | high-flow cap |
| ----------- | ------------ | ------------------------ | ------------- |
| 0 (front only) | ~2.9 W | ~0.02 | ~5 W |
| 1 mm | ~4.2 W | ~0.03 | ~7 W |
| 2 mm | ~6.3 W | ~0.06 | ~12 W |
| 3.4 mm (full) | ~17.5 W | ~0.33 | none |

Two things move together as you expose more side: the **wetted area grows** (steeper slope, more
power) **and** the buried-NTC series resistance `R_fn = (1−L_side/thick)·ntc_depth/(k·A)` fades
out, so the **high-flow saturation cap `ΔT/R_fn` rises and finally disappears** at full exposure.
At low exposure the head behaves like the single probe (shallow, saturating, but low power and a
cool heater); at full exposure it is the strong non-saturating King's-law curve (best resolution,
but more power and a hotter heater). The sensing point being buried behind the wetted surface is
what causes the saturation — full side wetting puts wetted metal right alongside the NTC.

The **block→head gap** (0 = block in direct contact, or set back by a neck) is adjustable too.
Note it only moves the **required heater temperature** (longer gap ⇒ hotter heater ⇒ eventual
feasibility limit), *not* the power/flow signal: with the NTC temperature held, only what lies
between the NTC and the water sets the heat throughput, so everything on the heater side of the
NTC just changes how hard the heater must push.

The **block→head gap** (0 = block in direct contact with the back face, or set back by a neck)
is adjustable in both wetting modes. Note it only moves the **required heater temperature**
(longer gap ⇒ hotter heater ⇒ eventual feasibility limit), *not* the power/flow signal: with the
NTC temperature held, only what lies between the NTC and the water sets the heat throughput, so
everything on the heater side of the NTC just changes how hard the heater must push.

## Representative results (defaults: ΔT 10 °C, fluid 20 °C, glass bead, ESP32 ADC)

| Quantity                         | Single probe | DoubleNTC (bead) |
| -------------------------------- | ------------ | ---------------- |
| 1σ flow resolution @ 30 l/min    | ~±23 l/min   | **~±1.1 l/min**  |
| Signal behaviour at high flow    | saturates    | keeps rising (√v) |
| Temperature compensation         | linear fit + heater-off ambient read | true constant ΔT (software), no Beta-ratio drift |
| Response time                    | seconds (head/block mass) | seconds (two-node plant, ~8.5 s pole) |

The ~20× resolution improvement at high flow, with true temperature compensation, is the case for
the two-NTC approach. The cost is the heater's power draw in water (watts, PWM'd off the bus) and
a separate heater — plus the digital design's dependence on the ESP32 (hence the hardware
watchdog + thermal cutout fail-safe).

## The model (see `model.js`)

- **Power balance:** `P = (h·A_wet + G_para)·ΔT`, with the element held at `T_fluid+ΔT`.
- **Convection:** Churchill–Bernstein (cylinder) for the tube, Whitaker (sphere) for the bead,
  blended with a still-water natural-convection floor; air adds a linearised radiation term.
- **Heater drive:** a separate heater of resistance `heater_R` on a `v_drive` rail, `P_max =
  v_drive²/heater_R`. The ESP32 software PI commands `duty = P/P_max` via LEDC PWM; the reported
  flow signal is `P = duty · v_drive² / heater_R` from the **known duty** and the **measured**
  bus (`v_drive_min`/`v_drive_max` bound the swing for the compensation chart). No current sense.
- **Sensing NTCs:** low-power on 3.3 V dividers (`ntc_vexc`, `ntc_rseries`); `senseSelfHeating`
  confirms the rise is negligible. `ntcDividerVoltage`/`ntcDividerSensitivity` give the ADC read
  and its dV/dT.
- **Control:** a software PI (`pi_kp`, `pi_ki`) with output clamp 0..1 and back-calculation
  anti-windup, tuned for the slow plant.
- **Accuracy:** ADC noise (random ÷√N ⊕ quantisation ⊕ INL floor) on each NTC divider →
  σ_T = σ_V/|dV/dT| → σ_ΔT = √(σ_Tup²+σ_Tdn²) → flow via the calibration; a duty-LSB + V_bus-ADC
  term adds in quadrature. `vbusCompBenefit` quantifies the V_drive-compensation gain. The
  single-probe comparison uses the same ADC.
- **Transients:** a **two-node** plant — heater+block node `C_hs` coupled through `R_cond` to the
  element/NTC node `C_el`, losing to fluid via `h·A+G_para` — reproducing the ~8.5 s dominant
  pole. Both turn-on and the flow step are simulated with the actual software PI (explicit Euler).

## The fully-digital control loop (software PI + LEDC PWM)

The ESP32 closes the ΔT loop **in software**: read both NTC dividers + V_bus on three ADCs,
compute `T_up`/`T_dn`, hold `T_dn = T_up + ΔT` with a software PI, and output hardware PWM (LEDC)
to the gate driver. The flow signal `P = duty·V_bus²/R` comes for free from the commanded duty.
`pi_kp`/`pi_ki` are the software gains; the plant's slow ~8.5 s pole sets the achievable bandwidth.

**Trade-off vs the analog loop:** simpler hardware, programmable, **true** constant ΔT (no
Beta-ratio drift), and power-for-free — at the cost of an **ADC-noise-limited ΔT** and a
**dependence on MCU uptime** (so the hardware watchdog + thermal cutout fail-safe is mandatory).
The analog loop (below) regulated ΔT even with the MCU asleep; it is retained as a reference /
fallback.

## The analog variant (reference / fallback)

The original design closed the ΔT loop in **analog hardware** (sensing bridge → instrumentation
amp → PI integrator → PWM comparator → MOSFET, with a current-sense shunt the ESP32 read). It is
kept as a documented fallback (and is what the LTspice netlists below model). Its signal chain:

```
 (1) BRIDGE ERROR  —  one-op-amp difference amplifier
                          Rf
                     ┌───/\/\───┐
   B (measured) ─/\/\┤           │
                 R   │ −\        │
                     │   >───────┴──► e = (A − B)·Rf/R
   A (target) ──/\/\─┤ +/            (how far the downstream NTC
                 R   │/               sits from the ΔT set-point)
                    [R]
                     │
                    GND
```

```
 (2) PI CONTROLLER  —  op-amp integrator (Cf) + proportional path (Rf)
                     Cf
                 ┌───||───┐         Cf → INTEGRAL term: output HOLDS when e = 0,
                 │   Rf   │              so the heater keeps its power at balance
                 ├──/\/\──┤         Rf → PROPORTIONAL term  ⇒  PI controller
          Ri     │  |\    │
   e ───/\/\─────┴──|−\   │
                    |  >──┴──► Vctrl   (heater-drive demand)
   Vset ───────────|+/
                    |/
```

```
 (3) PWM DRIVER + POWER STAGE                          +12 V
                                                         │
   ┌──────┐                                       [ 40 W heater ]
   │ OSC  ├── saw ──┐  comparator                        │
   └──────┘         └──|−\                               ●D
  triangle/saw         |  >── PWM ─[Rg]──── gate ───────┤G   M1  (n-MOSFET,
  (555 or op-amp       |+/                               ●S       low-side)
   relaxation)  Vctrl ─┘|/                                │
                   duty ∝ Vctrl                      [ R_sense ]
                                                         │
                                                        GND
   · · · · · · · · · · · · · · · · · · · · · · · · · · · ·│· · · · · ·  analog | digital
   ┌──────────────── ESP32 (monitor only) ─────────────┐ │
   │  ADC ◀── V_sense (across R_sense) ◀────────────────┼─┘
   │   P = I_avg·V_drive  →  flow_lpm(P) / classify / alarm / BLE
   │  ADC ◀── upstream-NTC divider  →  fluid temperature
   └─────────────────────────────────────────────────────┘
```

The comparator turns the PI output into a duty cycle (`Vctrl` on `+`, sawtooth on `−` ⇒ duty
rises with `Vctrl`); the MOSFET switches the 12 V rail through the heater, and the averaged
voltage across `R_sense` is the flow signal the ESP32 digitises. (A linear pass-FET could replace
the PWM stage but would dissipate `(12 − V_heater)·I` — far less efficient.) **The chosen design
moves this loop into the ESP32** — read both NTCs + V_bus, run a software PI, output hardware PWM
(LEDC) to the gate, compute `P = duty·V_bus²/R` — trading the analog loop's MCU-independent
regulation for exact/programmable ΔT, at the cost of an ADC-noise-limited ΔT and dependence on
MCU uptime (hence the hardware watchdog + thermal cutout). The netlists below model this analog
variant as a reference / fallback.

### Simulate it: `ltspice/doublentc_ctd_loop.cir`

> **Note:** the LTspice netlists model the **analog variant** (op-amp bridge + PI + PWM + current
> sense), retained as a reference / analog fallback. The chosen digital design runs the same loop
> dynamics in ESP32 software, but the thermal plant, the constant-ΔT behaviour and the King's-law
> power signal these netlists verify carry over unchanged.

A runnable LTspice netlist (`ltspice/doublentc_ctd_loop.cir`) verifies this loop with a
behavioural **electrothermal** model (node voltage = °C, B-source current = W, R = K/W,
C = J/K). Open it in LTspice (File → Open) and Run. It contains the same chain — difference amp →
PI integrator (with anti-windup) → sawtooth + comparator → PWM'd heater — driving a one-node
thermal plant, with a **flow step at t = 3 s**. You should see `V(Tdn)` hold at fluid + ΔT (= 30)
and `V(Pavg)` step from ~10 W to ~17.5 W (= G·ΔT) as flow increases, confirming the constant-ΔT
behaviour. Gains (`Kp`, `Ki`), `ΔT`, `Pmax`, flow `Gf` and the PWM frequency are all `.param`s at
the top to tune. (It models the loop dynamics; the NTC bridge is represented by the temperature
nodes directly rather than component-level dividers.)

### Component-level model: `ltspice/doublentc_ctd_components.cir`

A second netlist builds the **actual circuit out of components** to verify the real hardware (not
just the loop dynamics): two NTC thermistors as **Beta-model behavioural resistors** in a
**Wheatstone bridge**, an op-amp **difference amplifier**, an op-amp **PI integrator** with diode
output clamp / anti-windup, an op-amp **PWM comparator**, a **power MOSFET** (inline `VDMOS`)
switching the 12 V heater, and the **current-sense shunt + ×10 amplifier** the ESP32 ADC reads.
The op-amp is a self-contained single-pole macromodel (`.subckt OPAMP`) and the MOSFET model is
inline, so **no external libraries are needed**. Only the thermal plant (physics) and the PWM
carrier (a stand-in for a 555 / op-amp relaxation oscillator — a component version is in the
file's comments) remain behavioural.

Open and Run; with the same **flow step at t = 3 s** you should see `V(Tdn)` hold at fluid + ΔT
(= 30), `V(Th)` settle ~60 °C (still) / ~82 °C (flow), the bridge midpoints `V(nodeL)`/`V(nodeR)`
converge, and `V(vadc)` (the current-sense ADC voltage, ≈ I_avg in volts) step up with flow. The
bridge ratio `Ra/Rb` is set for ΔT = 10 at a 20 °C design point; running it at other `Vfl` values
reproduces the **±10 % Beta-ratio drift** (ΔT ≈ 9.0 °C at 5 °C fluid, 10.7 °C at 30 °C) noted in
`DESIGN_NOTES.md`.

A **drawn schematic** of the same circuit is in **`ltspice/doublentc_ctd_components.asc`** (open it in
the LTspice GUI). Both files were **verified in LTspice 17.2.4**: the loop holds `V(Tdn)` ≈ 30 °C
(29.8 still / 30.0 flow), heater body `V(Th)` ≈ 59 °C (still) / 82 °C (flow), and `V(vadc)` (≈ I_avg)
steps **0.9 → 1.5 A** at the flow step — true constant-ΔT regulation. Note the **physical settling
time is ~10–30 s**: the aluminium block + element mass through the conduction resistance give a
dominant thermal time constant of ~8.5 s, so this sensor responds over tens of seconds, not instantly
— a real design characteristic the component model exposes. (The macOS LTspice CLI can't batch-netlist
`.asc` files; open the schematic in the GUI — the `.cir` runs in batch.)

## Assumptions & limitations

- The control loop is the **actual software PI** on a two-node thermal plant (block + element
  through R_cond), so the ~8.5 s dominant pole and loop bandwidth show; op-amp/driver electronics,
  PWM ripple and ADC sample timing are out of scope. In hardware, bond the heater close to the
  downstream NTC so the coupling is tight and repeatable.
- **ΔT is held in software as an explicit number**, so the digital loop has **no Beta-ratio
  drift** (the ~±10 % drift was an artefact of the analog fixed-resistor bridge). Residual
  temperature dependence is only from fluid-property drift; calibrate that out if needed.
- **The held ΔT is ADC-noise-limited.** σ on the two NTC reads sets σ_ΔT; oversample (the plant
  is slow) and use eFuse-Vref / two-point ADC calibration.
- Seawater properties are **fixed at ~20 °C**; the temperature-compensation chart shows the
  *geometric* compensation only — real fluid-property drift adds a few percent.
- The upstream NTC is assumed to read `T_fluid` with **negligible self-heating** and to sit
  outside the heated element's wake — true only for the **design flow direction**; at zero or
  reverse flow the heated wake can warm the reference (a real limitation).
- **Fouling / salt scaling** changes the wetted `h` and would re-scale the calibration; not
  modelled.
- This tool produces the **model, calibration and detection coefficients only**. The detailed
  analog design (in-amp, PI compensation, PWM stage, MOSFET), ADC sampling, BLE GATT and firmware
  are downstream work.
