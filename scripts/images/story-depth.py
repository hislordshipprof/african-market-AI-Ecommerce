"""Cut the story surface photo crops and generate the depth map (#35).

Offline only. Nothing here runs in the app, and none of it is an app dependency.

  python -m pip install onnxruntime numpy pillow
  # model: https://huggingface.co/onnx-community/depth-anything-v2-small (onnx/model.onnx, Apache-2.0)
  # source: https://unsplash.com/photos/cnVn4Gg4b00 (2560 x 3199 original)
  python -I scripts/images/story-depth.py --source bodija.jpg --model model.onnx --out public/images/story

Look at the depth map before committing it: near things are light, the sky is black.
"""
import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

# Crops are fractions of the source: (left, top, right, bottom).
WIDE_CROP = (0.0, 0.32, 1.0, 0.82)  # 16:10. Stall, vendor and umbrellas, for tablets and up.
TALL_CROP = (0.205, 0.32, 0.74, 1.0)  # Vendor in the top third, above a bottom-anchored form.
WIDE_SIZE = (2000, 1250)
TALL_SIZE = (780, 1248)
DEPTH_SIZE = (1000, 625)
MODEL_INPUT = (826, 518)  # Depth Anything needs multiples of 14.
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def crop(image: Image.Image, box: tuple[float, float, float, float], size: tuple[int, int]) -> Image.Image:
    w, h = image.size
    left, top, right, bottom = box
    region = (round(left * w), round(top * h), round(right * w), round(bottom * h))
    return image.crop(region).resize(size, Image.Resampling.LANCZOS)


def estimate_depth(image: Image.Image, model: Path) -> Image.Image:
    pixels = np.asarray(image.resize(MODEL_INPUT, Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
    pixels = ((pixels - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None]
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    disparity = session.run(None, {session.get_inputs()[0].name: pixels})[0].squeeze()
    low, high = np.percentile(disparity, (1, 99))
    normalized = np.clip((disparity - low) / (high - low), 0, 1)
    depth = Image.fromarray((normalized * 255).astype(np.uint8)).resize(DEPTH_SIZE, Image.Resampling.BICUBIC)
    # Grow near silhouettes a little so the background stretches at an edge, not the subject.
    return depth.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    source = Image.open(args.source).convert("RGB")
    wide = crop(source, WIDE_CROP, WIDE_SIZE)
    wide.save(args.out / "bodija-wide.webp", quality=74, method=6)
    crop(source, TALL_CROP, TALL_SIZE).save(args.out / "bodija-tall.webp", quality=70, method=6)
    estimate_depth(wide, args.model).save(args.out / "bodija-wide-depth.webp", quality=80, method=6)


if __name__ == "__main__":
    main()
