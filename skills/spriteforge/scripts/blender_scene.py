"""Evaluate source geometry without changing its rig, then render pixel proxies."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from settings import DIRECTIONS, Settings


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(source: Path, report: Path) -> None:
    scene = bpy.context.scene
    objects = []
    for obj in scene.objects:
        materials = []
        for slot in obj.material_slots:
            if slot.material:
                mat = slot.material
                materials.append({"name": mat.name, "image_textures": [n.image.name for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image] if mat.use_nodes else []})
        objects.append({"name": obj.name, "type": obj.type, "hide_render": obj.hide_render,
                        "hide_viewport": obj.hide_viewport,
                        "modifiers": [{"name": m.name, "type": m.type, "viewport": m.show_viewport,
                                       "render": m.show_render} for m in obj.modifiers],
                        "dimensions": list(obj.dimensions), "materials": materials})
    report.write_text(json.dumps({"source": str(source), "blender": bpy.app.version_string,
                                 "collections": [c.name for c in bpy.data.collections],
                                 "frame_range": [scene.frame_start, scene.frame_end],
                                 "actions": [a.name for a in bpy.data.actions], "objects": objects}, indent=2) + "\n")


def band_material(name: str, settings: Settings) -> bpy.types.Material:
    colors = settings.palette.get(name)
    if colors is None:
        raise ValueError(f"material {name!r} needs a palette ramp (inspect the source first)")
    mat = bpy.data.materials.new(f"Pixel / {name}")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    geometry = nodes.new("ShaderNodeNewGeometry")
    dot = nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = Vector(settings.light).normalized()
    links.new(geometry.outputs["Normal"], dot.inputs[0])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements.remove(ramp.color_ramp.elements[1])
    for index, color in enumerate(colors):
        position = index * 0.85 / max(1, len(colors) - 1)
        stop = ramp.color_ramp.elements[0] if index == 0 else ramp.color_ramp.elements.new(position)
        stop.position = position
        srgb = [v / 255 for v in bytes.fromhex(color)]
        stop.color = tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in srgb) + (1,)
    links.new(dot.outputs["Value"], ramp.inputs["Fac"])
    emission = nodes.new("ShaderNodeEmission")
    links.new(ramp.outputs["Color"], emission.inputs["Color"])
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(emission.outputs[0], output.inputs["Surface"])
    return mat


def snapshots(scene: bpy.types.Scene, collection: str | None) -> list[tuple[bpy.types.Mesh, Matrix]]:
    bpy.context.window.scene = scene
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    allowed = None
    if collection:
        selected = bpy.data.collections.get(collection)
        if selected is None:
            raise ValueError(f"collection {collection!r} does not exist")
        allowed = set(selected.all_objects)
    meshes = []
    for instance in depsgraph.object_instances:
        obj = instance.object
        original = obj.original
        owner = instance.parent.original if instance.is_instance and instance.parent else original
        if not instance.show_self or obj.type not in ("MESH", "CURVE", "SURFACE", "FONT", "META"):
            continue
        if original.hide_render or owner.hide_render or (allowed is not None and owner not in allowed and original not in allowed):
            continue
        # Snapshot evaluation uses the viewport depsgraph. Reject divergent render
        # settings until a render-depsgraph bake is needed for a concrete asset.
        for modifier in original.modifiers:
            if modifier.show_viewport != modifier.show_render or (
                modifier.type == "SUBSURF" and modifier.levels != modifier.render_levels
            ):
                raise ValueError(f"{original.name}/{modifier.name}: viewport and render settings must match for snapshot export")
        mesh = bpy.data.meshes.new_from_object(obj, preserve_all_data_layers=True, depsgraph=depsgraph)
        if mesh.vertices:
            meshes.append((mesh, instance.matrix_world.copy()))
        else:
            bpy.data.meshes.remove(mesh)
    if not meshes:
        raise ValueError("no renderable geometry in the selected asset")
    return meshes


def render(source: Path, output: Path) -> None:
    settings = Settings.load(output / "asset.json")
    original = bpy.context.scene
    source_hash = sha256(source)
    scene = bpy.data.scenes.new("Pixel Render")
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 1
    scene.render.resolution_x, scene.render.resolution_y = settings.size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.use_compositing = scene.render.use_sequencer = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.world = bpy.data.worlds.new("Pixel World")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.05, 0.05, 0.05, 1)
    camera = bpy.data.objects.new("Pixel Camera", bpy.data.cameras.new("Pixel Camera"))
    scene.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(settings.size) / settings.pixels_per_unit
    camera.rotation_euler = (0, 0, 0)
    width, height = settings.size
    camera.location = ((0.5 - settings.anchor[0]) * width / settings.pixels_per_unit,
                       (settings.anchor[1] - 0.5) * height / settings.pixels_per_unit, 100)
    scene.camera = camera
    if settings.shading == "preserve":
        light = bpy.data.objects.new("Pixel Key", bpy.data.lights.new("Pixel Key", "SUN"))
        scene.collection.objects.link(light)
        light.rotation_euler = (-Vector(settings.light)).to_track_quat("-Z", "Y").to_euler()
        light.data.energy = 2
        light.data.angle = 0
    materials = {}
    raw = output / "raw"
    raw.mkdir()
    mesh_counts = []
    for frame in settings.frames:
        bpy.context.window.scene = original
        original.frame_set(frame)
        evaluated = snapshots(original, settings.collection)
        mesh_counts.append(len(evaluated))
        for direction in settings.directions:
            rotation = Matrix.Rotation(math.radians(DIRECTIONS[direction]), 4, "Z")
            shear = Matrix(((1, 0, settings.shear[0], 0), (0, 1, settings.shear[1], 0), (0, 0, 1, 0), (0, 0, 0, 1)))
            transform = shear @ rotation @ Matrix.Translation(-Vector(settings.pivot))
            proxies = []
            for mesh, world in evaluated:
                copy = mesh.copy()
                copy.transform(transform @ world)
                if settings.shading == "bands":
                    originals = list(copy.materials)
                    copy.materials.clear()
                    for material in originals or [None]:
                        name = material.name if material else "default"
                        if name not in materials:
                            materials[name] = band_material(name, settings)
                        copy.materials.append(materials[name])
                obj = bpy.data.objects.new("Pixel Proxy", copy)
                scene.collection.objects.link(obj)
                proxies.append(obj)
            bpy.context.window.scene = scene
            scene.render.filepath = str(raw / f"{direction}-{frame:04d}.png")
            bpy.ops.render.render(write_still=True, scene=scene.name)
            if frame == settings.frames[0] and direction == settings.directions[0]:
                scene["Pixel workflow"] = "Evaluated proxies; source scene retained; fixed scale/anchor; normal ramps and palette finishing."
                scene["Source sha256"] = source_hash
                bpy.context.preferences.filepaths.save_version = 0
                bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"))
            for obj in proxies:
                mesh = obj.data
                bpy.data.objects.remove(obj, do_unlink=True)
                bpy.data.meshes.remove(mesh)
        for mesh, _ in evaluated:
            bpy.data.meshes.remove(mesh)
    if sha256(source) != source_hash:
        raise ValueError("source changed during rendering")
    (output / "manifest.json").write_text(json.dumps({"source": str(source), "source_sha256": source_hash,
        "source_unchanged": True, "blender": bpy.app.version_string, "settings": "asset.json",
        "scene": "scene.blend", "size": settings.size, "pixels_per_unit": settings.pixels_per_unit,
        "anchor": settings.anchor, "pivot": settings.pivot, "fps": settings.fps,
        "directions": settings.directions, "frames": settings.frames, "evaluated_mesh_counts": mesh_counts}, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["inspect", "render"])
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if bpy.app.version < (5, 2, 0):
        raise ValueError("Blender 5.2 or newer is required")
    bpy.ops.wm.open_mainfile(filepath=str(args.source), use_scripts=False)
    if args.command == "inspect":
        inspect(args.source, args.report)
    else:
        render(args.source, args.output)


if __name__ == "__main__":
    main()
