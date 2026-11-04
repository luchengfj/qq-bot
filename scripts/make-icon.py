"""Render the market card raster icon from the same design as icon.svg.

The plugin market wants a GitHub-hosted raster tile; icon.svg stays the
in-repo vector source. Only Pillow (bundled with DSH) is used.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "icon-180.png"
SIZE = 180


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    scale = SIZE / 64.0

    def s(v):
        return round(v * scale)

    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Blue gradient background, rounded corners.
    top = (0x4A, 0x90, 0xE2)
    bottom = (0x1C, 0x6F, 0xD6)
    gradient = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gradient)
    for y in range(SIZE):
        gd.line([(0, y), (SIZE, y)], fill=lerp(top, bottom, y / (SIZE - 1)) + (255,))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [s(2), s(2), s(62), s(62)], radius=s(16), fill=255
    )
    img.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(img)

    white = (0xFF, 0xFF, 0xFF, 0xFF)
    body = (0xF2, 0xF6, 0xFB, 0xFF)
    dark = (0x1C, 0x2B, 0x3A, 0xFF)
    beak = (0xF5, 0xA6, 0x23, 0xFF)
    light = (0xDF, 0xE8, 0xF2, 0xFF)

    # Body / belly.
    draw.ellipse([s(17), s(21), s(47), s(55)], fill=white)
    draw.ellipse([s(22), s(32), s(42), s(54)], fill=body)
    # Eye whites + pupils.
    draw.ellipse([s(20), s(23), s(32), s(35)], fill=white)
    draw.ellipse([s(32), s(23), s(44), s(35)], fill=white)
    draw.ellipse([s(24), s(26), s(30), s(32)], fill=dark)
    draw.ellipse([s(34), s(26), s(40), s(32)], fill=dark)
    # Beak.
    draw.arc([s(26), s(31), s(38), s(39)], start=0, end=180, fill=beak, width=s(2.5))
    # Wing line.
    draw.arc([s(18), s(46), s(46), s(58)], start=0, end=180, fill=light, width=s(2))

    img.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
