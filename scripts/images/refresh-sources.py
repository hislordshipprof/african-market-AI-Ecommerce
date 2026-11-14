"""Rebuild the missing source CSV from the existing manifest + reviewed Commons replacements."""
import csv
import html
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
REPLACEMENTS = {
    "semovita": "Durum wheat flour (2).jpg",
    "pounded yam flour": "Sun dried yam flour.jpg",
    "poundo yam": "Sun dried yam flour.jpg",
    "ofada rice": "Brown Rice.jpg",
    "suya spice": "Yaji pepper.jpg",
    "cow foot": "A prepared cow feet.jpg",
    "puff puff mix": "Wheat flour.jpg",
    "cameroon pepper": "Dried bush pepper.jpg",
    "dried hibiscus flowers": "Dried hibiscus flowers.jpg",
    "dried zobo leaves": "Dried hibiscus flowers.jpg",
    "palm oil": "PALM OIL BOTTLES.jpg",
    "maggi cubes": "Maggi Seasoning Cube.jpg",
    "peak milk": "Peak Milk 01.jpg",
    "malt drink": "Maltina Soft Drink.jpg",
    "tomato paste": "Tomato paste can.jpg",
    "coconut oil": "Coconut oil bottle in the background of coconuts from Kaleeswari Farm.jpg",
    "oxtail": "Raw oxtail-01.jpg",
}


def main():
    manifest_path = ROOT / "src/lib/storefront/catalog-media.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    evidence = {}
    for key, filename in REPLACEMENTS.items():
        if filename not in evidence:
            url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({"action": "query", "format": "json", "titles": "File:" + filename, "prop": "imageinfo", "iiprop": "url|extmetadata"})
            request = urllib.request.Request(url, headers={"User-Agent": "StorefrontCatalog/1.0 (attribution research)"})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.load(response)
            page = next(iter(data["query"]["pages"].values()))
            evidence[filename] = page["imageinfo"][0]
        info = evidence[filename]
        metadata = info["extmetadata"]
        plain = lambda key: html.unescape(re.sub("<[^>]+>", "", metadata.get(key, {}).get("value", ""))).strip()
        entry = manifest.setdefault(key, {"catalogId": re.sub("[^a-z0-9]+", "-", key), "localNames": "", "description": "A familiar ingredient for your next meal. Check the pack for origin, ingredients and storage."})
        entry.update(imageUrl=info["url"].split("?")[0], source=info["descriptionurl"], author=plain("Artist"), license=plain("LicenseShortName"))
        print(key + " | " + plain("ImageDescription")[:130] + " | " + entry["license"], flush=True)
    # Same raw ingredient, now correctly looked up for the ground variant as well.
    for field in ("imageUrl", "source", "author", "license"):
        manifest["ground crayfish"][field] = manifest["dried crayfish"][field]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (ROOT / "scripts/images/source-verification.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    grouped = {}
    for key, entry in manifest.items():
        slug = entry["catalogId"]
        if slug not in grouped:
            grouped[slug] = {"listing_slug": slug, "catalog_keys": [], "image_url": entry["imageUrl"], "source_page": entry["source"], "author": entry["author"], "license": entry["license"], "subject_kind": "ready-to-eat-product" if key in ("chin chin", "plantain chips", "kulikuli (groundnut cake)") else "ingredient"}
        grouped[slug]["catalog_keys"].append(key)
    target = ROOT / "research/catalog/master-catalog.csv"
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(next(iter(grouped.values())).keys()))
        writer.writeheader()
        for row in grouped.values():
            row["catalog_keys"] = "|".join(row["catalog_keys"])
            writer.writerow(row)
    print(f"Wrote {len(grouped)} unique product sources")


if __name__ == "__main__":
    main()
