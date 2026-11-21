import type { HistoryCommand } from '../history';

/** Tile edge in pixels. 128 keeps per-tile overhead low while bounding the cost of a dirty upload. */
export const TILE = 128;
const TILE_BYTES = TILE * TILE * 4;
const OFFSET = 32768;
export const tileKey = (tx: number, ty: number) => (ty + OFFSET) * 65536 + (tx + OFFSET);
export const tileX = (key: number) => (key % 65536) - OFFSET;
export const tileY = (key: number) => Math.floor(key / 65536) - OFFSET;

export interface Rect { x: number; y: number; width: number; height: number }
export interface RGBAImage { width: number; height: number; data: Uint8ClampedArray }

export function unionRect(a: Rect | undefined, b: Rect | undefined): Rect | undefined {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * A sparse, unbounded RGBA (straight alpha, 8-bit) raster split into 128px tiles.
 * Missing tiles are fully transparent. Each tile carries a version so renderers upload only what changed.
 */
export class TiledSurface {
  readonly tiles = new Map<number, Uint8ClampedArray>();
  readonly versions = new Map<number, number>();
  /** Incremented on every change; cheap "is anything stale" check. */
  version = 0;
  private listeners = new Set<(keys: Iterable<number>) => void>();

  get(tx: number, ty: number) { return this.tiles.get(tileKey(tx, ty)); }
  ensure(key: number) {
    let tile = this.tiles.get(key);
    if (!tile) { tile = new Uint8ClampedArray(TILE_BYTES); this.tiles.set(key, tile); }
    return tile;
  }
  /** Replace a tile (or remove it with null), marking it dirty. */
  put(key: number, tile: Uint8ClampedArray | null) {
    if (tile) this.tiles.set(key, tile); else this.tiles.delete(key);
    this.touch([key]);
  }
  touch(keys: Iterable<number>) {
    this.version++;
    for (const key of keys) this.versions.set(key, this.version);
    for (const listener of this.listeners) listener(keys);
  }
  onChange(listener: (keys: Iterable<number>) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Tile keys intersecting a pixel rectangle. */
  keysIn(rect: Rect) {
    const keys: number[] = [];
    const x0 = Math.floor(rect.x / TILE), y0 = Math.floor(rect.y / TILE);
    const x1 = Math.floor((rect.x + rect.width - 1) / TILE), y1 = Math.floor((rect.y + rect.height - 1) / TILE);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) keys.push(tileKey(tx, ty));
    return keys;
  }

  /** Drop fully transparent tiles to keep memory and saved files minimal. */
  prune(keys: Iterable<number> = [...this.tiles.keys()]) {
    for (const key of keys) {
      const tile = this.tiles.get(key);
      if (tile && isTransparent(tile)) this.tiles.delete(key);
    }
  }

  /** Exact bounds of non-transparent pixels, or undefined when empty. */
  bounds(): Rect | undefined {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [key, tile] of this.tiles) {
      const ox = tileX(key) * TILE, oy = tileY(key) * TILE;
      if (ox >= left && ox + TILE <= right && oy >= top && oy + TILE <= bottom) continue;
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        if (!tile[(y * TILE + x) * 4 + 3]) continue;
        const px = ox + x, py = oy + y;
        if (px < left) left = px; if (px > right) right = px; if (py < top) top = py; if (py > bottom) bottom = py;
      }
    }
    return left === Infinity ? undefined : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  }

  read(rect: Rect): RGBAImage {
    const data = new Uint8ClampedArray(rect.width * rect.height * 4);
    for (const key of this.keysIn(rect)) {
      const tile = this.tiles.get(key);
      if (!tile) continue;
      const ox = tileX(key) * TILE, oy = tileY(key) * TILE;
      const x0 = Math.max(rect.x, ox), x1 = Math.min(rect.x + rect.width, ox + TILE);
      const y0 = Math.max(rect.y, oy), y1 = Math.min(rect.y + rect.height, oy + TILE);
      for (let y = y0; y < y1; y++) {
        const from = ((y - oy) * TILE + (x0 - ox)) * 4;
        data.set(tile.subarray(from, from + (x1 - x0) * 4), ((y - rect.y) * rect.width + (x0 - rect.x)) * 4);
      }
    }
    return { width: rect.width, height: rect.height, data };
  }

  /** Write pixels (replacing, not compositing) at an offset. Transparent source tiles are not allocated. */
  write(x: number, y: number, image: RGBAImage) {
    const rect = { x, y, width: image.width, height: image.height }, keys = this.keysIn(rect);
    for (const key of keys) {
      const ox = tileX(key) * TILE, oy = tileY(key) * TILE;
      const x0 = Math.max(x, ox), x1 = Math.min(x + image.width, ox + TILE);
      const y0 = Math.max(y, oy), y1 = Math.min(y + image.height, oy + TILE);
      let tile = this.tiles.get(key);
      for (let py = y0; py < y1; py++) {
        const from = ((py - y) * image.width + (x0 - x)) * 4, row = image.data.subarray(from, from + (x1 - x0) * 4);
        if (!tile) { let any = false; for (let i = 3; i < row.length; i += 4) if (row[i]) { any = true; break; } if (!any) continue; tile = this.ensure(key); }
        tile.set(row, ((py - oy) * TILE + (x0 - ox)) * 4);
      }
    }
    this.touch(keys);
  }

  clone() {
    const copy = new TiledSurface();
    for (const [key, tile] of this.tiles) copy.tiles.set(key, tile.slice());
    return copy;
  }
}

export function isTransparent(tile: Uint8ClampedArray) {
  for (let i = 3; i < tile.length; i += 4) if (tile[i]) return false;
  return true;
}

/**
 * Captures tiles before they change. Undo/redo *swap* the stored tile with the live one,
 * so a command holds exactly one tile copy per touched tile at any time.
 */
export class TileRecorder {
  readonly before = new Map<number, Uint8ClampedArray | null>();
  constructor(readonly surface: TiledSurface) {}
  capture(key: number) {
    if (this.before.has(key)) return this.before.get(key)!;
    const tile = this.surface.tiles.get(key);
    const copy = tile ? tile.slice() : null;
    this.before.set(key, copy);
    return copy;
  }
  captureRect(rect: Rect) { for (const key of this.surface.keysIn(rect)) this.capture(key); }
  /** Restore every captured tile (cancel an in-progress operation). */
  restore() {
    for (const [key, tile] of this.before) { if (tile) this.surface.tiles.set(key, tile.slice()); else this.surface.tiles.delete(key); }
    this.surface.touch(this.before.keys());
  }
  command(label: string): HistoryCommand | undefined {
    this.surface.prune(this.before.keys());
    const entries = [...this.before].filter(([key, before]) => {
      const now = this.surface.tiles.get(key);
      return !(before === null ? !now : now && equal(before, now));
    });
    if (!entries.length) return undefined;
    const surface = this.surface;
    const swap = () => {
      for (const entry of entries) {
        const live = surface.tiles.get(entry[0]) ?? null;
        if (entry[1]) surface.tiles.set(entry[0], entry[1]); else surface.tiles.delete(entry[0]);
        entry[1] = live;
      }
      surface.touch(entries.map(([key]) => key));
    };
    return { label, bytes: entries.length * TILE_BYTES, undo: swap, redo: swap };
  }
}

function equal(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4), y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
