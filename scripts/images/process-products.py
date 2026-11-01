"""Offline, resumable product cut-outs. App runtime never imports rembg.

python -m venv <outside-app-venv>
<venv-python> -m pip install "rembg[cpu]"
<venv-python> scripts/images/process-products.py

See README.md for download-only/offline operation, review and licensing.
"""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def to_thumb_url(url: str, width: int = 960) -> str:
    """Convert a Wikimedia Commons full-size URL to a thumbnail URL to avoid 429s."""
    prefix = "https://upload.wikimedia.org/wikipedia/commons/"
    if not url.startswith(prefix) or "/thumb/" in url:
        return url
    rest = url[len(prefix):]
    filename = rest.rsplit("/", 1)[-1]
    ext = filename.rsplit(".", 1)[-1].lower()
    render_ext = "jpg" if ext in ("jpg", "jpeg", "tif", "tiff") else "png"
    return f"{prefix}thumb/{rest}/{width}px-{filename}" if ext in ("jpg", "jpeg", "png", "gif", "webp") else f"{prefix}thumb/{rest}/{width}px-{filename}.{render_ext}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=ROOT / "research/catalog/master-catalog.csv")
    parser.add_argument("--cache", type=Path, default=Path(tempfile.gettempdir()) / "storefront-image-sources")
    parser.add_argument("--offline", action="store_true", help="Use only previously downloaded originals/model")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    all_rows = list(csv.DictReader(args.catalog.open(encoding="utf-8-sig", newline="")))
    rows = all_rows
    if args.limit:
        rows = rows[:args.limit]
    output = ROOT / "public/images/products"
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = ROOT / "src/lib/storefront/catalog-media.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    catalog_id_to_keys = {}
    for key, entry in manifest.items():
        cid = entry.get("catalogId", "")
        catalog_id_to_keys.setdefault(cid, []).append(key)
    session = None
    results = []
    for row in rows:
        slug = row["id"]
        url = row.get("image_url", "")
        if not re.fullmatch(r"[a-z0-9-]+", slug):
            raise ValueError(f"Unsafe catalog id: {slug}")
        try:
            if not url:
                raise ValueError("No licensed source image")
            original = args.cache / (hashlib.sha256(url.encode()).hexdigest() + ".source")
            if not original.exists():
                if args.offline:
                    raise ValueError("Original not downloaded; rerun with --download-only online first")
                downloaded = False
                ua = {"User-Agent": "StorefrontCatalog/1.0 (offline product image preparation)"}
                for width in (960, 500, 250):
                    dl_url = to_thumb_url(url, width)
                    if dl_url == url:
                        break
                    request = urllib.request.Request(dl_url, headers=ua)
                    try:
                        with urllib.request.urlopen(request, timeout=45) as response:
                            original.write_bytes(response.read())
                        downloaded = True
                        break
                    except urllib.error.HTTPError as he:
                        if he.code in (400, 404):
                            continue
                        if he.code == 429:
                            time.sleep(10)
                            continue
                        raise
                if not downloaded:
                    request = urllib.request.Request(url, headers=ua)
                    with urllib.request.urlopen(request, timeout=45) as response:
                        original.write_bytes(response.read())
                time.sleep(1.0)
            if args.download_only:
                results.append({"slug": slug, "status": "downloaded"})
                continue
            from PIL import Image, ImageOps
            from rembg import new_session, remove
            if session is None:
                if args.offline and not (Path(os.environ.get("U2NET_HOME", Path.home() / ".u2net")) / "u2netp.onnx").exists():
                    raise ValueError("Offline model missing: download u2netp once before using --offline")
                session = new_session("u2netp")
            image = ImageOps.exif_transpose(Image.open(io.BytesIO(original.read_bytes()))).convert("RGBA")
            image.thumbnail((960, 960), Image.Resampling.LANCZOS)
            cutout = remove(image, session=session).convert("RGBA")
            alpha = cutout.getchannel("A")
            bbox = alpha.getbbox()
            if not bbox or alpha.getextrema()[0] == 255:
                raise ValueError("Empty or opaque segmentation: manual review required")
            cutout = cutout.crop(bbox)
            cutout.thumbnail((680, 680), Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", (800, 800), (0, 0, 0, 0))
            canvas.alpha_composite(cutout, ((800 - cutout.width) // 2, (800 - cutout.height) // 2))
            target = output / f"{slug}.webp"
            canvas.save(target, "WEBP", quality=88, method=6)
            if target.stat().st_size > 120_000:
                for q in (80, 72, 65):
                    canvas.save(target, "WEBP", quality=q, method=6)
                    if target.stat().st_size <= 120_000:
                        break
            with Image.open(target) as check:
                assert check.size == (800, 800) and "A" in check.getbands()
            for key in catalog_id_to_keys.get(slug, []):
                manifest[key]["imageUrl"] = f"/images/products/{slug}.webp"
            results.append({"slug": slug, "status": "processed", "bytes": target.stat().st_size})
            print(f"Processed {slug}", flush=True)
        except Exception as error:
            results.append({"slug": slug, "status": "failed", "error": str(error)})
            print(f"Failed {slug}: {error}", flush=True)
    if not args.download_only:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        credits = ROOT / "public/images/CREDITS.md"
        previous = credits.read_text(encoding="utf-8-sig").split("## Phase 3 product cut-outs")[0]
        existing = [row for row in all_rows if (output / f"{row['id']}.webp").exists()]
        note = "800px WebP with alpha. Background removed; resized. ShareAlike derivatives retain the source license. Review segmentation before publication." if existing else "No alpha WebP outputs have been produced yet. Original backgrounds remain; source attribution above still applies."
        lines = ["## Phase 3 product cut-outs", "", note, "", "| Product | Source / author | License | Changes |", "|---|---|---|---|"]
        for row in all_rows:
            if (output / f"{row['id']}.webp").exists():
                lines.append(f"| {row['id']} | [{row['image_author']}]({row['image_source_page']}) | {row['image_license']} | Background removed; resized to 800px |")
        credits.write_text(previous.rstrip() + "\n\n" + "\n".join(lines) + "\n", encoding="utf-8")
    report = {"processed": sum(r["status"] == "processed" for r in results), "failed": sum(r["status"] == "failed" for r in results), "results": results}
    (ROOT / "scripts/images/processing-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "results"}))
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
