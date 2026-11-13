# EBayManager image AI (docs/imageai.md): one small CPU image, three open models on onnxruntime, no PyTorch at
# run time. Built and published to GitHub Container Registry by .github/workflows/imageai.yml.

# ---- Stage 1: fetch the models (checksums pinned) and export Real-ESRGAN to ONNX (needs PyTorch, build only)
FROM python:3.12-slim AS models
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir onnx==1.17.0 numpy==2.2.1
WORKDIR /models
# IS-Net general use (rembg's release, Apache-2.0 model); LaMa ONNX (Apache-2.0); Real-ESRGAN weights (BSD-3).
RUN curl -fsSL -o isnet-general-use.onnx https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx \
 && curl -fsSL -o lama_fp32.onnx https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx \
 && curl -fsSL -o /tmp/general.pth https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth \
 && curl -fsSL -o /tmp/wdn.pth https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth \
 && printf '%s\n' \
    "60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a  isnet-general-use.onnx" \
    "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6  lama_fp32.onnx" \
    "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292  /tmp/general.pth" \
    "1641f8c4464b9f097c9fdda5589273713f67cf59f3d909e0bd688f0cee269dca  /tmp/wdn.pth" \
  | sha256sum -c -
COPY export_esrgan.py /tmp/
RUN python /tmp/export_esrgan.py /tmp/general.pth /tmp/wdn.pth /models && ls -la /models

# ---- Stage 2: the service
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODELS_DIR=/models ORT_THREADS=2
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=models /models /models
COPY app.py .
RUN useradd --uid 10001 --no-create-home imageai
USER 10001
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--timeout-keep-alive", "30"]
