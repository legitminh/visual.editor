import { defaultBrush, type Brush } from './brush/brush';
import { DEFAULT_BRUSH, DEFAULT_ERASER } from './brush/presets';
import { decodeImage, encodePng } from './codec/png';
import { defaultDocument, parseDocument, serializeDocument, type EditorState, type LayerEntry, type LayerKind, type VisualDocument } from './document/model';
import { compound, History, type HistoryCommand } from './history';
import { parseColor, polygonMask, RasterStroke, type ClipMask } from './raster/paint';
import { clearMasked, extractMasked, stampImage } from './raster/selection';
import { TiledSurface, TileRecorder, unionRect, type Rect, type RGBAImage } from './raster/surface';
import { applyMatrix, isConvex, quadBounds, rectQuad, rectToQuad, warpImage, type Matrix3, type Quad } from './transform/homography';
import { appendPoint, hitsStroke, isVectorFile, newStroke, parseVector, pointInPolygon, replaceStrokes, serializeVector, strokeBounds, VectorLayerData, type VectorStroke } from './vector/vector';

export interface Layer {
  id: string;
  entry: LayerEntry;
  raster?: TiledSurface;
  vector?: VectorLayerData;
  /** The referenced file could not be found; the entry is kept so the link is not lost. */
  missing: boolean;
  error?: string;
  savedVersion: number;
}

export interface LayerIO {
  /** Read a layer asset by its reference in the main file. Resolve to undefined when it does not exist. */
  read(reference: string): Promise<Blob | undefined>;
}

export interface Selection {
  layerId: string;
  path: [number, number][];
  rect: Rect;
  clip?: ClipMask;
  strokeIds?: Set<string>;
}
export interface TransformTarget {
  layer: Layer;
  /** Source rectangle of this layer's lifted content. */
  rect: Rect;
  image?: RGBAImage;
  recorder?: TileRecorder;
  strokes?: VectorStroke[];
  others?: VectorStroke[];
  before?: VectorStroke[];
}
export interface TransformSession { from: Rect; quad: Quad; targets: TransformTarget[]; allLayers: boolean; version: number }

export interface SavedFile { name: string; data: Uint8Array | string; kind: LayerKind }
export interface SaveResult { main: string; files: SavedFile[] }
export type EditorChange = 'layers' | 'content' | 'history' | 'state' | 'selection' | 'brushes';
export type ActiveTool = 'brush' | 'eraser';

const MAX_LAYERS = 200;
let layerSequence = 0;
const layerId = () => `L${(++layerSequence).toString(36)}`;
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';

/**
 * The editing core: owns the document model, layer pixels/strokes, history and tool state.
 * Hosts provide file IO and UI; renderers subscribe to changes. No DOM is required.
 */
export class VisualEditor {
  layers: Layer[] = [];
  readonly history: History;
  /** Brush palette: reference (as written in the document) → brush. */
  readonly brushes = new Map<string, Brush>();
  activeLayerId = '';
  selection?: Selection;
  transform?: TransformSession;
  private stroke?: { layer: Layer; raster?: RasterStroke; vector?: VectorStroke; erased?: Set<string>; vectorBefore?: VectorStroke[]; erase: boolean };
  private listeners = new Set<(change: EditorChange) => void>();
  private savedSignature = '';
  /** When false (flat images), tool/colour choices do not make the document dirty. */
  persistState = true;
  private names: Set<string>;

  private constructor(public doc: VisualDocument, public base: string, existing: Iterable<string> = []) {
    this.history = new History({ frames: doc.config.history, bytes: doc.config.historyMb * 1024 * 1024 });
    this.names = new Set([...existing].map((name) => name.toLowerCase()));
  }

  // ---------------------------------------------------------------- creation
  /** Open a document from its main-file text, loading every layer through `io`. */
  static async open(text: string, io: LayerIO, options: { base: string; existing?: Iterable<string> }) {
    const editor = new VisualEditor(parseDocument(text), options.base, options.existing);
    editor.layers = await Promise.all(editor.doc.layers.map((entry) => editor.loadLayer(entry, io)));
    editor.activeLayerId = (editor.layers[editor.doc.state.layer ?? editor.layers.length - 1] ?? editor.layers.at(-1))?.id ?? '';
    if (!editor.layers.length) editor.addLayerInternal('raster', 'Layer 1');
    editor.savedSignature = editor.signature();
    return editor;
  }

  /** A new, empty document with one raster layer. Its files are produced by the first `save()`. */
  static create(base: string, width: number, height: number, existing: Iterable<string> = []) {
    const editor = new VisualEditor(defaultDocument(width, height), base, existing);
    editor.addLayerInternal('raster', 'Layer 1');
    editor.savedSignature = '';
    return editor;
  }

  /** Wrap flat images (PNG/JPEG/HEIC/ORA layers) as an in-memory document; layer files are never written. */
  static fromImages(base: string, width: number, height: number, images: { name: string; visible: boolean; opacity: number; image: RGBAImage; x?: number; y?: number }[]) {
    const editor = new VisualEditor(defaultDocument(width, height), base);
    editor.persistState = false;
    for (const item of images) {
      const raster = new TiledSurface();
      raster.write(item.x ?? 0, item.y ?? 0, item.image);
      raster.prune();
      editor.layers.push({ id: layerId(), entry: { kind: 'raster', file: `${slug(item.name)}.png`, x: 0, y: 0, name: item.name, visible: item.visible, opacity: item.opacity, locked: false }, raster, missing: false, savedVersion: raster.version });
    }
    if (!editor.layers.length) editor.addLayerInternal('raster', 'Layer 1');
    editor.activeLayerId = editor.layers.at(-1)!.id;
    editor.savedSignature = editor.signature();
    return editor;
  }

  private async loadLayer(entry: LayerEntry, io: LayerIO): Promise<Layer> {
    const layer: Layer = { id: layerId(), entry, missing: false, savedVersion: 0 };
    this.names.add(entry.file.replace(/^.*\//, '').toLowerCase());
    let blob: Blob | undefined;
    try { blob = await io.read(entry.file); }
    catch (error) { layer.error = error instanceof Error ? error.message : String(error); }
    if (!blob) {
      layer.missing = true;
      if (entry.kind === 'raster') layer.raster = new TiledSurface(); else layer.vector = new VectorLayerData();
      return layer;
    }
    try {
      if (entry.kind === 'raster') {
        layer.raster = new TiledSurface();
        layer.raster.write(entry.x, entry.y, await decodeImage(blob));
        layer.raster.prune();
        layer.savedVersion = layer.raster.version;
      } else {
        const text = await blob.text();
        if (!isVectorFile(text)) throw new Error(`“${entry.file}” is not a vector layer.`);
        layer.vector = parseVector(text, entry.x, entry.y);
        layer.savedVersion = layer.vector.version;
      }
    } catch (error) {
      layer.missing = true; layer.error = error instanceof Error ? error.message : String(error);
      layer.raster ??= entry.kind === 'raster' ? new TiledSurface() : undefined;
      layer.vector ??= entry.kind === 'vector' ? new VectorLayerData() : undefined;
    }
    return layer;
  }

  // ---------------------------------------------------------------- events
  on(listener: (change: EditorChange) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(...changes: EditorChange[]) { for (const change of changes) for (const listener of this.listeners) listener(change); }

  // ---------------------------------------------------------------- accessors
  get width() { return this.doc.config.width; }
  get height() { return this.doc.config.height; }
  get state() { return this.doc.state; }
  get activeLayer() { return this.layers.find((layer) => layer.id === this.activeLayerId) ?? this.layers.at(-1); }
  get missingLayers() { return this.layers.filter((layer) => layer.missing); }
  get canUndo() { return this.history.canUndo && !this.stroke && !this.transform; }
  get canRedo() { return this.history.canRedo && !this.stroke && !this.transform; }
  get busy() { return !!this.stroke || !!this.transform; }
  layer(id: string) { return this.layers.find((layer) => layer.id === id); }

  /** Resolve a brush reference; falls back to the built-in Krita basic presets. */
  brush(reference?: string, eraser = false): Brush {
    return (reference && this.brushes.get(reference)) || (eraser ? DEFAULT_ERASER : DEFAULT_BRUSH);
  }
  get currentBrush() { return this.brush(this.state.brush); }
  get currentEraser() { return this.brush(this.state.eraser, true); }
  brushSize(tool: ActiveTool) { return tool === 'eraser' ? this.state.eraserSize ?? this.currentEraser.size : this.state.brushSize ?? this.currentBrush.size; }

  // ---------------------------------------------------------------- state & brushes
  setState(patch: Partial<EditorState>) {
    Object.assign(this.doc.state, patch);
    if (patch.color) {
      const recent = [patch.color, ...this.state.recentColors.filter((color) => color !== patch.color)];
      this.state.recentColors = recent.slice(0, 12);
    }
    this.emit('state');
  }
  /** Register a brush. With `reference` in the palette it is persisted in the main file. */
  addBrush(reference: string, brush: Brush, inPalette = true) {
    this.brushes.set(reference, brush);
    if (inPalette && !this.doc.brushes.includes(reference)) this.doc.brushes.push(reference);
    this.emit('brushes', 'state');
  }
  removeBrush(reference: string) {
    this.doc.brushes = this.doc.brushes.filter((item) => item !== reference);
    this.emit('brushes', 'state');
  }
  setConfig(patch: Partial<VisualDocument['config']>) {
    Object.assign(this.doc.config, patch);
    this.history.configure({ frames: this.doc.config.history, bytes: this.doc.config.historyMb * 1024 * 1024 });
    this.emit('state');
  }

  // ---------------------------------------------------------------- history
  private record(command: HistoryCommand | undefined, ...changes: EditorChange[]) {
    if (!command) return false;
    this.history.push(command); this.emit('history', ...changes);
    return true;
  }
  undo() { if (!this.canUndo) return false; this.selection = undefined; this.history.undo(); this.repairActive(); this.emit('history', 'content', 'layers', 'selection'); return true; }
  redo() { if (!this.canRedo) return false; this.selection = undefined; this.history.redo(); this.repairActive(); this.emit('history', 'content', 'layers', 'selection'); return true; }
  private repairActive() { if (!this.layer(this.activeLayerId)) this.activeLayerId = this.layers.at(-1)?.id ?? ''; }

  // ---------------------------------------------------------------- strokes
  /** Begin painting at document coordinates. Returns false when the active layer cannot be edited. */
  beginStroke(x: number, y: number, pressure: number, tool: ActiveTool) {
    this.cancelStroke();
    const layer = this.activeLayer;
    if (!layer || layer.missing || layer.entry.locked || !layer.entry.visible) return false;
    const brush = tool === 'eraser' ? this.currentEraser : this.currentBrush;
    const erase = tool === 'eraser' || brush.eraser, size = this.brushSize(tool);
    const clip = this.selection?.layerId === layer.id ? this.selection.clip : undefined;
    if (layer.raster) {
      const limit = { x: 0, y: 0, width: this.width, height: this.height };
      this.stroke = { layer, erase, raster: new RasterStroke(layer.raster, { ...brush, opacity: tool === 'brush' ? (this.state.brushOpacity ?? brush.opacity) : brush.opacity }, this.state.color, erase, size, clip, limit) };
      this.stroke.raster!.add({ x, y, pressure });
    } else if (layer.vector) {
      if (erase) {
        this.stroke = { layer, erase, erased: new Set(), vectorBefore: layer.vector.strokes };
        this.eraseVector(x, y, size / 2);
      } else {
        const stroke = newStroke(brush, this.state.color, size);
        stroke.opacity = this.state.brushOpacity ?? brush.opacity;
        appendPoint(stroke, x, y, pressure);
        this.stroke = { layer, erase, vector: stroke, vectorBefore: layer.vector.strokes };
        layer.vector.strokes = [...layer.vector.strokes, stroke]; layer.vector.touch();
      }
    }
    this.emit('content');
    return true;
  }
  strokeTo(x: number, y: number, pressure: number) {
    const stroke = this.stroke;
    if (!stroke) return;
    if (stroke.raster) stroke.raster.add({ x, y, pressure });
    else if (stroke.erased) this.eraseVector(x, y, this.brushSize('eraser') / 2);
    else if (stroke.vector) { appendPoint(stroke.vector, x, y, pressure); stroke.layer.vector!.touch(); }
    this.emit('content');
  }
  private eraseVector(x: number, y: number, radius: number) {
    const stroke = this.stroke!, vector = stroke.layer.vector!;
    const hit = vector.strokes.filter((item) => hitsStroke(item, x, y, radius));
    if (!hit.length) return;
    for (const item of hit) stroke.erased!.add(item.id);
    vector.strokes = vector.strokes.filter((item) => !stroke.erased!.has(item.id)); vector.touch();
  }
  endStroke() {
    const stroke = this.stroke;
    if (!stroke) return false;
    this.stroke = undefined;
    if (stroke.raster) return this.record(stroke.raster.finish(), 'content');
    const vector = stroke.layer.vector!, after = vector.strokes;
    if (stroke.erased && !stroke.erased.size) return false;
    vector.strokes = stroke.vectorBefore!;
    return this.record(replaceStrokes(vector, after, stroke.erased ? 'erase strokes' : 'add stroke'), 'content');
  }
  cancelStroke() {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = undefined;
    if (stroke.raster) stroke.raster.cancel();
    else { stroke.layer.vector!.strokes = stroke.vectorBefore!; stroke.layer.vector!.touch(); }
    this.emit('content');
  }

  // ---------------------------------------------------------------- selection
  /** Lasso-select on the active layer (pixels for raster, whole strokes for vector). */
  lasso(path: [number, number][]) {
    const layer = this.activeLayer;
    this.selection = undefined;
    if (!layer || layer.missing || path.length < 3) { this.emit('selection'); return undefined; }
    if (layer.raster) {
      const clip = polygonMask(path, { x: 0, y: 0, width: this.width, height: this.height });
      if (clip) this.selection = { layerId: layer.id, path, rect: clip.rect, clip };
    } else if (layer.vector) {
      const ids = new Set(layer.vector.strokes.filter((stroke) => {
        // Only strokes entirely inside the lasso are selected.
        for (let i = 0; i < stroke.points.length; i += 3) if (!pointInPolygon(stroke.points[i], stroke.points[i + 1], path)) return false;
        return stroke.points.length > 0;
      }).map((stroke) => stroke.id));
      if (ids.size) {
        const rect = layer.vector.strokes.filter((stroke) => ids.has(stroke.id)).map(strokeBounds).reduce((a, b) => unite(a, b));
        this.selection = { layerId: layer.id, path, rect, strokeIds: ids };
      }
    }
    this.emit('selection');
    return this.selection;
  }
  deselect() { this.cancelTransform(); this.selection = undefined; this.emit('selection'); }
  /** Delete the selected pixels or strokes. */
  clearSelection() {
    const selection = this.selection, layer = selection && this.layer(selection.layerId);
    if (!selection || !layer || this.busy) return false;
    this.selection = undefined;
    if (layer.raster && selection.clip) return this.record(clearMasked(layer.raster, selection.clip).command('clear selection'), 'content', 'selection');
    if (layer.vector && selection.strokeIds) return this.record(replaceStrokes(layer.vector, layer.vector.strokes.filter((stroke) => !selection.strokeIds!.has(stroke.id)), 'delete strokes'), 'content', 'selection');
    return false;
  }
  // ---------------------------------------------------------------- transform
  /**
   * Begin a transform session. With a lasso selection only the selected pixels (raster) or the strokes
   * fully inside it (vector) move; otherwise whole layers do. `allLayers` applies it to every editable
   * layer instead of just the active one. The session's quad is edited freely (move, corner stretch/shear,
   * edge scale, rotate, scale) and committed as one undo step.
   */
  beginTransformSession(allLayers = false) {
    if (this.busy) return false;
    const selection = this.selection;
    const selectionLayer = selection && this.layer(selection.layerId);
    const layers = allLayers ? this.layers.filter((layer) => !layer.missing && !layer.entry.locked && layer.entry.visible)
      : [selectionLayer ?? this.activeLayer].filter((layer): layer is Layer => !!layer && !layer.missing && !layer.entry.locked);
    const targets: TransformTarget[] = [];
    let from: Rect | undefined;
    for (const layer of layers) {
      if (layer.raster) {
        let clip: ClipMask | undefined;
        if (selection?.clip && layer.id === selection.layerId) clip = selection.clip;
        else if (selection) clip = polygonMask(selection.path);
        else {
          const bounds = layer.raster.bounds();
          if (bounds) clip = { rect: bounds, mask: new Uint8Array(bounds.width * bounds.height).fill(255) };
        }
        if (!clip) continue;
        const image = extractMasked(layer.raster, clip);
        if (!image.data.some((value, index) => index % 4 === 3 && value > 0)) continue;
        const recorder = clearMasked(layer.raster, clip);
        targets.push({ layer, rect: clip.rect, image, recorder });
        from = unionRect(from, clip.rect);
      } else if (layer.vector) {
        const before = layer.vector.strokes;
        const inside = (stroke: VectorStroke) => {
          if (!selection) return true;
          for (let i = 0; i < stroke.points.length; i += 3) if (!pointInPolygon(stroke.points[i], stroke.points[i + 1], selection.path)) return false;
          return true;
        };
        const strokes = before.filter(inside);
        if (!strokes.length) continue;
        const rect = strokes.map(strokeBounds).reduce((a, b) => unite(a, b));
        targets.push({ layer, rect, strokes, before, others: before.filter((stroke) => !inside(stroke)) });
        from = unionRect(from, rect);
      }
    }
    if (!targets.length || !from) return false;
    this.transform = { from, quad: rectQuad(from), targets, allLayers, version: 0 };
    this.emit('selection', 'content');
    return true;
  }
  /** Replace the session's corner quad. Self-intersecting quads are rejected. */
  setTransformQuad(quad: Quad) {
    const session = this.transform;
    if (!session || !isConvex(quad)) return false;
    session.quad = quad.map((p) => [p[0], p[1]]) as Quad; session.version++;
    const matrix = rectToQuad(session.from, session.quad), scale = Math.sqrt(Math.abs(quadArea(session.quad) / Math.max(1e-9, session.from.width * session.from.height)));
    for (const target of session.targets) {
      if (!target.strokes || !target.layer.vector) continue;
      target.layer.vector.strokes = [...target.others!, ...target.strokes.map((stroke) => mapStroke(stroke, matrix, scale))];
      target.layer.vector.touch();
    }
    this.emit('selection', 'content');
    return true;
  }
  /** True when transformed content would extend past the canvas edges. */
  transformOutsideCanvas() {
    const session = this.transform;
    if (!session) return false;
    const box = quadBounds(session.quad);
    return box.x < 0 || box.y < 0 || box.x + box.width > this.width || box.y + box.height > this.height;
  }
  /** Commit as one undoable step. `keepOutside: false` crops transformed content to the canvas. */
  commitTransformSession(keepOutside = true) {
    const session = this.transform;
    if (!session) return false;
    this.transform = undefined;
    const canvas = { x: 0, y: 0, width: this.width, height: this.height };
    const commands: HistoryCommand[] = [];
    const matrix = rectToQuad(session.from, session.quad), scale = Math.sqrt(Math.abs(quadArea(session.quad) / Math.max(1e-9, session.from.width * session.from.height)));
    for (const target of session.targets) {
      if (target.image && target.recorder && target.layer.raster) {
        const warped = warpImage(target.image, target.rect, targetQuad(matrix, target.rect), keepOutside ? undefined : canvas);
        if (warped) stampImage(target.layer.raster, warped.image, warped.rect, target.recorder);
        const command = target.recorder.command('transform');
        if (command) commands.push(command);
      } else if (target.strokes && target.layer.vector) {
        const vector = target.layer.vector;
        let moved = target.strokes.map((stroke) => mapStroke(stroke, matrix, scale));
        if (!keepOutside) moved = moved.filter((stroke) => intersects(strokeBounds(stroke), canvas));
        vector.strokes = target.before!;
        commands.push(replaceStrokes(vector, [...target.others!, ...moved], 'transform strokes'));
      }
    }
    this.selection = undefined;
    if (!commands.length) { this.emit('selection', 'content'); return false; }
    return this.record(compound('transform', commands), 'content', 'selection');
  }
  cancelTransformSession() {
    const session = this.transform;
    if (!session) return;
    this.transform = undefined;
    for (const target of session.targets) {
      target.recorder?.restore();
      if (target.before && target.layer.vector) { target.layer.vector.strokes = target.before; target.layer.vector.touch(); }
    }
    this.emit('selection', 'content');
  }
  /** Target corner quad for a sub-rectangle of the session (used to warp each layer's pixels). */
  transformQuadFor(rect: Rect): Quad | undefined {
    const session = this.transform;
    return session && targetQuad(rectToQuad(session.from, session.quad), rect);
  }

  // Rectangle move/resize of the lasso selection, expressed as a transform session.
  /** Lift the selection so it can be moved/resized; preview via `transform`. */
  beginTransform() { return !!this.selection && this.beginTransformSession(false); }
  setTransform(box: Rect) { this.setTransformQuad(rectQuad({ ...box, width: Math.max(1, box.width), height: Math.max(1, box.height) })); }
  commitTransform() { return this.commitTransformSession(true); }
  cancelTransform() { this.cancelTransformSession(); }
  /** Bounding box of the transformed content while a session is active. */
  get floating() { const session = this.transform; return session ? { from: session.from, box: quadBounds(session.quad) } : undefined; }

  // ---------------------------------------------------------------- layers
  /** A filename for a new layer asset, unique among known files. */
  private layerFileName(kind: LayerKind, name: string) {
    const extension = kind === 'raster' ? '.png' : '.svg';
    for (let i = 0; ; i++) {
      const file = `${this.base}.${slug(name)}${i ? `-${i + 1}` : ''}${extension}`;
      if (!this.names.has(file.toLowerCase())) { this.names.add(file.toLowerCase()); return file; }
    }
  }
  private addLayerInternal(kind: LayerKind, name: string) {
    const layer: Layer = { id: layerId(), missing: false, savedVersion: -1,
      entry: { kind, file: this.layerFileName(kind, name), x: 0, y: 0, name, visible: true, opacity: 1, locked: false },
      raster: kind === 'raster' ? new TiledSurface() : undefined, vector: kind === 'vector' ? new VectorLayerData() : undefined };
    const index = this.layers.findIndex((item) => item.id === this.activeLayerId);
    this.layers.splice(index < 0 ? this.layers.length : index + 1, 0, layer);
    this.activeLayerId = layer.id;
    return layer;
  }
  private changeLayers(label: string, change: () => void, active?: string) {
    const before = [...this.layers], beforeEntries = new Map(this.layers.map((layer) => [layer.id, { ...layer.entry }])), beforeActive = this.activeLayerId;
    change();
    if (active) this.activeLayerId = active;
    const after = [...this.layers], afterEntries = new Map(this.layers.map((layer) => [layer.id, { ...layer.entry }])), afterActive = this.activeLayerId;
    const apply = (layers: Layer[], entries: Map<string, LayerEntry>, activeId: string) => {
      this.layers = [...layers];
      for (const layer of this.layers) { const entry = entries.get(layer.id); if (entry) layer.entry = { ...entry }; }
      this.activeLayerId = activeId;
    };
    this.record({ label, bytes: 256, undo: () => apply(before, beforeEntries, beforeActive), redo: () => apply(after, afterEntries, afterActive) }, 'layers', 'content');
  }
  addLayer(kind: LayerKind, name = `${kind === 'raster' ? 'Layer' : 'Ink'} ${this.layers.length + 1}`) {
    if (this.layers.length >= MAX_LAYERS || this.busy) return undefined;
    let layer: Layer | undefined;
    this.deselect();
    this.changeLayers(`add ${kind} layer`, () => { layer = this.addLayerInternal(kind, name); });
    return layer;
  }
  removeLayer(id = this.activeLayerId) {
    if (this.layers.length < 2 || this.busy) return false;
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index < 0) return false;
    this.deselect();
    const next = (this.layers[index - 1] ?? this.layers[index + 1]).id;
    this.changeLayers('delete layer', () => { this.layers.splice(index, 1); }, next);
    return true;
  }
  /** Move toward the top (+1) or bottom (-1) of the stack. */
  moveLayer(id: string, direction: 1 | -1) {
    const index = this.layers.findIndex((layer) => layer.id === id), target = index + direction;
    if (index < 0 || target < 0 || target >= this.layers.length || this.busy) return false;
    this.changeLayers('reorder layer', () => { [this.layers[index], this.layers[target]] = [this.layers[target], this.layers[index]]; });
    return true;
  }
  updateLayer(id: string, patch: Partial<Pick<LayerEntry, 'name' | 'visible' | 'opacity' | 'locked'>>) {
    const layer = this.layer(id);
    if (!layer || this.busy) return false;
    this.changeLayers('layer properties', () => { layer.entry = { ...layer.entry, ...patch }; });
    return true;
  }
  setActiveLayer(id: string) { if (this.layer(id) && !this.busy) { this.deselect(); this.activeLayerId = id; this.emit('layers', 'state'); } }

  // ---------------------------------------------------------------- persistence
  serialize(compact = false) {
    this.doc.layers = this.layers.map((layer) => layer.entry);
    this.doc.state.layer = Math.max(0, this.layers.findIndex((layer) => layer.id === this.activeLayerId));
    return serializeDocument(this.doc, { compact });
  }
  layerVersion(layer: Layer) { return layer.raster?.version ?? layer.vector?.version ?? 0; }
  isLayerDirty(layer: Layer) { return !layer.missing && this.layerVersion(layer) !== layer.savedVersion; }
  private signature() {
    return this.persistState ? this.serialize() : JSON.stringify(this.layers.map((layer) => [layer.id, layer.entry]));
  }
  get dirty() { return this.layers.some((layer) => this.isLayerDirty(layer)) || this.signature() !== this.savedSignature; }

  /**
   * Produce the main text plus every changed layer file. Raster layers are cropped to their content,
   * and their offsets recorded in the main file. Call `markSaved(result)` once the host has written them.
   */
  async save(): Promise<SaveResult & { versions: Map<string, number> }> {
    if (this.stroke) this.endStroke();
    if (this.transform) this.commitTransformSession(true);
    const files: SavedFile[] = [], versions = new Map<string, number>();
    for (const layer of this.layers) {
      if (!this.isLayerDirty(layer)) continue;
      versions.set(layer.id, this.layerVersion(layer));
      if (layer.raster) {
        const bounds = layer.raster.bounds() ?? { x: 0, y: 0, width: 1, height: 1 };
        layer.entry = { ...layer.entry, x: bounds.x, y: bounds.y };
        files.push({ name: layer.entry.file, kind: 'raster', data: await encodePng(layer.raster.read(bounds)) });
      } else if (layer.vector) {
        layer.entry = { ...layer.entry, x: 0, y: 0 };
        files.push({ name: layer.entry.file, kind: 'vector', data: serializeVector(layer.vector, this.width, this.height) });
      }
    }
    return { main: this.serialize(), files, versions };
  }
  markSaved(result: { main: string; versions: Map<string, number> }) {
    for (const layer of this.layers) { const version = result.versions.get(layer.id); if (version !== undefined) layer.savedVersion = version; }
    this.savedSignature = this.persistState ? result.main : this.signature();
    this.emit('state');
  }

  // ---------------------------------------------------------------- flattening
  /** Rasterize a layer into the given rectangle (vector strokes are rendered with the raster brush engine). */
  layerPixels(layer: Layer, rect: Rect = { x: 0, y: 0, width: this.width, height: this.height }): RGBAImage {
    if (layer.raster) return layer.raster.read(rect);
    const surface = new TiledSurface();
    for (const stroke of layer.vector?.strokes ?? []) {
      const painter = new RasterStroke(surface, defaultBrush({ size: stroke.size, minSize: stroke.minSize, sizePressure: stroke.sizePressure, pressureGamma: stroke.pressureGamma, opacity: stroke.opacity, spacing: 0.05 }), stroke.color, false, undefined, undefined, rect);
      for (let i = 0; i < stroke.points.length; i += 3) painter.add({ x: stroke.points[i], y: stroke.points[i + 1], pressure: stroke.points[i + 2] });
      painter.finish();
    }
    return surface.read(rect);
  }
  /** Composite visible layers (straight alpha) — for export, thumbnails and flat image formats. */
  flatten(rect: Rect = { x: 0, y: 0, width: this.width, height: this.height }, background?: string): RGBAImage {
    const out = new Uint8ClampedArray(rect.width * rect.height * 4);
    if (background) { const [r, g, b] = parseColor(background); for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; } }
    for (const layer of this.layers) {
      if (!layer.entry.visible || layer.missing || layer.entry.opacity <= 0) continue;
      const src = this.layerPixels(layer, rect).data, opacity = layer.entry.opacity;
      for (let i = 0; i < out.length; i += 4) {
        const sa = src[i + 3] / 255 * opacity;
        if (!sa) continue;
        const da = out[i + 3] / 255, outA = sa + da * (1 - sa), keep = da * (1 - sa);
        out[i] = (src[i] * sa + out[i] * keep) / outA; out[i + 1] = (src[i + 1] * sa + out[i + 1] * keep) / outA; out[i + 2] = (src[i + 2] * sa + out[i + 2] * keep) / outA;
        out[i + 3] = Math.round(outA * 255);
      }
    }
    return { width: rect.width, height: rect.height, data: out };
  }
}

const quadArea = (q: Quad) => Math.abs(q.reduce((sum, p, i) => { const n = q[(i + 1) % 4]; return sum + p[0] * n[1] - n[0] * p[1]; }, 0)) / 2;
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const targetQuad = (matrix: Matrix3, rect: Rect): Quad => rectQuad(rect).map(([x, y]) => applyMatrix(matrix, x, y)) as Quad;
function mapStroke(stroke: VectorStroke, matrix: Matrix3, scale: number): VectorStroke {
  const points = stroke.points.slice();
  for (let i = 0; i < points.length; i += 3) { const [x, y] = applyMatrix(matrix, points[i], points[i + 1]); points[i] = Math.round(x * 100) / 100; points[i + 1] = Math.round(y * 100) / 100; }
  return { ...stroke, points, size: Math.max(0.25, stroke.size * scale) };
}
const unite = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

export { compound };
