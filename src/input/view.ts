/** Screen ↔ document transform: screen = doc * zoom + pan. */
export class ViewTransform {
  zoom = 1; panX = 0; panY = 0;
  viewportWidth = 1; viewportHeight = 1;
  constructor(public contentWidth: number, public contentHeight: number, public minimumVisible = 32, public maxZoom = 64) {}

  get minZoom() { return Math.min(1, this.minimumVisible / Math.max(this.contentWidth, this.contentHeight)); }
  toDocument(x: number, y: number): [number, number] { return [(x - this.panX) / this.zoom, (y - this.panY) / this.zoom]; }
  toScreen(x: number, y: number): [number, number] { return [x * this.zoom + this.panX, y * this.zoom + this.panY]; }

  resize(width: number, height: number) { this.viewportWidth = Math.max(1, width); this.viewportHeight = Math.max(1, height); this.clamp(); }
  /** Keep at least `minimumVisible` pixels (or the whole content when smaller) on screen on both axes. */
  clamp() {
    const width = this.contentWidth * this.zoom, height = this.contentHeight * this.zoom;
    const vx = Math.min(this.minimumVisible, width, this.viewportWidth), vy = Math.min(this.minimumVisible, height, this.viewportHeight);
    this.panX = Math.min(this.viewportWidth - vx, Math.max(vx - width, this.panX));
    this.panY = Math.min(this.viewportHeight - vy, Math.max(vy - height, this.panY));
  }
  fit(margin = 12) {
    this.zoom = Math.max(this.minZoom, Math.min((this.viewportWidth - margin * 2) / this.contentWidth, (this.viewportHeight - margin * 2) / this.contentHeight, 1));
    this.panX = (this.viewportWidth - this.contentWidth * this.zoom) / 2; this.panY = (this.viewportHeight - this.contentHeight * this.zoom) / 2;
    this.clamp();
  }
  zoomAt(next: number, x = this.viewportWidth / 2, y = this.viewportHeight / 2) {
    if (!Number.isFinite(next)) return;
    next = Math.max(this.minZoom, Math.min(this.maxZoom, next));
    this.panX = x - (x - this.panX) * next / this.zoom; this.panY = y - (y - this.panY) * next / this.zoom; this.zoom = next;
    this.clamp();
  }
  panBy(dx: number, dy: number) { this.panX += dx; this.panY += dy; this.clamp(); }
  /** Place a document point under a screen point at a given zoom (pinch). */
  anchor(docX: number, docY: number, screenX: number, screenY: number, zoom: number) {
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this.panX = screenX - docX * this.zoom; this.panY = screenY - docY * this.zoom; this.clamp();
  }
}
