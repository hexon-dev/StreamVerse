#!/usr/bin/env python3
"""
Build the StreamVerse Studio on-screen brand assets used to brand every final
master (see src/branding.js).

Output (transparent PNG, RGBA):
  logo/streamverse_lockup.png   icon tile + "StreamVerse" + "STUDIO"
                                (mirrors the header of the public site)

The lockup is rendered ONCE here and committed, so the production server needs
no fonts and no font rendering at runtime.

Inputs
  logo/streamverse_icon_source.webp   the icon (128x114)
  --serif  Noto Serif variable font   (OFL) https://github.com/google/fonts/tree/main/ofl/notoserif
  --sans   Inter variable font        (OFL) https://github.com/google/fonts/tree/main/ofl/inter

Usage
  python3 scripts/build_brand_assets.py --serif NotoSerif.ttf --sans Inter.ttf
"""
import argparse, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def var_font(path, size, axes):
    f = ImageFont.truetype(path, size)
    f.set_variation_by_axes(axes)
    return f

def lerp(a, b, t): return tuple(int(round(a[i] + (b[i]-a[i])*t)) for i in range(3))

def gradient_text(text, font, stops, pad=0):
    """Render text filled with a horizontal multi-stop gradient. Returns RGBA."""
    l, t, r, b = font.getbbox(text)
    w, h = r - l + pad*2, b - t + pad*2
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).text((pad - l, pad - t), text, font=font, fill=255)
    grad = Image.new("RGB", (w, 1))
    for x in range(w):
        p = x / max(1, w-1)
        for i in range(len(stops)-1):
            p0, c0 = stops[i]; p1, c1 = stops[i+1]
            if p0 <= p <= p1:
                grad.putpixel((x, 0), lerp(c0, c1, (p-p0)/(p1-p0))); break
    grad = grad.resize((w, h))
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0)); out.paste(grad, (0, 0), mask)
    return out

def spaced_text(text, font, fill, tracking):
    """Letter-spaced text (PIL has no tracking)."""
    widths = [font.getlength(ch) for ch in text]
    bbox = font.getbbox("H")
    w = int(sum(widths) + tracking*(len(text)-1)) + 2
    h = font.getbbox("Hg")[3] - font.getbbox("Hg")[1] + 4
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    x = 0
    for ch, cw in zip(text, widths):
        d.text((x, -font.getbbox("Hg")[1] + 2), ch, font=font, fill=fill); x += cw + tracking
    return img

def rounded_tile(img, radius):
    m = Image.new("L", img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, img.size[0]-1, img.size[1]-1], radius=radius, fill=255)
    out = img.convert("RGBA"); out.putalpha(m); return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serif", required=True); ap.add_argument("--sans", required=True)
    ap.add_argument("--icon", default=os.path.join(ROOT, "logo", "streamverse_icon_source.webp"))
    ap.add_argument("--out",  default=os.path.join(ROOT, "logo", "streamverse_lockup.png"))
    a = ap.parse_args()

    # 1. Icon tile (rounded, like the site header). 2x Lanczos so it stays crisp at 1080p.
    icon = Image.open(a.icon).convert("RGB")
    icon = icon.resize((icon.width*2, icon.height*2), Image.LANCZOS)
    tile = rounded_tile(icon, radius=int(min(icon.size)*0.22))
    H = tile.height                                   # lockup height = tile height

    # 2. Wordmark: "Stream" white + "Verse" gradient, bold serif
    serif = var_font(a.serif, 118, [700, 100])
    stream = gradient_text("Stream", serif, [(0, (255,255,255)), (1, (255,255,255))])
    verse  = gradient_text("Verse",  serif, [(0.0,(160,142,255)), (0.5,(92,160,238)), (1.0,(28,184,214))])
    word_w = stream.width + verse.width - 4
    word_h = max(stream.height, verse.height)

    # 3. "STUDIO" - letter-spaced, light
    sans = var_font(a.sans, 66, [32, 500])
    studio = spaced_text("STUDIO", sans, (226,226,240,255), tracking=16)

    gap_icon, gap_lines = 34, 10
    text_h = word_h + gap_lines + studio.height
    text_top = (H - text_h)//2
    W = tile.width + gap_icon + max(word_w, studio.width)
    pad = 28
    canvas = Image.new("RGBA", (W + pad*2, H + pad*2), (0,0,0,0))
    canvas.alpha_composite(tile, (pad, pad))
    tx = pad + tile.width + gap_icon
    canvas.alpha_composite(stream, (tx, pad + text_top))
    canvas.alpha_composite(verse,  (tx + stream.width - 4, pad + text_top))
    canvas.alpha_composite(studio, (tx + 4, pad + text_top + word_h + gap_lines))

    # 4. Soft drop shadow baked in so the bug stays legible on bright footage
    alpha = canvas.split()[3]
    shadow = Image.new("RGBA", canvas.size, (0,0,0,0))
    sh_a = alpha.filter(ImageFilter.GaussianBlur(9)).point(lambda v: int(v*0.65))
    shadow.putalpha(ImageChops.offset(sh_a, 0, 5))
    final = Image.alpha_composite(shadow, canvas)
    final.save(a.out, optimize=True)
    print(f"wrote {a.out}  {final.size[0]}x{final.size[1]}")

if __name__ == "__main__":
    main()
