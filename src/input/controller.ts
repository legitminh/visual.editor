/**
 * Turns raw pointer input into editing intents. Platform-neutral: hosts translate their events
 * (DOM PointerEvent, Tauri/native touch) into `RawPointer` and receive strokes, pans, zooms and taps.
 */
export type PointerKind = 'pen' | 'touch' | 'mouse';
export interface RawPointer {
  id: number;
  kind: PointerKind;
  phase: 'down' | 'move' | 'up' | 'cancel';
  /** Viewport (screen) coordinates. */
  x: number; y: number;
  /** 0..1; mice report 0.5 while pressed in browsers, normalised to 1 here. */
  pressure: number;
  /** DOM-style buttons bitmask; 4 = middle. */
  buttons: number;
  button?: number;
  time: number;
}

export interface StrokePoint { x: number; y: number; pressure: number; time: number; kind: PointerKind }
export interface InputHandlers {
  strokeBegin?(point: StrokePoint): void;
  strokeMove?(point: StrokePoint): void;
  strokeEnd?(point: StrokePoint): void;
  strokeCancel?(): void;
  pan?(dx: number, dy: number): void;
  /** Pinch: scale relative to gesture start around a screen-space center. */
  pinch?(phase: 'begin' | 'move' | 'end', scale: number, centerX: number, centerY: number): void;
  undo?(): void;
  redo?(): void;
}
export interface InputOptions {
  /** Only pens draw; one finger pans instead. */
  stylusOnly: boolean;
  /** Force panning (pan tool, held space bar). */
  panMode: boolean;
  /** 0..1 exponential smoothing for stroke positions. */
  smoothing: number;
  /** Touches within this many ms of pen activity are treated as palm contact. */
  palmMs: number;
  tapMs: number;
  tapSlop: number;
}

export class InputController {
  options: InputOptions = { stylusOnly: false, panMode: false, smoothing: 0, palmMs: 500, tapMs: 300, tapSlop: 10 };
  private stroke?: { id: number; kind: PointerKind; x: number; y: number; pressure: number };
  private panPointer?: { id: number; x: number; y: number };
  private touches = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  private tap?: { start: number; max: number; moved: boolean };
  private pinchStart?: { distance: number };
  private lastPen = -Infinity;

  constructor(private handlers: InputHandlers, options: Partial<InputOptions> = {}) { Object.assign(this.options, options); }
  get drawing() { return !!this.stroke; }

  handle(event: RawPointer) {
    if (event.kind === 'pen') this.lastPen = event.time;
    if (event.kind === 'touch') return this.touch(event);
    return this.single(event);
  }

  /** Commit (or cancel) an in-progress stroke, e.g. when focus is lost. Pen/mouse ink is kept. */
  interrupt(keepInk = true) {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = undefined;
    if (keepInk && stroke.kind !== 'touch') this.handlers.strokeEnd?.({ x: stroke.x, y: stroke.y, pressure: stroke.pressure, time: Date.now(), kind: stroke.kind });
    else this.handlers.strokeCancel?.();
  }
  reset() { this.interrupt(false); this.touches.clear(); this.tap = undefined; this.pinchStart = undefined; this.panPointer = undefined; }

  private normalisedPressure(event: RawPointer) {
    if (event.kind === 'mouse') return 1;
    return event.pressure > 0 ? event.pressure : event.kind === 'touch' ? 1 : 0.5;
  }

  private smoothed(event: RawPointer) {
    const s = this.stroke!, k = Math.min(0.95, this.options.smoothing), pressure = this.normalisedPressure(event);
    s.x += (event.x - s.x) * (1 - k); s.y += (event.y - s.y) * (1 - k); s.pressure += (pressure - s.pressure) * (1 - k * 0.5);
    return { x: s.x, y: s.y, pressure: s.pressure, time: event.time, kind: s.kind };
  }

  private single(event: RawPointer) {
    const middle = event.button === 1 || (event.buttons & 4) !== 0;
    if (event.phase === 'down') {
      if (this.stroke && this.stroke.id !== event.id) this.interrupt();
      if (event.kind === 'pen' && this.stroke?.kind === 'touch') this.interrupt(false);
      if (middle || this.options.panMode) { this.panPointer = { id: event.id, x: event.x, y: event.y }; return; }
      if (event.button !== undefined && event.button > 1) return;
      this.stroke = { id: event.id, kind: event.kind, x: event.x, y: event.y, pressure: this.normalisedPressure(event) };
      this.handlers.strokeBegin?.({ x: event.x, y: event.y, pressure: this.stroke.pressure, time: event.time, kind: event.kind });
      return;
    }
    if (this.panPointer?.id === event.id) {
      if (event.phase === 'move') { this.handlers.pan?.(event.x - this.panPointer.x, event.y - this.panPointer.y); this.panPointer.x = event.x; this.panPointer.y = event.y; }
      else this.panPointer = undefined;
      return;
    }
    if (this.stroke?.id !== event.id) return;
    if (event.phase === 'move') {
      // Recover from lost release events: a hovering pen/mouse with no buttons ends the stroke.
      if (event.kind !== 'touch' && !(event.buttons & 3) && event.pressure === 0) { this.interrupt(); return; }
      this.handlers.strokeMove?.(this.smoothed(event));
    } else if (event.phase === 'up') {
      const point = this.smoothed({ ...event, pressure: this.stroke.pressure });
      this.stroke = undefined; this.handlers.strokeEnd?.(point);
    } else this.interrupt();
  }

  private touch(event: RawPointer) {
    const now = event.time;
    if (event.phase === 'down') {
      if ((this.stroke && this.stroke.kind !== 'touch') || now - this.lastPen < this.options.palmMs) return; // palm rejection
      this.touches.set(event.id, { x: event.x, y: event.y, startX: event.x, startY: event.y });
      if (this.touches.size === 1) this.tap = { start: now, max: 1, moved: false };
      else if (this.tap) this.tap.max = Math.max(this.tap.max, this.touches.size);
      if (this.touches.size === 2) {
        // A second finger turns a tentative stroke into a navigation gesture.
        if (this.stroke) { this.stroke = undefined; this.handlers.strokeCancel?.(); }
        const [a, b] = [...this.touches.values()];
        this.pinchStart = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
        this.handlers.pinch?.('begin', 1, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (this.touches.size === 1 && !this.options.stylusOnly && !this.options.panMode) {
        this.stroke = { id: event.id, kind: 'touch', x: event.x, y: event.y, pressure: 1 };
        this.handlers.strokeBegin?.({ x: event.x, y: event.y, pressure: 1, time: now, kind: 'touch' });
      }
      return;
    }
    const contact = this.touches.get(event.id);
    if (!contact) return;
    if (event.phase === 'move') {
      const dx = event.x - contact.x, dy = event.y - contact.y;
      contact.x = event.x; contact.y = event.y;
      if (this.tap && Math.hypot(event.x - contact.startX, event.y - contact.startY) > this.options.tapSlop) this.tap.moved = true;
      if (this.pinchStart && this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        this.handlers.pinch?.('move', Math.hypot(a.x - b.x, a.y - b.y) / this.pinchStart.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (this.stroke?.id === event.id) this.handlers.strokeMove?.(this.smoothed(event));
      else if (this.touches.size === 1) this.handlers.pan?.(dx, dy);
      return;
    }
    this.touches.delete(event.id);
    if (this.stroke?.id === event.id) {
      if (event.phase === 'up') { const point = this.smoothed(event); this.stroke = undefined; this.handlers.strokeEnd?.(point); }
      else this.interrupt(false);
    }
    if (this.pinchStart && this.touches.size < 2) { this.pinchStart = undefined; this.handlers.pinch?.('end', 1, event.x, event.y); }
    if (!this.touches.size && this.tap) {
      const tap = this.tap; this.tap = undefined;
      if (event.phase === 'up' && !tap.moved && now - tap.start < this.options.tapMs && now - this.lastPen >= this.options.palmMs) {
        if (tap.max === 2) this.handlers.undo?.(); else if (tap.max === 3) this.handlers.redo?.();
      }
    }
  }
}

/** Convert a DOM PointerEvent (relative to an element's rect) into a RawPointer. */
export function fromPointerEvent(event: PointerEvent, rect: { left: number; top: number }, phase: RawPointer['phase']): RawPointer {
  return { id: event.pointerId, kind: event.pointerType === 'pen' ? 'pen' : event.pointerType === 'touch' ? 'touch' : 'mouse', phase,
    x: event.clientX - rect.left, y: event.clientY - rect.top, pressure: event.pressure, buttons: event.buttons, button: event.button, time: event.timeStamp };
}
