import { formatCommand, keyed, parseBoolean, parseCommands, parseNumber, positional, type Arg, type Command } from './syntax';

export type LayerKind = 'raster' | 'vector';
export type Tool = 'brush' | 'eraser' | 'lasso' | 'pan';

export interface LayerEntry {
  kind: LayerKind;
  /** Reference to the layer asset, resolved by the host relative to the main file. */
  file: string;
  x: number;
  y: number;
  name?: string;
  visible: boolean;
  opacity: number;
  locked: boolean;
}

export interface DocumentConfig {
  width: number;
  height: number;
  /** Undo frames kept in memory. */
  history: number;
  /** Undo memory budget in megabytes. */
  historyMb: number;
  background?: string;
  palette: string[];
}

/** User choices that should survive closing and reopening the document. */
export interface EditorState {
  tool: Tool;
  color: string;
  brush?: string;
  brushSize?: number;
  brushOpacity?: number;
  eraser?: string;
  eraserSize?: number;
  /** Index of the active layer, bottom = 0. */
  layer?: number;
  recentColors: string[];
}

export interface VisualDocument {
  config: DocumentConfig;
  state: EditorState;
  /** Brush palette: references to brush files, resolved by the host. */
  brushes: string[];
  /** Bottom to top. In the text file, lower lines are drawn on top of upper lines. */
  layers: LayerEntry[];
  /** Text that is not an image_editor command (comments, notes); preserved at the top of the file. */
  notes: string[];
}

export const DEFAULT_PALETTE = ['#202733', '#ffffff', '#868e96', '#e03131', '#f08c00', '#fcc419', '#2f9e44', '#1c7ed6', '#7048e8', '#c2255c'];
export const VISUAL_EXTENSION = '.visual';

export function defaultDocument(width = 1920, height = 1080): VisualDocument {
  return {
    config: { width, height, history: 100, historyMb: 256, palette: [...DEFAULT_PALETTE] },
    state: { tool: 'brush', color: '#202733', recentColors: [] },
    brushes: [], layers: [], notes: []
  };
}

const tools: Tool[] = ['brush', 'eraser', 'lasso', 'pan'];
const colorPattern = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const colors = (value?: string) => (value ?? '').split(/[\s|;]+/).filter((color) => colorPattern.test(color)).map((color) => color.toLowerCase());

function layerEntry(kind: LayerKind, args: Arg[]): LayerEntry | undefined {
  const [file, x, y, ...flags] = positional(args), options = keyed(args);
  const reference = options.file ?? file;
  if (!reference) return undefined;
  return {
    kind, file: reference,
    x: Math.round(parseNumber(options.x ?? x, 0)), y: Math.round(parseNumber(options.y ?? y, 0)),
    name: options.name || undefined,
    visible: parseBoolean(options.visible, !flags.some((flag) => /^hidden$/i.test(flag))),
    opacity: parseNumber(options.opacity, 1, 0, 1),
    locked: parseBoolean(options.locked, flags.some((flag) => /^locked$/i.test(flag)))
  };
}

function applyConfig(document: VisualDocument, options: Record<string, string>) {
  const { config } = document;
  config.width = Math.round(parseNumber(options.width ?? options.w, config.width, 1, 16384));
  config.height = Math.round(parseNumber(options.height ?? options.h, config.height, 1, 16384));
  config.history = Math.round(parseNumber(options.history, config.history, 0, 10000));
  config.historyMb = parseNumber(options.history_mb, config.historyMb, 1, 16384);
  if (options.background && colorPattern.test(options.background)) config.background = options.background.toLowerCase();
  if (options.palette !== undefined) config.palette = colors(options.palette);
  applyState(document, options);
}

function applyState(document: VisualDocument, options: Record<string, string>) {
  const { state } = document;
  if (tools.includes(options.tool as Tool)) state.tool = options.tool as Tool;
  if (options.color && colorPattern.test(options.color)) state.color = options.color.toLowerCase();
  if (options.brush) state.brush = options.brush;
  if (options.eraser) state.eraser = options.eraser;
  if (options.brush_size) state.brushSize = parseNumber(options.brush_size, 10, 0.5, 5000);
  if (options.brush_opacity) state.brushOpacity = parseNumber(options.brush_opacity, 1, 0, 1);
  if (options.eraser_size) state.eraserSize = parseNumber(options.eraser_size, 30, 0.5, 5000);
  if (options.layer) state.layer = Math.max(0, Math.round(parseNumber(options.layer, 0)));
  if (options.recent !== undefined) state.recentColors = colors(options.recent).slice(0, 16);
}

/** Expand the compact domain operator `\image_editor[\r[...]\v[...]\c[...]\b[...]]`. */
function expand(command: Command): Command[] {
  if (command.name !== 'image_editor') return [command];
  const alias: Record<string, string> = { r: 'image_editor_raster', v: 'image_editor_vector', c: 'image_editor_config', s: 'image_editor_state', b: 'image_editor_brushes' };
  return parseCommands(command.body).flatMap((item) => item.type === 'command'
    ? expand({ ...item.command, name: alias[item.command.name] ?? item.command.name }) : []);
}

export function parseDocument(text: string): VisualDocument {
  const document = defaultDocument();
  for (const item of parseCommands(text.replace(/\r\n?/g, '\n'))) {
    if (item.type === 'text') {
      for (const line of item.text.split('\n')) if (line.trim()) document.notes.push(line.trimEnd());
      continue;
    }
    for (const command of expand(item.command)) {
      const options = keyed(command.args);
      switch (command.name) {
        case 'image_editor_config': applyConfig(document, options); break;
        case 'image_editor_state': applyState(document, options); break;
        case 'image_editor_brushes': document.brushes.push(...positional(command.args)); break;
        case 'image_editor_raster': case 'image_editor_vector': {
          const entry = layerEntry(command.name === 'image_editor_raster' ? 'raster' : 'vector', command.args);
          if (entry) document.layers.push(entry);
          break;
        }
        default: document.notes.push(`\\${command.name}[${command.body}]`);
      }
    }
  }
  document.brushes = [...new Set(document.brushes)];
  return document;
}

export function serializeDocument(document: VisualDocument, options: { compact?: boolean } = {}) {
  const { config, state } = document;
  const configArgs: [string, string | number][] = [['width', config.width], ['height', config.height], ['history', config.history], ['history_mb', config.historyMb]];
  if (config.background) configArgs.push(['background', config.background]);
  configArgs.push(['palette', config.palette.join(' ')]);
  const stateArgs: [string, string | number][] = [['tool', state.tool], ['color', state.color]];
  if (state.brush) stateArgs.push(['brush', state.brush]);
  if (state.brushSize !== undefined) stateArgs.push(['brush_size', round(state.brushSize)]);
  if (state.brushOpacity !== undefined) stateArgs.push(['brush_opacity', round(state.brushOpacity)]);
  if (state.eraser) stateArgs.push(['eraser', state.eraser]);
  if (state.eraserSize !== undefined) stateArgs.push(['eraser_size', round(state.eraserSize)]);
  if (state.layer !== undefined) stateArgs.push(['layer', state.layer]);
  if (state.recentColors.length) stateArgs.push(['recent', state.recentColors.join(' ')]);
  const layer = (entry: LayerEntry) => {
    const args: (string | number | [string, string | number | boolean])[] = [entry.file, entry.x, entry.y];
    if (entry.name) args.push(['name', entry.name]);
    if (entry.opacity !== 1) args.push(['opacity', round(entry.opacity)]);
    if (!entry.visible) args.push('hidden');
    if (entry.locked) args.push('locked');
    return args;
  };
  if (options.compact) {
    const inner = [formatCommand('c', configArgs), formatCommand('s', stateArgs),
      ...(document.brushes.length ? [formatCommand('b', document.brushes)] : []),
      ...document.layers.map((entry) => formatCommand(entry.kind === 'raster' ? 'r' : 'v', layer(entry)))];
    return [...document.notes, `\\image_editor[${inner.join('')}]`].join('\n') + '\n';
  }
  return [
    ...document.notes,
    formatCommand('image_editor_config', configArgs),
    formatCommand('image_editor_state', stateArgs),
    ...(document.brushes.length ? [formatCommand('image_editor_brushes', document.brushes, document.brushes.length > 3)] : []),
    ...document.layers.map((entry) => formatCommand(entry.kind === 'raster' ? 'image_editor_raster' : 'image_editor_vector', layer(entry)))
  ].join('\n') + '\n';
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function isVisualDocumentName(name: string) { return name.toLowerCase().endsWith(VISUAL_EXTENSION); }

/** Quick check used by hosts to decide whether a text file is a visual document. */
export function looksLikeVisualDocument(text: string) { return /\\image_editor(?:_config|_state|_raster|_vector|_brushes)?\[/.test(text); }
