#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib


ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
CODEX_HOME = Path(os.environ.get("CODEX_HOME", HOME / ".codex"))
MARKETPLACE_PATH = ROOT / ".agents" / "plugins" / "marketplace.json"
CONFIG_PATH = ROOT / "codex" / "config.toml"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_config() -> dict:
    with CONFIG_PATH.open("rb") as handle:
        return tomllib.load(handle)


def manifest_path(plugin_root: Path) -> Path:
    for relative in [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]:
        path = plugin_root / relative
        if path.is_file():
            return path
    raise SystemExit(f"missing plugin manifest in {plugin_root}")


def plugin_version(plugin_root: Path) -> str:
    manifest = load_json(manifest_path(plugin_root))
    version = str(manifest.get("version") or "local").strip()
    if not version:
        raise SystemExit(f"blank plugin version in {plugin_root}")
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-_+")
    if any(ch not in allowed for ch in version) or version in {".", ".."}:
        raise SystemExit(f"invalid plugin version `{version}` in {plugin_root}")
    return version


def install_plugin(marketplace_name: str, plugin: dict) -> None:
    name = plugin["name"]
    source = plugin["source"]
    if source.get("source") != "local":
        print(f"skipping {name}@{marketplace_name}: only local sources are installed here")
        return

    source_path = (ROOT / source["path"]).resolve()
    manifest = load_json(manifest_path(source_path))
    if manifest.get("name") != name:
        raise SystemExit(f"plugin manifest name `{manifest.get('name')}` does not match `{name}`")

    version = plugin_version(source_path)
    target = CODEX_HOME / "plugins" / "cache" / marketplace_name / name / version
    tmp = target.with_name(f".{target.name}.tmp")
    backup = target.with_name(f".{target.name}.old")

    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(source_path, tmp, symlinks=True)
    shutil.rmtree(backup, ignore_errors=True)
    if target.exists() or target.is_symlink():
        target.rename(backup)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp.rename(target)
    shutil.rmtree(backup, ignore_errors=True)
    print(f"installed {name}@{marketplace_name} {version} -> {target}")


def main() -> None:
    marketplace = load_json(MARKETPLACE_PATH)
    marketplace_name = marketplace["name"]
    config = load_config()
    enabled = {
        key
        for key, value in config.get("plugins", {}).items()
        if isinstance(value, dict) and value.get("enabled") is True
    }

    installed = 0
    for plugin in marketplace.get("plugins", []):
        plugin_key = f"{plugin['name']}@{marketplace_name}"
        if plugin_key not in enabled:
            continue
        install_plugin(marketplace_name, plugin)
        installed += 1

    if installed == 0:
        print(f"no enabled plugins found for marketplace `{marketplace_name}`", file=sys.stderr)


if __name__ == "__main__":
    main()
