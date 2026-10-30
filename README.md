# Lawrence Value per Acre

3D MapLibre map of **Lawrence, Kansas** showing **appraised value per acre** by parcel, plus zoning, census, and building layers.

**Live site:** https://lawrence-vpa.pages.dev/

## What the map shows

Each Lawrence parcel is colored (and extruded in 3D) by:

```text
value_per_acre = total_appraised_value / acres
```

using **2026** Douglas County Appraiser totals (`RP_AprTot`). Popups show appraised value, $/acre, property class, acres, and situs — **no owner names**.

Inspired by Urban3-style value-per-acre maps and tools like [Pracre](https://pracre.org). **Not affiliated** with Urban3, Pracre, or Strong Towns.

## Method

1. Join county `PropertyNumber` → map parcel ID (exact string match).
2. **Match rate: 99.97%** (27,834 / 27,842 map parcels). **8 unmatched.**
3. Acres: prefer county `vproplevel_TotalAcres` when &gt; 0; otherwise fall back to Tax_Parcel / geometry acres (**868** matched parcels used the fallback when county acres were 0).
4. Land vs. improvement is **not** broken out in the county file (total only).
5. 3D height is proportional to the metric, then **capped at the 99.5th percentile** (default max extrusion ~1,400 m at 1.0×) so outliers stay on screen. **Legend colors and popups use true uncapped values.**

## Data sources

| Layer | Provenance |
|-------|------------|
| **Appraised values** | Douglas County Appraiser's Office, **2026** values (`DgCo2026Values.xlsx`). Received **2026-10-30** via a free **Kansas Open Records Act (KORA)** request answered by County Appraiser **Brad Eldridge** (no fee). Columns include parcel ID, appraised total, assessed total, class, tax unit, acres. **No owner names.** |
| Parcel polygons | Douglas County GIS **Tax_Parcel** |
| Zoning | City of Lawrence **EPL FeatureServer** |
| Median home value | ACS **B25077** via [Census Reporter](https://censusreporter.org/) |
| Population density | **2020 Census** block groups (Douglas County GIS) |
| Building footprints | [Microsoft Building Footprints](https://github.com/microsoft/USBuildingFootprints) via Esri Living Atlas |
| Basemap | [OpenFreeMap](https://openfreemap.org/) / OpenStreetMap |

## Limitations

- Public-record appraisals, not sale prices or tax bills.
- Total appraised value only (no land/improvement split in this release).
- Tiny or zero-county-acre parcels can produce extreme $/acre; height is capped for display.
- Independent civic project — not an official city/county product.

## Site pages

- **Map** — interactive 3D view (rotate: right-drag, Q/E, Shift+arrows, on-screen buttons, compass)
- **About** — what value per acre means here
- **Methodology** — join, acres, height cap
- **Data** — sources and KORA provenance
- **Findings** — citywide medians and class summaries
- **FAQ**

## Run locally

```bash
python3 -m http.server -d site 8080
# open http://localhost:8080
```

Optional data scripts (Python 3):

```bash
python3 scripts/download_parcels.py   # GIS → data/raw/
python3 scripts/process_data.py       # historically DEMO; prefer join from xlsx
# Joined site data in this repo was built from DgCo2026Values.xlsx
```

Deployable tree is `site/` (static). Production is Cloudflare Pages project `lawrence-vpa`.

## License

- **Code:** MIT (see `LICENSE`)
- **Data:** Public record / open data from the publishers above; their terms apply

## Credits

Douglas County Appraiser's Office; Douglas County GIS; City of Lawrence; Census Reporter / ACS; Microsoft Building Footprints; MapLibre; OpenFreeMap / OSM contributors.
