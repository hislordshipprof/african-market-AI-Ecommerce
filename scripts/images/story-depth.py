"""Cut the story surface photo crops and generate the depth map (#35).

Offline only. Nothing here runs in the app, and none of it is an app dependency.

  python -m pip install onnxruntime numpy pillow
  # model: https://huggingface.co/onnx-community/depth-anything-v2-small (onnx/model.onnx, Apache-2.0)
  # source: https://images.unsplash.com/photo-1734255026082-82fdc81991f0?q=95&fm=jpg (2705 x 3380, the largest served)
  python -I scripts/images/story-depth.py --source bodija.jpg --model model.onnx --out public/images/story

Look at the depth map before committing it: near things are light, the sky is black.
"""
import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

# Crops are fractions of the source: (left, top, right, bottom).
# Both lead with hands and produce, under the faces and the stall's signage. The output
# sizes are the source's own pixels in each crop, so nothing is upscaled here.
WIDE_CROP = (0.0625, 0.5365, 0.9375, 0.93)  # 16:9, for tablets and up.
TALL_CROP = (0.25, 0.55, 0.62, 1.0)  # Hands and peppers above a bottom-anchored form.
WIDE_SIZE = (2367, 1331)
TALL_SIZE = (828, 1258)  # Smaller than the source: this is the phone's LCP image.
DEPTH_SIZE = (1000, 563)
MODEL_INPUT = (826, 462)  # Depth Anything needs multiples of 14.
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def crop(image: Image.Image, box: tuple[float, float, float, float], size: tuple[int, int]) -> Image.Image:
    w, h = image.size
    left, top, right, bottom = box
    region = (round(left * w), round(top * h), round(right * w), round(bottom * h))
    # The original is already smoothed, so a light sharpen brings back some edge definition.
    resized = image.crop(region).resize(size, Image.Resampling.LANCZOS)
    return resized.filter(ImageFilter.UnsharpMask(radius=1.6, percent=70, threshold=2))


def estimate_depth(image: Image.Image, model: Path) -> Image.Image:
    pixels = np.asarray(image.resize(MODEL_INPUT, Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
    pixels = ((pixels - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None]
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    disparity = session.run(None, {session.get_inputs()[0].name: pixels})[0].squeeze()
    low, high = np.percentile(disparity, (1, 99))
    normalized = np.clip((disparity - low) / (high - low), 0, 1)
    depth = Image.fromarray((normalized * 255).astype(np.uint8)).resize(DEPTH_SIZE, Image.Resampling.BICUBIC)
    # Grow near silhouettes a little so the background stretches at an edge, not the subject.
    return depth.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(3))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    source = Image.open(args.source).convert("RGB")
    wide = crop(source, WIDE_CROP, WIDE_SIZE)
    wide.save(args.out / "bodija-wide.webp", quality=82, method=6)
    crop(source, TALL_CROP, TALL_SIZE).save(args.out / "bodija-tall.webp", quality=66, method=6)
    estimate_depth(wide, args.model).save(args.out / "bodija-wide-depth.webp", quality=80, method=6)


if __name__ == "__main__":
    main()
