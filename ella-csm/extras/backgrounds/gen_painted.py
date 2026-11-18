"""Widescreen background via Gemini image models, needs GEMINI_API_KEY."""
import base64, json, os, sys, urllib.request, urllib.error
BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
key = os.environ.get("GEMINI_API_KEY") or sys.exit("set GEMINI_API_KEY first")
prompt, out = sys.argv[1], sys.argv[2]
for model, size in [("gemini-3.1-flash-image-preview", "4K"), ("gemini-3-pro-image-preview", "4K"), ("gemini-3.1-flash-image-preview", "2K")]:
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                       "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9", "imageSize": size}}}).encode()
    req = urllib.request.Request(BASE_URL.format(model=model), data=body, method="POST",
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            res = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"{model} {size}: {e.code} {e.read().decode()[:200]}", file=sys.stderr); continue
    for p in res.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        if "inlineData" in p:
            open(out, "wb").write(base64.b64decode(p["inlineData"]["data"]))
            print(f"ok {model} {size} -> {out}"); sys.exit(0)
    print(f"{model} {size}: no image", file=sys.stderr)
sys.exit(1)
