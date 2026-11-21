import { dabParams, type Brush } from '../brush/brush';
import type { HistoryCommand } from '../history';
import { TILE, TileRecorder, tileX, tileY, type Rect, type TiledSurface } from './surface';

export interface StrokeSample { x: number; y: number; pressure: number }
export interface ClipMask { rect: Rect; mask: Uint8Array }
export type RGB = [number, number, number];

export function parseColor(hex: string): RGB {
  const value = /^#?([0-9a-f]{6})/i.exec(hex)?.[1] ?? '000000';
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/**
 * Indirect ("wash") painting as in Krita: dabs accumulate into a per-stroke coverage mask with
 * alpha-darken (coverage rises toward the dab's opacity at the flow rate, never past it), and each
 * touched pixel is recomposited from its pre-stroke value. Overlapping dabs therefore never exceed
 * the stroke opacity, and the pre-stroke tiles double as the undo record.
 */
export class RasterStroke {
  private recorder: TileRecorder;
  private coverage = new Map<number, Float32Array>();
  private color: RGB;
  private last?: StrokeSample;
  private carry = 0;
  private dirty = new Set<number>();
  readonly bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };

  constructor(readonly surface: TiledSurface, readonly brush: Brush, color: string, readonly erase: boolean,
    readonly size?: number, readonly clip?: ClipMask, readonly limit?: Rect) {
    this.recorder = new TileRecorder(surface);
    this.color = parseColor(color);
  }

  /** Add an input sample; dabs are interpolated along the segment at the brush spacing. */
  add(sample: StrokeSample) {
    const last = this.last;
    if (!last) { this.dab(sample.x, sample.y, sample.pressure); this.last = sample; this.flush(); return; }
    const dx = sample.x - last.x, dy = sample.y - last.y, distance = Math.hypot(dx, dy);
    if (distance === 0) { this.last = { ...sample }; return; }
    let travelled = -this.carry;
    for (;;) {
      const t0 = Math.max(0, travelled) / distance;
      const pressure = last.pressure + (sample.pressure - last.pressure) * t0;
      const step = Math.max(0.5, this.spacingAt(pressure));
      if (travelled + step > distance) { this.carry = distance - travelled; break; }
      travelled += step;
      const t = travelled / distance;
      this.dab(last.x + dx * t, last.y + dy * t, last.pressure + (sample.pressure - last.pressure) * t);
    }
    this.last = sample;
    this.flush();
  }

  private spacingAt(pressure: number) { return dabParams(this.brush, pressure, this.size).radius * 2 * this.brush.spacing; }

  private flush() { if (this.dirty.size) { this.surface.touch(this.dirty); this.dirty = new Set(); } }

  private dab(cx: number, cy: number, pressure: number) {
    const { radius, opacity, flow } = dabParams(this.brush, pressure, this.size);
    if (opacity <= 0) return;
    const ratio = this.brush.ratio, angle = this.brush.angle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const extent = radius + 1;
    let x0 = Math.floor(cx - extent), y0 = Math.floor(cy - extent), x1 = Math.ceil(cx + extent), y1 = Math.ceil(cy + extent);
    if (this.limit) {
      x0 = Math.max(x0, this.limit.x); y0 = Math.max(y0, this.limit.y);
      x1 = Math.min(x1, this.limit.x + this.limit.width); y1 = Math.min(y1, this.limit.y + this.limit.height);
    }
    if (x1 <= x0 || y1 <= y0) return;
    const b = this.bounds;
    b.left = Math.min(b.left, x0); b.top = Math.min(b.top, y0); b.right = Math.max(b.right, x1); b.bottom = Math.max(b.bottom, y1);
    const hardness = this.brush.hardness, [cr, cg, cb] = this.color, clip = this.clip;
    const fadeStart = hardness >= 1 ? 1 : hardness;
    for (const key of this.surface.keysIn({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) {
      const ox = tileX(key) * TILE, oy = tileY(key) * TILE;
      const before = this.recorder.capture(key);
      if (this.erase && !before) continue;
      const tile = this.surface.ensure(key);
      let mask = this.coverage.get(key);
      if (!mask) { mask = new Float32Array(TILE * TILE); this.coverage.set(key, mask); }
      const px0 = Math.max(x0, ox), px1 = Math.min(x1, ox + TILE), py0 = Math.max(y0, oy), py1 = Math.min(y1, oy + TILE);
      let changed = false;
      for (let py = py0; py < py1; py++) {
        const dy = py + 0.5 - cy;
        for (let px = px0; px < px1; px++) {
          const dx = px + 0.5 - cx;
          // Elliptical distance in brush space.
          const u = dx * cos + dy * sin, v = (-dx * sin + dy * cos) / ratio;
          const distance = Math.sqrt(u * u + v * v);
          if (distance >= radius + 0.5) continue;
          let shape = 1;
          const d = distance / radius;
          if (d > fadeStart) { const t = Math.min(1, (d - fadeStart) / (1 - fadeStart)); shape = 1 - t * t * (3 - 2 * t); }
          shape = Math.min(shape, radius + 0.5 - distance); // 1px antialiased edge
          if (clip) {
            const mx = px - clip.rect.x, my = py - clip.rect.y;
            if (mx < 0 || my < 0 || mx >= clip.rect.width || my >= clip.rect.height) continue;
            shape *= clip.mask[my * clip.rect.width + mx] / 255;
          }
          if (shape <= 0) continue;
          const index = (py - oy) * TILE + (px - ox);
          const current = mask[index], target = opacity * shape;
          if (current >= target) continue;
          const next = current + (target - current) * flow;
          mask[index] = next;
          const p = index * 4;
          const dr = before ? before[p] : 0, dg = before ? before[p + 1] : 0, db = before ? before[p + 2] : 0, da = before ? before[p + 3] / 255 : 0;
          if (this.erase) {
            tile[p + 3] = Math.round(da * (1 - next) * 255);
          } else {
            const outA = next + da * (1 - next);
            if (outA <= 0) continue;
            const keep = da * (1 - next);
            tile[p] = (cr * next + dr * keep) / outA; tile[p + 1] = (cg * next + dg * keep) / outA; tile[p + 2] = (cb * next + db * keep) / outA;
            tile[p + 3] = Math.round(outA * 255);
          }
          changed = true;
        }
      }
      if (changed) this.dirty.add(key);
    }
  }

  /** Finish and return the undo command (undefined when nothing changed). */
  finish(label = this.erase ? 'erase' : 'paint'): HistoryCommand | undefined {
    this.flush(); this.coverage.clear();
    return this.recorder.command(label);
  }
  cancel() { this.coverage.clear(); this.recorder.restore(); }
}

/** Scanline-fill a closed polygon into an 8-bit mask (even-odd), clipped to optional bounds. */
export function polygonMask(points: readonly (readonly [number, number])[], within?: Rect): ClipMask | undefined {
  if (points.length < 3) return undefined;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  let x0 = Math.floor(left), y0 = Math.floor(top), x1 = Math.ceil(right), y1 = Math.ceil(bottom);
  if (within) { x0 = Math.max(x0, within.x); y0 = Math.max(y0, within.y); x1 = Math.min(x1, within.x + within.width); y1 = Math.min(y1, within.y + within.height); }
  if (x1 <= x0 || y1 <= y0) return undefined;
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, mask = new Uint8Array(rect.width * rect.height);
  const crossings: number[] = [];
  for (let y = y0; y < y1; y++) {
    const sy = y + 0.5; crossings.length = 0;
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
      if ((ay <= sy) !== (by <= sy)) crossings.push(ax + (sy - ay) * (bx - ax) / (by - ay));
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(x0, Math.round(crossings[i])), to = Math.min(x1, Math.round(crossings[i + 1]));
      if (to > from) mask.fill(255, (y - y0) * rect.width + from - x0, (y - y0) * rect.width + to - x0);
    }
  }
  return { rect, mask };
}
