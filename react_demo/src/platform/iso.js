// Isometric primitives. Origin: Ergplan/Replanner apps/web/lib/iso.ts (jouleWise 2:1 projection),
// copied here as plain JavaScript so the supply diagrams are generated from data, never drawn by hand.
export const U = 30; // half-width of one plan unit, in screen px
export const V = 15; // half-height (U = 2V makes it 2:1)
export const H = 24; // screen px per unit of height

export const iso = (x, y, z = 0, ox = 0, oy = 0) => [ox + (x - y) * U, oy + (x + y) * V - z * H];
const pt = (p) => p.join(",");
export const poly = (pts) => `M${pts.map(pt).join("L")}Z`;

/** The three visible faces of an axis-aligned box, back to front. */
export function box(x, y, w, d, h, z = 0, ox = 0, oy = 0) {
  const P = (a, b, c) => iso(a, b, c, ox, oy);
  return {
    top: poly([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)]),
    left: poly([P(x, y + d, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z), P(x, y + d, z)]),
    right: poly([P(x + w, y, z + h), P(x + w, y + d, z + h), P(x + w, y + d, z), P(x + w, y, z)]),
  };
}

/** A flat quad on a horizontal plane. */
export function tile(x, y, w, d, z, ox = 0, oy = 0) {
  const P = (a, b) => iso(a, b, z, ox, oy);
  return poly([P(x, y), P(x + w, y), P(x + w, y + d), P(x, y + d)]);
}

/** Fill a rectangle with tiles in reading order so the array grows from one corner as a value moves. */
export function panelGrid({ x, y, cols, rows, w = 0.8, d = 0.5, gap = 0.2, z = 0, count, ox = 0, oy = 0 }) {
  const out = [];
  let n = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (count !== undefined && n >= count) return out;
      out.push(tile(x + c * (w + gap), y + r * (d + gap), w, d, z, ox, oy));
      n += 1;
    }
  }
  return out;
}

/** A polyline route through plan points at height z (cables, flows). */
export function route(points, z, ox = 0, oy = 0) {
  return "M" + points.map(([x, y]) => pt(iso(x, y, z, ox, oy))).join("L");
}

export function routeMid(points, z, ox = 0, oy = 0) {
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  return iso((ax + bx) / 2, (ay + by) / 2, z, ox, oy);
}
