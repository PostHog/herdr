import colorsys, json
from PIL import Image, ImageDraw, ImageFont
# lightness / hue drift / sat factor per button, copied from the rain ramp
SHAPE = {"help": (0.57, -8, 1.0), "ca": (0.63, -3, 0.95), "verify": (0.71, 0, 0.85),
         "draft": (0.74, 8, 0.55), "devbox": (0.79, 14, 0.9), "thanks": (0.88, 10, 0.95)}
# scene: (base hue, saturation)
SCENES = {"sunset": (340, 0.26), "meadow": (95, 0.26), "night": (234, 0.30), "seaside": (192, 0.30),
          "blossom": (335, 0.42), "autumn": (26, 0.36), "snow": (218, 0.22),
          "forest": (75, 0.27)}
def hx(h, l, s):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360, l, s); return "#%02x%02x%02x" % tuple(round(c * 255) for c in (r, g, b))
out = {sc: {k: hx(h + dh, l, s * f) for k, (l, dh, f) in SHAPE.items()} for sc, (h, s) in SCENES.items()}
out["rain"] = {"verify": "#a9c0b4", "ca": "#8fb09c", "draft": "#b7c2b6", "devbox": "#cbd3c0", "thanks": "#dfe5da", "help": "#7fa688"}
json.dump(out, open("ramps.json", "w"), indent=1)
order = ["help", "verify", "ca", "draft", "devbox", "thanks"]
im = Image.new("RGB", (900, 50 * len(out) + 10), "#1c2622"); d = ImageDraw.Draw(im)
f = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 18)
for i, (sc, b) in enumerate(out.items()):
    y = 10 + 50 * i; d.text((10, y + 8), sc, fill="#ddd", font=f)
    for j, k in enumerate(order):
        x = 110 + j * 130; d.rounded_rectangle((x, y, x + 120, y + 36), 8, fill=b[k]); d.text((x + 10, y + 8), k, fill="#1c2622", font=f)
im.save("ramps.png")
