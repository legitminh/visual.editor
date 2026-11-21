import type { RGBAImage } from '../raster/surface';

/**
 * Minimal PNG codec on top of the platform's native (de)compression streams, so encoding works
 * identically in browsers, workers, Tauri webviews and Node 18+ without a canvas.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes: Uint8Array, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const output = new Blob([data as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(output).arrayBuffer());
}
export const deflate = (data: Uint8Array) => transform(data, new CompressionStream('deflate'));
export const inflate = (data: Uint8Array) => transform(data, new DecompressionStream('deflate'));

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encode straight-alpha RGBA8. Uses the "up" filter, which compresses painted art well and is cheap. */
export async function encodePng(image: RGBAImage, text?: Record<string, string>): Promise<Uint8Array> {
  const { width, height, data } = image, stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride, out = y * (stride + 1);
    raw[out] = y ? 2 : 0;
    if (!y) { raw.set(data.subarray(0, stride), 1); continue; }
    for (let i = 0; i < stride; i++) raw[out + 1 + i] = data[row + i] - data[row - stride + i];
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  const chunks = [chunk('IHDR', header)];
  for (const [key, value] of Object.entries(text ?? {})) chunks.push(chunk('tEXt', new TextEncoder().encode(`${key}\0${value}`)));
  chunks.push(chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array()));
  const out = new Uint8Array(8 + chunks.reduce((sum, c) => sum + c.length, 0));
  out.set(SIGNATURE); let offset = 8;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

export interface PngChunk { type: string; data: Uint8Array }
export function readChunks(bytes: Uint8Array): PngChunk[] {
  if (!SIGNATURE.every((value, i) => bytes[i] === value)) throw new Error('Not a PNG file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks: PngChunk[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Text metadata (tEXt, zTXt, iTXt uncompressed) — used for Krita `.kpp` presets. */
export async function readPngText(bytes: Uint8Array) {
  const result: Record<string, string> = {}, latin1 = new TextDecoder('latin1'), utf8 = new TextDecoder();
  for (const { type, data } of readChunks(bytes)) {
    const nul = data.indexOf(0);
    if (nul < 0) continue;
    const key = latin1.decode(data.subarray(0, nul));
    if (type === 'tEXt') result[key] = latin1.decode(data.subarray(nul + 1));
    else if (type === 'zTXt') result[key] = latin1.decode(await inflate(data.subarray(nul + 2)));
    else if (type === 'iTXt') {
      const compressed = data[nul + 1];
      let i = nul + 3; i = data.indexOf(0, i) + 1; i = data.indexOf(0, i) + 1;
      result[key] = utf8.decode(compressed ? await inflate(data.subarray(i)) : data.subarray(i));
    }
  }
  return result;
}

/** Decode non-interlaced 8-bit PNGs (gray, gray+alpha, RGB, RGBA, palette). Browsers should prefer `decodeImage`. */
export async function decodePng(bytes: Uint8Array): Promise<RGBAImage> {
  const chunks = readChunks(bytes), header = chunks.find((c) => c.type === 'IHDR');
  if (!header) throw new Error('PNG header missing.');
  const view = new DataView(header.data.buffer, header.data.byteOffset);
  const width = view.getUint32(0), height = view.getUint32(4), depth = header.data[8], type = header.data[9], interlace = header.data[12];
  if (depth !== 8 || interlace) throw new Error('Only 8-bit, non-interlaced PNGs are supported by the built-in decoder.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels) throw new Error('Unsupported PNG color type.');
  const idat = chunks.filter((c) => c.type === 'IDAT'), joined = new Uint8Array(idat.reduce((sum, c) => sum + c.data.length, 0));
  let offset = 0; for (const c of idat) { joined.set(c.data, offset); offset += c.data.length; }
  const raw = await inflate(joined), stride = width * channels, pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[row + i - channels] : 0, b = y ? pixels[row - stride + i] : 0, c = y && i >= channels ? pixels[row - stride + i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a; else if (filter === 2) value += b; else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      pixels[row + i] = value;
    }
  }
  const palette = chunks.find((c) => c.type === 'PLTE')?.data, alpha = chunks.find((c) => c.type === 'tRNS')?.data;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (type === 6) { data[d] = pixels[s]; data[d + 1] = pixels[s + 1]; data[d + 2] = pixels[s + 2]; data[d + 3] = pixels[s + 3]; }
    else if (type === 2) { data[d] = pixels[s]; data[d + 1] = pixels[s + 1]; data[d + 2] = pixels[s + 2]; data[d + 3] = 255; }
    else if (type === 0) { data[d] = data[d + 1] = data[d + 2] = pixels[s]; data[d + 3] = 255; }
    else if (type === 4) { data[d] = data[d + 1] = data[d + 2] = pixels[s]; data[d + 3] = pixels[s + 1]; }
    else { const k = pixels[s]; data[d] = palette?.[k * 3] ?? 0; data[d + 1] = palette?.[k * 3 + 1] ?? 0; data[d + 2] = palette?.[k * 3 + 2] ?? 0; data[d + 3] = alpha?.[k] ?? 255; }
  }
  return { width, height, data };
}

/** Decode any browser-supported image (PNG/JPEG/WebP…) to straight RGBA, falling back to the built-in PNG decoder. */
export async function decodeImage(blob: Blob): Promise<RGBAImage> {
  const scope = globalThis as unknown as { createImageBitmap?: typeof createImageBitmap; OffscreenCanvas?: typeof OffscreenCanvas; document?: Document };
  if (scope.createImageBitmap && (scope.OffscreenCanvas || scope.document)) {
    const bitmap = await scope.createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    try {
      const canvas = scope.OffscreenCanvas ? new scope.OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(scope.document!.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: bitmap.width, height: bitmap.height, data };
    } finally { bitmap.close(); }
  }
  return decodePng(new Uint8Array(await blob.arrayBuffer()));
}
