import { dabParams, type Brush } from '../brush/brush';
import type { HistoryCommand } from '../history';
import type { Rect } from '../raster/surface';

/** A vector stroke keeps its raw samples so it can be re-rendered, hit-tested, moved and scaled. */
export interface VectorStroke {
  id: string;
  /** Flat [x, y, pressure, x, y, pressure, ...] in document pixels. */
  points: number[];
  color: string;
  /** Full-pressure diameter. */
  size: number;
  minSize: number;
  sizePressure: boolean;
  opacity: number;
  pressureGamma: number;
}

let sequence = 0;
export const strokeId = () => `s${Date.now().toString(36)}${(sequence++).toString(36)}`;

export class VectorLayerData {
  strokes: VectorStroke[] = [];
  version = 0;
  private listeners = new Set<() => void>();
  onChange(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  touch() { this.version++; for (const listener of this.listeners) listener(); }
  bounds(): Rect | undefined {
    let rect: Rect | undefined;
    for (const stroke of this.strokes) { const box = strokeBounds(stroke); rect = rect ? union(rect, box) : box; }
    return rect;
  }
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

export function radiusAt(stroke: VectorStroke, pressure: number) {
  const brush = { size: stroke.size, minSize: stroke.minSize, sizePressure: stroke.sizePressure, pressureGamma: stroke.pressureGamma, opacity: 1, flow: 1,
    opacityPressure: false, flowPressure: false } as Brush;
  return dabParams(brush, pressure).radius;
}

export function strokeBounds(stroke: VectorStroke): Rect {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let i = 0; i < stroke.points.length; i += 3) {
    const r = radiusAt(stroke, stroke.points[i + 2]);
    left = Math.min(left, stroke.points[i] - r); right = Math.max(right, stroke.points[i] + r);
    top = Math.min(top, stroke.points[i + 1] - r); bottom = Math.max(bottom, stroke.points[i + 1] + r);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function newStroke(brush: Brush, color: string, size: number): VectorStroke {
  return { id: strokeId(), points: [], color, size, minSize: brush.minSize, sizePressure: brush.sizePressure,
    opacity: brush.opacity, pressureGamma: brush.pressureGamma };
}

/** Append a sample, dropping points closer than a quarter pixel to keep files small. */
export function appendPoint(stroke: VectorStroke, x: number, y: number, pressure: number) {
  const n = stroke.points.length;
  if (n >= 3 && Math.hypot(x - stroke.points[n - 3], y - stroke.points[n - 2]) < 0.25) { stroke.points[n - 1] = Math.max(stroke.points[n - 1], pressure); return; }
  stroke.points.push(round(x), round(y), round(pressure));
}
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Outline geometry as consistently-wound subpaths (circles at samples, quads between them).
 * Filled with the nonzero rule they union into a single variable-width stroke, so translucent
 * strokes do not darken where segments overlap.
 */
export interface Outline { circles: [number, number, number][]; quads: number[][] }
export function strokeOutline(stroke: VectorStroke): Outline {
  const circles: [number, number, number][] = [], quads: number[][] = [];
  const p = stroke.points;
  for (let i = 0; i < p.length; i += 3) {
    const r = radiusAt(stroke, p[i + 2]);
    circles.push([p[i], p[i + 1], r]);
    if (i === 0) continue;
    const [ax, ay, ar] = circles[circles.length - 2], bx = p[i], by = p[i + 1], br = r;
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    if (length <= Math.abs(ar - br)) continue; // one circle contains the other
    // External tangents between two circles.
    const angle = Math.atan2(dy, dx), offset = Math.acos((ar - br) / length);
    const a1 = angle + offset, a2 = angle - offset;
    let quad = [ax + ar * Math.cos(a1), ay + ar * Math.sin(a1), bx + br * Math.cos(a1), by + br * Math.sin(a1),
      bx + br * Math.cos(a2), by + br * Math.sin(a2), ax + ar * Math.cos(a2), ay + ar * Math.sin(a2)];
    if (signedArea(quad) < 0) quad = [quad[6], quad[7], quad[4], quad[5], quad[2], quad[3], quad[0], quad[1]];
    quads.push(quad);
  }
  return { circles, quads };
}
function signedArea(points: number[]) {
  let area = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    area += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return area / 2;
}

/** SVG path data for the outline; circles use sweep-flag 1 to match the quads' winding. */
export function outlinePath(stroke: VectorStroke) {
  const { circles, quads } = strokeOutline(stroke), f = (n: number) => String(Math.round(n * 100) / 100);
  const parts = circles.map(([x, y, r]) => `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 1 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 1 ${f(-2 * r)} 0Z`);
  for (const q of quads) parts.push(`M${f(q[0])} ${f(q[1])}L${f(q[2])} ${f(q[3])}L${f(q[4])} ${f(q[5])}L${f(q[6])} ${f(q[7])}Z`);
  return parts.join('');
}

/** True when a circle of `radius` at (x, y) touches the stroke. */
export function hitsStroke(stroke: VectorStroke, x: number, y: number, radius: number) {
  const p = stroke.points;
  for (let i = 0; i < p.length; i += 3) {
    const j = Math.max(0, i - 3), ax = p[j], ay = p[j + 1], bx = p[i], by = p[i + 1];
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
    const reach = radius + radiusAt(stroke, p[i + 2]);
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= reach * reach) return true;
  }
  return false;
}

export function pointInPolygon(x: number, y: number, polygon: readonly (readonly [number, number])[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Replace the whole stroke list; undo swaps it back. Stroke arrays are shared, never mutated in place. */
export function replaceStrokes(layer: VectorLayerData, next: VectorStroke[], label: string): HistoryCommand {
  let other = layer.strokes;
  layer.strokes = next; layer.touch();
  const swap = () => { const live = layer.strokes; layer.strokes = other; other = live; layer.touch(); };
  return { label, bytes: 64 + next.length * 8, undo: swap, redo: swap };
}

export function transformStroke(stroke: VectorStroke, from: Rect, to: Rect): VectorStroke {
  const sx = to.width / Math.max(1e-6, from.width), sy = to.height / Math.max(1e-6, from.height), points = stroke.points.slice();
  for (let i = 0; i < points.length; i += 3) { points[i] = round(to.x + (points[i] - from.x) * sx); points[i + 1] = round(to.y + (points[i + 1] - from.y) * sy); }
  return { ...stroke, points, size: stroke.size * Math.sqrt(Math.abs(sx * sy)) };
}

const VECTOR_HEADER = '<svg xmlns="http://www.w3.org/2000/svg" data-visual-vector="1"';

/** Vector layers are standalone SVG files: viewable anywhere, with raw samples kept for editing. */
export function serializeVector(layer: VectorLayerData, width: number, height: number) {
  const body = layer.strokes.map((stroke) => {
    const meta = `size:${stroke.size};min:${stroke.minSize};pressure:${stroke.sizePressure ? 1 : 0};gamma:${stroke.pressureGamma}`;
    const points = [];
    for (let i = 0; i < stroke.points.length; i += 3) points.push(`${stroke.points[i]},${stroke.points[i + 1]},${stroke.points[i + 2]}`);
    return `  <path id="${stroke.id}" fill="${stroke.color}"${stroke.opacity !== 1 ? ` fill-opacity="${stroke.opacity}"` : ''} data-brush="${meta}" data-points="${points.join(' ')}" d="${outlinePath(stroke)}"/>`;
  }).join('\n');
  return `${VECTOR_HEADER} width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n<g fill-rule="nonzero">\n${body}\n</g>\n</svg>\n`;
}

export function isVectorFile(text: string) { return text.startsWith(VECTOR_HEADER); }

/** Parse without a DOM so the engine also runs in workers and Node. */
export function parseVector(text: string, offsetX = 0, offsetY = 0): VectorLayerData {
  if (!isVectorFile(text)) throw new Error('This is not a visual.editor vector layer.');
  const layer = new VectorLayerData();
  for (const match of text.matchAll(/<path\b([^>]*)\/?>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const meta = Object.fromEntries((attrs['data-brush'] ?? '').split(';').map((part) => part.split(':')));
    const points: number[] = [];
    for (const triple of (attrs['data-points'] ?? '').trim().split(/\s+/)) {
      const [x, y, p] = triple.split(',').map(Number);
      if ([x, y].every(Number.isFinite)) points.push(x + offsetX, y + offsetY, Number.isFinite(p) ? p : 1);
    }
    if (!points.length) continue;
    layer.strokes.push({ id: attrs.id || strokeId(), points, color: attrs.fill ?? '#000000',
      opacity: Number(attrs['fill-opacity'] ?? 1), size: Number(meta.size) || 3, minSize: Number(meta.min) || 0,
      sizePressure: meta.pressure === '1', pressureGamma: Number(meta.gamma) || 1 });
  }
  return layer;
}
