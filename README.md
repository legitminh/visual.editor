# visual.editor

A cross-platform engine for layered sketching. Raster and vector layers live in one document. The engine has a plaintext document model, a Krita-style brush engine, tiled undo history, input gesture handling and a Canvas2D compositor. It uses no framework and no Node APIs, so it runs in browsers, workers, Tauri webviews and Node.

It's designed so that a host app ([Notework](https://github.com/legitminh/notework), or a standalone image editor) only has to provide UI and file IO.

```ts
import { VisualEditor, ViewTransform, CanvasRenderer, InputController, fromPointerEvent } from 'visual.editor';

const editor = await VisualEditor.open(mainText, { read: (ref) => loadBlob(ref) }, { base: 'sketch' });
const view = new ViewTransform(editor.width, editor.height);
const renderer = new CanvasRenderer(canvasElement, editor, view);
const input = new InputController({
  strokeBegin: (p) => editor.beginStroke(...view.toDocument(p.x, p.y), p.pressure, 'brush'),
  strokeMove: (p) => editor.strokeTo(...view.toDocument(p.x, p.y), p.pressure),
  strokeEnd: () => editor.endStroke(),
  undo: () => editor.undo(), redo: () => editor.redo()
});
const { main, files, versions } = await editor.save(); // write files, then editor.markSaved({ main, versions })
```

Documents look like this (lower lines are drawn on top):

```
\image_editor_config[width=1920, height=1080, history=100, palette=#202733 #ffffff]
\image_editor_state[tool=brush, color=#202733, brush=brushes/basic-1.vbrush, brush_size=8]
\image_editor_brushes[brushes/basic-1.vbrush]
\image_editor_raster[sketch.background.png, 0, 0, name=Background]
\image_editor_vector[sketch.ink.svg, 0, 0, name=Ink]
```

See [docs/architecture.md](docs/architecture.md) for the design and the work plan.

## Develop

```sh
pnpm install
pnpm check   # type-check
pnpm test    # unit tests (node:test + tsx)
```

To develop it alongside Notework, link the two checkouts as siblings. Notework depends on `link:../visual.editor` and Vite compiles this package's TypeScript sources directly, so edits show up immediately.

## License

MIT
