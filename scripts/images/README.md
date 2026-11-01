# Offline product imagery

The requested source CSV was absent from this checkout. `research/catalog/master-catalog.csv` is reconstructed from the existing catalog manifest, with replacement Commons ingredient/packaging photographs verified via Commons imageinfo metadata. It is a source register, not a claim to have recovered the missing original research.

Create a throwaway venv outside the app, then follow the [upstream rembg README](https://github.com/danielgatis/rembg):

```powershell
python -m venv "$env:TEMP\storefront-rembg"
& "$env:TEMP\storefront-rembg\Scripts\python.exe" -m pip install "rembg[cpu]"
& "$env:TEMP\storefront-rembg\Scripts\python.exe" scripts/images/process-products.py
```

The processor downloads source originals to a temp cache, reuses one small `u2netp` CPU model session, removes backgrounds, centers the subject on an 800 × 800 transparent canvas, writes WebP, updates the existing catalog manifest used by the seed and all storefront projections, and appends attribution with “background removed” to CREDITS.md. It never adds rembg to app dependencies. CSS supplies contact shadows, leaving the actual WebP alpha clean.

`--download-only` caches original sources without importing rembg. `--offline` requires those originals and the previously downloaded model. `--cache <path>` selects a cache. `--limit 3` allows a small first pass. Failed entries retain their usable source URL; output includes an exact processing report. Do not treat a successful segmentation as visual approval: inspect edges and remove any bad output before rerunning. Representative grain/flour photos are not verified brand packshots.

This sandbox failed creating the outside-app venv during ensurepip with PermissionError. No background removal is claimed until the processor actually succeeds. Existing product photos render with object-contain on store-tinted tiles.

For seeding an existing server, set `STOREFRONT_REVALIDATION_URL` to its `/api/storefront/revalidate` URL and use the same strong `STOREFRONT_REVALIDATION_SECRET` on the seed and server. The seed calls this after listing/banner/collection writes. Without a running server, reads have a 60-second freshness fallback and deployment-specific cache keys.
