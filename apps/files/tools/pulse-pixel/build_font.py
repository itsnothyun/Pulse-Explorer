"""Builds Pulse Pixel (crates/rf-app/assets/fonts/PulsePixel.ttf) from Pulse's 5x7 glyph table.

The table lives in packages/ui/src/glyphs.ts of Pulse Explorer; every lit cell becomes a square
dot with a small gap, so headings look like the PixelText headings of the web app. Lowercase
letters map to the uppercase glyphs (PixelText renders uppercase too).

    pip install fonttools
    python tools/pulse-pixel/build_font.py
"""

import json
import re
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = Path(__file__).resolve().parent
FILES = HERE.parent.parent
GLYPHS_TS = FILES.parent.parent / "packages" / "ui" / "src" / "glyphs.ts"
OUT = FILES / "crates" / "rf-app" / "assets" / "fonts" / "PulsePixel.ttf"

FAMILY = "Pulse Pixel"
DOT = 100  # font units per grid cell
INK = 84  # side of a lit dot; the rest of the cell is the gap
COLS, ROWS, ADVANCE = 5, 7, 6
UPM = 1000
ASCENT, DESCENT = 850, 250


def load_table():
    src = GLYPHS_TS.read_text(encoding="utf-8")
    return json.loads(re.search(r"=\s*(\{.*\});", src, re.S).group(1))


def dot_glyph(rows):
    pen = TTGlyphPen(None)
    for r, bits in enumerate(rows):
        for c in range(COLS):
            if bits & (0x10 >> c):
                x, y = c * DOT, (ROWS - 1 - r) * DOT
                pen.moveTo((x, y))
                pen.lineTo((x, y + INK))
                pen.lineTo((x + INK, y + INK))
                pen.lineTo((x + INK, y))
                pen.closePath()
    return pen.glyph()


def main():
    table = load_table()
    names = {ch: f"uni{ord(ch):04X}" for ch in table}
    order = [".notdef"] + list(names.values())
    glyphs = {".notdef": dot_glyph([31, 17, 17, 17, 17, 17, 31])}
    for ch, rows in table.items():
        glyphs[names[ch]] = dot_glyph(rows)
    cmap = {ord(ch): name for ch, name in names.items()}
    for ch, name in names.items():
        if ch.isalpha() and ch.lower() != ch:
            cmap.setdefault(ord(ch.lower()), name)
    metrics = {name: (ADVANCE * DOT, 0) for name in order}

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
    fb.setupNameTable({
        "familyName": FAMILY,
        "styleName": "Regular",
        "uniqueFontIdentifier": "PulsePixel-Regular",
        "fullName": f"{FAMILY} Regular",
        "psName": "PulsePixel-Regular",
        "version": "Version 1.000",
        "licenseDescription": "MIT (glyphs from Pulse, github.com/itsnothyun/Pulse)",
    })
    fb.setupOS2(
        sTypoAscender=ASCENT, sTypoDescender=-DESCENT, sTypoLineGap=0,
        usWinAscent=ASCENT, usWinDescent=DESCENT, sxHeight=ROWS * DOT, sCapHeight=ROWS * DOT,
        achVendID="PULS", fsType=0,
    )
    fb.setupPost()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    fb.save(str(OUT))
    print(f"{OUT} ({len(table)} glyphs)")


if __name__ == "__main__":
    main()
