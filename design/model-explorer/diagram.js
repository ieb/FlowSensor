/*
 * diagram.js — Scaled cross-section of the sensor with a live temperature
 * gradient and a thermal-network overlay. Pure canvas drawing.
 *
 * Layout (probe axis horizontal): the self-regulating PTC / aluminium block sits
 * at the LEFT (hot), the stainless shaft runs to the right inside a PTFE sleeve,
 * and the head — the only wetted part — is at the RIGHT, immersed in the fluid.
 */

(function (global) {
  'use strict';

  // Blue -> cyan -> yellow -> red colormap for t in [0,1].
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
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(360, rect.width),
      H = Math.max(260, rect.height);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const totalLen = p.shaft_len_mm + p.head_thick_mm; // mm
    const marginL = 110,
      marginR = 150;
    const drawW = W - marginL - marginR;
    const scale = drawW / totalLen; // px per mm
    const cy = H * 0.40;

    const xLeft = marginL; // PTC / shaft far end
    const xRight = marginL + drawW; // wetted face
    const xHeadStart = xRight - p.head_thick_mm * scale; // head base (shaft/head junction)

    const headHalf = (p.head_dia_mm / 2) * scale;
    const shaftHalf = (p.shaft_od_mm / 2) * scale;
    const boreHalf = (p.shaft_id_mm / 2) * scale;
    // Aluminium sleeve geometry (covers the shaft from the PTC end to the seal gap).
    const sleeveOn = p.sleeve_enabled && p.sleeve_od_mm > p.shaft_od_mm;
    const sleeveHalf = (p.sleeve_od_mm / 2) * scale;
    const xSleeveEnd = xHeadStart - p.sleeve_gap_mm * scale; // sleeve stops here, short of head
    const ptfeHalf = (sleeveOn ? sleeveHalf : shaftHalf) + 14; // PTFE wraps the outermost metal

    // --- fluid region ---
    // The whole head sits in the fluid, so shade the fluid to the RIGHT of the
    // face and also the bands ABOVE and BELOW the head (its sides are wetted).
    const fluidColor = scenario === 'air' ? '#eef2f7' : '#dceffb';
    ctx.fillStyle = fluidColor;
    ctx.fillRect(xRight, 0, W - xRight, H); // downstream of the face
    ctx.fillRect(xHeadStart, 0, xRight - xHeadStart, cy - headHalf); // above head
    ctx.fillRect(xHeadStart, cy + headHalf, xRight - xHeadStart, H - (cy + headHalf)); // below head
    ctx.fillStyle = '#6b87a3';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const fluidName =
      scenario === 'air' ? 'AIR' : scenario === 'flowing' ? 'FLOWING SEAWATER' : 'STILL SEAWATER';
    ctx.fillText(fluidName, xRight + 10, 22);
    ctx.fillText(`${p.T_fluid.toFixed(0)}°C`, xRight + 10, 40);

    // flow arrows in flowing case — crossflow passing the head, including its
    // top and bottom sides, then continuing downstream past the front face.
    if (scenario === 'flowing') {
      ctx.strokeStyle = '#69b6d5';
      ctx.fillStyle = '#69b6d5';
      ctx.lineWidth = 2;
      const arrow = (ay, ax0, ax1) => {
        ctx.beginPath();
        ctx.moveTo(ax0, ay);
        ctx.lineTo(ax1, ay);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ax1, ay);
        ctx.lineTo(ax1 - 7, ay - 4);
        ctx.lineTo(ax1 - 7, ay + 4);
        ctx.closePath();
        ctx.fill();
      };
      // arrows skimming the head sides (start upstream of the head)
      arrow(cy - headHalf - 12, xHeadStart - 24, W - 14);
      arrow(cy + headHalf + 12, xHeadStart - 24, W - 14);
      // arrows downstream of the front face
      arrow(cy - 16, xRight + 14, W - 14);
      arrow(cy + 16, xRight + 14, W - 14);
    }

    // --- PTFE sleeve around the shaft (hatched) ---
    ctx.fillStyle = '#ece9e3';
    ctx.fillRect(xLeft, cy - ptfeHalf, xHeadStart - xLeft, ptfeHalf * 2);
    ctx.strokeStyle = '#cfc8bb';
    ctx.lineWidth = 1;
    for (let x = xLeft; x < xHeadStart; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, cy - ptfeHalf);
      ctx.lineTo(x + 7, cy - ptfeHalf + 7);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, cy + ptfeHalf - 7);
      ctx.lineTo(x + 7, cy + ptfeHalf);
      ctx.stroke();
    }

    // --- metal (shaft + head) filled with the temperature gradient ---
    const grad = ctx.createLinearGradient(xRight, 0, xLeft, 0);
    if (result.profile) {
      result.profile.forEach((pt) => {
        const off = Math.max(0, Math.min(1, pt.x_mm / totalLen));
        const tnorm = (pt.T - p.T_fluid) / Math.max(1e-3, p.T_ptc - p.T_fluid);
        grad.addColorStop(off, heatColor(tnorm));
      });
    } else {
      grad.addColorStop(0, heatColor(0.3));
      grad.addColorStop(1, heatColor(1));
    }

    ctx.fillStyle = grad;
    // aluminium sleeve bands (above and below the stainless), drawn first so the
    // stainless shaft sits on top. Filled with the same temperature gradient.
    if (sleeveOn) {
      const sw = xSleeveEnd - xLeft;
      if (sw > 0) {
        ctx.fillRect(xLeft, cy - sleeveHalf, sw, sleeveHalf - shaftHalf); // upper band
        ctx.fillRect(xLeft, cy + shaftHalf, sw, sleeveHalf - shaftHalf); // lower band
        ctx.strokeStyle = '#7a8087';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(xLeft, cy - sleeveHalf, sw, sleeveHalf * 2 - 0); // sleeve outline
        ctx.setLineDash([]);
      }
    }
    // shaft body
    ctx.fillRect(xLeft, cy - shaftHalf, xHeadStart - xLeft, shaftHalf * 2);
    // head body
    ctx.fillRect(xHeadStart, cy - headHalf, p.head_thick_mm * scale, headHalf * 2);
    // outlines
    ctx.strokeStyle = '#5a5a5a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(xLeft, cy - shaftHalf, xHeadStart - xLeft, shaftHalf * 2);
    ctx.strokeRect(xHeadStart, cy - headHalf, p.head_thick_mm * scale, headHalf * 2);
    // sleeve label + seal-gap marker
    if (sleeveOn && xSleeveEnd - xLeft > 0) {
      label(ctx, (xLeft + xSleeveEnd) / 2, cy - sleeveHalf - 6, 'Al sleeve', '#5a6b80');
      ctx.fillStyle = '#b23';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('seal gap', (xSleeveEnd + xHeadStart) / 2, cy + shaftHalf + 12);
    }

    // central bore (3mm) shown as a white channel through the shaft
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(xLeft, cy - boreHalf, xHeadStart - xLeft, boreHalf * 2);
    ctx.strokeStyle = '#b9b9b9';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(xLeft, cy - boreHalf, xHeadStart - xLeft, boreHalf * 2);
    ctx.setLineDash([]);

    // --- PTC / aluminium block on the far left ---
    const blockW = 26;
    ctx.fillStyle = '#c9ccd1';
    ctx.fillRect(xLeft - blockW, cy - ptfeHalf, blockW, ptfeHalf * 2);
    ctx.strokeStyle = '#8a8d92';
    ctx.strokeRect(xLeft - blockW, cy - ptfeHalf, blockW, ptfeHalf * 2);
    ctx.fillStyle = '#b23';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PTC', xLeft - blockW / 2, cy - ptfeHalf - 18);
    ctx.fillText(`${p.T_ptc.toFixed(0)}°C`, xLeft - blockW / 2, cy - ptfeHalf - 4);

    // --- NTC bead in the head, ntc_from_face mm from the wetted face ---
    const ntcX = xRight - p.ntc_from_face_mm * scale;
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(ntcX, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
    // NTC lead going back through the bore
    ctx.strokeStyle = '#444';
    ctx.beginPath();
    ctx.moveTo(ntcX, cy);
    ctx.lineTo(xLeft - blockW, cy);
    ctx.stroke();

    // --- labels / callouts ---
    ctx.fillStyle = '#33405a';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    // head label + temperature together below the head (keeps the top clear for
    // the NTC callout and the side-flow arrows)
    label(
      ctx,
      xHeadStart + (p.head_thick_mm * scale) / 2,
      cy + headHalf + 30,
      `HEAD ${result.T_head.toFixed(1)}°C`,
      '#b23'
    );
    // NTC reading callout
    ctx.strokeStyle = '#222';
    ctx.beginPath();
    ctx.moveTo(ntcX, cy - 6);
    ctx.lineTo(ntcX, cy - headHalf - 32);
    ctx.stroke();
    label(ctx, ntcX, cy - headHalf - 36, `NTC ${result.T_ntc.toFixed(1)}°C`, '#1a6');
    // shaft label (material-aware)
    const mat = (global.SensorModel.MATERIALS[p.material] || {}).short || '316 SS';
    label(ctx, (xLeft + xHeadStart) / 2, cy - ptfeHalf - 8, `${mat} shaft (PTFE sleeved)`, '#7a7367');

    // --- dimension hints ---
    ctx.fillStyle = '#8b97a8';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      `shaft ${p.shaft_len_mm}mm · Ø${p.shaft_od_mm}/${p.shaft_id_mm}mm`,
      (xLeft + xHeadStart) / 2,
      cy + ptfeHalf + 16
    );
    ctx.fillText(
      `head Ø${p.head_dia_mm} × ${p.head_thick_mm}mm`,
      xHeadStart + (p.head_thick_mm * scale) / 2,
      cy + headHalf + 44
    );

    // --- thermal-network schematic along the bottom ---
    drawNetwork(ctx, W, H, p, result, scenario);

    // --- colour scale legend ---
    drawColorbar(ctx, W, H, p);
  }

  function label(ctx, x, y, text, color) {
    ctx.fillStyle = color || '#33405a';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  }

  function drawNetwork(ctx, W, H, p, result, scenario) {
    const y = H - 46;
    const x0 = 70,
      x1 = W - 120;
    const nodes = [
      { x: x0, t: `PTC\n${p.T_ptc.toFixed(0)}°C`, c: '#b23' },
      { x: x0 + (x1 - x0) * 0.45, t: `head\n${result.T_head.toFixed(1)}°C`, c: '#d68' },
      { x: x1, t: `fluid\n${p.T_fluid.toFixed(0)}°C`, c: '#2a8' },
    ];
    ctx.strokeStyle = '#9aa6bd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nodes[0].x, y);
    ctx.lineTo(nodes[2].x, y);
    ctx.stroke();

    // resistor boxes
    drawResistor(ctx, (nodes[0].x + nodes[1].x) / 2, y, `R_cond\n${result.R_cond.toFixed(0)} K/W`);
    drawResistor(
      ctx,
      (nodes[1].x + nodes[2].x) / 2,
      y,
      `R_conv\n${result.R_conv.toFixed(2)} K/W`
    );

    nodes.forEach((n) => {
      ctx.fillStyle = n.c;
      ctx.beginPath();
      ctx.arc(n.x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#33405a';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const lines = n.t.split('\n');
      ctx.fillText(lines[0], n.x, y + 18);
      ctx.fillText(lines[1], n.x, y + 30);
    });

    // heat flow Q
    ctx.fillStyle = '#33405a';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Q = ${result.Q.toFixed(3)} W   h = ${result.h.toFixed(0)} W/m²K`, x0, y - 16);
  }

  function drawResistor(ctx, x, y, text) {
    const w = 46,
      h = 16;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#62708a';
    ctx.lineWidth = 1.5;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = '#33405a';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const lines = text.split('\n');
    ctx.fillText(lines[0], x, y - 12);
    ctx.fillText(lines[1], x, y + 22);
  }

  function drawColorbar(ctx, W, H, p) {
    const bx = W - 28,
      by = 60,
      bw = 12,
      bh = 120;
    const g = ctx.createLinearGradient(0, by + bh, 0, by);
    for (let i = 0; i <= 10; i++) g.addColorStop(i / 10, heatColor(i / 10));
    ctx.fillStyle = g;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#9aa6bd';
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#62708a';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${p.T_ptc.toFixed(0)}°`, bx - 3, by + 4);
    ctx.fillText(`${p.T_fluid.toFixed(0)}°`, bx - 3, by + bh);
  }

  global.SensorDiagram = { drawDiagram, heatColor };
})(typeof window !== 'undefined' ? window : globalThis);
