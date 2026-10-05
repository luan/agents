"""Create original practice assets; these are pipeline fixtures, not finished art."""
import argparse
import math
from pathlib import Path
import sys
import bpy


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    if args.output.exists():
        raise ValueError("demo output already exists")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    palette = {"skin": (0.5, 0.25, 0.14), "cloth": (0.04, 0.2, 0.21),
               "metal": (0.3, 0.4, 0.5), "wood": (0.22, 0.1, 0.04),
               "leaf": (0.06, 0.24, 0.08), "grass": (0.12, 0.25, 0.06),
               "earth": (0.22, 0.13, 0.06)}
    materials = {}
    for name, color in palette.items():
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*color, 1)
        materials[name] = mat
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, 4

    def collection(name):
        result = bpy.data.collections.new(name)
        scene.collection.children.link(result)
        return result

    def own(obj, group, material):
        for old in list(obj.users_collection):
            old.objects.unlink(obj)
        group.objects.link(obj)
        obj.data.materials.append(materials[material])
        return obj

    def box(group, name, location, scale, material):
        bpy.ops.mesh.primitive_cube_add(size=1, location=location)
        obj = own(bpy.context.object, group, material)
        obj.name = name
        obj.scale = scale
        return obj

    character = collection("Character")
    box(character, "Torso", (0, 0, 1.18), (0.55, 0.32, 0.72), "cloth")
    box(character, "Head", (0, -0.01, 1.82), (0.38, 0.35, 0.4), "skin")
    box(character, "Cap", (0, 0.02, 2.07), (0.44, 0.4, 0.13), "cloth")
    for sign in (-1, 1):
        box(character, "Leg", (sign * 0.16, 0, 0.52), (0.2, 0.24, 0.62), "wood")
        box(character, "Boot", (sign * 0.16, -0.09, 0.16), (0.24, 0.38, 0.26), "wood")
        arm = box(character, "Arm", (sign * 0.39, 0, 1.13), (0.17, 0.22, 0.65), "skin")
        for frame, angle in [(1, -20), (2, 0), (3, 20), (4, 0)]:
            arm.rotation_euler.x = math.radians(sign * angle)
            arm.keyframe_insert("rotation_euler", frame=frame)
    # Collection instancing exercises foliage evaluation without duplicating source meshes.
    tree = collection("Tree")
    box(tree, "Trunk", (0, 0, 1.35), (0.35, 0.38, 2.7), "wood")
    foliage = bpy.data.collections.new("Foliage source")
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.85)
    leaf = own(bpy.context.object, foliage, "leaf")
    leaf.name = "Canopy cluster"
    for location, scale in [((0, 0, 3), (1.3, 1, 1)), ((-0.65, 0, 2.7), (0.8, 1, 0.8)), ((0.65, 0.15, 2.6), (0.8, 1, 0.8))]:
        instance = bpy.data.objects.new("Foliage instance", None)
        instance.instance_type, instance.instance_collection = "COLLECTION", foliage
        instance.location, instance.scale = location, scale
        tree.objects.link(instance)
    terrain = collection("Terrain")
    box(terrain, "Ground", (0, 0, -0.05), (2, 2, 0.1), "grass")
    for x, y in [(-0.45, -0.3), (0.3, 0.45), (0.15, -0.4)]:
        box(terrain, "Dirt patch", (x, y, 0.008), (0.23, 0.18, 0.016), "earth")
    item = collection("Item")
    box(item, "Sword blade", (0, 0, 0.25), (0.16, 0.1, 0.9), "metal")
    box(item, "Guard", (0, 0, -0.22), (0.5, 0.15, 0.12), "metal")
    box(item, "Grip", (0, 0, -0.46), (0.13, 0.12, 0.36), "wood")
    scene.frame_set(1)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(args.output.resolve()))


if __name__ == "__main__":
    main()
