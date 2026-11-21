import type { Rect, RGBAImage } from '../raster/surface';

export type Point = [number, number];
/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];
/** Row-major 3×3 projective matrix. */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export const rectQuad = (rect: Rect): Quad => [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]];

/** Projective map from the unit square to a quad (Heckbert's square-to-quad). */
export function squareToQuad(q: Quad): Matrix3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det, h = (dx1 * sy - sx * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invertMatrix(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('The transform is degenerate.');
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

export function multiplyMatrix(m: Matrix3, n: Matrix3): Matrix3 {
  const r = new Array(9) as Matrix3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = m[i * 3] * n[j] + m[i * 3 + 1] * n[3 + j] + m[i * 3 + 2] * n[6 + j];
  return r;
}

export function applyMatrix(m: Matrix3, x: number, y: number): Point {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Matrix mapping document points inside `from` to their transformed position inside `quad`. */
export function rectToQuad(from: Rect, quad: Quad): Matrix3 {
  const normalize: Matrix3 = [1 / Math.max(1e-9, from.width), 0, -from.x / Math.max(1e-9, from.width), 0, 1 / Math.max(1e-9, from.height), -from.y / Math.max(1e-9, from.height), 0, 0, 1];
  return multiplyMatrix(squareToQuad(quad), normalize);
}

export function quadBounds(quad: Quad): Rect {
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.ceil(Math.max(...xs)) - x, height: Math.ceil(Math.max(...ys)) - y };
}

/** True when the quad is convex and not self-intersecting (all corner turns share a sign). */
export function isConvex(quad: Quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i], [bx, by] = quad[(i + 1) % 4], [cx, cy] = quad[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    if (!sign) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/**
 * Warp `image` (covering `from`) into document space through a projective transform, with bilinear
 * sampling. Returns the warped pixels and the rectangle they cover, optionally clipped to `limit`.
 */
export function warpImage(image: RGBAImage, from: Rect, quad: Quad, limit?: Rect): { image: RGBAImage; rect: Rect } | undefined {
  let rect = quadBounds(quad);
  if (limit) {
    const x = Math.max(rect.x, limit.x), y = Math.max(rect.y, limit.y);
    rect = { x, y, width: Math.min(rect.x + rect.width, limit.x + limit.width) - x, height: Math.min(rect.y + rect.height, limit.y + limit.height) - y };
  }
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const inverse = invertMatrix(squareToQuad(quad)), src = image.data, w = image.width, h = image.height;
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const [a, b, c, d, e, f, g, hh, i] = inverse;
  for (let py = 0; py < rect.height; py++) {
    const y = rect.y + py + 0.5;
    for (let px = 0; px < rect.width; px++) {
      const x = rect.x + px + 0.5, wq = g * x + hh * y + i;
      const u = (a * x + b * y + c) / wq, v = (d * x + e * y + f) / wq;
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      const sx = u * w - 0.5, sy = v * h - 0.5, x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      let r = 0, gg = 0, bb = 0, aa = 0;
      for (let k = 0; k < 4; k++) {
        const qx = x0 + (k & 1), qy = y0 + (k >> 1);
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const weight = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy), s = (qy * w + qx) * 4, alpha = src[s + 3] * weight;
        aa += alpha; r += src[s] * alpha; gg += src[s + 1] * alpha; bb += src[s + 2] * alpha;
      }
      if (aa <= 0) continue;
      const o = (py * rect.width + px) * 4;
      out[o] = r / aa; out[o + 1] = gg / aa; out[o + 2] = bb / aa; out[o + 3] = aa;
    }
  }
  return { image: { width: rect.width, height: rect.height, data: out }, rect };
}

// ---------------------------------------------------------------- quad editing helpers

export const quadCenter = (q: Quad): Point => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
export const translateQuad = (q: Quad, dx: number, dy: number): Quad => q.map(([x, y]) => [x + dx, y + dy]) as Quad;
export function rotateQuad(q: Quad, radians: number, center = quadCenter(q)): Quad {
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return q.map(([x, y]) => [center[0] + (x - center[0]) * cos - (y - center[1]) * sin, center[1] + (x - center[0]) * sin + (y - center[1]) * cos]) as Quad;
}
export function scaleQuad(q: Quad, factor: number, center = quadCenter(q)): Quad {
  return q.map(([x, y]) => [center[0] + (x - center[0]) * factor, center[1] + (y - center[1]) * factor]) as Quad;
}
/** Move one corner (0..3) to a point: stretching and shearing. */
export function moveCorner(q: Quad, corner: number, point: Point): Quad {
  const next = q.map((p) => [...p]) as Quad; next[corner] = [...point]; return next;
}
/**
 * Drag an edge midpoint (0 = top, 1 = right, 2 = bottom, 3 = left) to scale along one axis only:
 * both corners of the edge move by the drag projected on the direction across the quad.
 */
export function moveEdge(q: Quad, edge: number, dx: number, dy: number): Quad {
  const a = edge, b = (edge + 1) % 4, opposite = [(edge + 3) % 4, (edge + 2) % 4];
  const mid: Point = [(q[a][0] + q[b][0]) / 2, (q[a][1] + q[b][1]) / 2];
  const far: Point = [(q[opposite[0]][0] + q[opposite[1]][0]) / 2, (q[opposite[0]][1] + q[opposite[1]][1]) / 2];
  let nx = mid[0] - far[0], ny = mid[1] - far[1];
  const length = Math.hypot(nx, ny) || 1; nx /= length; ny /= length;
  const along = dx * nx + dy * ny;
  const next = q.map((p) => [...p]) as Quad;
  for (const corner of [a, b]) next[corner] = [q[corner][0] + nx * along, q[corner][1] + ny * along];
  return next;
}
export const edgeMidpoint = (q: Quad, edge: number): Point => [(q[edge][0] + q[(edge + 1) % 4][0]) / 2, (q[edge][1] + q[(edge + 1) % 4][1]) / 2];
