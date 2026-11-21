// Minimal standalone host: proves the engine, input controller and renderer work without any framework.
import { VisualEditor, ViewTransform, CanvasRenderer, InputController, fromPointerEvent, KRITA_BASIC_PACK, brushFileName } from '../src/index';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const editor = VisualEditor.create('demo', 1600, 1000);
for (const brush of KRITA_BASIC_PACK) editor.addBrush(brushFileName(brush.name), brush, false);
const view = new ViewTransform(editor.width, editor.height);
const renderer = new CanvasRenderer(canvas, editor, view);
let tool: 'brush' | 'eraser' = 'brush';
const input = new InputController({
  strokeBegin: (p) => { const [x, y] = view.toDocument(p.x, p.y); editor.beginStroke(x, y, p.pressure, tool); },
  strokeMove: (p) => { const [x, y] = view.toDocument(p.x, p.y); editor.strokeTo(x, y, p.pressure); },
  strokeEnd: (p) => { const [x, y] = view.toDocument(p.x, p.y); editor.strokeTo(x, y, p.pressure); editor.endStroke(); },
  strokeCancel: () => editor.cancelStroke(),
  pan: (dx, dy) => { view.panBy(dx, dy); renderer.request(); },
  undo: () => editor.undo(), redo: () => editor.redo()
});
const resize = () => { const r = canvas.getBoundingClientRect(); renderer.resize(r.width, r.height, devicePixelRatio); };
new ResizeObserver(resize).observe(canvas); resize(); view.fit(); renderer.request();
for (const [type, phase] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel']] as const) {
  (type === 'pointerdown' ? canvas : window).addEventListener(type, (event) => {
    const e = event as PointerEvent;
    if (type === 'pointerdown') canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    for (const sample of (phase === 'move' ? e.getCoalescedEvents?.() : undefined) ?? [e]) input.handle(fromPointerEvent(sample, rect, phase));
  });
}
canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); view.zoomAt(view.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); renderer.request(); }, { passive: false });
document.querySelector('#brushes')!.append(...KRITA_BASIC_PACK.map((brush) => Object.assign(document.createElement('option'), { value: brushFileName(brush.name), textContent: brush.name })));
document.querySelector<HTMLSelectElement>('#brushes')!.onchange = (e) => editor.setState({ brush: (e.target as HTMLSelectElement).value });
document.querySelector<HTMLInputElement>('#color')!.oninput = (e) => editor.setState({ color: (e.target as HTMLInputElement).value });
document.querySelector<HTMLButtonElement>('#tool')!.onclick = (e) => { tool = tool === 'brush' ? 'eraser' : 'brush'; (e.target as HTMLElement).textContent = tool; };
document.querySelector<HTMLButtonElement>('#undo')!.onclick = () => editor.undo();
document.querySelector<HTMLButtonElement>('#redo')!.onclick = () => editor.redo();
document.querySelector<HTMLButtonElement>('#vector')!.onclick = () => editor.addLayer('vector');
Object.assign(window, { editor, view, renderer });
