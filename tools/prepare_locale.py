#!/usr/bin/env python3
"""Prepare another game language from an installed copy of the same patch.

The base installation (var/game) keeps the binaries the WASM build is lifted
from. A language adds only its localized data archives and cinematics under
var/locales/<language>/; the server substitutes them for the base files when a
player chooses that language. The data must be the same patch: the scripts and
gameplay tables are compared with the base installation, which also keeps LAN
games between localizations compatible (map checksums use these scripts).

Supply an archive created from your own licensed localized installation.
Example: tools/prepare_locale.py "/path/to/your-localized-installation.zip" --language en
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from mpq_reader import MPQReader  # noqa: E402
from prepare_fonts import prepare as prepare_fonts  # noqa: E402
from prepare_media import prepare as prepare_media  # noqa: E402

# Localized data archives; every localization of a patch ships its own copy.
ARCHIVES = ("war3.mpq", "War3x.mpq", "War3xLocal.mpq", "War3Patch.mpq")
MOVIES = ("HumanEd", "HumanOp", "IntroX", "NightElfEd", "OrcEd", "OutroX", "TutorialIn", "TutorialOp", "UndeadEd")
# Files that must be identical across localizations of one patch.
SAME_PATCH = (r"Scripts\common.j", r"Scripts\Blizzard.j", r"Scripts\common.ai", r"Units\UnitData.slk",
              r"Units\UnitBalance.slk", r"Units\AbilityData.slk", r"Units\UnitWeapons.slk", r"Units\ItemData.slk",
              r"Units\UpgradeData.slk", r"Units\MiscGame.txt")
NAMES = {"en": "English", "ru": "Русский"}


def find_member(listing, name):
    """Archive member whose file name equals `name` case-insensitively, at the root or under Movies/."""
    matches = [member for member in listing if member.rsplit("/", 1)[-1].casefold() == name.casefold()
               and member.count("/") <= 1 and ".." not in member.split("/")]
    preferred = [m for m in matches if m.count("/") == (1 if name.casefold().endswith(".mpq") and m.casefold().startswith("movies/") else 0)]
    return (preferred or matches or [None])[0]


def extract(archive, staging):
    listing = subprocess.run(["bsdtar", "-tf", str(archive)], check=True, capture_output=True, text=True).stdout.splitlines()
    wanted = {name: find_member(listing, name) for name in ARCHIVES}
    wanted.update({f"Movies/{movie}.mpq": find_member([m for m in listing if m.casefold().startswith("movies/")], f"{movie}.mpq") for movie in MOVIES})
    missing = [name for name, member in wanted.items() if member is None]
    if missing:
        raise SystemExit(f"The archive lacks {', '.join(missing)}")
    print(f"Extracting {len(wanted)} files (a solid 7z archive takes several minutes)", flush=True)
    subprocess.run(["bsdtar", "-xf", str(archive), "-C", str(staging), *wanted.values()], check=True)
    # Canonical names: the runtime mounts these over the base paths.
    for name, member in wanted.items():
        source, target = staging / member, staging / "out" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink() or not source.is_file():
            raise SystemExit(f"{member} is not a regular file")
        source.replace(target)
    return staging / "out"


def chain(directory):
    readers = []
    for name in reversed(ARCHIVES):  # War3Patch.mpq first, as the game reads them
        readers.append(MPQReader(str(directory / name)))
    return readers


def read(readers, name):
    for reader in readers:
        try:
            data = reader.read_file(name.encode())
        except Exception:
            data = None
        if data:
            return data
    return None


def verify_same_patch(base, localized):
    base_chain, localized_chain = chain(base), chain(localized)
    for name in SAME_PATCH:
        expected, actual = read(base_chain, name), read(localized_chain, name)
        if expected is None or actual is None or hashlib.sha256(expected).digest() != hashlib.sha256(actual).digest():
            raise SystemExit(f"{name} differs from the base installation: the localization is not the same patch")
    print(f"Scripts and gameplay tables match the base installation ({len(SAME_PATCH)} files)", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--language", required=True, choices=sorted(NAMES))
    parser.add_argument("--base", type=Path, default=ROOT / "var/game")
    parser.add_argument("--destination", type=Path, help="default: var/locales/<language>")
    args = parser.parse_args()
    if not shutil.which("bsdtar"):
        raise SystemExit("bsdtar (libarchive) is required to read the archive")
    destination = args.destination or ROOT / "var/locales" / args.language
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        localized = extract(args.archive.resolve(), Path(temporary))
        verify_same_patch(args.base, localized)
        prepare_media(localized)
        # Russian chat and names need Cyrillic letters in every localization.
        fonts = [] if args.language == "ru" else [name for name in [prepare_fonts(localized)] if name]
        (localized / "locale.json").write_text(json.dumps(
            {"schemaVersion": 1, "language": args.language, "name": NAMES[args.language],
             "source": args.archive.name, "archives": list(ARCHIVES), "localFiles": fonts},
            ensure_ascii=False, indent=2) + "\n")
        if destination.exists():
            shutil.rmtree(destination)
        localized.replace(destination)
    print(f"Prepared {NAMES[args.language]} in {destination}", flush=True)


if __name__ == "__main__":
    main()
