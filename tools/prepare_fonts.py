#!/usr/bin/env python3
"""Cyrillic letters for a localization whose interface font lacks them.

Warcraft draws chat, edit boxes and most of the interface with
Fonts\\FRIZQT__.TTF (UI\\war3skins.txt). The English Friz Quadrata has no
Cyrillic glyphs, and an edit box ignores a character its font cannot draw:
Russian typed in the English game, or chat from Russian players, is lost. The
same English archives ship Nimrod MT (Fonts\\NIM_____.ttf) with the Cyrillic
alphabet. This tool copies those glyphs into Friz Quadrata, scaled to its
capital height, and writes var/locales/<language>/Fonts/FRIZQT__.TTF. Latin
glyphs stay untouched. The runtime turns on Warcraft's own "Allow Local Files"
setting, so the game reads that file before the archives.

Example: tools/prepare_fonts.py var/locales/en
"""
from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from mpq_reader import MPQReader  # noqa: E402

ARCHIVES = ("War3Patch.mpq", "War3xLocal.mpq", "War3x.mpq", "war3.mpq")  # the game's search order
MASTER, CYRILLIC = r"Fonts\FRIZQT__.TTF", r"Fonts\NIM_____.ttf"
OUTPUT = "Fonts/FRIZQT__.TTF"
CYRILLIC_BLOCK = range(0x0400, 0x0500)
EXTRA = (0x2116,)  # № (numero sign)


def read(directory, name):
    for archive in ARCHIVES:
        try:
            data = MPQReader(str(directory / archive)).read_file(name.encode())
        except (OSError, KeyError, ValueError, NotImplementedError):
            data = None
        if data:
            return data
    raise SystemExit(f"{name} is not in the archives of {directory}")


def capital_height(font):
    glyphs = font.getGlyphSet()
    pen = BoundsPen(glyphs)
    glyphs[font.getBestCmap()[ord("H")]].draw(pen)
    return pen.bounds[3]


def add_cyrillic(master_data, source_data):
    """Friz Quadrata (master) with the Cyrillic glyphs of the source font."""
    master, source = TTFont(BytesIO(master_data)), TTFont(BytesIO(source_data))
    master_map, source_map = master.getBestCmap(), source.getBestCmap()
    scale = capital_height(master) / capital_height(source)
    source_glyphs = source.getGlyphSet()
    glyf, hmtx = master["glyf"], master["hmtx"]
    order = list(master.getGlyphOrder())
    added = {}
    for code in sorted(set(CYRILLIC_BLOCK) | set(EXTRA)):
        if code in master_map or code not in source_map:
            continue
        # Components (Ё = Е + diaeresis) are decomposed: the master font has
        # no glyphs of that name.
        recording = DecomposingRecordingPen(source_glyphs)
        source_glyphs[source_map[code]].draw(recording)
        pen = TTGlyphPen(None)
        recording.replay(TransformPen(pen, (scale, 0, 0, scale, 0, 0)))
        name = f"uni{code:04X}"
        glyph = pen.glyph()
        glyph.recalcBounds(glyf)
        glyf[name] = glyph
        order.append(name)
        hmtx[name] = (round(source["hmtx"][source_map[code]][0] * scale), getattr(glyph, "xMin", 0))
        added[code] = name
    if not added:
        return master_data, 0
    master.setGlyphOrder(order)
    for table in master["cmap"].tables:
        if table.isUnicode():
            table.cmap.update(added)
    # Per-glyph device metrics would no longer cover every glyph; they are optional.
    for tag in ("hdmx", "LTSH", "VDMX"):
        if tag in master:
            del master[tag]
    os2 = master["OS/2"]
    os2.ulUnicodeRange1 |= 1 << 9  # Cyrillic
    os2.ulCodePageRange1 |= 1 << 2  # Windows-1251
    output = BytesIO()
    master.save(output)
    return output.getvalue(), len(added)


def prepare(directory):
    directory = Path(directory)
    data, count = add_cyrillic(read(directory, MASTER), read(directory, CYRILLIC))
    if not count:
        print(f"{MASTER} already has Cyrillic letters", flush=True)
        return None
    target = directory / OUTPUT
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(data)
    print(f"{target}: {count} Cyrillic glyphs from {CYRILLIC}", flush=True)
    return OUTPUT


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory", type=Path, help="a prepared localization, e.g. var/locales/en")
    prepare(parser.parse_args().directory)


if __name__ == "__main__":
    main()
