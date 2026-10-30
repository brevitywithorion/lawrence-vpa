#!/usr/bin/env python3
"""Join real appraised values onto parcels and rebuild site/data/parcels.geojson.

Preferred input: data/DgCo2026Values.xlsx (Douglas County Appraiser KORA file) OR
a CSV with: parcel_id,appraised_value[,assessed_value,prop_class,county_acres]

Usage:
  python3 scripts/join_from_xlsx.py   # preferred for the county xlsx
  python3 scripts/join_values.py data/processed/values_real.csv
"""
from __future__ import annotations
import csv, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE_PARCELS = ROOT / "site" / "data" / "parcels.geojson"
PROC = ROOT / "data" / "processed"
SOURCE = "Douglas County Appraiser's Office, 2026 values, via KORA request"

def main():
    if len(sys.argv) < 2:
        print("Usage: join_values.py path/to/values.csv", file=sys.stderr)
        sys.exit(2)
    csv_path = Path(sys.argv[1])
    values = {}
    with csv_path.open() as fh:
        for row in csv.DictReader(fh):
            pid = (row.get("parcel_id") or "").strip()
            try:
                values[pid] = float(row["appraised_value"])
            except (KeyError, ValueError, TypeError):
                continue
    print(f"Loaded {len(values)} values from {csv_path}")
    fc = json.loads(SITE_PARCELS.read_text())
    matched = 0
    for f in fc["features"]:
        pid = f["properties"].get("parcel_id")
        if pid in values:
            val = values[pid]
            acres = float(f["properties"].get("acres") or 0)
            f["properties"]["appraised_value"] = val
            f["properties"]["value_per_acre"] = round(val / acres, 2) if acres > 0 else None
            f["properties"]["demo"] = False
            f["properties"]["demo_note"] = None
            f["properties"]["value_source"] = SOURCE
            matched += 1
    out = PROC / "parcels_joined.geojson"
    text = json.dumps(fc, separators=(",", ":"))
    out.write_text(text)
    SITE_PARCELS.write_text(text)
    print(f"Matched {matched}/{len(fc['features'])}; wrote {SITE_PARCELS}")

if __name__ == "__main__":
    main()
