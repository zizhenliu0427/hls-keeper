"""Generate the extension icon set from the source artwork.

Usage:
    python scripts/make_icons.py [path/to/logo.png]

Defaults to assets/logo-source.png and writes extension/icons/icon<size>.png
for every size the manifest declares. Re-run this after changing the artwork.

Two corrections are applied on the way down, both of which matter at 16 px:

* the transparent margin around the artwork is trimmed, otherwise the mark
  only fills about two thirds of the toolbar frame;
* transparent cut-outs inside the artwork (the play triangle) are filled with
  white, otherwise they show the toolbar through and vanish on a dark theme.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "assets" / "logo-source.png"
TARGET = ROOT / "extension" / "icons"
SIZES = (16, 24, 32, 48, 128)
PADDING_FRACTION = 0.03
TRANSPARENT_BELOW = 8


def fill_interior_cutouts(image: Image.Image) -> Image.Image:
    pixels = np.array(image)
    transparent = pixels[..., 3] < TRANSPARENT_BELOW
    # Flood the transparent area that touches the border; whatever stays is an interior hole.
    # The copy() matters: a numpy-backed image is read-only and floodfill fails silently on it.
    outside = Image.fromarray((transparent * 255).astype(np.uint8), mode="L").copy()
    ImageDraw.floodfill(outside, (0, 0), 128)
    interior = np.array(outside) == 255
    if interior.any():
        pixels[interior] = [255, 255, 255, 255]
        print(f"Filled {int(interior.sum())} interior cut-out pixels with white.")
    return Image.fromarray(pixels, "RGBA")


def trim_and_pad(image: Image.Image) -> Image.Image:
    rows, columns = np.where(np.array(image)[..., 3] > TRANSPARENT_BELOW)
    if not len(rows):
        return image
    trimmed = image.crop((columns.min(), rows.min(), columns.max() + 1, rows.max() + 1))
    pad = round(max(trimmed.size) * PADDING_FRACTION)
    canvas = Image.new("RGBA", (trimmed.width + pad * 2, trimmed.height + pad * 2), (0, 0, 0, 0))
    canvas.paste(trimmed, (pad, pad))
    return canvas


def main(argv: list[str]) -> int:
    if len(argv) > 2:
        print(__doc__.strip())
        return 2
    source_path = Path(argv[1]).expanduser() if len(argv) == 2 else DEFAULT_SOURCE
    if not source_path.is_file():
        print(f"Source image not found: {source_path}")
        return 1

    master = trim_and_pad(fill_interior_cutouts(Image.open(source_path).convert("RGBA")))
    TARGET.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        destination = TARGET / f"icon{size}.png"
        master.resize((size, size), Image.LANCZOS).save(destination, format="PNG", optimize=True)
        print(f"{destination.relative_to(ROOT)}  {destination.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
