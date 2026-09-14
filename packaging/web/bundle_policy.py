#!/usr/bin/env python3
"""Browser bundle metadata and the no-ROM/no-BIOS policy (see LEGAL.md).

  bundle_policy.py stale <out dir>
      exit 1 listing ROM/BIOS leftovers from older build_web.sh versions
  bundle_policy.py expected <project dir> [--rom-sha1 HEX]
      print the SHA-1s the page will require from the visitor (exit 1 if unknown)
  bundle_policy.py manifest <repo> <out dir> <generated BIOS dir> <project dir> [--rom-sha1 HEX]
      write <out>/manifest.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import web_asset_guard  # noqa: E402

BUNDLE_FILES = ["game.js", "game.wasm", "host_web.js", "save_store.js", "asset_store.js",
                "bootstrap.js", "index.html", "audio_worklet_bundle.js", "robots.txt"]
STALE_NAMES = ["game.gba", "gba_bios.bin", "rom_sha1.js"]
SHA1 = re.compile(r"^[0-9a-f]{40}$")


def toml_string(text: str, section: str, key: str) -> str | None:
    """`key = "value"` inside `[section]`. Python 3.9 has no tomllib."""
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        header = re.match(r"^\[\[?\s*([A-Za-z0-9_.-]+)\s*\]\]?\s*(#.*)?$", line)
        if header:
            current = header.group(1)
            continue
        if current == section:
            match = re.match(rf'^{re.escape(key)}\s*=\s*"([^"]*)"\s*(#.*)?$', line)
            if match:
                return match.group(1)
    return None


def expected_assets(project: Path, rom_sha1: str | None) -> dict:
    game_toml = project / "game.toml"
    text = game_toml.read_text() if game_toml.is_file() else ""
    configured = (toml_string(text, "identity", "sha1") or "").lower()
    override = (rom_sha1 or "").lower()
    if configured and override and configured != override:
        raise ValueError(f"--rom-sha1 {override} differs from [identity] sha1 {configured} in {game_toml}")
    rom = override or configured
    if not SHA1.match(rom):
        raise ValueError(f"no ROM SHA-1: add [identity] sha1 to {game_toml} or pass --rom-sha1")
    return {
        "policy": "visitor-supplied",
        "rom_sha1": rom,
        "bios_sha1": web_asset_guard.parse_bios_sha1(),
        "bios_size": web_asset_guard.BIOS_SIZE,
        "game_name": toml_string(text, "program", "name") or project.name,
    }


def stale_assets(out: Path) -> list[str]:
    names = {name for name in STALE_NAMES if (out / name).exists()}
    names.update(path.name for path in out.glob("*.gba"))
    return sorted(names)


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_manifest(root: Path, out: Path, bios_gen: Path, project: Path, assets: dict,
                   emcc: str | None = None) -> None:
    data = {
        "abi": 1,
        "host_backend": "web",
        "revision": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
        "emcc": emcc or subprocess.check_output(["emcc", "--version"], text=True).splitlines()[0],
        # Playable bundles contain code translated from the ROM and BIOS: private test use only.
        "distribution": "private-test",
        "assets": assets,
        "files": {name: _digest(out / name) for name in BUNDLE_FILES if (out / name).is_file()},
        "inputs": {p.name: _digest(p) for p in [bios_gen / "bios_recompiled.cpp",
                                                bios_gen / "bios_dispatch_table.cpp",
                                                project / "game.toml"] if p.exists()},
    }
    (out / "manifest.json").write_text(json.dumps(data, indent=2) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    sub = parser.add_subparsers(dest="cmd")
    stale = sub.add_parser("stale")
    stale.add_argument("out", type=Path)
    expected = sub.add_parser("expected")
    expected.add_argument("project", type=Path)
    expected.add_argument("--rom-sha1")
    manifest = sub.add_parser("manifest")
    for name in ["root", "out", "bios_gen", "project"]:
        manifest.add_argument(name, type=Path)
    manifest.add_argument("--rom-sha1")
    args = parser.parse_args(argv)
    if args.cmd == "stale":
        names = stale_assets(args.out)
        for name in names:
            print(args.out / name)
        return 1 if names else 0
    if args.cmd not in ("expected", "manifest"):
        parser.print_usage(sys.stderr)
        return 2
    try:
        assets = expected_assets(args.project, args.rom_sha1)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if args.cmd == "manifest":
        write_manifest(args.root, args.out, args.bios_gen, args.project, assets)
    print(f"assets: game={assets['game_name']!r} rom_sha1={assets['rom_sha1']} bios_sha1={assets['bios_sha1']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
