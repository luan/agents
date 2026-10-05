---
name: spriteforge
description: Create or adapt Blender models and render consistent pixel-art characters, terrain, props, and inventory items with palette-locked sprites, animation sheets, and editable 3D sources.
---

Use the scripts beside this skill to render assets. Resolve commands against this
skill's directory; do not assume the caller's working directory or rewrite the
renderer for each model.
Run host Python entrypoints with `uv run --script`; their inline declarations
manage Python and dependencies. Scripts importing `bpy` run inside Blender,
launched by the pipeline or with Blender's `--python` option.

1. Establish the reference style, native cell size, world scale, directions, and
   requested animation. Reuse the project's palette and pixels per unit. When no
   style is supplied, use the bundled practice settings and identify the result
   as a draft. Read [references/workflow.md](references/workflow.md) for setup,
   commands, the asset settings contract, and rendering limits.
2. For an existing model, run
   `uv run --script scripts/pipeline.py inspect --source model.blend`.
   Select its asset collection and inspect materials, instances, and animation.
   For new models, read the relevant category in
   [references/categories.md](references/categories.md), then create a saved,
   editable `.blend`. Judge models at their final sprite size.
3. Write an asset JSON using the shared style. Render with `--preview` to a fresh
   directory. View `preview.png` at native scale and integer enlargement. Compare
   silhouette, proportions, projection, shading clusters, and palette to the
   reference; fix the model or settings before multiplying the work. If likeness
   remains uncertain, show the actual preview and ask for the specific missing
   direction. Do not promise quality from geometry counts or silhouette scores.
4. Render the requested directions and frames to another fresh directory. Inspect
   animation for pixel swimming, foot sliding, clipping, and silhouette changes.
   For ground, inspect `tiled-preview.png`; the edge check alone does not prove
   convincing terrain or transition coverage.
5. Deliver the source `.blend`, asset JSON, PNG sprites, atlas, manifest, and
   previews. State what rendered and passed validation, what received visual
   review, and any missing animations or integration. Technical validation is
   separate from reference fidelity and game integration.

The renderer preserves the input file, uses a fixed anchor and pixel density,
and requires a new output directory. Keep these invariants when adapting it.
Preserve the source rig and use evaluated render geometry rather than applying
object transforms or projection modifiers to the original model.

Use `bands` for explicit material ramps and `preserve` for authored UV textures
or custom illustrated materials. Both finish against the configured palette.
Do not replace authored pixel texture clusters with random noise.
