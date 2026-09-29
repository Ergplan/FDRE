// CSV / PNG export helpers.

import { fmtBlockTime, isoDay } from './format.js';

const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function toCSV(dataset, series, i0 = 0, i1 = dataset.t.length - 1, unit = 'kW') {
  const head = ['Date', 'Time', ...(dataset.block ? ['Block'] : []), ...series.map((s) => `${s.label || s.key} (${unit})`)];
  const lines = [head.map(esc).join(',')];
  for (let i = i0; i <= i1; i++) {
    const t = dataset.t[i];
    const row = [isoDay(t - 1), fmtBlockTime(t), ...(dataset.block ? [dataset.block[i]] : []), ...series.map((s) => +(dataset.values[s.key]?.[i] ?? 0).toFixed(3))];
    lines.push(row.map(esc).join(','));
  }
  return lines.join('\n');
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

/** Rasterise an SVG element (colours are inline attributes, so it serialises as-is). */
export function svgToPNG(svg, background = '#ffffff', scale = 2) {
  const w = +svg.getAttribute('width');
  const hgt = +svg.getAttribute('height');
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.querySelectorAll('.efc-hit, .efc-focusring, .efc-now .pulse').forEach((n) => n.remove());
  // CSS-class-driven opacity (highlight dimming) is not carried; reset for a clean export
  clone.querySelectorAll('.efc-dim, .efc-dimline').forEach((n) => n.classList.remove('efc-dim', 'efc-dimline'));
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  Object.entries({ width: w, height: hgt, fill: background }).forEach(([k, v]) => bg.setAttribute(k, v));
  clone.insertBefore(bg, clone.firstChild);
  const src = new XMLSerializer().serializeToString(clone);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w * scale;
      c.height = hgt * scale;
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
    };
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
  });
}
