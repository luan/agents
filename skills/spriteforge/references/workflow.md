# Rendering workflow

Requirements: Blender 5.2+ and `uv`. The launcher's inline metadata requires
Python 3.10+ and Pillow 12; `uv` provisions them automatically. Blender's embedded
Python evaluates scenes; the `uv` environment finishes PNGs. No Aseprite, FFmpeg,
or Blender plugin is required.

From this skill directory:

```sh
uv run --script scripts/pipeline.py inspect --source /path/to/model.blend
uv run --script scripts/pipeline.py render --source /path/to/model.blend \
  --config /path/to/asset.json --output /path/to/preview-run --preview
uv run --script scripts/pipeline.py render --source /path/to/model.blend \
  --config /path/to/asset.json --output /path/to/full-run
```

Use `--blender /path/to/blender` if Blender is not on PATH. Paths containing
spaces are supported. Output directories must not exist. Failed runs remain
available with their raw images and settings; choose a new directory on retry.

## Asset settings

```json
{
  "collection": "Character",
  "size": [64, 64],
  "pixels_per_unit": 16,
  "palette": {
    "skin": ["583a32", "825749", "ad7c65", "ce9d82"],
    "cloth": ["123638", "215a5d", "378184", "60a5a6"]
  },
  "directions": ["east", "north", "west", "south"],
  "frames": [1, 2, 3, 4],
  "fps": 8,
  "pivot": [0, 0, 0],
  "anchor": [0.5, 0.8],
  "shear": [-0.45, 0.45],
  "light": [-0.5, -0.65, 1],
  "outline": "10151c",
  "shading": "bands",
  "tileable": false
}
```

`size`, `pixels_per_unit`, and `palette` are required. Other values above are
defaults except `collection` and `frames`: collection defaults to all renderable
geometry, frames to `[1]`. Exported frames have equal durations even when source
frame numbers have gaps.

- `collection` selects an asset including descendants and collection instances.
  Hide unrelated floors or select a specific collection.
- `size` is the native PNG cell. Rectangular cells are valid.
- `pixels_per_unit` sets shared world scale. Increasing the canvas makes room
  without shrinking the asset. Match density across world assets.
- `pivot` is a fixed world-space origin before direction rotation. Use the feet
  for actors. `anchor` locates it in normalized image coordinates from the
  top-left. Neither changes between frames.
- `directions`: East 90°, North 180°, West 270°, South 0°. Models face -Y in
  the south view; correct a different forward axis in the authored asset.
- `shear` reproduces the recovered oblique method: after rotation, screen
  X = X + shear[0] × Z and screen Y = Y + shear[1] × Z. The camera looks down -Z.
  Ground stays square and height runs diagonally. This artistic projection is
  not a physical isometric camera. `[0,0]` gives a top-down view.
- `palette` maps exact material names to 1–16 shades, dark to light. `bands`
  builds constant normal-light ramps. Every rendered material needs a ramp;
  unassigned materials use `default`. `preserve` retains source materials and
  adds a sun; the palette becomes the output color set. Pack texture images or
  retain accessible files. Prefer UV mapping: Generated/world coordinates can
  change when render proxies are projected.
- `outline` adds a one-pixel outer contour; null disables it. Non-ground sprites
  need at least two transparent pixels around the finished contour.
- `tileable` requires full opacity, no outline, and exactly matching opposite
  edge pixels. This is a conservative border contract: continuous textures can
  be visually seamless without identical boundary samples. Set it false for
  those textures and review repetition manually.

Single-sample EEVEE renders produce native PNGs. Finishing thresholds alpha at
128, quantizes without dithering, adds the optional contour, and enlarges
previews with nearest-neighbor sampling. Do not blur or resample final PNGs.

## Outputs

`scene.blend` retains the original editable scene and a `Pixel Render` scene with
static proxies for the first view/frame. Edit or animate the original scene and
rerun the pipeline; the proxy scene is not an animation rig.

`asset.json` contains effective settings, including the preview subset when
`--preview` is used. `raw/` retains Blender PNGs; `sprites/` has finished PNGs.
`atlas.png` puts frames in columns and directions in rows; `manifest.json`
records their rectangles, source hash, Blender version, scale, anchor, and checks.
`preview.png` shows the first frame; animation adds `preview.gif`.
Tileable runs add a 3×3 `tiled-preview.png`.

## Deliberate limits

The pipeline samples the active source scene, viewport-visible geometry, and
assigned animations. Keep the selected asset visible in the active view layer.
Snapshot evaluation uses the viewport depsgraph; the exporter rejects different
viewport/render modifier switches or subdivision levels instead of silently
producing different geometry. Match them in an export copy of the source.
Assign an
action or NLA sequence before rendering separate clips. It does not invent
rigging, walk cycles, autotile masks, collision, or runtime integration. Root
motion is retained; author an in-place export action if travel leaves the cell.
Add root tracking only for a concrete asset that needs it, preserving vertical
movement and fixed pixel density.

The default shader captures the old normal-ramp method. It does not automatically
make a rounded tree or detailed model look hand-pixelled. Author readable forms,
painted UV clusters, or material regions and use `preserve` as needed.

## Recovery provenance

Recovered from the surviving September 12, 2026 monk and tree chat forks. The
parent transcript and downloaded models were missing. Their scripts assumed
specific material names, a Mixamo rig, and one model's camera scale. This package
retains the rendering principles and removes those assumptions. The later skrl
island workflow informed texture and terrain guidance; its models and third-party
art are not bundled.
