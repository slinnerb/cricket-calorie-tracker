'use strict';

/**
 * Minimal dependency-free bar chart for the weekly view.
 * Draws 7 day bars with value labels, a dashed daily-goal line, and weekday
 * labels. Colours are read from CSS custom properties so it follows the theme.
 */
function drawWeekChart(canvas, { labels, values, goal }) {
  const cssVar = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };
  const COL = {
    bar: cssVar('--accent', '#4ea1ff'),
    barSoft: cssVar('--accent-2', '#7c5cff'),
    goal: cssVar('--warn', '#ffb020'),
    text: cssVar('--text', '#e8ecf3'),
    muted: cssVar('--muted', '#93a0b4'),
    grid: cssVar('--line', '#2b3240')
  };

  // Handle high-DPI crispness.
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = 300;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 46, padR = 16, padT = 20, padB = 34;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const maxVal = Math.max(goal || 0, ...values, 1);
  const niceMax = niceCeil(maxVal * 1.15);
  const yToPx = (v) => padT + plotH - (v / niceMax) * plotH;

  // Horizontal gridlines + y labels.
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = (niceMax / ticks) * i;
    const y = yToPx(val);
    ctx.strokeStyle = COL.grid;
    ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = COL.muted;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(val)), padL - 8, y);
  }

  // Bars.
  const n = values.length;
  const slot = plotW / n;
  const barW = Math.min(46, slot * 0.6);
  values.forEach((v, i) => {
    const x = padL + slot * i + (slot - barW) / 2;
    const y = yToPx(v);
    const h = padT + plotH - y;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, COL.bar);
    grad.addColorStop(1, COL.barSoft);
    ctx.fillStyle = grad;
    roundRect(ctx, x, y, barW, Math.max(h, v > 0 ? 2 : 0), 6);
    ctx.fill();

    // Value label above bar (skipped when there are many bars, e.g. a month).
    if (v > 0 && n <= 14) {
      ctx.fillStyle = COL.text;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(Math.round(v)), x + barW / 2, y - 3);
    }
    // Weekday label.
    ctx.fillStyle = COL.muted;
    ctx.textBaseline = 'top';
    ctx.fillText(labels[i], x + barW / 2, padT + plotH + 8);
  });

  // Goal line.
  if (goal && goal > 0) {
    const y = yToPx(goal);
    ctx.strokeStyle = COL.goal;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (h <= 0) return;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, 0);
  ctx.arcTo(x, y + h, x, y, 0);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function niceCeil(v) {
  if (v <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 2.5 ? 2.5
    : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 8 ? 8 : 10;
  return step * mag;
}

window.drawWeekChart = drawWeekChart;
