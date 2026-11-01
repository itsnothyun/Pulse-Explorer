"""
Generates the Windows file-type icons (filetype-icons/*.ico) that Explorer shows
for files associated with Pulse.

Design: a dark Pulse page (ground #0e0e0e) with widget scanlines, a phosphor
hairline edge, a folded corner with a lit pip, a soft drop shadow, the Pulse
heartbeat as a small brand strip, a 9x9 pixel pictogram for the type, and a lit
label band with the type in the Pulse 5x7 glyph font. Every size is drawn on its own pixel
grid (no downscaling) so 16 and 32 px stay crisp.

Run:  python scripts/make_filetype_icons.py
"""
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "filetype-icons"
GLYPH_SRC = ROOT.parents[2] / "packages" / "ui" / "src" / "glyphs.ts"

GROUND = (14, 14, 14, 255)
FOLD = (42, 42, 40, 255)
EDGE = (242, 242, 237, 90)
ON = (242, 242, 237, 255)
DIM = (117, 117, 115, 255)
MID = (179, 179, 173, 255)
INK = (9, 9, 9, 255)

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

# name -> (label at >= 48px, label at 32-40px)
TYPES = {
    "pdf": ("PDF", "PDF"),
    "doc": ("DOC", "DOC"),
    "slides": ("PPT", "PPT"),
    "sheet": ("XLS", "XLS"),
    "ebook": ("EPUB", "EPB"),
    "image": ("IMG", "IMG"),
    "text": ("TXT", "TXT"),
    "media": ("MEDIA", "AV"),
    "archive": ("ZIP", "ZIP"),
}

# Heartbeat from the Pulse logo on a 15 x 9 grid: (col, row, tone)
BEAT = [
    (0, 4, DIM), (1, 4, DIM), (2, 4, MID), (3, 3, MID), (4, 4, ON), (5, 4, ON),
    (6, 5, ON), (7, 3, ON), (7, 2, ON), (7, 1, ON), (8, 0, ON), (8, 1, ON), (8, 2, ON),
    (8, 3, ON), (9, 4, ON), (9, 5, ON), (9, 6, ON), (10, 7, ON), (10, 6, ON), (11, 4, ON),
    (12, 3, MID), (13, 4, ON), (14, 4, ON),
]


def load_glyphs():
    text = GLYPH_SRC.read_text(encoding="utf-8")
    body = re.search(r"=\s*(\{.*\});", text, re.S).group(1)
    return json.loads(body)


GLYPHS = load_glyphs()


def draw_text(d, text, x, y, cell, color):
    for i, ch in enumerate(text):
        rows = GLYPHS.get(ch)
        if not rows:
            continue
        for r in range(7):
            for c in range(5):
                if rows[r] & (0x10 >> c):
                    px = x + (i * 6 + c) * cell
                    py = y + r * cell
                    d.rectangle([px, py, px + cell - 1, py + cell - 1], fill=color)


def text_width(text, cell):
    return (len(text) * 6 - 1) * cell


# 9 x 9 pixel pictograms, one per type ("X" = lit)
PICTO = {
    "pdf": ["XXXXX....", ".........", "XXX.XXXXX", "X.X......", "XXX.XXXXX", ".........", "XXXXXXXXX", ".........", "XXXXXX..."],
    "doc": ["XXXXXXXXX", ".........", "XXXXXXXXX", ".........", "XXXXXXX..", ".........", "XXXXXXXXX", ".........", "XXXXX...."],
    "slides": ["XXXXXXXXX", "X.......X", "X.....X.X", "X...X.X.X", "X.X.X.X.X", "XXXXXXXXX", "....X....", "...XXX...", "........."],
    "sheet": ["XXXXXXXXX", "XXXXXXXXX", "X...X...X", "XXXXXXXXX", "X...X...X", "XXXXXXXXX", "X...X...X", "XXXXXXXXX", "........."],
    "ebook": ["XX.....XX", "X.XX.XX.X", "X...X...X", "X...X...X", "X...X...X", "X...X...X", "XXX.X.XXX", "...XXX...", "........."],
    "image": ["XXXXXXXXX", "X.......X", "X.XX....X", "X.XX..X.X", "X....XXXX", "X.X.XXXXX", "XXXXXXXXX", ".........", "........."],
    "text": [".........", ".........", "..X..XX..", ".X...X.X.", "X...X...X", ".X.X...X.", "..XX..X..", ".........", "........."],
    "media": [".........", ".XX......", ".XXXX....", ".XXXXXX..", ".XXXXXXX.", ".XXXXXX..", ".XXXX....", ".XX......", "........."],
    "archive": ["XXXXXXXXX", "X...X...X", "XXXXXXXXX", "X...X...X", "X..XXX..X", "X..X.X..X", "X..XXX..X", "X.......X", "XXXXXXXXX"],
}

SHADOW = (0, 0, 0, 120)
SCAN = (242, 242, 237, 12)
EDGE_BRIGHT = (242, 242, 237, 120)


def draw_grid(d, rows, x, y, cell, color, gap=0):
    for r, line in enumerate(rows):
        for c, ch in enumerate(line):
            if ch == "X":
                px, py = x + c * cell, y + r * cell
                d.rectangle([px, py, px + cell - 1 - gap, py + cell - 1 - gap], fill=color)


def page_polygon(x0, y0, x1, y1, fold, edge):
    return [(x0 + edge, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1 - edge),
            (x1 - edge, y1), (x0 + edge, y1), (x0, y1 - edge), (x0, y0 + edge)]


def make(size, name, label_big, label_small):
    from PIL import ImageFilter

    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Page geometry on whole pixels (leave room at the bottom for the shadow)
    pw = round(size * 0.70)
    ph = round(size * (0.86 if size >= 48 else 0.90))
    x0 = (size - pw) // 2
    y0 = max(0, (size - ph) // 2 - (size // 64))
    x1, y1 = x0 + pw - 1, y0 + ph - 1
    fold = max(2, round(pw * 0.26))
    edge = max(1, size // 64)
    poly = page_polygon(x0, y0, x1, y1, fold, edge)

    # Soft drop shadow (desktop object, per Pulse's elevation rules)
    if size >= 48:
        sh = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        off = max(1, size // 48)
        ImageDraw.Draw(sh).polygon([(x + 0, y + off * 2) for x, y in poly], fill=SHADOW)
        sh = sh.filter(ImageFilter.GaussianBlur(radius=max(1, size // 40)))
        im.alpha_composite(sh)

    d = ImageDraw.Draw(im)
    d.polygon(poly, fill=GROUND)

    # Widget scanlines over the page
    if size >= 64:
        scan = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        sd = ImageDraw.Draw(scan)
        step = max(3, size // 64 * 3)
        for yy in range(y0, y1, step):
            sd.line([(x0, yy), (x1, yy)], fill=SCAN, width=max(1, size // 128))
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).polygon(poly, fill=255)
        im.paste(Image.alpha_composite(im, scan), (0, 0), mask)
        d = ImageDraw.Draw(im)

    d.line(poly + [poly[0]], fill=EDGE_BRIGHT if size >= 48 else EDGE, width=edge)
    fold_poly = [(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)]
    d.polygon(fold_poly, fill=FOLD)
    d.line(fold_poly, fill=EDGE_BRIGHT if size >= 48 else EDGE, width=edge)
    if size >= 48:  # a single lit pixel on the fold, like the widget's live pip
        pip = max(2, size // 40)
        fx, fy = x1 - fold + fold // 3, y0 + fold - fold // 3 - pip
        d.rectangle([fx, fy, fx + pip - 1, fy + pip - 1], fill=ON)

    # Label band
    band_h = max(3, round(ph * (0.22 if size >= 48 else 0.20)))
    if 32 <= size < 48:
        band_h = max(band_h, 9)
    by0 = y1 - edge - band_h
    d.rectangle([x0 + edge + 1, by0, x1 - edge - 1, y1 - edge - 1], fill=ON)
    if size >= 32:
        label = label_big if size >= 48 else label_small
        inner_w = pw - 2 * (edge + 3)
        cell = max(1, min((band_h - 2) // 7, inner_w // max(1, len(label) * 6 - 1)))
        tw = text_width(label, cell)
        draw_text(d, label, x0 + (pw - tw) // 2 + 1, by0 + (band_h - 7 * cell) // 2, cell, INK)

    pad = edge + max(1, size // 24)
    body_top = y0 + edge + max(1, size // 32)
    body_bottom = by0 - max(1, size // 32)

    # Brand strip: the Pulse heartbeat, small, top-left beside the fold
    if size >= 48:
        bcell = max(1, (pw - fold - 2 * pad) // 18)
        draw_grid_beat = [(c, r, t) for c, r, t in BEAT]
        for col, row, tone in draw_grid_beat:
            px, py = x0 + pad + col * bcell, body_top + row * bcell
            d.rectangle([px, py, px + bcell - 1, py + bcell - 1], fill=tone)
        body_top = max(body_top + 9 * bcell, y0 + fold) + max(1, size // 32)

    # Type pictogram, centred in the remaining body
    if size >= 20:
        avail_w = pw - 2 * pad
        avail_h = body_bottom - body_top
        pcell = max(1, min(avail_w * 2 // 3, avail_h) // 9)
        gap = 1 if pcell >= 5 else 0
        gw = 9 * pcell
        gx = x0 + (pw - gw) // 2
        gy = body_top + max(0, (avail_h - gw) // 2)
        draw_grid(d, PICTO[name], gx, gy, pcell, ON, gap)
    else:
        mid = (body_top + body_bottom) // 2
        d.rectangle([x0 + pad, mid - 2, x1 - pad - 1, mid - 2], fill=MID)
        d.rectangle([x0 + pad, mid, x1 - pad - 3, mid], fill=DIM)
    return im


def main():
    OUT.mkdir(exist_ok=True)
    for name, (big, small) in TYPES.items():
        images = [make(s, name, big, small) for s in SIZES]
        largest = images[-1]
        largest.save(
            OUT / f"{name}.ico",
            format="ICO",
            sizes=[(s, s) for s in SIZES],
            append_images=images[:-1],
        )
        largest.save(OUT / f"{name}-preview.png")
    print("wrote", ", ".join(f"{n}.ico" for n in TYPES))


if __name__ == "__main__":
    main()
