# Photo AI container

Three open models behind one small HTTP API, for the photo editor's AI tools. Architecture, costs and deploy
steps: [docs/imageai.md](../docs/imageai.md).

| Endpoint | Model | Returns |
| --- | --- | --- |
| `POST /v1/remove_background` (`image`) | IS-Net general use, rembg's method | PNG with alpha |
| `POST /v1/erase` (`image`, `mask`: PNG, white = remove) | LaMa inpainting, 512×512 ONNX | JPEG |
| `POST /v1/upscale` (`image`, optional `denoise` 0..1) | Real-ESRGAN realesr-general-x4v3 (ONNX, tiled) | JPEG: enlarged up to 2400 px, or the same size with detail restored when already full size |
| `GET /health` | | `{"ok": true}` |

Every `/v1` call needs `X-ImageAI-Key` (constant-time compare). Inputs: JPEG or PNG, ≤ 12 MB, ≤ 2400 px.
Nothing is stored. Everything runs on onnxruntime CPU; there is no PyTorch in the running image. PyTorch is
used only in the build stage, to export Real-ESRGAN.

## Models, sources and licences

| File | Source (pinned SHA-256 in the Dockerfile) | Licence |
| --- | --- | --- |
| `isnet-general-use.onnx` | github.com/danielgatis/rembg releases v0.0.0 | IS-Net (DIS): Apache-2.0; rembg: MIT |
| `lama_fp32.onnx` | huggingface.co/Carve/LaMa-ONNX | Apache-2.0 |
| `realesr-general-x4v3.pth`, `realesr-general-wdn-x4v3.pth` | github.com/xinntao/Real-ESRGAN releases v0.2.5.0 | BSD-3-Clause |

- **Background removal.** This uses rembg's `isnet-general-use` pipeline: 1024 px input, mean 0.5 and min–max scaling. It's reimplemented in `app.py` because the rembg package pulls in numba, scipy and scikit-image for alpha matting, which we don't use. IS-Net is used rather than U²-Net because it was trained at 1024 px on the high-resolution DIS set (U²-Net: 320 px), so thin edges on products survive.
- **Spot removal.** LaMa extends the surrounding texture into the masked area; it doesn't generate new objects. It works on a square of about twice the mask's size, resized to 512. Only the masked pixels are pasted back, with a feathered edge.
- **Upscale.** Real-ESRGAN's denoise strength blends the two checkpoints' weights, so the build exports three ONNX models (strength 0.2, 0.5, 0.8) and the request picks the nearest. It runs in 256 px tiles with a 12 px overlap. Oversampling is capped at 2× (a large input is shrunk first) to keep CPU time down, and the result is brought down to ≤ 2400 px with Lanczos.

## Local test

```sh
docker build -t ebaymanager-imageai:local imageai
docker run --rm -p 8080:8080 --cpus 2 --memory 4g -e IMAGEAI_KEY=local-test-key ebaymanager-imageai:local
node imageai/test-local.mjs test/fixtures-photos/front.jpg   # writes imageai/out/
```

Measured on 2026-11-13 (2 CPUs, 4 GB, a 1600×1200 photo, each the first call, so including loading its model):
remove_background 2.5 s, erase 7 s, upscale to 2400×1800 16 s. Peak memory 1.8 GB.
