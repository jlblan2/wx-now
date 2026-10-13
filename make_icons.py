from PIL import Image, ImageDraw


def make_icon(size, path):
    s = size / 512
    img = Image.new("RGBA", (size, size), (10, 18, 32, 255))
    d = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2

    # radar rings
    for r, a in ((200, 70), (140, 110), (80, 160)):
        r *= s
        mix = tuple(int(bg + (fg - bg) * a / 255) for fg, bg in zip((46, 196, 182), (10, 18, 32)))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=mix + (255,), width=max(2, int(6 * s)))

    # raindrop
    top = (cx, cy - 150 * s)
    r = 95 * s
    by = cy + 40 * s
    d.polygon([top, (cx - r * 0.93, by - r * 0.37), (cx + r * 0.93, by - r * 0.37)], fill=(74, 140, 255, 255))
    d.ellipse([cx - r, by - r, cx + r, by + r], fill=(74, 140, 255, 255))

    # sweep tick (orange) for "now"
    d.pieslice([cx - 200 * s, cy - 200 * s, cx + 200 * s, cy + 200 * s], -60, -50, fill=(255, 159, 28, 255))
    img.save(path)


make_icon(192, "icons/icon-192.png")
make_icon(512, "icons/icon-512.png")
print("done")
