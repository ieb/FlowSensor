/*
 * charts.js — Minimal self-contained canvas line charting. No dependencies.
 *
 * A LineChart owns one <canvas>. Call setData() with one or more series and
 * optional horizontal threshold bands, then it renders crisp (HiDPI-aware)
 * axes, gridlines, a legend and the series.
 */

(function (global) {
  'use strict';

  const COLORS = ['#2d7dd2', '#e15554', '#3bb273', '#e1bc29', '#7768ae', '#f26419'];

  class LineChart {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = Object.assign(
        {
          xLabel: '',
          yLabel: '',
          title: '',
          padding: { top: 28, right: 16, bottom: 44, left: 56 },
          xMin: null,
          xMax: null,
          yMin: null,
          yMax: null,
        },
        opts
      );
      this.series = [];
      this.bands = [];
      this.markers = [];
      this._resizeAndDraw = this._resizeAndDraw.bind(this);
      window.addEventListener('resize', this._resizeAndDraw);
    }

    // series: [{name, color?, points:[{x,y}], dashed?}]
    // bands:  [{y, label?, color?}]  horizontal reference lines
    // markers:[{x, y, label?, color?}] highlighted points
    setData(series, bands = [], markers = []) {
      this.series = series || [];
      this.bands = bands || [];
      this.markers = markers || [];
      this._resizeAndDraw();
    }

    _resizeAndDraw() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(200, rect.width);
      const h = Math.max(160, rect.height);
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._w = w;
      this._h = h;
      this.draw();
    }

    _bounds() {
      const o = this.opts;
      let xMin = o.xMin,
        xMax = o.xMax,
        yMin = o.yMin,
        yMax = o.yMax;
      const allPts = [];
      this.series.forEach((s) => s.points.forEach((p) => allPts.push(p)));
      if (allPts.length) {
        if (xMin == null) xMin = Math.min(...allPts.map((p) => p.x));
        if (xMax == null) xMax = Math.max(...allPts.map((p) => p.x));
        if (yMin == null) yMin = Math.min(...allPts.map((p) => p.y));
        if (yMax == null) yMax = Math.max(...allPts.map((p) => p.y));
      }
      // include band y-values in range
      this.bands.forEach((b) => {
        if (yMin == null || b.y < yMin) yMin = b.y;
        if (yMax == null || b.y > yMax) yMax = b.y;
      });
      if (xMin == null) {
        xMin = 0;
        xMax = 1;
      }
      if (yMin == null) {
        yMin = 0;
        yMax = 1;
      }
      if (xMin === xMax) xMax = xMin + 1;
      if (yMin === yMax) yMax = yMin + 1;
      // small padding on y
      const pad = (yMax - yMin) * 0.06;
      yMin -= pad;
      yMax += pad;
      return { xMin, xMax, yMin, yMax };
    }

    draw() {
      const ctx = this.ctx;
      const { padding } = this.opts;
      const w = this._w,
        h = this._h;
      ctx.clearRect(0, 0, w, h);

      const b = this._bounds();
      const plotX = padding.left,
        plotY = padding.top;
      const plotW = w - padding.left - padding.right;
      const plotH = h - padding.top - padding.bottom;

      const sx = (x) => plotX + ((x - b.xMin) / (b.xMax - b.xMin)) * plotW;
      const sy = (y) => plotY + plotH - ((y - b.yMin) / (b.yMax - b.yMin)) * plotH;
      this._sx = sx;
      this._sy = sy;

      // plot background
      ctx.fillStyle = '#fbfcfe';
      ctx.fillRect(plotX, plotY, plotW, plotH);

      // gridlines + ticks
      ctx.strokeStyle = '#e6eaf0';
      ctx.fillStyle = '#62708a';
      ctx.lineWidth = 1;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const yTicks = 5;
      for (let i = 0; i <= yTicks; i++) {
        const yv = b.yMin + ((b.yMax - b.yMin) * i) / yTicks;
        const py = sy(yv);
        ctx.beginPath();
        ctx.moveTo(plotX, py);
        ctx.lineTo(plotX + plotW, py);
        ctx.stroke();
        ctx.fillText(fmt(yv), plotX - 8, py);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const xTicks = 6;
      for (let i = 0; i <= xTicks; i++) {
        const xv = b.xMin + ((b.xMax - b.xMin) * i) / xTicks;
        const px = sx(xv);
        ctx.strokeStyle = '#eef1f6';
        ctx.beginPath();
        ctx.moveTo(px, plotY);
        ctx.lineTo(px, plotY + plotH);
        ctx.stroke();
        ctx.fillStyle = '#62708a';
        ctx.fillText(fmt(xv), px, plotY + plotH + 6);
      }

      // axis labels + title
      ctx.fillStyle = '#33405a';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      if (this.opts.xLabel) ctx.fillText(this.opts.xLabel, plotX + plotW / 2, h - 8);
      if (this.opts.title) {
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.fillText(this.opts.title, plotX + plotW / 2, 16);
      }
      if (this.opts.yLabel) {
        ctx.save();
        ctx.translate(14, plotY + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(this.opts.yLabel, 0, 0);
        ctx.restore();
      }

      // bands (horizontal reference lines)
      this.bands.forEach((band) => {
        const py = sy(band.y);
        ctx.strokeStyle = band.color || '#9aa6bd';
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(plotX, py);
        ctx.lineTo(plotX + plotW, py);
        ctx.stroke();
        ctx.setLineDash([]);
        if (band.label) {
          ctx.fillStyle = band.color || '#62708a';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(band.label, plotX + 4, py - 2);
        }
      });

      // clip to plot for series
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotX, plotY, plotW, plotH);
      ctx.clip();
      this.series.forEach((s, idx) => {
        const color = s.color || COLORS[idx % COLORS.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        if (s.dashed) ctx.setLineDash([6, 4]);
        ctx.beginPath();
        s.points.forEach((p, i) => {
          const px = sx(p.x),
            py = sy(p.y);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });
      // markers
      this.markers.forEach((m) => {
        const px = sx(m.x),
          py = sy(m.y);
        ctx.fillStyle = m.color || '#e15554';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        if (m.label) {
          ctx.fillStyle = '#33405a';
          ctx.font = '10px system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(m.label, px + 6, py - 4);
        }
      });
      ctx.restore();

      // legend
      const named = this.series.filter((s) => s.name);
      if (named.length) {
        let lx = plotX + 8;
        const ly = plotY + 6;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        named.forEach((s, idx) => {
          const color = s.color || COLORS[this.series.indexOf(s) % COLORS.length];
          const tw = ctx.measureText(s.name).width;
          ctx.fillStyle = color;
          ctx.fillRect(lx, ly + 4, 14, 3);
          ctx.fillStyle = '#33405a';
          ctx.fillText(s.name, lx + 18, ly + 6);
          lx += 18 + tw + 18;
        });
      }
    }

    destroy() {
      window.removeEventListener('resize', this._resizeAndDraw);
    }
  }

  function fmt(v) {
    const a = Math.abs(v);
    if (a !== 0 && (a < 0.01 || a >= 10000)) return v.toExponential(1);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }

  global.LineChart = LineChart;
})(typeof window !== 'undefined' ? window : globalThis);
