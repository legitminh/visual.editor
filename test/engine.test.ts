import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDocument, serializeDocument, TiledSurface, RasterStroke, defaultBrush, TILE, encodePng, decodePng, VisualEditor,
  importBrush, serializeBrush, parseBrush, kritaBasicFiles, InputController, type RawPointer, History, polygonMask,
  parseVector, serializeVector, VectorLayerData, readPngText
} from '../src/index';

const alphaAt = (surface: TiledSurface, x: number, y: number) => surface.read({ x, y, width: 1, height: 1 }).data[3];

test('document syntax round-trips, keeps notes, and supports the compact domain operator', () => {
  const text = `my sketch notes
\\image_editor_config[
  width=800
  height=600
  palette=#112233 #ffffff
]
\\image_editor_brushes[app.asset/editor.visual/brushes/basic-1.vbrush, "odd, name.vbrush"]
\\image_editor_raster[sketch.bg.png, 10, -4, name=Background]
\\image_editor_vector[sketch.ink.svg, 0, 0, opacity=0.5, hidden]
`;
  const doc = parseDocument(text);
  assert.equal(doc.config.width, 800);
  assert.deepEqual(doc.config.palette, ['#112233', '#ffffff']);
  assert.deepEqual(doc.brushes, ['app.asset/editor.visual/brushes/basic-1.vbrush', 'odd, name.vbrush']);
  assert.equal(doc.layers.length, 2);
  assert.deepEqual([doc.layers[0].x, doc.layers[0].y, doc.layers[0].name], [10, -4, 'Background']);
  assert.equal(doc.layers[1].visible, false); assert.equal(doc.layers[1].opacity, 0.5);
  assert.deepEqual(doc.notes, ['my sketch notes']);
  const again = parseDocument(serializeDocument(doc));
  assert.deepEqual(again, doc);
  const compact = serializeDocument(doc, { compact: true });
  assert.match(compact, /\\image_editor\[\\c\[/);
  assert.deepEqual(parseDocument(compact), doc);
});

test('wash painting caps coverage at opacity, undo swaps tiles, eraser removes pixels', () => {
  const surface = new TiledSurface(), history = new History();
  const stroke = new RasterStroke(surface, defaultBrush({ size: 20, opacity: 0.5, spacing: 0.05 }), '#ff0000', false);
  for (let x = 10; x <= 300; x += 3) stroke.add({ x, y: 50, pressure: 1 });
  for (let x = 300; x >= 10; x -= 3) stroke.add({ x, y: 50, pressure: 1 });
  history.push(stroke.finish()!);
  assert.equal(alphaAt(surface, 150, 50), 128, 'overlapping dabs do not exceed stroke opacity');
  assert.ok([...surface.tiles.keys()].length >= 3, 'stroke spans several tiles');
  history.undo(); assert.equal(alphaAt(surface, 150, 50), 0); assert.equal(surface.tiles.size, 0);
  history.redo(); assert.equal(alphaAt(surface, 150, 50), 128);
  const eraser = new RasterStroke(surface, defaultBrush({ size: 30 }), '#000000', true);
  eraser.add({ x: 150, y: 50, pressure: 1 }); history.push(eraser.finish()!);
  assert.equal(alphaAt(surface, 150, 50), 0); assert.equal(alphaAt(surface, 250, 50), 128);
  history.undo(); assert.equal(alphaAt(surface, 150, 50), 128);
});

test('selection clip limits painting', () => {
  const surface = new TiledSurface();
  const clip = polygonMask([[0, 0], [100, 0], [100, 100], [0, 100]])!;
  const stroke = new RasterStroke(surface, defaultBrush({ size: 10 }), '#000000', false, undefined, clip);
  for (let x = 50; x <= 150; x += 2) stroke.add({ x, y: 50, pressure: 1 });
  stroke.finish();
  assert.equal(alphaAt(surface, 60, 50), 255); assert.equal(alphaAt(surface, 120, 50), 0);
});

test('history drops the oldest frames beyond its frame limit', () => {
  const history = new History({ frames: 2, bytes: Infinity }); let value = 0;
  for (let i = 1; i <= 3; i++) { const from = value, to = i; value = to; history.push({ label: 'set', bytes: 1, undo: () => { value = from; }, redo: () => { value = to; } }); }
  history.undo(); history.undo(); assert.equal(value, 1); assert.equal(history.canUndo, false);
});

test('PNG encode/decode round-trip with text chunks', async () => {
  const data = new Uint8ClampedArray(5 * 3 * 4).map((_, i) => (i * 37) % 256);
  const png = await encodePng({ width: 5, height: 3, data }, { preset: '<Preset name="x"/>' });
  const decoded = await decodePng(png);
  assert.deepEqual([...decoded.data], [...data]);
  assert.equal((await readPngText(png)).preset, '<Preset name="x"/>');
});

test('editor saves cropped raster layers and vector layers, reports missing layers, and reopens', async () => {
  const editor = VisualEditor.create('sketch', 400, 300);
  assert.equal(editor.layers.length, 1);
  editor.setState({ brushSize: 12 });
  editor.beginStroke(100, 100, 1, 'brush'); editor.strokeTo(200, 120, 1); editor.endStroke();
  const ink = editor.addLayer('vector', 'Ink')!;
  editor.beginStroke(50, 50, 0.5, 'brush'); editor.strokeTo(80, 60, 1); editor.endStroke();
  assert.equal(ink.vector!.strokes.length, 1);
  const saved = await editor.save();
  editor.markSaved(saved);
  assert.equal(editor.dirty, false);
  assert.deepEqual(saved.files.map((file) => file.name), ['sketch.layer-1.png', 'sketch.ink.svg']);
  assert.match(saved.main, /\\image_editor_raster\[sketch\.layer-1\.png, 9\d, 9\d/);
  const files = new Map(saved.files.map((file) => [file.name, new Blob([file.data as BlobPart])]));
  const reopened = await VisualEditor.open(saved.main + '\\image_editor_raster[gone.png, 0, 0]\n', { read: async (name) => files.get(name) }, { base: 'sketch' });
  assert.equal(reopened.layers.length, 3);
  assert.deepEqual(reopened.missingLayers.map((layer) => layer.entry.file), ['gone.png']);
  assert.equal(reopened.layers[0].raster!.read({ x: 150, y: 110, width: 1, height: 1 }).data[3], 255);
  assert.equal(reopened.layers[1].vector!.strokes.length, 1);
  // Vector eraser removes whole strokes.
  reopened.setActiveLayer(reopened.layers[1].id);
  reopened.beginStroke(65, 55, 1, 'eraser'); reopened.endStroke();
  assert.equal(reopened.layers[1].vector!.strokes.length, 0);
  reopened.undo(); assert.equal(reopened.layers[1].vector!.strokes.length, 1);
});

test('lasso clears and transforms raster pixels as single undoable operations', () => {
  const editor = VisualEditor.create('t', 300, 200), surface = editor.activeLayer!.raster!;
  surface.write(0, 0, { width: 300, height: 200, data: new Uint8ClampedArray(300 * 200 * 4).fill(255) });
  editor.lasso([[100, 50], [200, 50], [200, 150], [100, 150]]);
  assert.ok(editor.clearSelection());
  assert.equal(alphaAt(surface, 150, 100), 0); assert.equal(alphaAt(surface, 99, 100), 255);
  editor.undo(); assert.equal(alphaAt(surface, 150, 100), 255);
  editor.lasso([[100, 50], [200, 50], [200, 150], [100, 150]]);
  editor.beginTransform(); editor.setTransform({ x: 150, y: 50, width: 100, height: 100 }); editor.commitTransform();
  assert.equal(alphaAt(surface, 120, 100), 0); assert.equal(alphaAt(surface, 240, 100), 255);
  editor.undo(); assert.equal(alphaAt(surface, 120, 100), 255);
});

test('layer operations are undoable and persisted in the main file', async () => {
  const editor = VisualEditor.create('doc', 100, 100);
  const second = editor.addLayer('raster', 'Top')!;
  editor.updateLayer(second.id, { visible: false, opacity: 0.25 });
  editor.moveLayer(second.id, -1);
  assert.equal(editor.layers[0].id, second.id);
  const main = (await editor.save()).main;
  assert.match(main, /doc\.top\.png, 0, 0, name=Top, opacity=0\.25, hidden\]\n\\image_editor_raster\[doc\.layer-1\.png/);
  editor.undo(); editor.undo(); editor.undo();
  assert.equal(editor.layers.length, 1);
  editor.redo(); assert.equal(editor.layers.length, 2);
});

test('brush formats import into the engine format', async () => {
  const vbr = await importBrush('Hardness 075.vbr', new TextEncoder().encode('GIMP-VBR\n1.0\nHardness 075\n10.000000\n12.5\n0.75\n1.0\n0.0\n'));
  assert.equal(vbr.size, 25); assert.equal(vbr.hardness, 0.75); assert.equal(vbr.spacing, 0.1);
  const myb = await importBrush('pencil.myb', new TextEncoder().encode(JSON.stringify({ version: 3, settings: {
    radius_logarithmic: { base_value: Math.log(3), inputs: { pressure: [[0, 0], [1, 0.5]] } }, opaque: { base_value: 0.9, inputs: {} },
    hardness: { base_value: 0.6, inputs: {} }, dabs_per_actual_radius: { base_value: 4, inputs: {} } } })));
  assert.ok(Math.abs(myb.size - 6) < 1e-9); assert.equal(myb.sizePressure, true); assert.equal(myb.spacing, 0.125);
  const xml = `<Preset paintopid="paintbrush" name="b) Basic-5 Size"><param name="brush_definition" type="string"><![CDATA[<Brush useAutoSpacing="0" angle="0" spacing="0.08" type="auto_brush"><MaskGenerator diameter="15" ratio="1" hfade="1" vfade="1" type="circle" id="default"/></Brush>]]></param><param name="PressureSize" type="string"><![CDATA[true]]></param><param name="OpacityValue" type="string"><![CDATA[0.9]]></param><param name="CompositeOp" type="string"><![CDATA[normal]]></param></Preset>`;
  const kpp = await importBrush('basic-5.kpp', await encodePng({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, { preset: xml }));
  assert.deepEqual([kpp.name, kpp.size, kpp.sizePressure, kpp.opacity, kpp.spacing, kpp.eraser], ['b) Basic-5 Size', 15, true, 0.9, 0.08, false]);
  const files = kritaBasicFiles();
  assert.ok(files.length >= 12 && files.some((file) => file.name === 'basic-1.vbrush'));
  for (const file of files) assert.deepEqual(parseBrush(file.text), file.brush);
  assert.deepEqual(parseBrush(serializeBrush(kpp)), kpp);
});

test('vector layers serialize to SVG and parse back', () => {
  const layer = new VectorLayerData();
  layer.strokes.push({ id: 'a', points: [1, 2, 0.5, 30, 40, 1], color: '#ff0000', size: 6, minSize: 0.2, sizePressure: true, opacity: 0.8, pressureGamma: 1 });
  const svg = serializeVector(layer, 100, 100);
  assert.match(svg, /<path id="a" fill="#ff0000" fill-opacity="0.8"/);
  assert.deepEqual(parseVector(svg).strokes, layer.strokes);
});

test('input: two-finger tap undoes, three-finger tap redoes, palm touches after pen are ignored, second finger cancels stroke', () => {
  const log: string[] = [];
  const input = new InputController({ strokeBegin: () => log.push('begin'), strokeEnd: () => log.push('end'), strokeCancel: () => log.push('cancel'), undo: () => log.push('undo'), redo: () => log.push('redo'), pinch: (phase) => log.push(`pinch-${phase}`) });
  const event = (id: number, kind: RawPointer['kind'], phase: RawPointer['phase'], time: number, x = 10): RawPointer => ({ id, kind, phase, x, y: 10, pressure: 0.5, buttons: phase === 'up' ? 0 : 1, button: 0, time });
  input.handle(event(1, 'touch', 'down', 0)); input.handle(event(2, 'touch', 'down', 10));
  input.handle(event(1, 'touch', 'up', 50)); input.handle(event(2, 'touch', 'up', 60));
  assert.deepEqual(log, ['begin', 'cancel', 'pinch-begin', 'pinch-end', 'undo']);
  log.length = 0;
  for (const id of [1, 2, 3]) input.handle(event(id, 'touch', 'down', 1000 + id));
  for (const id of [1, 2, 3]) input.handle(event(id, 'touch', 'up', 1100 + id));
  assert.ok(log.includes('redo'));
  log.length = 0;
  input.handle(event(9, 'pen', 'down', 2000)); input.handle(event(9, 'pen', 'up', 2050));
  input.handle(event(4, 'touch', 'down', 2100)); input.handle(event(4, 'touch', 'up', 2150));
  assert.deepEqual(log, ['begin', 'end']);
});

test('TILE is 128 so renderer and history agree', () => assert.equal(TILE, 128));
