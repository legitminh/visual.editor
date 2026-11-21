import { formatCommand, keyed, parseBoolean, parseCommands, parseNumber } from '../document/syntax';

/**
 * Engine-native brush. Parameters follow Krita's pixel brush with an auto (generated) circular tip,
 * so presets from other apps map onto it with little loss.
 */
export interface Brush {
  name: string;
  /** Diameter in pixels at full pressure. */
  size: number;
  /** Fraction of size used at zero pressure when sizePressure is on. */
  minSize: number;
  sizePressure: boolean;
  /** Maximum coverage a single stroke can reach (Krita "opacity"). */
  opacity: number;
  opacityPressure: boolean;
  /** How quickly coverage builds toward opacity per dab (Krita "flow"). */
  flow: number;
  flowPressure: boolean;
  /** 1 = hard edge, 0 = fully soft. */
  hardness: number;
  /** Dab spacing as a fraction of the current diameter. */
  spacing: number;
  /** Tip height / width, 0 < ratio <= 1. */
  ratio: number;
  /** Tip rotation in degrees. */
  angle: number;
  /** Input smoothing, 0 = raw input, 1 = heavy. */
  smoothing: number;
  /** Pressure response exponent: < 1 softer, > 1 firmer. */
  pressureGamma: number;
  /** Erases instead of painting, regardless of the active tool. */
  eraser: boolean;
  /** Where the preset came from, e.g. "krita:a) Basic-1". Informational. */
  source?: string;
}

export const BRUSH_EXTENSION = '.vbrush';

export const defaultBrush = (patch: Partial<Brush> = {}): Brush => ({
  name: 'Round', size: 10, minSize: 0, sizePressure: false, opacity: 1, opacityPressure: false,
  flow: 1, flowPressure: false, hardness: 1, spacing: 0.08, ratio: 1, angle: 0, smoothing: 0.2,
  pressureGamma: 1, eraser: false, ...patch
});

const fields: [keyof Brush, string, 'number' | 'boolean' | 'string'][] = [
  ['name', 'name', 'string'], ['size', 'size', 'number'], ['minSize', 'min_size', 'number'], ['sizePressure', 'size_pressure', 'boolean'],
  ['opacity', 'opacity', 'number'], ['opacityPressure', 'opacity_pressure', 'boolean'], ['flow', 'flow', 'number'],
  ['flowPressure', 'flow_pressure', 'boolean'], ['hardness', 'hardness', 'number'], ['spacing', 'spacing', 'number'],
  ['ratio', 'ratio', 'number'], ['angle', 'angle', 'number'], ['smoothing', 'smoothing', 'number'],
  ['pressureGamma', 'pressure_gamma', 'number'], ['eraser', 'eraser', 'boolean'], ['source', 'source', 'string']
];

export function sanitizeBrush(brush: Brush): Brush {
  const clamp = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  return { ...brush,
    name: brush.name.trim() || 'Brush', size: clamp(brush.size, 0.5, 5000, 10), minSize: clamp(brush.minSize, 0, 1, 0),
    opacity: clamp(brush.opacity, 0, 1, 1), flow: clamp(brush.flow, 0.001, 1, 1), hardness: clamp(brush.hardness, 0, 1, 1),
    spacing: clamp(brush.spacing, 0.01, 10, 0.08), ratio: clamp(brush.ratio, 0.01, 1, 1), angle: clamp(brush.angle, -360, 360, 0),
    smoothing: clamp(brush.smoothing, 0, 0.99, 0.2), pressureGamma: clamp(brush.pressureGamma, 0.1, 10, 1) };
}

/** `.vbrush` files use the same plaintext command syntax as visual documents. */
export function serializeBrush(brush: Brush) {
  const args = fields.filter(([key]) => brush[key] !== undefined).map(([key, label]) => [label, brush[key] as string | number | boolean] as [string, string | number | boolean]);
  return formatCommand('visual_brush', args, true) + '\n';
}

export function parseBrush(text: string, fallbackName = 'Brush'): Brush {
  const command = parseCommands(text).find((item) => item.type === 'command' && item.command.name === 'visual_brush');
  if (!command || command.type !== 'command') throw new Error('This is not a visual brush file (expected \\visual_brush[...]).');
  const options = keyed(command.command.args), brush = defaultBrush({ name: fallbackName });
  const record = brush as unknown as Record<string, unknown>;
  for (const [key, label, type] of fields) {
    const value = options[label];
    if (value === undefined) continue;
    record[key] = type === 'number' ? parseNumber(value, record[key] as number) : type === 'boolean' ? parseBoolean(value, false) : value;
  }
  return sanitizeBrush(brush);
}

/** Pressure → [0,1] response with the brush's gamma curve. */
export const pressureResponse = (brush: Brush, pressure: number) => Math.pow(Math.max(0, Math.min(1, pressure)), brush.pressureGamma);

export interface DabParams { radius: number; opacity: number; flow: number }
export function dabParams(brush: Brush, pressure: number, sizeOverride?: number): DabParams {
  const p = pressureResponse(brush, pressure), size = sizeOverride ?? brush.size;
  return {
    radius: Math.max(0.25, size * (brush.sizePressure ? brush.minSize + (1 - brush.minSize) * p : 1) / 2),
    opacity: brush.opacity * (brush.opacityPressure ? p : 1),
    flow: brush.flow * (brush.flowPressure ? p : 1)
  };
}

export function brushFileName(name: string) {
  return name.toLowerCase().replace(/^[a-z]\)\s*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + BRUSH_EXTENSION;
}
