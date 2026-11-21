import type { HistoryCommand } from '../history';
import type { ClipMask } from './paint';
import { TILE, TileRecorder, tileX, tileY, type Rect, type RGBAImage, type TiledSurface } from './surface';

/** Remove the masked pixels from a surface. */
export function clearMasked(surface: TiledSurface, clip: ClipMask, recorder = new TileRecorder(surface)) {
  const { rect, mask } = clip;
  for (const key of surface.keysIn(rect)) {
    const tile = surface.tiles.get(key);
    if (!tile) continue;
    recorder.capture(key);
    const ox = tileX(key) * TILE, oy = tileY(key) * TILE;
    const x0 = Math.max(rect.x, ox), x1 = Math.min(rect.x + rect.width, ox + TILE), y0 = Math.max(rect.y, oy), y1 = Math.min(rect.y + rect.height, oy + TILE);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const m = mask[(y - rect.y) * rect.width + (x - rect.x)];
      if (!m) continue;
      const p = ((y - oy) * TILE + (x - ox)) * 4 + 3;
      tile[p] = Math.round(tile[p] * (255 - m) / 255);
    }
  }
  surface.touch(surface.keysIn(rect));
  return recorder;
}

/** Copy the masked pixels into a standalone image covering the mask rectangle. */
export function extractMasked(surface: TiledSurface, clip: ClipMask): RGBAImage {
  const image = surface.read(clip.rect);
  for (let i = 0; i < clip.mask.length; i++) image.data[i * 4 + 3] = Math.round(image.data[i * 4 + 3] * clip.mask[i] / 255);
  return image;
}

/** Composite an image (bilinear-scaled into `box`) over the surface with source-over. */
export function stampImage(surface: TiledSurface, image: RGBAImage, box: Rect, recorder: TileRecorder) {
  if (box.width < 1 || box.height < 1) return;
  const x0 = Math.floor(box.x), y0 = Math.floor(box.y), x1 = Math.ceil(box.x + box.width), y1 = Math.ceil(box.y + box.height);
  const sx = image.width / box.width, sy = image.height / box.height, src = image.data, w = image.width, h = image.height;
  const sample = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : src[(y * w + x) * 4 + c];
  const keys = surface.keysIn({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  for (const key of keys) {
    recorder.capture(key);
    const ox = tileX(key) * TILE, oy = tileY(key) * TILE;
    const px0 = Math.max(x0, ox), px1 = Math.min(x1, ox + TILE), py0 = Math.max(y0, oy), py1 = Math.min(y1, oy + TILE);
    let tile = surface.tiles.get(key);
    for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) {
      const u = (x + 0.5 - box.x) * sx - 0.5, v = (y + 0.5 - box.y) * sy - 0.5;
      const ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy;
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy], at = [[ix, iy], [ix + 1, iy], [ix, iy + 1], [ix + 1, iy + 1]];
      let a = 0, r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        const [qx, qy] = at[k], alpha = sample(qx, qy, 3) * weights[k];
        a += alpha; r += sample(qx, qy, 0) * alpha; g += sample(qx, qy, 1) * alpha; b += sample(qx, qy, 2) * alpha;
      }
      if (a <= 0.5) continue;
      if (!tile) tile = surface.ensure(key);
      const p = ((y - oy) * TILE + (x - ox)) * 4, sa = a / 255, da = tile[p + 3] / 255, outA = sa + da * (1 - sa);
      const keep = da * (1 - sa);
      tile[p] = (r / a * sa + tile[p] * keep) / outA; tile[p + 1] = (g / a * sa + tile[p + 1] * keep) / outA; tile[p + 2] = (b / a * sa + tile[p + 2] * keep) / outA;
      tile[p + 3] = Math.round(outA * 255);
    }
  }
  surface.touch(keys);
}

export function finishRecorder(recorder: TileRecorder, label: string): HistoryCommand | undefined { return recorder.command(label); }
