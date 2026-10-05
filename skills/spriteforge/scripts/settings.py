"""The asset contract shared by rendering and pixel finishing."""
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path

DIRECTIONS = {"east": 90, "north": 180, "west": 270, "south": 0}


def number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def vector(value: object, length: int, label: str) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) != length:
        raise ValueError(f"{label} must contain {length} numbers")
    return tuple(number(v, label) for v in value)


@dataclass(frozen=True)
class Settings:
    size: tuple[int, int]
    pixels_per_unit: float
    palette: dict[str, tuple[str, ...]]
    collection: str | None = None
    frames: tuple[int, ...] = (1,)
    directions: tuple[str, ...] = tuple(DIRECTIONS)
    pivot: tuple[float, ...] = (0, 0, 0)
    anchor: tuple[float, ...] = (0.5, 0.8)
    shear: tuple[float, ...] = (-0.45, 0.45)
    light: tuple[float, ...] = (-0.5, -0.65, 1)
    outline: str | None = "10151c"
    shading: str = "bands"
    fps: float = 8
    tileable: bool = False

    @classmethod
    def load(cls, path: Path) -> "Settings":
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError("asset settings must be an object")
        unknown = data.keys() - cls.__dataclass_fields__.keys()
        if unknown:
            raise ValueError(f"unknown settings: {', '.join(sorted(unknown))}")
        size = vector(data.get("size"), 2, "size")
        if any(v != int(v) or not 1 <= v <= 4096 for v in size):
            raise ValueError("size must contain integers from 1 to 4096")
        density = number(data.get("pixels_per_unit"), "pixels_per_unit")
        if density <= 0:
            raise ValueError("pixels_per_unit must be positive")
        ramps = data.get("palette")
        if not isinstance(ramps, dict) or not ramps:
            raise ValueError("palette must map material names to shade lists")
        palette = {}
        for name, colors in ramps.items():
            if not isinstance(name, str) or not name or not isinstance(colors, list) or not 1 <= len(colors) <= 16:
                raise ValueError("each material needs 1 to 16 colors")
            palette[name] = tuple(hexcolor(c) for c in colors)
        frames = data.get("frames", [1])
        if not isinstance(frames, list) or not frames or any(type(f) is not int for f in frames):
            raise ValueError("frames must be a nonempty list of integers")
        if frames != sorted(set(frames)):
            raise ValueError("frames must be unique and increasing")
        directions = data.get("directions", list(DIRECTIONS))
        if not isinstance(directions, list) or not directions or any(type(d) is not str or d not in DIRECTIONS for d in directions):
            raise ValueError(f"directions must use {', '.join(DIRECTIONS)}")
        if len(set(directions)) != len(directions):
            raise ValueError("directions must be unique")
        collection = data.get("collection")
        if collection is not None and (not isinstance(collection, str) or not collection):
            raise ValueError("collection must be a nonempty name")
        outline = data.get("outline", "10151c")
        if outline is not None:
            outline = hexcolor(outline)
        if len({c for ramp in palette.values() for c in ramp} | ({outline} if outline else set())) > 256:
            raise ValueError("the combined palette exceeds 256 colors")
        anchor = vector(data.get("anchor", [0.5, 0.8]), 2, "anchor")
        if any(not 0 <= v <= 1 for v in anchor):
            raise ValueError("anchor must be normalized coordinates from 0 to 1")
        light = vector(data.get("light", [-0.5, -0.65, 1]), 3, "light")
        if not any(light):
            raise ValueError("light must be nonzero")
        shading = data.get("shading", "bands")
        if shading not in ("bands", "preserve"):
            raise ValueError("shading must be bands or preserve")
        fps = number(data.get("fps", 8), "fps")
        if not 0 < fps <= 100:
            raise ValueError("fps must be positive and at most 100")
        tileable = data.get("tileable", False)
        if type(tileable) is not bool:
            raise ValueError("tileable must be a boolean")
        if tileable and outline is not None:
            raise ValueError("tileable assets require outline: null")
        return cls(tuple(int(v) for v in size), density, palette, collection,
                   tuple(frames), tuple(directions), vector(data.get("pivot", [0, 0, 0]), 3, "pivot"),
                   anchor, vector(data.get("shear", [-0.45, 0.45]), 2, "shear"),
                   light, outline, shading, fps, tileable)

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), indent=2) + "\n")


def hexcolor(value: object) -> str:
    if not isinstance(value, str) or len(value) != 6 or any(c not in "0123456789abcdefABCDEF" for c in value):
        raise ValueError("colors must be six hexadecimal digits without #")
    return value.lower()
