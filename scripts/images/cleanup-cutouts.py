"""Post-process product cut-outs: clean matte, crop, scale, quality-gate."""
from __future__ import annotations
import json, shutil, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import label

ROOT = Path(__file__).resolve().parents[2]
PRODUCTS = ROOT / "public" / "images" / "products"
BACKUP = ROOT / "scripts" / "images" / "cutout-backup"
REPORT = ROOT / "scripts" / "images" / "processing-report.json"

CANVAS = 800
FILL_TARGET = 0.775  # 77.5% of canvas (midpoint of 75-80%)
ALPHA_THRESHOLD = 40
COMPONENT_MIN_RATIO = 0.05  # keep components >= 5% of largest
MIN_OBJECT_DIM = 80  # reject if either dim < 80px after crop
MIN_COVERAGE = 0.04  # reject if alpha coverage < 4% of bounding box
MAX_HAZE_RATIO = 0.20  # reject if semi-transparent area > 20% of object bbox


def clean_alpha(img: Image.Image) -> Image.Image:
    """Threshold low alpha, keep largest connected component + large siblings."""
    arr = np.array(img)
    alpha = arr[:, :, 3].copy()

    # Step 1: threshold low alpha
    alpha[alpha < ALPHA_THRESHOLD] = 0

    # Step 2: connected components on the binary mask
    mask = alpha > 0
    labeled, n_features = label(mask)
    if n_features == 0:
        arr[:, :, 3] = 0
        return Image.fromarray(arr)

    # Find largest component
    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0  # ignore background
    largest_label = sizes.argmax()
    largest_size = sizes[largest_label]
    threshold_size = int(largest_size * COMPONENT_MIN_RATIO)

    # Keep largest + any component >= 5% of largest
    keep = np.zeros(n_features + 1, dtype=bool)
    for lbl in range(1, n_features + 1):
        if sizes[lbl] >= threshold_size:
            keep[lbl] = True

    clean_mask = keep[labeled]
    alpha[~clean_mask] = 0

    # Step 3: erosion (2px) then feather (1px gaussian on alpha)
    alpha_img = Image.fromarray(alpha, mode="L")
    alpha_img = alpha_img.filter(ImageFilter.MinFilter(3))  # erode pass 1
    alpha_img = alpha_img.filter(ImageFilter.MinFilter(3))  # erode pass 2
    alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=1.0))  # feather

    arr[:, :, 3] = np.array(alpha_img)
    return Image.fromarray(arr)


def crop_and_scale(img: Image.Image) -> Image.Image | None:
    """Crop to alpha bbox, scale to fill ~77.5% of canvas, center."""
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return None

    cropped = img.crop(bbox)
    w, h = cropped.size

    if w < MIN_OBJECT_DIM or h < MIN_OBJECT_DIM:
        return None

    # Check coverage: ratio of non-zero alpha to bounding box area
    crop_alpha = np.array(cropped.getchannel("A"))
    coverage = np.count_nonzero(crop_alpha) / (w * h)
    if coverage < MIN_COVERAGE:
        return None

    # Scale to fill FILL_TARGET of canvas
    target_dim = int(CANVAS * FILL_TARGET)  # ~620px
    scale = target_dim / max(w, h)
    if scale > 1:
        scale = min(scale, 2.0)  # don't upscale more than 2x
    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    paste_x = (CANVAS - new_w) // 2
    paste_y = (CANVAS - new_h) // 2
    canvas.alpha_composite(resized, (paste_x, paste_y))
    return canvas


def process_all() -> dict:
    """Process all WebP cut-outs, return report."""
    if not PRODUCTS.exists():
        print(f"Error: {PRODUCTS} not found")
        sys.exit(1)

    BACKUP.mkdir(parents=True, exist_ok=True)

    webps = sorted(PRODUCTS.glob("*.webp"))
    print(f"Found {len(webps)} cut-outs to process")

    results: list[dict] = []
    accepted = 0
    rejected = 0

    for path in webps:
        slug = path.stem
        backup_path = BACKUP / path.name
        if not backup_path.exists():
            shutil.copy2(path, backup_path)

        try:
            img = Image.open(path).convert("RGBA")
            cleaned = clean_alpha(img)
            final = crop_and_scale(cleaned)

            if final is None:
                results.append({"slug": slug, "status": "rejected", "reason": "object too small or low coverage after cleanup"})
                rejected += 1
                # Remove the broken cut-out so listing falls back to original photo
                path.unlink()
                print(f"  REJECT {slug}")
                continue

            # Additional quality check: ensure object isn't mostly white/transparent haze
            final_alpha = np.array(final.getchannel("A"))
            total_pixels = CANVAS * CANVAS
            opaque_pixels = np.count_nonzero(final_alpha > 128)
            opaque_ratio = opaque_pixels / total_pixels

            if opaque_ratio < 0.02:
                results.append({"slug": slug, "status": "rejected", "reason": "too few opaque pixels after cleanup"})
                rejected += 1
                path.unlink()
                print(f"  REJECT {slug} (low opacity)")
                continue

            # Haze/ghost detection: semi-transparent pixels relative to bbox area
            semi_pixels = np.count_nonzero((final_alpha > 0) & (final_alpha <= 128))
            bbox_alpha = final_alpha[final_alpha > 0]
            if len(bbox_alpha) > 0:
                haze_ratio = semi_pixels / len(bbox_alpha)
                if haze_ratio > MAX_HAZE_RATIO:
                    results.append({"slug": slug, "status": "rejected", "reason": f"excessive ghosting/haze ({haze_ratio:.0%})"})
                    rejected += 1
                    path.unlink()
                    print(f"  REJECT {slug} (haze {haze_ratio:.0%})")
                    continue

            final.save(path, "WEBP", quality=88, method=6)
            results.append({"slug": slug, "status": "accepted"})
            accepted += 1
            print(f"  OK     {slug}")
        except Exception as e:
            results.append({"slug": slug, "status": "error", "error": str(e)})
            rejected += 1
            print(f"  ERROR  {slug}: {e}")

    report = {"processed": len(webps), "accepted": accepted, "rejected": rejected, "results": results}

    # Merge with existing report (keep failed entries from original pipeline)
    if REPORT.exists():
        existing = json.loads(REPORT.read_text())
        existing_failed = [r for r in existing.get("results", []) if r.get("status") == "failed"]
        report["original_pipeline_failed"] = len(existing_failed)

    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(f"\nDone: {accepted} accepted, {rejected} rejected out of {len(webps)}")
    return report


if __name__ == "__main__":
    process_all()
