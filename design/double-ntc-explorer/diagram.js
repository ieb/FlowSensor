/*
 * diagram.js — Schematic of the two-NTC constant-ΔT flow sensor. Pure canvas.
 *
 * drawDiagram (the pipe cross-section, top): flow passing the UPSTREAM reference
 * NTC (cold) and then the DOWNSTREAM heated element held at T_fluid+ΔT, with its
 * thermal wake trailing downstream. UNCHANGED by the digital-control refactor.
 *
 * drawCircuit (the control schematic, bottom): the FULLY-DIGITAL loop — two NTC
 * dividers and a Vbus divider feeding three ESP32 ADC channels, the firmware
 * computing T_up/T_dn, T_target = T_up+ΔT, a software PI and a LEDC PWM output to a
 * gate driver + low-side MOSFET that switches the 40 W heater off the 12 V bus. The
 * flow signal is computed as duty × Vbus²/R (no analog op-amps, no current sense).
 */

(function (global) {
  'use strict';

  // Blue -> cyan -> green -> yellow -> red colormap for t in [0,1].
  function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    const stops = [
      [0.0, [40, 90, 200]],
      [0.35, [40, 180, 200]],
      [0.6, [120, 200, 90]],
      [0.8, [240, 200, 60]],
      [1.0, [220, 60, 50]],
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const [a, ca] = stops[i],
        [b, cb] = stops[i + 1];
      if (t >= a && t <= b) {
        const f = (t - a) / (b - a);
        const c = ca.map((v, k) => Math.round(v + f * (cb[k] - v)));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    return 'rgb(220,60,50)';
  }

  function drawDiagram(canvas, p, result, scenario) {
    const M = global.DoubleNTCModel;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(360, rect.width),
      H = Math.max(260, rect.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // ---- pipe region (top ~55%) ----
    const pipeTop = 34,
      pipeBot = H * 0.55;
    const pipeMidY = (pipeTop + pipeBot) / 2;
    const xL = 20,
      xR = W - 20;

    const fluidColor = scenario === 'air' ? '#eef2f7' : '#dceffb';
    ctx.fillStyle = fluidColor;
    ctx.fillRect(xL, pipeTop, xR - xL, pipeBot - pipeTop);
    // pipe walls
    ctx.strokeStyle = '#9aa6bd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xL, pipeTop);
    ctx.lineTo(xR, pipeTop);
    ctx.moveTo(xL, pipeBot);
    ctx.lineTo(xR, pipeBot);
    ctx.stroke();

    const fluidName =
      scenario === 'air' ? 'AIR' : scenario === 'flowing' ? 'FLOWING SEAWATER' : 'STILL SEAWATER';
    ctx.fillStyle = '#6b87a3';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${fluidName}  ${p.T_fluid.toFixed(0)}°C`, xL + 6, pipeTop - 12);

    // flow direction arrows (only when flowing)
    if (scenario === 'flowing') {
      ctx.strokeStyle = '#69b6d5';
      ctx.fillStyle = '#69b6d5';
      ctx.lineWidth = 2;
      const arrow = (ay) => {
        ctx.beginPath();
        ctx.moveTo(xL + 8, ay);
        ctx.lineTo(xL + 70, ay);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(xL + 70, ay);
        ctx.lineTo(xL + 62, ay - 4);
        ctx.lineTo(xL + 62, ay + 4);
        ctx.closePath();
        ctx.fill();
      };
      arrow(pipeTop + 16);
      arrow(pipeBot - 16);
    }

    // sensor positions along the pipe
    const xUp = xL + (xR - xL) * 0.30; // upstream reference NTC
    const xDn = xL + (xR - xL) * 0.62; // downstream heated element
    const scale = (xDn - xUp) / Math.max(2, p.spacing_mm); // px per mm

    // ---- thermal wake of the heated element, trailing downstream along the wall ----
    if (scenario !== 'air') {
      const wakeColor = scenario === 'flowing' ? 'rgba(225,120,80,0.18)' : 'rgba(225,120,80,0.10)';
      ctx.fillStyle = wakeColor;
      const wakeLen = scenario === 'flowing' ? (xR - xDn) * 0.9 : (xR - xDn) * 0.4;
      ctx.beginPath();
      ctx.moveTo(xDn, pipeBot - 6);
      ctx.lineTo(xDn + wakeLen, pipeBot - 34);
      ctx.lineTo(xDn + wakeLen, pipeBot - 6);
      ctx.closePath();
      ctx.fill();
    }

    // Both sensors are mounted on the pipe wall (here the lower wall), protruding
    // only a little into the flow, with leads passing out through the wall.
    function wallMount(xc, half) {
      ctx.fillStyle = '#c9ccd1';
      ctx.fillRect(xc - half, pipeBot - 2, half * 2, 5);
      ctx.strokeStyle = '#8a8d92';
      ctx.lineWidth = 1;
      ctx.strokeRect(xc - half, pipeBot - 2, half * 2, 5);
    }

    const hot = heatColor(0.78);
    if (M.isProbe(p)) {
      // Both NTCs share the SAME housing: head at the wall, a 3 mm neck, then a
      // Ø15×5 aluminium block holding the cartridge heater + the NTC leads. The
      // upstream one is identical but its heater is unpowered (cold reference).
      const probeS = Math.min(
        7,
        Math.max(
          3,
          Math.min(
            (H - pipeBot - 46) / (p.probe_gap_mm + p.al_thick_mm + 3),
            ((xDn - xUp) / 2 - 12) / (p.al_dia_mm / 2)
          )
        )
      );
      drawProbeHousing(ctx, p, result, xUp, pipeTop, pipeBot, probeS, false); // upstream, cold
      drawProbeHousing(ctx, p, result, xDn, pipeTop, pipeBot, probeS, true); // downstream, heated
    } else {
      // ---- upstream reference NTC (cold bead on the wall) ----
      const upR = 7;
      const upCy = pipeBot - upR - 2;
      ctx.strokeStyle = '#5a6b80';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xUp, upCy);
      ctx.lineTo(xUp, pipeBot + 14);
      ctx.stroke();
      wallMount(xUp, 11);
      ctx.fillStyle = heatColor(0.05);
      ctx.beginPath();
      ctx.arc(xUp, upCy, upR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      label(ctx, xUp, pipeTop + 14, 'upstream NTC (on wall)', '#2d7dd2');
      label(ctx, xUp, pipeTop + 27, `ref ${p.T_fluid.toFixed(0)}°C`, '#2d7dd2');

      // ---- downstream heated element (bead or tube, wall-mounted) ----
      if (M.isBead(p)) {
        const r = Math.max(6, (p.bead_dia_mm / 2) * scale);
        const cy = pipeBot - r - 1;
        ctx.strokeStyle = '#5a6b80';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xDn, cy);
        ctx.lineTo(xDn, pipeBot + 14);
        ctx.stroke();
        wallMount(xDn, r + 3);
        ctx.fillStyle = hot;
        ctx.beginPath();
        ctx.arc(xDn, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#7a2a22';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = 'rgba(120,120,130,0.55)';
        ctx.beginPath();
        ctx.arc(xDn, cy, r, 0.0, Math.PI, false);
        ctx.fill();
      } else {
        const halfW = Math.max(4, (p.tube_od_mm / 2) * scale);
        const len = Math.max(18, p.active_len_mm * scale);
        ctx.fillStyle = hot;
        ctx.fillRect(xDn - halfW, pipeBot - len, halfW * 2, len);
        ctx.strokeStyle = '#7a2a22';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(xDn - halfW, pipeBot - len, halfW * 2, len);
        const boreHalf = Math.max(1.5, (p.tube_id_mm / 2) * scale);
        ctx.fillStyle = '#fff';
        ctx.fillRect(xDn - boreHalf, pipeBot - len, boreHalf * 2, len);
        wallMount(xDn, halfW + 3);
      }
      label(ctx, xDn, pipeTop + 14, 'heated element', '#b23');
      label(ctx, xDn, pipeTop + 27, `${(p.T_fluid + p.delta_T).toFixed(0)}°C  (+${p.delta_T.toFixed(0)})`, '#b23');
    }

    // spacing dimension between the two wall-mounted sensors (drawn up in the flow)
    const dimY = pipeBot - 44;
    ctx.strokeStyle = '#8b97a8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xUp, dimY);
    ctx.lineTo(xDn, dimY);
    ctx.stroke();
    [xUp, xDn].forEach((x) => {
      ctx.beginPath();
      ctx.moveTo(x, dimY - 3);
      ctx.lineTo(x, dimY + 3);
      ctx.stroke();
    });
    ctx.fillStyle = '#8b97a8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${p.spacing_mm.toFixed(0)} mm`, (xUp + xDn) / 2, dimY - 4);

    // ---- readout strip (bottom of the canvas) ----
    ctx.textAlign = 'left';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = '#33405a';
    const ry = H - 30;
    const Pstr = result.P >= 1 ? `${result.P.toFixed(2)} W` : `${(result.P * 1000).toFixed(0)} mW`;
    const heaterTxt = result.R_cond > 0 ? `   heater ${result.T_heater.toFixed(0)}°C` : '';
    ctx.fillText(
      `Hold ΔT=${p.delta_T.toFixed(0)}°C  →  P = ${Pstr}   duty = ${Math.min(100, result.duty * 100).toFixed(0)}%   ` +
        `h = ${result.h.toFixed(0)} W/m²K${heaterTxt}`,
      xL,
      ry
    );
    if (!result.power_ok) {
      ctx.fillStyle = '#b23';
      const why = !result.heat_ok
        ? `heater would need ${result.T_heater.toFixed(0)}°C (> ${p.heater_tmax_c.toFixed(0)}°C limit) to push ${Pstr} down the shaft`
        : `needs ${Pstr} > ${result.P_max.toFixed(0)} W heater`;
      ctx.fillText(`⚠ can't hold ΔT here — ${why}`, xL, ry + 15);
    }

    // ---- colour scale legend ----
    drawColorbar(ctx, W, H, p);
  }

  function drawLead(ctx, x, y, yBottom) {
    ctx.strokeStyle = '#5a6b80';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, yBottom + 4);
    ctx.stroke();
  }

  // Shared NTC housing, WALL-MOUNTED: only the Ø9.2 × 3.4 head pokes into the flow
  // (NTC inside); a 3 mm conduction neck connects it to a Ø15 × 5 aluminium block
  // (behind the wall) that holds the cartridge heater in one Ø6 hole and the NTC
  // leads in the other. The block is a near-isothermal spreader, so the heater is
  // effectively only the 3 mm neck from the head. `heated`=false draws the identical
  // upstream housing with its heater unpowered (cold reference).
  function drawProbeHousing(ctx, p, result, xc, pipeTop, pipeBot, s, heated) {
    const Lexp = Math.max(0, Math.min(p.head_side_exposed_mm, p.probe_head_thick_mm));
    const exposedFrac = p.probe_head_thick_mm > 0 ? Lexp / p.probe_head_thick_mm : 1;
    const headHalf = Math.max(14, (p.probe_head_dia_mm / 2) * s);
    const headH = Math.max(8, p.probe_head_thick_mm * s);
    const neckHalf = Math.max(5, (p.probe_head_dia_mm / 2) * s * 0.7);
    const blockHalf = Math.max(16, (p.al_dia_mm / 2) * s);
    const blockH = Math.max(12, p.al_thick_mm * s);
    const holeR = Math.max(3, (p.al_hole_mm / 2) * s);

    const headTop = pipeBot - headH;
    const neckLen = p.probe_gap_mm * s; // block→head gap (0 = direct contact)
    const neckBot = pipeBot + neckLen;
    const blockTop = neckBot;
    const blockBot = blockTop + blockH;

    const tHead = heated ? p.T_fluid + p.delta_T : p.T_fluid;
    const tBlock = heated ? result.T_heater : p.T_fluid;
    const tnHead = Math.max(0, Math.min(1, (tHead - p.T_fluid) / 80));
    const tnBlock = Math.max(0, Math.min(1, (tBlock - p.T_fluid) / 80));

    // conduction neck (metal) between head and block, gradient head→block
    const g = ctx.createLinearGradient(0, pipeBot, 0, neckBot);
    g.addColorStop(0, heatColor(tnHead));
    g.addColorStop(1, heatColor(tnBlock));
    if (neckLen > 0.5) {
      ctx.fillStyle = g;
      ctx.fillRect(xc - neckHalf, pipeBot, neckHalf * 2, neckLen);
      ctx.strokeStyle = '#5a5a5a';
      ctx.lineWidth = 1;
      ctx.strokeRect(xc - neckHalf, pipeBot, neckHalf * 2, neckLen);
    }
    if (neckLen > 5)
      label(ctx, xc + neckHalf + 12, pipeBot + neckLen / 2 + 3, `${p.probe_gap_mm} mm gap`, '#8b97a8', '9px');

    // aluminium block
    ctx.fillStyle = heatColor(tnBlock);
    roundRect(ctx, xc - blockHalf, blockTop, blockHalf * 2, blockH, 3);
    ctx.fill();
    ctx.strokeStyle = '#5a5a5a';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const holeY = (blockTop + blockBot) / 2;
    const holeOff = blockHalf * 0.45;
    // heater hole (left)
    ctx.fillStyle = heated ? heatColor(0.98) : '#aeb6c2';
    ctx.beginPath();
    ctx.arc(xc - holeOff, holeY, holeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = heated ? '#7a2a22' : '#8a8d92';
    ctx.lineWidth = 1;
    ctx.stroke();
    // sensor hole (right) with the NTC lead
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(xc + holeOff, holeY, holeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8a8d92';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(xc + holeOff, holeY);
    ctx.lineTo(xc + holeOff, blockBot + 12);
    ctx.stroke();
    if (heated) {
      ctx.strokeStyle = '#b23';
      ctx.beginPath();
      ctx.moveTo(xc - holeOff, holeY);
      ctx.lineTo(xc - holeOff, blockBot + 12);
      ctx.stroke();
    }

    // pipe-wall mount flange
    ctx.fillStyle = '#c9ccd1';
    ctx.fillRect(xc - (blockHalf - 2), pipeBot - 2, (blockHalf - 2) * 2, 5);
    ctx.strokeStyle = '#8a8d92';
    ctx.lineWidth = 1;
    ctx.strokeRect(xc - (blockHalf - 2), pipeBot - 2, (blockHalf - 2) * 2, 5);

    // head (wetted) — only the 3.4 mm protrudes into the flow
    ctx.fillStyle = heatColor(tnHead);
    roundRect(ctx, xc - headHalf, headTop, headHalf * 2, headH, 3);
    ctx.fill();
    ctx.strokeStyle = '#7a2a22';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // PTFE collar over the UNEXPOSED (back) portion of the head sides. The front
    // (top) `exposedFrac` of the side is wetted; the rest (toward the wall) is PTFE.
    if (exposedFrac < 0.999) {
      const cw = 6;
      const collarH = headH * (1 - exposedFrac);
      const collarY = pipeBot - collarH; // sits at the wall side of the head
      [-1, 1].forEach((sgn) => {
        const x0 = sgn < 0 ? xc - headHalf - cw : xc + headHalf;
        ptfeHatch(ctx, x0, collarY, cw, collarH);
      });
    }
    const ntcY = headTop + Math.min(headH - 2, p.probe_ntc_from_face_mm * s);
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(xc, ntcY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // labels
    if (heated) {
      const wettedTxt = exposedFrac < 0.02 ? 'front face only' : `face + ${Lexp.toFixed(1)} mm side`;
      label(ctx, xc, pipeTop + 14, `heated head — ${wettedTxt}`, '#b23');
      label(ctx, xc, pipeTop + 27, `NTC ${(p.T_fluid + p.delta_T).toFixed(0)}°C`, '#1a6');
    } else {
      label(ctx, xc, pipeTop + 14, 'upstream NTC — same housing', '#2d7dd2');
      label(ctx, xc, pipeTop + 27, `ref ${p.T_fluid.toFixed(0)}°C`, '#2d7dd2');
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#62708a';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(`Al Ø${p.al_dia_mm}×${p.al_thick_mm} block`, xc, blockBot + 6);
    if (heated) {
      ctx.fillStyle = result.heat_ok ? '#62708a' : '#b23';
      ctx.fillText(`heater ${result.T_heater.toFixed(0)}°C${result.heat_ok ? '' : ' ⚠'}`, xc, blockBot + 18);
    }
  }

  function ptfeHatch(ctx, x, y, w, h) {
    ctx.fillStyle = '#ece9e3';
    ctx.fillRect(x, y, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = '#cfc8bb';
    ctx.lineWidth = 1;
    for (let xx = x - h; xx < x + w; xx += 5) {
      ctx.beginPath();
      ctx.moveTo(xx, y + h);
      ctx.lineTo(xx + h, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#cfc8bb';
    ctx.strokeRect(x, y, w, h);
  }

  function label(ctx, x, y, text, color, font) {
    ctx.fillStyle = color || '#33405a';
    ctx.font = `${font || '600 11px'} system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  }

  // ==========================================================================
  // FULLY-DIGITAL block diagram of the constant-ΔT control loop.
  //
  // Three ADC channels feed the ESP32: ADC0 = upstream NTC divider (→ T_up),
  // ADC1 = downstream NTC divider (→ T_dn), ADC2 = Vbus divider (→ V_drive). The
  // firmware computes T_target = T_up + ΔT, runs a software PI (clamp 0..1 +
  // anti-windup) and writes a LEDC PWM duty to a gate driver + low-side MOSFET that
  // switches the 40 W heater off the 12 V bus. The flow signal is computed in
  // firmware as duty × Vbus² / R. No op-amps, no current sense. A hardware watchdog
  // forces the gate OFF and a thermal cutout on the block backs it up.
  // ==========================================================================
  function drawCircuit(canvas, p, result) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(680, rect.width),
      H = Math.max(360, rect.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fbfcfe';
    ctx.fillRect(0, 0, W, H);

    const SW = 720;
    const ox = Math.max(12, (W - SW) / 2);
    const X = (x) => ox + x;

    const wire = '#33405a';
    const hot = heatColor(0.8);
    const cold = heatColor(0.08);
    const sense = '#2d7dd2';
    const heatRail = '#b23';
    const pwmCol = '#f26419';
    const fmtW = (P) => (P >= 1 ? `${P.toFixed(2)} W` : `${(P * 1000).toFixed(0)} mW`);

    // x positions of the three sensing dividers
    const x0 = 40, // upstream NTC divider → ADC0
      x1 = 104, // downstream NTC divider → ADC1
      x2 = 168; // Vbus divider → ADC2
    const svY = 40, // 3.3 V sensing rail
      midY = 150, // divider midpoints (ADC taps)
      gndY = 232; // divider grounds
    // ESP32 block
    const espX = 268,
      espY = 64,
      espW = 210,
      espH = 196;
    // heater column
    const hvY = 40, // 12 V bus rail
      heatX = 624,
      gdX = 520; // gate driver

    // ===================== 3.3 V sensing dividers =====================
    hline(ctx, X(x0 - 12), X(x2 + 12), svY, sense);
    label(ctx, X(x0 - 12), svY - 7, '3.3 V', sense, '600 10px');
    // upstream NTC divider (Rs top, NTC bottom) → ADC0
    vResistor(ctx, X(x0), svY, midY - 14, 'Rs', null, wire);
    vResistor(ctx, X(x0), midY + 14, gndY, 'NTC↑', 'upstream', cold);
    vline(ctx, X(x0), midY - 14, midY + 14, wire);
    dot(ctx, X(x0), midY, sense);
    // downstream NTC divider → ADC1
    vResistor(ctx, X(x1), svY, midY - 14, 'Rs', null, wire);
    vResistor(ctx, X(x1), midY + 14, gndY, 'NTC↓', 'downstream', hot);
    vline(ctx, X(x1), midY - 14, midY + 14, wire);
    dot(ctx, X(x1), midY, heatRail);
    // Vbus divider (off the 12 V rail) → ADC2
    hline(ctx, X(x2), X(heatX), hvY, heatRail); // 12 V rail spans across to the heater
    label(ctx, X(x2 + 30), hvY - 7, '12 V bus (V_drive)', heatRail, '600 10px');
    vResistor(ctx, X(x2), hvY, midY - 14, 'Ra', null, wire);
    vResistor(ctx, X(x2), midY + 14, gndY, 'Rb', 'Vbus sense', '#7768ae');
    vline(ctx, X(x2), midY - 14, midY + 14, wire);
    dot(ctx, X(x2), midY, '#7768ae');
    // common ground bar for the three dividers
    hline(ctx, X(x0 - 12), X(x2 + 12), gndY, wire);
    groundSym(ctx, X(x1), gndY);

    // ADC tap wires into the ESP32
    const adcYs = [espY + 34, espY + 60, espY + 86];
    [
      [x0, adcYs[0], 'ADC0', sense],
      [x1, adcYs[1], 'ADC1', heatRail],
      [x2, adcYs[2], 'ADC2', '#7768ae'],
    ].forEach(([xx, yy, tag, col]) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(X(xx), midY);
      ctx.lineTo(X(xx), yy);
      ctx.lineTo(X(espX), yy);
      ctx.stroke();
      label(ctx, X(espX) - 22, yy - 4, tag, col, '600 9px');
    });
    label(ctx, X((x0 + x2) / 2), gndY + 26, 'low-current dividers — no self-heating', '#62708a', '9px');

    // ===================== ESP32 firmware block =====================
    block(ctx, X(espX), espY, espW, espH, '', '', '#eef3fb');
    label(ctx, X(espX + espW / 2), espY + 14, 'ESP32  (software control loop)', '#33405a', '600 12px');
    const lines = [
      ['T_up, T_dn ← ADC0/1 (Beta)', '#33405a'],
      ['T_target = T_up + ΔT', '#33405a'],
      [`software PI  (clamp 0..1, AW)`, '#2d7dd2'],
      [`LEDC PWM  →  duty ${(result.duty * 100).toFixed(0)}%`, pwmCol],
      ['V_drive ← ADC2', '#7768ae'],
      ['flow ← duty × V_bus² / R', '#1a7f4b'],
    ];
    ctx.textAlign = 'left';
    lines.forEach((ln, i) => {
      label(ctx, X(espX + 14), espY + 44 + i * 24, ln[0], ln[1], i >= 2 ? '600 11px' : '11px');
    });
    ctx.textAlign = 'center';

    // ===================== PWM → gate driver → MOSFET → heater =====================
    const pwmY = espY + 86 + 24 * 1; // align near the LEDC line
    hline(ctx, X(espX + espW), X(gdX), pwmY, pwmCol); // LEDC PWM out
    label(ctx, X((espX + espW + gdX) / 2), pwmY - 6, 'PWM', pwmCol, '600 9px');
    block(ctx, X(gdX), pwmY - 18, 64, 36, 'gate', 'driver', '#fff2e8');
    const mosY = 196;
    hline(ctx, X(gdX + 64), X(heatX) - 26, mosY, wire); // gate-driver out → MOSFET gate
    vline(ctx, X(gdX + 32), pwmY + 18, mosY, pwmCol); // driver down to the gate row
    hline(ctx, X(gdX + 32), X(heatX) - 26, mosY, wire);

    // 12 V → heater → MOSFET → ground
    vResistor(ctx, X(heatX), hvY, 132, '40 W heater', `${p.heater_R.toFixed(1)} Ω`, hot);
    vline(ctx, X(heatX), 132, mosY - 24, wire); // heater → drain
    mosfet(ctx, X(heatX), mosY, wire); // low-side switch
    vline(ctx, X(heatX), mosY + 24, gndY, wire);
    hline(ctx, X(heatX - 12), X(heatX + 12), gndY, wire);
    groundSym(ctx, X(heatX), gndY);
    label(ctx, X(heatX) + 34, 120, fmtW(result.P_report), '#1a7f4b', '600 11px');
    if (!result.power_ok) label(ctx, X(heatX) + 34, 134, `> ${result.P_max.toFixed(0)} W!`, heatRail, '600 10px');

    // ===================== fail-safe note =====================
    ctx.strokeStyle = '#c0392b';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(X(gdX + 32), mosY + 6);
    ctx.lineTo(X(gdX + 32), gndY + 18);
    ctx.lineTo(X(heatX), gndY + 18);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, X((gdX + heatX) / 2 + 16), gndY + 30, 'FAIL-SAFE: watchdog forces gate OFF', '#c0392b', '9px');
    label(ctx, X((gdX + heatX) / 2 + 16), gndY + 41, '+ thermal cutout on the Al block', '#c0392b', '9px');

    // ===================== caption =====================
    ctx.fillStyle = '#62708a';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Fully digital: the ESP32 reads two NTC dividers + Vbus on three ADCs, runs a software PI, and LEDC-PWMs the 40 W heater. Flow = duty × V_bus² / R (no op-amps, no current sense).',
      W / 2,
      H - 12
    );
  }

  // ---- schematic primitives ----
  function hline(ctx, x1, x2, y, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();
  }
  function vline(ctx, x, y1, y2, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
    ctx.stroke();
  }
  function dot(ctx, x, y, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // a no-connect hop (small semicircle) where a wire crosses another
  function hop(ctx, x, y, color) {
    ctx.strokeStyle = '#fbfcfe';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 5, Math.PI, 0, false);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, 5, Math.PI, 0, false);
    ctx.stroke();
  }
  // vertical zigzag resistor between (x,yTop) and (x,yBot)
  function vResistor(ctx, x, yTop, yBot, name, sub, color) {
    const lead = 10;
    const zTop = yTop + lead,
      zBot = yBot - lead;
    ctx.strokeStyle = color || '#33405a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, zTop);
    const seg = (zBot - zTop) / 6,
      amp = 6;
    for (let i = 0; i < 6; i++) {
      const yy = zTop + seg * (i + 0.5);
      ctx.lineTo(x + (i % 2 === 0 ? amp : -amp), yy);
    }
    ctx.lineTo(x, zBot);
    ctx.lineTo(x, yBot);
    ctx.stroke();
    if (name) {
      ctx.fillStyle = color || '#33405a';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, x + amp + 6, (zTop + zBot) / 2 - 6);
      if (sub) {
        ctx.fillStyle = '#62708a';
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillText(sub, x + amp + 6, (zTop + zBot) / 2 + 7);
      }
    }
  }
  // horizontal zigzag resistor between (xL,y) and (xR,y)
  function hResistor(ctx, xL, xR, y, name, sub, color) {
    const lead = 10;
    const zL = xL + lead,
      zR = xR - lead;
    ctx.strokeStyle = color || '#33405a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(xL, y);
    ctx.lineTo(zL, y);
    const seg = (zR - zL) / 6,
      amp = 6;
    for (let i = 0; i < 6; i++) {
      const xx = zL + seg * (i + 0.5);
      ctx.lineTo(xx, y + (i % 2 === 0 ? amp : -amp));
    }
    ctx.lineTo(zR, y);
    ctx.lineTo(xR, y);
    ctx.stroke();
    // labels below the wire (the area above carries the ADC tap)
    ctx.fillStyle = color || '#33405a';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(name, (xL + xR) / 2, y + amp + 4);
    if (sub) {
      ctx.fillStyle = '#62708a';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(sub, (xL + xR) / 2, y + amp + 16);
    }
  }
  function opAmp(ctx, xIn, yMid, xTip, color) {
    const h = 40;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(xIn, yMid - h);
    ctx.lineTo(xIn, yMid + h);
    ctx.lineTo(xTip, yMid);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  function groundSym(ctx, x, y) {
    ctx.strokeStyle = '#33405a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 8);
    ctx.stroke();
    for (let i = 0; i < 3; i++) {
      const w = 14 - i * 5;
      ctx.beginPath();
      ctx.moveTo(x - w / 2, y + 8 + i * 4);
      ctx.lineTo(x + w / 2, y + 8 + i * 4);
      ctx.stroke();
    }
  }
  function chip(ctx, cx, cy, title, val, fill) {
    const w = 56,
      h = 30;
    ctx.fillStyle = fill || '#fff';
    ctx.strokeStyle = '#9aa6bd';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(cx - w / 2, cy - h / 2, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#33405a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText(title, cx, cy - 5);
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = '#62708a';
    ctx.fillText(val, cx, cy + 7);
  }
  function arrowOnWire(ctx, x1, y1, x2, y2, color) {
    const mx = (x1 + x2) / 2,
      my = (y1 + y2) / 2;
    const dir = x2 > x1 ? -1 : 1; // arrowhead points along current flow (out->Vt)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx + dir * 9, my - 4);
    ctx.lineTo(mx + dir * 9, my + 4);
    ctx.closePath();
    ctx.fill();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function block(ctx, x, y, w, h, title, sub, fill) {
    ctx.fillStyle = fill || '#fff';
    ctx.strokeStyle = '#9aa6bd';
    ctx.lineWidth = 1.2;
    roundRect(ctx, x, y, w, h, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#33405a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText(title, x + w / 2, y + h / 2 - 6);
    if (sub) {
      ctx.fillStyle = '#62708a';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(sub, x + w / 2, y + h / 2 + 8);
    }
  }
  // simple n-channel MOSFET (low-side switch), gate lead entering from the left
  function mosfet(ctx, cx, cy, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    vline(ctx, cx, cy - 12, cy + 12, color); // channel bar
    vline(ctx, cx - 6, cy - 9, cy + 9, color); // gate plate
    hline(ctx, cx - 26, cx - 6, cy, color); // gate lead
    vline(ctx, cx, cy - 24, cy - 12, color); // drain lead
    vline(ctx, cx, cy + 12, cy + 24, color); // source lead
    label(ctx, cx + 14, cy + 3, 'M1', '#62708a', '9px');
  }

  function drawColorbar(ctx, W, H, p) {
    const bx = W - 22,
      by = 40,
      bw = 10,
      bh = 90;
    const g = ctx.createLinearGradient(0, by + bh, 0, by);
    for (let i = 0; i <= 10; i++) g.addColorStop(i / 10, heatColor(i / 10));
    ctx.fillStyle = g;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#9aa6bd';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#62708a';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('hot', bx - 3, by + 6);
    ctx.fillText('cold', bx - 3, by + bh - 2);
  }

  global.DoubleNTCDiagram = { drawDiagram, drawCircuit, heatColor };
})(typeof window !== 'undefined' ? window : globalThis);
