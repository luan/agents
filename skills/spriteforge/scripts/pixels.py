"""Palette-lock, validate, and assemble native-resolution sprites."""
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from settings import Settings


def finish_image(image: Image.Image, settings: Settings) -> Image.Image:
    colors = list(dict.fromkeys(c for ramp in settings.palette.values() for c in ramp))
    if settings.outline and settings.outline not in colors:
        colors.append(settings.outline)
    palette = [tuple(bytes.fromhex(c)) for c in colors]
    lookup = Image.new("P", (1, 1))
    lookup.putpalette([v for color in palette for v in color] + list(palette[0]) * (256 - len(palette)))
    image = image.convert("RGBA")
    alpha = image.getchannel("A").point(lambda a: 255 if a >= 128 else 0)
    result = image.convert("RGB").quantize(palette=lookup, dither=Image.Dither.NONE).convert("RGBA")
    result.putalpha(alpha)
    if settings.outline:
        contour = Image.new("RGBA", image.size, (*bytes.fromhex(settings.outline), 0))
        contour.putalpha(alpha.filter(ImageFilter.MaxFilter(3)))
        contour.alpha_composite(result)
        result = contour
    return result


def validate_image(image: Image.Image, settings: Settings) -> dict:
    if image.size != settings.size:
        raise ValueError(f"wrong image size: {image.size}, expected {settings.size}")
    box = image.getbbox()
    if box is None:
        raise ValueError("empty sprite")
    allowed = {tuple(bytes.fromhex(c)) for ramp in settings.palette.values() for c in ramp}
    if settings.outline:
        allowed.add(tuple(bytes.fromhex(settings.outline)))
    for pixel in image.get_flattened_data():
        if pixel[3] not in (0, 255) or (pixel[3] and pixel[:3] not in allowed):
            raise ValueError("sprite contains an invalid alpha or palette color")
    width, height = image.size
    if settings.tileable:
        if image.getchannel("A").getextrema() != (255, 255):
            raise ValueError("tileable ground must cover the full cell")
        horizontal = ImageChops.difference(image.crop((0, 0, 1, height)), image.crop((width - 1, 0, width, height)))
        vertical = ImageChops.difference(image.crop((0, 0, width, 1)), image.crop((0, height - 1, width, height)))
        if horizontal.convert("RGB").getbbox() or vertical.convert("RGB").getbbox():
            raise ValueError("tileable ground has mismatched opposite edges")
    elif box[0] < 2 or box[1] < 2 or box[2] > width - 2 or box[3] > height - 2:
        raise ValueError("sprite reaches the crop margin; enlarge the canvas or adjust its anchor")
    return {"bounds": box, "tileable": settings.tileable}


def finish(directory: Path) -> None:
    settings = Settings.load(directory / "asset.json")
    manifest = json.loads((directory / "manifest.json").read_text())
    width, height = settings.size
    sprites = directory / "sprites"
    sprites.mkdir()
    atlas = Image.new("RGBA", (width * len(settings.frames), height * len(settings.directions)))
    # Contact sheet uses only integer enlargement and preserves native anchors.
    zoom = max(1, min(4, 512 // max(width, height)))
    preview_frames = []
    records = []
    images = {}
    for row, direction in enumerate(settings.directions):
        for column, frame in enumerate(settings.frames):
            name = f"{direction}-{frame:04d}.png"
            image = finish_image(Image.open(directory / "raw" / name), settings)
            record = validate_image(image, settings)
            image.save(sprites / name)
            images[direction, frame] = image
            atlas.alpha_composite(image, (column * width, row * height))
            records.append({"file": f"sprites/{name}", "frame": frame, "direction": direction,
                            "atlas_rect": [column * width, row * height, width, height], **record})
    atlas.save(directory / "atlas.png")
    for frame in settings.frames:
        preview = Image.new("RGB", (width * zoom * len(settings.directions), height * zoom + 24), "#34373d")
        draw = ImageDraw.Draw(preview)
        for column, direction in enumerate(settings.directions):
            draw.text((column * width * zoom + 4, 5), f"{direction} / {frame}", fill="white")
            image = images[direction, frame].resize((width * zoom, height * zoom), Image.Resampling.NEAREST)
            preview.paste(image, (column * width * zoom, 24), image)
        preview_frames.append(preview)
    preview_frames[0].save(directory / "preview.png")
    if len(preview_frames) > 1:
        durations = [max(10, (round((i + 1) * 100 / settings.fps) - round(i * 100 / settings.fps)) * 10) for i in range(len(preview_frames))]
        preview_frames[0].save(directory / "preview.gif", save_all=True, append_images=preview_frames[1:],
                               duration=durations, loop=0, disposal=2)
    if settings.tileable:
        tiled = Image.new("RGBA", (width * 3, height * 3))
        image = images[settings.directions[0], settings.frames[0]]
        for x in range(3):
            for y in range(3):
                tiled.alpha_composite(image, (x * width, y * height))
        tiled.resize((width * 3 * zoom, height * 3 * zoom), Image.Resampling.NEAREST).save(directory / "tiled-preview.png")
    manifest.update({"sprites": records, "atlas": "atlas.png", "preview": "preview.png",
                     "validation": {"passed": True, "sprite_count": len(records), "visual_acceptance": "unreviewed"}})
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
