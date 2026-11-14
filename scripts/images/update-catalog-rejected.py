"""Update catalog-media.json: replace deleted WebP paths with source photo URLs."""
import json, hashlib, re, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "scripts" / "images" / "processing-report.json"
CATALOG = ROOT / "src" / "lib" / "storefront" / "catalog-media.json"

report = json.loads(REPORT.read_text())
catalog = json.loads(CATALOG.read_text())

rejected_slugs = {r["slug"] for r in report["results"] if r["status"] == "rejected"}
print(f"Rejected slugs: {len(rejected_slugs)}")


def wiki_source_to_direct(source_url: str) -> str | None:
    m = re.search(r"File:(.+)$", source_url)
    if not m:
        return None
    filename = urllib.parse.unquote(m.group(1)).replace(" ", "_")
    md5 = hashlib.md5(filename.encode()).hexdigest()
    return f"https://upload.wikimedia.org/wikipedia/commons/{md5[0]}/{md5[:2]}/{urllib.parse.quote(filename)}"


updated = 0
for key, entry in catalog.items():
    cid = entry.get("catalogId", "")
    if cid in rejected_slugs and entry.get("imageUrl", "").startswith("/images/products/"):
        source = entry.get("source", "")
        direct = wiki_source_to_direct(source)
        if direct:
            entry["imageUrl"] = direct
            print(f"  {cid}: -> {direct[:90]}...")
            updated += 1
        else:
            entry.pop("imageUrl", None)
            print(f"  {cid}: no source, removed imageUrl")
            updated += 1

CATALOG.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
print(f"\nUpdated {updated} entries in catalog-media.json")
