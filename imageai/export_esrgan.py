"""Build-time only (Dockerfile builder stage): turns the official Real-ESRGAN realesr-general-x4v3 weights into
ONNX models for onnxruntime, so the running image needs no PyTorch.

Real-ESRGAN's "denoise strength" blends two checkpoints' weights (deep network interpolation, as its
inference_realesrgan.py does): strength d uses d x realesr-general-x4v3 + (1 - d) x realesr-general-wdn-x4v3.
Blending happens on weights, so it can't be done on the outputs at run time: one ONNX file per strength.
"""

import sys

import torch
import torch.nn.functional as F
from torch import nn


class SRVGGNetCompact(nn.Module):
    """The realesr-general-x4v3 network (from Real-ESRGAN, BSD-3-Clause), unchanged."""

    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        return out + F.interpolate(x, scale_factor=self.upscale, mode="nearest")


def weights(path):
    ckpt = torch.load(path, map_location="cpu", weights_only=True)
    return ckpt.get("params_ema", ckpt.get("params", ckpt))


def main(general, wdn, out_dir, strengths):
    a, b = weights(general), weights(wdn)
    for s in strengths:
        net = SRVGGNetCompact()
        net.load_state_dict({k: s * a[k] + (1 - s) * b[k] for k in a}, strict=True)
        net.eval()
        x = torch.rand(1, 3, 64, 64)
        path = f"{out_dir}/realesr-general-x4v3-dn{int(round(s * 100)):02d}.onnx"
        torch.onnx.export(
            net,
            x,
            path,
            input_names=["input"],
            output_names=["output"],
            dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "h4", 3: "w4"}},
            opset_version=17,
        )
        print("exported", path)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], [0.2, 0.5, 0.8])
