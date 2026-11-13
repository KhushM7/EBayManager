"""EBayManager image AI: three open models on onnxruntime (CPU), behind one shared key.

  POST /v1/remove_background  image (JPEG/PNG)            -> PNG with alpha       (IS-Net, rembg's method)
  POST /v1/erase              image + mask (PNG, white=x)  -> JPEG                 (LaMa inpainting)
  POST /v1/upscale            image [+ denoise 0..1]       -> JPEG: enlarged up to 2400px, or enhanced at its own size (Real-ESRGAN general x4v3)
  GET  /health                                             -> {"ok": true}

Every /v1 call needs X-ImageAI-Key, compared in constant time. Models load lazily on first use and stay
loaded for the replica's life; the app runs on Azure Container Apps scaled to zero, so it costs nothing idle
(docs/imageai.md). Nothing is stored: each photo lives only in memory for the length of its request.
"""

import hmac
import io
import os
import threading

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageFilter, ImageOps

MODELS = os.environ.get("MODELS_DIR", "/models")
KEY = os.environ.get("IMAGEAI_KEY", "")
MAX_BYTES = 12 * 1024 * 1024
MAX_SIDE = 2400
THREADS = int(os.environ.get("ORT_THREADS", "2"))

Image.MAX_IMAGE_PIXELS = MAX_SIDE * MAX_SIDE * 2

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_sessions: dict[str, ort.InferenceSession] = {}
_load_lock = threading.Lock()
# One photo at a time: bounds memory on a small replica (the app sends one request per tap anyway).
_run_lock = threading.Lock()


class Refused(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status, self.message, self.code = status, message, code


def session(name: str) -> ort.InferenceSession:
    with _load_lock:
        if name not in _sessions:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = THREADS
            opts.inter_op_num_threads = 1
            _sessions[name] = ort.InferenceSession(f"{MODELS}/{name}", opts, providers=["CPUExecutionProvider"])
        return _sessions[name]


def read_image(data: bytes, what: str) -> Image.Image:
    if not data:
        raise Refused(400, f"No {what} was sent.")
    if len(data) > MAX_BYTES:
        raise Refused(413, f"The {what} is over 12 MB.")
    if not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n"):
        raise Refused(415, f"The {what} must be a JPEG or PNG.")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        raise Refused(400, f"The {what} couldn't be read.")
    img = ImageOps.exif_transpose(img)
    if max(img.size) > MAX_SIDE:
        raise Refused(413, f"The {what} is larger than {MAX_SIDE}px on its long side.")
    return img


def jpeg(img: Image.Image) -> bytes:
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=92, optimize=True)
    return out.getvalue()


# ---------------------------------------------------------------- Background removal (IS-Net)
#
# rembg's "isnet-general-use" session, reimplemented here (rembg is MIT): the same model file, 1024x1024
# input, mean 0.5 / std 1.0 normalisation and min-max scaling of the prediction. Using the rembg package
# itself would pull in numba, scipy and scikit-image (for alpha matting we don't use), doubling the image.
# IS-Net is chosen over U-2-Net: it was trained on the high-resolution DIS dataset at 1024px (U-2-Net: 320px),
# so it keeps thin edges, handles and cables on products far better.


def remove_background(img: Image.Image) -> bytes:
    rgb = img.convert("RGB")
    x = np.asarray(rgb.resize((1024, 1024), Image.LANCZOS), dtype=np.float32) / 255.0
    x = (x - 0.5) / 1.0
    s = session("isnet-general-use.onnx")
    pred = s.run(None, {s.get_inputs()[0].name: x.transpose(2, 0, 1)[None]})[0][:, 0, :, :]
    lo, hi = float(pred.min()), float(pred.max())
    m = (pred - lo) / max(hi - lo, 1e-6)
    mask = Image.fromarray((np.squeeze(m) * 255).clip(0, 255).astype(np.uint8), "L").resize(rgb.size, Image.LANCZOS)
    # A gentle curve: near-transparent haze goes fully transparent, the item's body fully opaque, edges stay soft.
    lut = [0 if v < 20 else 255 if v > 235 else round((v - 20) * 255 / 215) for v in range(256)]
    rgba = rgb.copy()
    rgba.putalpha(mask.point(lut))
    out = io.BytesIO()
    rgba.save(out, "PNG", optimize=True)
    return out.getvalue()


# ---------------------------------------------------------------- Spot removal (LaMa)
#
# LaMa fills a masked area by extending the textures around it; it doesn't invent objects. The model is a
# fixed 512x512 export, so the work happens on a padded square around the mask, then only the masked pixels
# (with a feathered edge) are pasted back: the rest of the photo is untouched, at full resolution.

LAMA = 512


def erase(img: Image.Image, mask_img: Image.Image) -> bytes:
    rgb = img.convert("RGB")
    if mask_img.size != rgb.size:
        raise Refused(400, "The mask must be the same size as the photo.")
    W, H = rgb.size
    mask = mask_img.convert("L").point(lambda v: 255 if v > 127 else 0)
    # A few pixels more than painted, so the object's soft edge and shadow fringe go too.
    grow = max(3, round(max(W, H) / 400)) | 1
    mask = mask.filter(ImageFilter.MaxFilter(grow))
    box = mask.getbbox()
    if not box:
        raise Refused(400, "Paint over what to remove first.")
    x0, y0, x1, y1 = box
    side = max(x1 - x0, y1 - y0)
    side = min(max(W, H), max(LAMA // 2, int(side * 2)))  # context around the mask: twice its size
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    cw, ch = min(side, W), min(side, H)
    left = min(max(0, cx - cw // 2), W - cw)
    top = min(max(0, cy - ch // 2), H - ch)
    crop = (left, top, left + cw, top + ch)

    part = rgb.crop(crop)
    part_mask = mask.crop(crop)
    x = np.asarray(part.resize((LAMA, LAMA), Image.LANCZOS), dtype=np.float32) / 255.0
    m = (np.asarray(part_mask.resize((LAMA, LAMA), Image.NEAREST), dtype=np.float32) > 127).astype(np.float32)
    s = session("lama_fp32.onnx")
    names = [i.name for i in s.get_inputs()]
    feeds = {names[0]: x.transpose(2, 0, 1)[None], names[1]: m[None, None]}
    y = s.run(None, feeds)[0][0].transpose(1, 2, 0)
    if y.max() <= 1.5:  # some exports return 0..1, the Carve one 0..255
        y = y * 255.0
    filled = Image.fromarray(y.clip(0, 255).astype(np.uint8), "RGB").resize(part.size, Image.LANCZOS)

    feather = part_mask.filter(ImageFilter.GaussianBlur(max(1.5, grow / 2)))
    part.paste(filled, (0, 0), feather)
    rgb.paste(part, crop[:2])
    return jpeg(rgb)


# ---------------------------------------------------------------- Upscale (Real-ESRGAN)
#
# realesr-general-x4v3, exported to ONNX at build time at three denoise strengths (export_esrgan.py). Run in
# overlapping tiles so memory stays flat, then brought down to the target with Lanczos. At most 2x
# oversampling: a larger photo is shrunk first so a 4x pass never exceeds twice the target (speed on a CPU).
#
# The point is quality, not only size (K, 2026-11-13): a small photo is enlarged up to 2400px, and a photo
# that's already full size keeps its size and gets the same pass, which restores detail and removes blur,
# noise and JPEG blocks (half-size in, 4x, back down to the original: about the cost of a 1200px enlarge).

TILE = 256
PAD = 12
STRENGTHS = {0.2: "dn20", 0.5: "dn50", 0.8: "dn80"}


def upscale(img: Image.Image, denoise: float) -> bytes:
    rgb = img.convert("RGB")
    W, H = rgb.size
    long = max(W, H)
    # Enlarge when there's room, else enhance at the photo's own size.
    target = max(long, min(MAX_SIDE, long * 4))
    if long * 4 > target * 2:
        f = (target / 2) / long
        rgb = rgb.resize((max(1, round(W * f)), max(1, round(H * f))), Image.LANCZOS)
    key = min(STRENGTHS, key=lambda k: abs(k - denoise))
    s = session(f"realesr-general-x4v3-{STRENGTHS[key]}.onnx")

    src = np.asarray(rgb, dtype=np.float32).transpose(2, 0, 1) / 255.0
    _, h, w = src.shape
    out = np.zeros((3, h * 4, w * 4), dtype=np.float32)
    for ty in range(0, h, TILE):
        for tx in range(0, w, TILE):
            # The tile plus a margin of real pixels on each side, so seams don't show; the margin is dropped after.
            ax0, ay0 = max(0, tx - PAD), max(0, ty - PAD)
            ax1, ay1 = min(w, tx + TILE + PAD), min(h, ty + TILE + PAD)
            t = s.run(None, {"input": src[None, :, ay0:ay1, ax0:ax1]})[0][0]
            ix0, iy0 = (tx - ax0) * 4, (ty - ay0) * 4
            tw, th = (min(tx + TILE, w) - tx) * 4, (min(ty + TILE, h) - ty) * 4
            out[:, ty * 4 : ty * 4 + th, tx * 4 : tx * 4 + tw] = t[:, iy0 : iy0 + th, ix0 : ix0 + tw]
    big = Image.fromarray((out.transpose(1, 2, 0) * 255.0).round().clip(0, 255).astype(np.uint8), "RGB")
    f = target / max(big.size)
    if f < 1:
        big = big.resize((round(big.width * f), round(big.height * f)), Image.LANCZOS)
    return jpeg(big)


# ---------------------------------------------------------------- HTTP


def authorised(key: str | None) -> bool:
    return bool(KEY) and key is not None and hmac.compare_digest(key.encode(), KEY.encode())


def refuse(status: int, message: str, code: str | None = None) -> JSONResponse:
    return JSONResponse({"error": message, **({"code": code} if code else {})}, status_code=status)


@app.get("/health")
def health():
    return {"ok": True, "loaded": sorted(_sessions)}


@app.post("/v1/{op}")
def run(
    op: str,
    image: UploadFile = File(None),
    mask: UploadFile = File(None),
    denoise: float = Form(0.5),
    x_imageai_key: str | None = Header(None),
):
    if not authorised(x_imageai_key):
        return refuse(401, "Not allowed.")
    if op not in ("remove_background", "erase", "upscale"):
        return refuse(404, "Unknown operation.")
    try:
        img = read_image(image.file.read() if image else b"", "photo")
        with _run_lock:
            if op == "remove_background":
                return Response(remove_background(img), media_type="image/png", headers={"X-Edit": "ai_background"})
            if op == "erase":
                m = read_image(mask.file.read() if mask else b"", "mask")
                return Response(erase(img, m), media_type="image/jpeg", headers={"X-Edit": "ai_erase"})
            return Response(upscale(img, min(1.0, max(0.0, denoise))), media_type="image/jpeg", headers={"X-Edit": "ai_upscale"})
    except Refused as r:
        return refuse(r.status, r.message, r.code)
