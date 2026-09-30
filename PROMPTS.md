# Agent prompt tests

Prompts to give Claude Code (or any MCP client connected to the running app) to exercise the tools.
After each one, look at the canvas and the Activity panel; the agent should be calling
`render_snapshot` on its own and correcting what it sees.

## Smoke

1. "Create a 16x16 sprite called `coin` with the pico8 palette, draw a gold coin with a darker outline and a single highlight pixel, then show me a snapshot."
2. "List the palette indexes you have and tell me which one you'd use for shadows."
3. "Undo your last edit, then redo it."

## Drawing quality

4. "Make a 32x32 knight facing right: dark outline, silver armour, red plume. Use `draw_from_ascii` for the base and fix details with `draw_pixels`. Check the snapshot at least twice before you're done."
5. "Draw a 24x24 potion bottle. Then make a second layer called `glow` and add a soft highlight on it only."
6. "The eyes are too far apart. Move them one pixel closer together." (after 4)

## Animation

7. "Give the coin a 6-frame spin: it should narrow to a 2-pixel line in frame 3 and widen again. Tag it `spin`, 80 ms per frame, and export `coin-spin.gif` at 4x."
8. "Make a 4-frame idle bounce for the knight (body squashes 1 px on frame 2). Use `render_animation_strip` to review the motion before exporting a sprite sheet with atlas."
9. "Delete frame 2 and make the animation loop smoothly again."

## Import

10. Put any PNG in `~/Documents/PixelAssetStudio/ref/` and ask: "Import `ref/<file>.png` as a 48x48 sprite using a palette derived from the image (12 colours), Floyd dither. Then clean up stray pixels by hand where the outline broke."
11. "Import the same picture again, but map it to the db16 palette with no dither and compare which looks better in a snapshot."

## Tilesets

12. "Create a tileset `terrain` of 16x16 tiles, 4 columns x 2 rows, db16. Tile 0 = grass, tile 1 = dirt, tile 2 = grass-to-dirt edge (grass on the left), tile 3 = water. Use `check_seams` so tile 0 joins tile 2 and tile 2 joins tile 1 without visible seams."
13. "Show me a tilemap preview: three rows of [0,0,2,1,1], [0,0,2,1,1], [3,3,3,3,3]."
14. "Copy tile 0 into tile 4 and add a flower to it."

## Robustness (should produce clear errors, not crashes)

15. "Draw a pixel at x=99, y=99 on the coin." (out of canvas: skipped, reported)
16. "Use colour index 40." (out of palette range)
17. "Export the sprite to `/etc/coin.png`." (outside the workspace: refused)
18. "Delete the only frame." (refused)

## Collaboration

19. Draw something by hand, then: "Look at what I drew and add a shadow beneath it without changing my pixels."
20. Start the agent on prompt 4, and while it works, draw on the canvas yourself. Both sets of edits should appear in the Activity panel and undo separately.
