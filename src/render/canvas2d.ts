import type { Layer, VisualEditor } from '../editor';
import type { ViewTransform } from '../input/view';
import { TILE, tileX, tileY, unionRect, type Rect } from '../raster/surface';
import { strokeOutline, type VectorStroke } from '../vector/vector';

type Canvas2D = CanvasRenderingContext2D;
interface Backing { canvas: HTMLCanvasElement; context: Canvas2D; rect: Rect; seen: number }

export interface RendererOptions {
  /** Shown where the document is transparent. */
  checker: [string, string];
  /** Outline around the document bounds. */
  border: string;
  devicePixelRatio: number;
}

/**
 * Canvas 2D compositor. Raster layers keep a GPU-backed backing canvas updated per dirty tile
 * (only changed 128px tiles are uploaded), and the visible viewport is recomposed at most once per
 * animation frame with a single transform — zoom/pan never touches layer pixels.
 */
export class CanvasRenderer {
  options: RendererOptions;
  private context: Canvas2D;
  private backings = new Map<string, Backing>();
  private paths = new WeakMap<VectorStroke, { length: number; path: Path2D }>();
  private scratch?: HTMLCanvasElement;
  private floatingCanvas?: { canvas: HTMLCanvasElement; source: object };
  private frame = 0;
  private checker?: CanvasPattern;
  private unsubscribe: () => void;
  /** Extra drawing in document space after layers (selection outlines, cursors). */
  overlay?: (context: Canvas2D, view: ViewTransform) => void;

  constructor(readonly canvas: HTMLCanvasElement, readonly editor: VisualEditor, readonly view: ViewTransform, options: Partial<RendererOptions> = {}) {
    this.options = { checker: ['#ffffff', '#e3e3e3'], border: 'rgba(0,0,0,.35)', devicePixelRatio: globalThis.devicePixelRatio || 1, ...options };
    this.context = canvas.getContext('2d', { alpha: true })!;
    this.unsubscribe = editor.on(() => this.request());
  }

  destroy() { cancelAnimationFrame(this.frame); this.unsubscribe(); this.backings.clear(); }

  /** Resize the display canvas to CSS size × device pixel ratio. */
  resize(width: number, height: number, devicePixelRatio = this.options.devicePixelRatio) {
    this.options.devicePixelRatio = devicePixelRatio;
    this.canvas.width = Math.max(1, Math.round(width * devicePixelRatio));
    this.canvas.height = Math.max(1, Math.round(height * devicePixelRatio));
    this.view.resize(width, height);
    this.render();
  }

  request() { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); }); }

  private backing(layer: Layer): Backing {
    const surface = layer.raster!;
    let backing = this.backings.get(layer.id);
    const content = unionRect({ x: 0, y: 0, width: this.editor.width, height: this.editor.height }, surface.tiles.size ? tilesRect(surface.tiles.keys()) : undefined)!;
    if (!backing || !contains(backing.rect, content)) {
      const rect = backing ? unionRect(backing.rect, content)! : content;
      const canvas = document.createElement('canvas');
      canvas.width = rect.width; canvas.height = rect.height;
      backing = { canvas, context: canvas.getContext('2d')!, rect, seen: -1 };
      this.backings.set(layer.id, backing);
    }
    if (backing.seen !== surface.version) {
      const full = backing.seen < 0;
      for (const [key, version] of surface.versions) {
        if (!full && version <= backing.seen) continue;
        const x = tileX(key) * TILE - backing.rect.x, y = tileY(key) * TILE - backing.rect.y, tile = surface.tiles.get(key);
        if (tile) backing.context.putImageData(new ImageData(tile as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), x, y);
        else backing.context.clearRect(x, y, TILE, TILE);
      }
      if (full) for (const [key, tile] of surface.tiles) if (!surface.versions.has(key)) backing.context.putImageData(new ImageData(tile as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), tileX(key) * TILE - backing.rect.x, tileY(key) * TILE - backing.rect.y);
      backing.seen = surface.version;
    }
    return backing;
  }

  private path(stroke: VectorStroke) {
    const cached = this.paths.get(stroke);
    if (cached && cached.length === stroke.points.length) return cached.path;
    const { circles, quads } = strokeOutline(stroke), path = new Path2D();
    for (const [x, y, r] of circles) { path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2); }
    for (const q of quads) { path.moveTo(q[0], q[1]); path.lineTo(q[2], q[3]); path.lineTo(q[4], q[5]); path.lineTo(q[6], q[7]); path.closePath(); }
    this.paths.set(stroke, { length: stroke.points.length, path });
    return path;
  }

  private drawVector(context: Canvas2D, layer: Layer, alpha: number) {
    for (const stroke of layer.vector!.strokes) {
      context.globalAlpha = alpha * stroke.opacity; context.fillStyle = stroke.color;
      context.fill(this.path(stroke), 'nonzero');
    }
  }

  render() {
    const { context, canvas, view, editor } = this, dpr = this.options.devicePixelRatio;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    // Checkerboard in screen space so it stays crisp at every zoom.
    const [sx, sy] = view.toScreen(0, 0);
    const docRect = [sx * dpr, sy * dpr, editor.width * view.zoom * dpr, editor.height * view.zoom * dpr] as const;
    if (editor.doc.config.background) { context.fillStyle = editor.doc.config.background; }
    else { this.checker ??= this.makeChecker(); context.fillStyle = this.checker ?? this.options.checker[0]; }
    context.fillRect(...docRect);
    context.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
    context.imageSmoothingEnabled = view.zoom < 2;
    const floatingLayer = editor.floating && editor.selection?.layerId;
    for (const layer of editor.layers) {
      if (!layer.entry.visible || layer.missing) continue;
      const alpha = layer.entry.opacity;
      if (layer.raster) {
        const backing = this.backing(layer);
        context.globalAlpha = alpha;
        context.drawImage(backing.canvas, backing.rect.x, backing.rect.y);
        if (floatingLayer === layer.id && editor.floating?.image) this.drawFloating(context);
      } else if (layer.vector) {
        if (alpha >= 1) this.drawVector(context, layer, 1);
        else {
          const scratch = this.scratch ??= document.createElement('canvas');
          if (scratch.width !== canvas.width || scratch.height !== canvas.height) { scratch.width = canvas.width; scratch.height = canvas.height; }
          const sc = scratch.getContext('2d')!;
          sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, scratch.width, scratch.height);
          sc.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
          this.drawVector(sc, layer, 1);
          context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = alpha; context.drawImage(scratch, 0, 0); context.restore();
        }
      }
    }
    context.globalAlpha = 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.strokeStyle = this.options.border; context.lineWidth = 1;
    context.strokeRect(Math.round(docRect[0]) + 0.5, Math.round(docRect[1]) + 0.5, Math.round(docRect[2]) - 1, Math.round(docRect[3]) - 1);
    if (this.overlay) { context.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY); this.overlay(context, view); }
  }

  private drawFloating(context: Canvas2D) {
    const floating = this.editor.floating!, image = floating.image!;
    if (this.floatingCanvas?.source !== image) {
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d')!.putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
      this.floatingCanvas = { canvas, source: image };
    }
    context.drawImage(this.floatingCanvas.canvas, floating.box.x, floating.box.y, floating.box.width, floating.box.height);
  }

  private makeChecker() {
    const size = 8 * this.options.devicePixelRatio, tile = document.createElement('canvas');
    tile.width = tile.height = size * 2;
    const c = tile.getContext('2d')!;
    c.fillStyle = this.options.checker[0]; c.fillRect(0, 0, size * 2, size * 2);
    c.fillStyle = this.options.checker[1]; c.fillRect(0, 0, size, size); c.fillRect(size, size, size, size);
    return this.context.createPattern(tile, 'repeat') ?? undefined;
  }
}

function tilesRect(keys: Iterable<number>): Rect | undefined {
  let rect: Rect | undefined;
  for (const key of keys) rect = unionRect(rect, { x: tileX(key) * TILE, y: tileY(key) * TILE, width: TILE, height: TILE });
  return rect;
}
const contains = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
