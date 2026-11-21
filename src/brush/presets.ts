import { brushFileName, defaultBrush, serializeBrush, type Brush } from './brush';

/**
 * The "Krita basic" pack: the pixel-brush presets Krita ships for everyday sketching, re-expressed as
 * engine parameters (auto circular tip, opacity/flow/size pressure). Values approximate Krita's defaults.
 */
const krita = (name: string, patch: Partial<Brush>): Brush => defaultBrush({ name, source: `krita:paintbrush:${name}`, ...patch });

export const KRITA_BASIC_PACK: Brush[] = [
  krita('a) Basic-1', { size: 10, hardness: 1, spacing: 0.1 }),
  krita('b) Basic-2 Opacity', { size: 20, hardness: 1, spacing: 0.1, opacityPressure: true }),
  krita('b) Basic-3 Flow', { size: 25, hardness: 1, spacing: 0.1, flow: 1, flowPressure: true }),
  krita('b) Basic-4 Flow Opacity', { size: 25, hardness: 0.85, spacing: 0.08, flowPressure: true, opacityPressure: true }),
  krita('b) Basic-5 Size', { size: 15, hardness: 1, spacing: 0.08, sizePressure: true, minSize: 0 }),
  krita('b) Basic-5 Size Opacity', { size: 15, hardness: 1, spacing: 0.08, sizePressure: true, minSize: 0, opacityPressure: true }),
  krita('b) Basic-6 Details', { size: 5, hardness: 1, spacing: 0.05, sizePressure: true, minSize: 0.2, smoothing: 0.35 }),
  krita('c) Pencil-1 Hard', { size: 3, hardness: 0.9, spacing: 0.05, opacityPressure: true, pressureGamma: 0.8 }),
  krita('c) Pencil-2', { size: 4, hardness: 0.5, spacing: 0.05, opacity: 0.85, opacityPressure: true, sizePressure: true, minSize: 0.5 }),
  krita('d) Ink-2 Fineliner', { size: 4, hardness: 1, spacing: 0.04, sizePressure: true, minSize: 0.35, smoothing: 0.45 }),
  krita('d) Ink-3 Gpen', { size: 9, hardness: 1, spacing: 0.04, sizePressure: true, minSize: 0, pressureGamma: 1.4, smoothing: 0.5 }),
  krita('e) Marker Chisel', { size: 30, hardness: 0.9, spacing: 0.05, ratio: 0.35, angle: 45, opacity: 0.8 }),
  krita('f) Airbrush Soft', { size: 80, hardness: 0, spacing: 0.05, flow: 0.08, flowPressure: true }),
  krita('g) Blender Soft Wash', { size: 60, hardness: 0.1, spacing: 0.1, opacity: 0.35, opacityPressure: true }),
  krita('a) Eraser Circle', { size: 30, hardness: 1, spacing: 0.08, eraser: true }),
  krita('a) Eraser Small', { size: 8, hardness: 1, spacing: 0.08, eraser: true, sizePressure: true, minSize: 0.3 }),
  krita('a) Eraser Soft', { size: 60, hardness: 0.2, spacing: 0.08, eraser: true, flow: 0.4 })
];

export const DEFAULT_BRUSH = KRITA_BASIC_PACK[6];
export const DEFAULT_ERASER = KRITA_BASIC_PACK[14];

/** Files to seed a brush folder with: `{ name: 'basic-1.vbrush', text: '\\visual_brush[...]' }`. */
export function kritaBasicFiles() {
  return KRITA_BASIC_PACK.map((brush) => ({ name: brushFileName(brush.name), text: serializeBrush(brush), brush }));
}
