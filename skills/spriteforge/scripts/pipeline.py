#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow>=12.1,<13"]
# ///
"""Portable entrypoint; run Blender in a fresh process with autoexec disabled."""
import argparse
from dataclasses import replace
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from settings import Settings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["inspect", "render"])
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--preview", action="store_true", help="first direction and frame, same pixel scale")
    parser.add_argument("--blender", default="blender", help="executable name or path")
    args = parser.parse_args()
    if not args.source.is_file() or args.source.suffix.lower() != ".blend":
        parser.error("--source must be an existing .blend file")
    blender = shutil.which(args.blender)
    if not blender:
        parser.error("Blender is missing; install Blender 5.2 or pass --blender /path/to/blender")
    script = Path(__file__).with_name("blender_scene.py")
    base = [blender, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", str(script), "--", args.command, "--source", str(args.source.resolve())]
    if args.command == "inspect":
        with tempfile.TemporaryDirectory(prefix="pixel-inspect-") as temporary:
            report = Path(temporary) / "inspection.json"
            subprocess.run(base + ["--report", str(report)], check=True, stdout=sys.stderr)
            print(report.read_text(), end="")
        return
    if args.config is None or args.output is None:
        parser.error("render requires --config and --output")
    settings = Settings.load(args.config)
    if args.preview:
        settings = replace(settings, frames=settings.frames[:1], directions=settings.directions[:1])
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()  # Fresh output is required; failed runs remain available for diagnosis.
    settings.save(output / "asset.json")
    subprocess.run(base + ["--output", str(output)], check=True, stdout=sys.stderr)
    from pixels import finish
    finish(output)
    manifest = json.loads((output / "manifest.json").read_text())
    print(json.dumps({"output": str(output), "preview": str(output / "preview.png"), "validation": manifest["validation"]}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"pixel pipeline: {error}", file=sys.stderr)
        raise SystemExit(1) from error
