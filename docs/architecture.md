# visual.editor architecture and work plan

## Goal

A sketching engine that is as fast as Krita, Photoshop or Procreate and runs on every platform, used inside Notework and as a standalone image editor. Native apps are built with Tauri's webview, so the engine uses no Node APIs and no particular UI framework. The host app owns UI and storage. The engine owns the document, pixels, strokes, history, input interpretation and rendering.

```
            ┌──────────── host (Notework, standalone app, Tauri shell) ────────────┐
            │  UI widgets · file IO (OPFS, FS Access, GitHub) · brush storage       │
            └───────▲───────────────▲───────────────────▲──────────────────▲───────┘
   RawPointer       │  LayerIO      │  save() files     │  on(change)      │ canvas
            ┌───────┴──┐  ┌─────────┴────────┐  ┌───────┴────────┐  ┌──────┴────────┐
            │  input/  │  │     editor.ts    │  │   document/    │  │    render/    │
            │controller│─▶│ (command facade) │─▶│ model + syntax │  │   canvas2d    │
            │  view    │  └──┬─────┬──────┬──┘  └────────────────┘  └──────▲────────┘
            └──────────┘     │     │      │                                │ dirty tiles
                    ┌────────▼┐ ┌──▼────┐ ┌▼────────┐                       │
                    │ raster/ │ │vector/│ │ history │───────────────────────┘
                    │ tiles,  │ │strokes│ │ (swap)  │
                    │ paint   │ └───────┘ └─────────┘
                    └─────────┘    brush/ (engine params, presets, importers)
```

## Document model (`src/document`)

A visual document is a **page folder**. The main file `name.visual` is plain text. Each layer is its own asset beside it, so it shows up in a file tree and can be opened, versioned or replaced on its own.

```
\image_editor_config[width=1920, height=1080, history=100, history_mb=256, palette=#202733 #ffffff …]
\image_editor_state[tool=brush, color=#202733, brush=app.asset/editor.visual/brushes/basic-6-details.vbrush, brush_size=6, eraser=…, eraser_size=40, layer=1, recent=#…]
\image_editor_brushes[app.asset/editor.visual/brushes/basic-1.vbrush, …]
\image_editor_raster[sketch.background.png, 0, 0, name=Background]
\image_editor_vector[sketch.ink.svg, 0, 0, name=Ink, opacity=0.8]
```

* Lines lower in the file are drawn on top.
* Layer arguments: `file, top_left_x, top_left_y`, then optional `name=`, `opacity=`, `hidden`, `locked`.
* `\image_editor[\c[…]\s[…]\b[…]\r[…]\v[…]]` is the compact domain operator. Both forms parse to the same model, and `serializeDocument(doc, { compact: true })` writes the compact one.
* Arguments are separated by commas or newlines, so any command can span lines. Use `"quotes"` for values that contain commas or brackets.
* Text that isn't an editor command (comments, notes) is kept at the top of the file.
* `\image_editor_config` holds the document's configuration: canvas size, history limits, palette. `\image_editor_state` records the user's choices (tool, colour, brushes, sizes, active layer, recent colours), so reopening a document picks up where the user left off.
* The host decides how layer references resolve. Notework resolves them relative to the main file first, then by graph path or name.

Raster layer files are PNGs cropped to their content. The crop offset is written as `x, y`, so a layer can be bigger than the canvas or offset from it. Vector layer files are SVGs any viewer can open. Each `<path>` keeps its raw `data-points` samples (x, y, pressure) and brush metadata so it can be edited again.

## Raster engine (`src/raster`)

* **Sparse 128 px tiles** (`TiledSurface`) hold straight-alpha RGBA8 in `Uint8ClampedArray`s. Missing tiles are transparent, layers are unbounded, and empty tiles are pruned. Each tile has a version number, so the renderer uploads only the tiles that changed.
* **Indirect ("wash") painting** works like Krita's. Dabs build a per-stroke coverage mask using alpha-darken: coverage moves toward the dab opacity at the flow rate. Each touched pixel is then recomposited from its pre-stroke value, so overlapping dabs never go past the stroke's opacity. The pre-stroke tile copies are reused as the undo record.
* **Undo by swapping.** A `TileRecorder` keeps one copy per touched tile. Undo and redo swap that copy with the live tile, so a history frame never holds more than one copy of a tile. History is capped by frame count (`history=`) and by memory (`history_mb=`).
* A lasso selection is a scanline polygon mask. It clips painting and can be cleared, or lifted and then moved or resized with bilinear resampling. Each of these is one undo step.

Measured on one CPU core in Node: 38 µs per input sample with an 8 px brush and 264 µs with a 200 px soft brush. Both are well within a 120 Hz frame budget.

## Vector engine (`src/vector`)

Strokes store their samples and brush parameters. The outline is drawn as consistently wound circles plus tangent quads filled with the nonzero rule, so translucent strokes don't darken where they overlap themselves. The eraser removes whole strokes. Lasso selects whole strokes, which can then be moved, scaled or deleted.

## Brushes (`src/brush`)

* The engine's brush is a Krita-style pixel brush with a generated tip: size, minimum size, pressure for size, opacity and flow, hardness, spacing, ratio, angle, smoothing, pressure gamma and eraser mode. It is stored in `.vbrush` files using the same plaintext syntax (`\visual_brush[…]`).
* Importers:
  * Krita `.kpp`: the PNG `preset` text chunk is read and mapped from the paintbrush auto-tip.
  * GIMP `.vbr`: versions 1.0 and 1.5.
  * MyPaint `.myb`: JSON v3.
* `KRITA_BASIC_PACK` is a set of everyday presets (Basic 1–6, Pencil, Ink, Marker, Airbrush, Erasers) whose parameters approximate Krita's defaults.
* Brush storage belongs to the host. The engine only keeps `reference → Brush` (`editor.addBrush(ref, brush)`) and writes the references to `\image_editor_brushes`.

## Input (`src/input`)

`InputController` takes `RawPointer` events, which DOM pointer events, Tauri or native touch can all be converted into, and emits stroke begin, move, end and cancel, plus pan, pinch, undo (two-finger tap) and redo (three-finger tap). It also handles:

* palm rejection after pen contact
* stylus-only mode, where one finger pans
* pan mode (space bar or middle button)
* recovery when a release event is lost
* smoothing

`ViewTransform` handles conversion between screen and document coordinates, plus fit, clamped panning and zooming around a point.

## Renderer (`src/render`)

`CanvasRenderer` keeps a backing canvas per raster layer and uploads only the tiles that changed (`putImageData`). On each animation frame it composites the visible layers into a canvas the size of the viewport under one transform. Zooming and panning never touch layer pixels. Vector layers are drawn from cached `Path2D`s, and translucent vector layers are composited through a scratch canvas.

## Work plan

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Engine core: document syntax, tiles, wash brush, history, vector layers, lasso, PNG codec, input, Canvas2D renderer, Krita basic pack, brush importers, unit tests, framework-free demo | **done (this MVP)** |
| 1 | Notework integration: `.visual` page folders, layer assets in the file tree, missing-layer notices, raw text view, brush library at `app.asset/editor.visual/brushes`, brush and eraser editors (size, colour wheel HSV/RGB, palette, brush type), state saved in the main file, existing images open through the engine | **done (this MVP)** |
| 2 | Speed: run the brush in a Worker over `SharedArrayBuffer` tiles. Move the compositor to WebGL2 with tiles as texture atlases. Predict pointer input with `getPredictedEvents` to cut perceived latency | next |
| 3 | Painting features: textured and image tips (`.kpp` embedded tips, `.gbr`, `.abr`), blend modes, layer groups, clipping masks, smudge and blur engines, ruler and stabiliser modes | next |
| 4 | Selection and transform: rotate and free transform, magic wand, selection feathering, copy and paste between layers and apps | next |
| 5 | Native: Tauri shell with direct file IO, Apple Pencil hover/azimuth via native touch bridge, optional Rust/WASM tile kernels (SIMD) | later |
| 6 | Interop: full ORA groups and blend modes, PSD import, Krita `.kra` import | later |

Run the checks with `pnpm check` (types) and `pnpm test` (Node unit tests). To try the demo, run `npx esbuild demo/main.ts --bundle --format=esm --outfile=demo/main.js`, then serve the `demo/` folder.
