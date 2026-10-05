# Asset-specific decisions

Read the category needed for the request. Bundled settings and demo models are
practice fixtures; use the project's actual style when available.

## Characters

Use the established body height in world units, a foot pivot, and shared pixel
density. Model recognizable anatomy and clothing silhouettes before details.
Separate materials for skin, fabric, metal, hair, and eyes allow controlled
ramps. Use UV-painted details when geometry becomes noisy at native size. A high
silhouette score does not prove likeness.

Inspect the rig and assigned animation before changing them. Author or retarget
a deformation rig when movement is requested. Export in-place actions with all
extrema inside the canvas. Inspect feet, hands, and face in every direction.
Quaternion keyframes need consistent signs to avoid interpolation turns.
The renderer samples assigned actions without prescribed bone names or invented
animation. `assets/character.json` exercises the practice animation.

## Terrain

Separate repeating ground, transitions, walls, and tall props. Repeating ground
usually needs a centered anchor, one view, no outline, and a full-cell footprint.
Copy details crossing a boundary periodically across its opposite edge. Keep
variation deterministic and animation periodic. Paint connected clusters rather
than uniform speckle noise.

For exact matching borders, enable `tileable` and inspect the 3×3 preview. Test
animated seams on every frame. Build requested transition masks explicitly and
show a composed map; the renderer does not create autotiles or prove transition
coverage. `assets/terrain.json` exercises the strict border contract.
Use larger canvases for trees while keeping world pixel density unchanged;
`assets/tree.json` illustrates this distinction.

Foliage needs readable canopy masses, connected leaf groups, and controlled
shadows. Smooth lighting can produce rounded 3D blobs; uniform flat patches can
erase structure. Check one native sprite before rendering every direction.
For painted cutout leaves, retain UV textures with `preserve` and include the
source alpha material.

## Items and props

Inventory icons can use their own presentation scale and centered anchor; world
pickups and props should match world density and placement pivots. Establish
whether the request means an icon, equipped item, or world object. Keep blades,
grips, and bottle necks readable at native size. One icon does not imply an
equipped or animated version. `assets/item.json` exercises the practice sword.
A 32px item, 64px actor, and 128px tree can share 16 pixels per world unit without
automatic per-model fitting.
