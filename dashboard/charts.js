// Chart components drawn as inline SVG and HTML. Labels from source data are
// always inserted with textContent.
import { drawPath, fadeIn, growX } from './motion.js';

const SVG = 'http://www.w3.org/2000/svg';
export const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

// Picks a readable tick step (1, 2 or 5 times a power of ten; whole numbers for
// counts) and the axis maximum it implies, aiming for about four gridlines.
export function niceScale(value, integer = true) {
  if (!(value > 0)) return { max: integer ? 4 : 1, step: integer ? 1 : 0.25 };
  const raw = value / 4;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw);
  if (integer) step = Math.max(1, Math.ceil(step));
  return { max: Math.ceil(value / step) * step, step };
}

function pathFor(points) {
  let d = '', open = false;
  for (const point of points) {
    if (point.y === null) { open = false; continue; }
    d += `${open ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
    open = true;
  }
  return d;
}

/**
 * Line + area trend with an optional previous-period line (dashed, muted) and a
 * crosshair tooltip that reads every series at the hovered day.
 * series: { dates: [...], current: [number|null], previous?: [number|null] }
 */
export function trendChart({ dates, current, previous, label, format, dateFormat, previousLabel }) {
  const root = el('div', undefined, 'trend');
  const plot = el('div', undefined, 'trend-plot');
  const tooltip = el('div', undefined, 'tooltip');
  tooltip.setAttribute('role', 'status');
  root.append(plot, tooltip);
  const values = [...current, ...(previous || [])].filter(value => value !== null);
  const peak = Math.max(...values, 0);
  const { max, step } = niceScale(peak, values.every(Number.isInteger) && peak >= 4);
  let width = 0;

  const draw = () => {
    width = Math.max(plot.clientWidth, 280);
    const height = 248, left = 52, right = 14, top = 14, bottom = 30;
    const innerW = width - left - right, innerH = height - top - bottom;
    const x = index => left + (dates.length > 1 ? index / (dates.length - 1) : 0.5) * innerW;
    const y = value => value === null || value === undefined ? null : top + innerH - (value / max) * innerH;
    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'trend-svg', role: 'img',
      'aria-label': `${label}: ${dates.length} days, highest ${format(Math.max(...current.filter(v => v !== null), 0))}` });

    const defs = svg('defs');
    const gradient = svg('linearGradient', { id: `fill-${label.replace(/\W/g, '')}`, x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(svg('stop', { offset: '0%', 'stop-color': 'var(--series-1)', 'stop-opacity': '.22' }), svg('stop', { offset: '100%', 'stop-color': 'var(--series-1)', 'stop-opacity': '0' }));
    defs.append(gradient); chart.append(defs);

    for (let value = 0; value <= max + step / 2; value += step) {
      const gy = y(value);
      chart.append(svg('line', { x1: left, x2: width - right, y1: gy, y2: gy, class: value === 0 ? 'axis-base' : 'grid' }));
      const tick = svg('text', { x: left - 10, y: gy + 4, class: 'tick', 'text-anchor': 'end' }); tick.textContent = format(value, true); chart.append(tick);
    }
    const labelIndexes = dates.length > 2 ? [0, Math.floor((dates.length - 1) / 2), dates.length - 1] : dates.map((_, i) => i);
    for (const index of labelIndexes) {
      const tick = svg('text', { x: x(index), y: height - 8, class: 'tick', 'text-anchor': index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle' });
      tick.textContent = dateFormat(dates[index]); chart.append(tick);
    }

    const currentPoints = current.map((value, index) => ({ x: x(index), y: y(value) }));
    const filled = currentPoints.filter(point => point.y !== null);
    if (filled.length > 1) {
      const area = svg('path', { d: `${pathFor(currentPoints)}L${filled.at(-1).x},${top + innerH}L${filled[0].x},${top + innerH}Z`, fill: `url(#fill-${label.replace(/\W/g, '')})`, class: 'area' });
      chart.append(area); fadeIn(area, { delay: 380, duration: 700 });
    }
    if (previous) {
      const prior = svg('path', { d: pathFor(previous.map((value, index) => ({ x: x(index), y: y(value) }))), class: 'line-previous' });
      chart.append(prior); fadeIn(prior, { delay: 200 });
    }
    const line = svg('path', { d: pathFor(currentPoints), class: 'line-current' });
    chart.append(line);

    const hair = svg('line', { y1: top, y2: top + innerH, class: 'hairline' });
    const dot = svg('circle', { r: 5, class: 'dot-current' });
    const dotPrevious = svg('circle', { r: 4, class: 'dot-previous' });
    const hover = svg('g', { class: 'hover-layer' });
    hover.append(hair, dotPrevious, dot); chart.append(hover);

    const hit = svg('rect', { x: left, y: top, width: innerW, height: innerH, fill: 'transparent', tabindex: 0, class: 'hit' });
    chart.append(hit);
    let index = dates.length - 1;
    const show = () => {
      const cx = x(index);
      hair.setAttribute('x1', cx); hair.setAttribute('x2', cx);
      const cy = y(current[index]);
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy ?? -20);
      const py = previous ? y(previous[index]) : null;
      dotPrevious.setAttribute('cx', cx); dotPrevious.setAttribute('cy', py ?? -20);
      hover.classList.add('on');
      tooltip.replaceChildren();
      tooltip.append(el('div', dateFormat(dates[index], true), 'tip-date'));
      const row = (cls, value, name) => { const r = el('div', undefined, 'tip-row'); r.append(el('span', undefined, `key ${cls}`), el('strong', value === null || value === undefined ? 'No data' : format(value)), el('span', name, 'tip-name')); return r; };
      tooltip.append(row('current', current[index], label));
      if (previous) tooltip.append(row('previous', previous[index], previousLabel));
      tooltip.classList.add('on');
      const tipWidth = tooltip.offsetWidth;
      tooltip.style.transform = `translate(${Math.min(Math.max(cx - tipWidth / 2, 0), width - tipWidth)}px, 0)`;
    };
    const hide = () => { hover.classList.remove('on'); tooltip.classList.remove('on'); };
    hit.addEventListener('pointermove', event => {
      const rect = chart.getBoundingClientRect();
      const px = (event.clientX - rect.left) * (width / rect.width);
      index = Math.round(((px - left) / innerW) * (dates.length - 1));
      index = Math.max(0, Math.min(dates.length - 1, index));
      show();
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') { index = Math.max(0, index - 1); show(); event.preventDefault(); }
      if (event.key === 'ArrowRight') { index = Math.min(dates.length - 1, index + 1); show(); event.preventDefault(); }
    });
    plot.replaceChildren(chart);
    return line;
  };

  root.mount = () => {
    const line = draw();
    drawPath(line);
    let pending;
    new ResizeObserver(() => {
      if (Math.abs(plot.clientWidth - width) < 8) return;
      cancelAnimationFrame(pending); pending = requestAnimationFrame(draw);
    }).observe(plot);
  };
  return root;
}

// A tiny trend line for stat tiles. Decorative: the tile states the figures.
export function sparkline(values) {
  const clean = values.map(value => value ?? null);
  const max = Math.max(...clean.filter(v => v !== null), 0) || 1;
  const width = 120, height = 34;
  const points = clean.map((value, index) => ({ x: clean.length > 1 ? (index / (clean.length - 1)) * width : 0, y: value === null ? null : height - 3 - (value / max) * (height - 6) }));
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  const line = svg('path', { d: pathFor(points), 'vector-effect': 'non-scaling-stroke' });
  chart.append(line);
  chart.drawIn = () => drawPath(line, { duration: 900, delay: 250 });
  return chart;
}

/**
 * Ranked rows with an inline magnitude bar. columns: [{ key, label, format, bar? }]
 * The first column is the label; one column may carry the bar.
 */
// Rows may carry a `detail` string, shown under the label. Headers sort the loaded rows
// (click again to reverse); sorting never fetches, so it only reorders what is shown.
export function rankedTable(rows, columns, { emptyText = 'No activity in this period.', bars: showBars = true } = {}) {
  if (!rows.length) return el('p', emptyText, 'empty-note');
  const barColumn = columns.find(column => column.bar) || columns[1];
  const wrap = el('div', undefined, 'table-scroll');
  const table = el('table', undefined, 'ranked');
  const head = el('tr');
  const body = el('tbody');
  let bars = [];
  let sort = { key: null, desc: true };
  const compare = (a, b) => {
    const x = a[sort.key], y = b[sort.key];
    const nx = typeof x === 'number' ? x : x === null || x === undefined ? -Infinity : NaN;
    const ny = typeof y === 'number' ? y : y === null || y === undefined ? -Infinity : NaN;
    const result = Number.isNaN(nx) || Number.isNaN(ny) ? String(x ?? '').localeCompare(String(y ?? '')) : nx - ny;
    return sort.desc ? -result : result;
  };
  const fill = () => {
    const ordered = sort.key ? [...rows].sort(compare) : rows;
    const max = Math.max(...rows.map(row => Number(row[barColumn.key]) || 0), 1);
    body.replaceChildren();
    bars = [];
    for (const row of ordered) {
      const tr = el('tr');
      columns.forEach((column, index) => {
        const value = row[column.key];
        if (!index) {
          const td = el('td', undefined, 'label-cell');
          const text = column.format ? column.format(value, row) : String(value ?? '');
          td.append(el('span', text === '' ? '(not set)' : text, 'label-text'));
          if (row.detail) td.append(el('span', row.detail, 'label-detail'));
          // Rows measured in different units (money next to counts) must not share one bar scale.
          if (!showBars) { td.title = String(value ?? ''); tr.append(td); return; }
          const track = el('span', undefined, 'bar-track');
          const bar = el('span', undefined, 'bar');
          const share = (Number(row[barColumn.key]) || 0) / max;
          bar.style.width = share > 0 ? `${Math.max(1.5, share * 100)}%` : '0';
          track.append(bar); td.append(track); bars.push(bar);
          td.title = String(value ?? '');
          tr.append(td);
        } else tr.append(el('td', column.format ? column.format(value, row) : String(value ?? '—'), 'num'));
      });
      body.append(tr);
    }
  };
  columns.forEach((column, index) => {
    const th = el('th'); th.scope = 'col';
    if (index) th.className = 'num';
    const button = el('button', column.label, 'sort'); button.type = 'button';
    button.onclick = () => {
      sort = { key: column.key, desc: sort.key === column.key ? !sort.desc : index > 0 };
      for (const other of head.querySelectorAll('th')) other.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', sort.desc ? 'descending' : 'ascending');
      fill();
    };
    th.append(button);
    head.append(th);
  });
  const thead = el('thead'); thead.append(head); table.append(thead);
  fill();
  table.append(body); wrap.append(table);
  wrap.animateIn = () => growX(bars, { delay: 200 });
  return wrap;
}

// One horizontal bar split into shares, with a legend that states each share.
export function shareBar(parts, format) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const root = el('div', undefined, 'share');
  if (!total) { root.append(el('p', 'No activity in this period.', 'empty-note')); return root; }
  const bar = el('div', undefined, 'share-bar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', parts.map(part => `${part.label} ${Math.round((part.value / total) * 100)}%`).join(', '));
  const legend = el('ul', undefined, 'share-legend');
  // Colour follows the entity: callers pass a fixed slot or status tone per part.
  parts.forEach((part, index) => {
    const swatchClass = part.tone || `s${(part.slot ?? index) % 6 + 1}`;
    const segment = el('span', undefined, `seg ${swatchClass}`);
    segment.style.flexGrow = String(part.value);
    segment.title = `${part.label}: ${format(part.value)} (${Math.round((part.value / total) * 100)}%)`;
    bar.append(segment);
    const item = el('li');
    item.append(el('span', undefined, `swatch ${swatchClass}`), el('span', part.label, 'legend-label'), el('strong', `${Math.round((part.value / total) * 100)}%`), el('span', format(part.value), 'legend-value'));
    legend.append(item);
  });
  root.append(bar, legend);
  root.animateIn = () => growX([bar], { duration: 900 });
  return root;
}

// Semicircle gauge for a single rate between 0 and 1.
export function gauge(rate, label) {
  const root = el('div', undefined, 'gauge');
  const chart = svg('svg', { viewBox: '0 0 120 70', role: 'img', 'aria-label': `${label}: ${Math.round(rate * 100)}%` });
  const arc = 'M10,62 A50,50 0 0 1 110,62';
  chart.append(svg('path', { d: arc, class: 'gauge-track' }));
  const value = svg('path', { d: arc, class: 'gauge-value', pathLength: 100, 'stroke-dasharray': `${Math.max(0, Math.min(1, rate)) * 100} 100` });
  chart.append(value);
  root.append(chart);
  const filled = `${Math.max(0, Math.min(1, rate)) * 100} 100`;
  root.animateIn = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    value.animate([{ strokeDasharray: '0 100' }, { strokeDasharray: filled }], { duration: 1200, delay: 300, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
  };
  return root;
}
