# Pixel Asset Studio

A desktop pixel-art editor (Electron + React + TypeScript) that people and AI agents can drive with equal power. Agents connect over MCP, draw with typed commands, look at their own work through snapshots, and export game-ready sprites.

## Run it

```bash
npm install
npm run dev        # launches the editor
```

The editor starts a local MCP server on `http://127.0.0.1:39217/mcp` (set `PAS_MCP_PORT` to change the port; it tries the next 10 ports if busy). The URL is shown in the bottom-right of the window.

Connect an agent, for example Claude Code:

```bash
claude mcp add --transport http pixel-asset-studio http://127.0.0.1:39217/mcp
```

Then ask: "Make a 16x16 slime enemy with a 4-frame idle loop and export a sprite sheet."

Agents read and write files only inside `~/Documents/PixelAssetStudio` (the workspace folder); paths outside it are refused. The server accepts local connections only.

## How it fits together

```
src/core      Pure TypeScript, no UI or Node dependencies
  commands.ts   Every edit as a zod-typed command (the single command surface)
  engine.ts     Runs commands, keeps the command log, grouped undo/redo
  render.ts     Frame compositing, upscaling with grid, sprite sheets
  serialize.ts  Project <-> readable JSON (.pxs)
src/main      Electron main process
  mcp.ts        MCP tools generated from the commands, plus inspect/export tools
  encode.ts     PNG and BMP encoders;  exporter.ts  frame and sprite-sheet export
src/preload   Bridge exposed to the UI as window.pas
src/renderer  React editor (canvas, palette, layers, frames, preview, activity log)
```

The UI and the MCP server call the same `Engine.execute()`, so anything a person can do an agent can do, and every change appears in the Activity panel tagged `you` or `agent`.

## Animation

Frames live in the timeline at the bottom: add (copy of current), move left/right, delete, per-frame duration, and tags (`idle` = frames 0–3) edited from the "tag" field. Play loops the current tag at ¼×–2× speed. The **onion** toggle shows the previous frame tinted red and the next tinted blue under the one you are editing. Export ▾ offers the current frame as PNG (1× or 4×), a sprite sheet with JSON atlas, or an animated GIF written by our own encoder (`src/main/gif.ts`, transparency kept, loops forever). Agents get the same through `frame_add`, `frame_delete`, `frame_move`, `frame_set_duration`, `tag_add`, `tag_remove`, `render_animation_strip` and `export_gif`.

## Tilesets

**New ▸ Kind: Tileset** makes a sprite that is a grid of equal tiles, numbered left-to-right, top-to-bottom; the pixel grid's strong lines then fall on tile boundaries. Agents use `tileset_create`, `tile_draw_from_ascii`, `tile_copy`, `check_seams` (compares the touching edges of two tiles) and `tilemap_preview` (renders a map of tile numbers as an image). Export the tileset like any sprite.

## Selection and layers

**M** is the selection tool: drag a rectangle, drag inside it to move those pixels, **Delete** clears it, **Esc** deselects. Layers can be renamed inline, reordered, deleted, and given an opacity from the inspector. Agents have `move_region`, `clear_region`, `layer_move`, `layer_delete` and `layer_set`.

## Importing pictures

**Import…** (top-left) or the `import_image` MCP tool turns any PNG/JPEG/GIF/WebP into pixel art with no external library:

1. box-filter downscale to the target size (contain / cover / stretch)
2. each pixel mapped to the nearest palette colour, measured in Oklab so the match is perceptual
3. optional dithering: Floyd–Steinberg for photos, ordered/Bayer for a retro look, none for flat art
4. cleanup: hard alpha edge and removal of isolated stray pixels

The palette can be the sprite's own, or derived from the picture with median cut (2–64 colours). The whole import is one undo step. Code: `src/core/pixelate.ts`; the PNG decoder is `src/main/decode.ts`, other formats go through Electron's `nativeImage`.

## Tests

```bash
npm test           # core + MCP server (real MCP client over HTTP)
npm run typecheck
```

The editor UI has browser smoke tests that do not need Electron: see `tests/ui/*.py`. Prompts for testing the agent side are in `PROMPTS.md`.

## Not built yet

Sprite resize, WebP/JPEG export, Aseprite import, copy/paste between sprites, terrain auto-tiling rules, headless CLI mode. Undo history for structural edits stores whole-project snapshots, which is fine for small sprites but should become diffs before large projects.
