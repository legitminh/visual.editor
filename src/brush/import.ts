import { readPngText } from '../codec/png';
import { defaultBrush, parseBrush, sanitizeBrush, BRUSH_EXTENSION, type Brush } from './brush';

/** Formats the importer understands, by extension. */
export const BRUSH_IMPORT_EXTENSIONS = [BRUSH_EXTENSION, '.kpp', '.vbr', '.myb'];

const baseName = (fileName: string) => fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
const cdata = (value: string) => value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
const decodeEntities = (text: string) => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Krita paintop presets (`.kpp`) are PNG thumbnails carrying the preset XML in a `preset` text chunk.
 * The pixel-brush ("paintbrush") auto-tip parameters map directly onto the engine brush;
 * other paint engines fall back to their size/opacity/flow so they remain usable.
 */
export function brushFromKritaXml(xml: string, fallbackName = 'Krita brush'): Brush {
  const root = attributes(/<Preset\b[^>]*>/.exec(xml)?.[0] ?? '');
  const params: Record<string, string> = {};
  for (const match of xml.matchAll(/<param\b([^>]*)>([\s\S]*?)<\/param>/g)) {
    const name = attributes(match[1]).name;
    if (name) params[name] = decodeEntities(cdata(match[2]));
  }
  const definition = params.brush_definition ?? '';
  const brushTag = attributes(/<Brush\b[^>]*>/.exec(definition)?.[0] ?? '');
  const mask = attributes(/<MaskGenerator\b[^>]*>/.exec(definition)?.[0] ?? '');
  const number = (value: string | undefined, fallback: number) => { const n = Number(value); return value !== undefined && Number.isFinite(n) ? n : fallback; };
  const sensor = (name: string) => /^(true|1)$/i.test(params[name] ?? '') || /<params[^>]*id="pressure"/.test(params[`${name}Sensor`] ?? '');
  const softType = /gauss|soft/i.test(mask.id ?? '') || mask.type === 'gaussian';
  const fade = Math.min(number(mask.hfade, 1), number(mask.vfade, 1));
  const diameter = number(mask.diameter, number(params.brush_size ?? params.size, 10)) * number(params.Size ?? params.SizeValue, 1);
  return sanitizeBrush(defaultBrush({
    name: root.name || fallbackName,
    size: diameter,
    minSize: 0,
    sizePressure: sensor('PressureSize'),
    opacity: number(params.OpacityValue ?? params.Opacity, 1),
    opacityPressure: sensor('PressureOpacity'),
    flow: number(params.FlowValue ?? params.Flow, 1),
    flowPressure: sensor('PressureFlow'),
    hardness: softType ? Math.min(0.3, fade * 0.3) : fade,
    spacing: number(brushTag.spacing, 0.1),
    ratio: number(mask.ratio, 1),
    angle: number(brushTag.angle, 0) * (Math.abs(number(brushTag.angle, 0)) <= Math.PI * 2 ? 180 / Math.PI : 1),
    eraser: (params.CompositeOp ?? '').toLowerCase() === 'erase' || /^(true|1)$/i.test(params.EraserMode ?? ''),
    source: `krita:${root.paintopid ?? 'paintbrush'}:${root.name ?? fallbackName}`
  }));
}

export async function brushFromKpp(bytes: Uint8Array, fallbackName = 'Krita brush') {
  const text = await readPngText(bytes);
  const xml = text.preset ?? Object.values(text).find((value) => value.includes('<Preset'));
  if (!xml) throw new Error('This .kpp file has no Krita preset data.');
  return brushFromKritaXml(xml, fallbackName);
}

/** GIMP generated brushes (`.vbr`), versions 1.0 and 1.5. */
export function brushFromVbr(text: string, fallbackName = 'GIMP brush'): Brush {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim());
  if (lines[0] !== 'GIMP-VBR') throw new Error('This is not a GIMP .vbr brush.');
  const v15 = lines[1] === '1.5';
  const [name, spacing, radius, ...rest] = lines.slice(2);
  const values = (v15 ? rest.slice(2) : rest).map(Number);   // 1.5 adds shape and spikes before hardness
  const [hardness = 1, aspect = 1, angle = 0] = values;
  return sanitizeBrush(defaultBrush({ name: name || fallbackName, size: Number(radius) * 2, spacing: Number(spacing) / 100,
    hardness, ratio: 1 / Math.max(1, aspect), angle, source: `gimp:${name || fallbackName}` }));
}

/** MyPaint brushes (`.myb`, JSON v3): base values plus whether pressure drives size/opacity. */
export function brushFromMyb(text: string, fallbackName = 'MyPaint brush'): Brush {
  const data = JSON.parse(text) as { settings?: Record<string, { base_value?: number; inputs?: Record<string, unknown[]> }> };
  const settings = data.settings;
  if (!settings) throw new Error('This is not a MyPaint brush.');
  const base = (key: string, fallback: number) => settings[key]?.base_value ?? fallback;
  const pressure = (key: string) => !!settings[key]?.inputs?.pressure?.length;
  const dabs = base('dabs_per_actual_radius', 2) + base('dabs_per_basic_radius', 0);
  return sanitizeBrush(defaultBrush({
    name: fallbackName, size: 2 * Math.exp(base('radius_logarithmic', 1)),
    sizePressure: pressure('radius_logarithmic'), minSize: pressure('radius_logarithmic') ? 0.2 : 0,
    opacity: Math.min(1, base('opaque', 1) * base('opaque_multiply', 1) || base('opaque', 1)), opacityPressure: pressure('opaque_multiply') || pressure('opaque'),
    hardness: base('hardness', 0.8), spacing: 1 / (2 * Math.max(0.1, dabs)),
    ratio: 1 / Math.max(1, base('elliptical_dab_ratio', 1)), angle: base('elliptical_dab_angle', 0),
    smoothing: Math.min(0.9, base('slow_tracking', 0) / 10), eraser: base('eraser', 0) > 0.5, source: `mypaint:${fallbackName}`
  }));
}

/** Convert any supported brush file into the engine format. */
export async function importBrush(fileName: string, bytes: Uint8Array): Promise<Brush> {
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf('.')), name = baseName(fileName);
  const text = () => new TextDecoder().decode(bytes);
  switch (extension) {
    case BRUSH_EXTENSION: return parseBrush(text(), name);
    case '.kpp': return brushFromKpp(bytes, name);
    case '.vbr': return brushFromVbr(text(), name);
    case '.myb': return brushFromMyb(text(), name);
    default: throw new Error(`Unsupported brush format “${extension}”. Supported: ${BRUSH_IMPORT_EXTENSIONS.join(', ')}.`);
  }
}
