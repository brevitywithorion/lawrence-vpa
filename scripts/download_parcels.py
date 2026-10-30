#!/usr/bin/env python3
"""Download Douglas County tax parcels intersecting Lawrence city limits."""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import requests
from shapely.geometry import shape, mapping, box
from shapely.ops import unary_union
from shapely.validation import make_valid
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
RAW.mkdir(parents=True, exist_ok=True)
PROCESSED.mkdir(parents=True, exist_ok=True)

LAYER = "https://gis.dgcoks.gov/server/rest/services/Tax_Parcel/MapServer/0/query"
OUT_FIELDS = "OBJECTID,PID,PARCELNUMBER,JOINPIN,SYSCALACRES,RECORDACRES,txunit,situs,address,city"
PAGE = 2000
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "lawrence-vpa-civic/0.1 (research; not commercial)"})


def load_lawrence_poly():
    fc = json.loads((RAW / "lawrence_limits.geojson").read_text())
    geoms = [make_valid(shape(f["geometry"])) for f in fc["features"]]
    return unary_union(geoms)


def fetch_page(envelope: dict, offset: int) -> dict:
    params = {
        "geometry": json.dumps(envelope),
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": OUT_FIELDS,
        "returnGeometry": "true",
        "outSR": 4326,
        "f": "geojson",
        "resultOffset": offset,
        "resultRecordCount": PAGE,
        "orderByFields": "OBJECTID ASC",
    }
    for attempt in range(5):
        r = SESSION.get(LAYER, params=params, timeout=120)
        if r.status_code == 200:
            return r.json()
        time.sleep(1.5 * (attempt + 1))
    r.raise_for_status()
    return r.json()


def main():
    lawrence = load_lawrence_poly()
    minx, miny, maxx, maxy = lawrence.bounds
    # small pad so edge parcels aren't missed before clip
    pad = 0.002
    envelope = {
        "xmin": minx - pad,
        "ymin": miny - pad,
        "xmax": maxx + pad,
        "ymax": maxy + pad,
        "spatialReference": {"wkid": 4326},
    }

    count_params = {
        "geometry": json.dumps(envelope),
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        "returnCountOnly": "true",
        "f": "json",
    }
    total = SESSION.get(LAYER, params=count_params, timeout=60).json()["count"]
    print(f"Server count in padded bbox: {total}", flush=True)

    features = []
    offset = 0
    with tqdm(total=total, desc="download") as bar:
        while offset < total:
            data = fetch_page(envelope, offset)
            batch = data.get("features") or []
            if not batch:
                break
            features.extend(batch)
            offset += len(batch)
            bar.update(len(batch))
            if len(batch) < PAGE:
                break
            time.sleep(0.15)

    raw_path = RAW / "parcels_bbox.geojson"
    raw_path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    print(f"Wrote {len(features)} features -> {raw_path}", flush=True)

    # Clip to city limits; keep parcels that meaningfully intersect
    clipped = []
    skipped = 0
    for f in tqdm(features, desc="clip"):
        try:
            g = make_valid(shape(f["geometry"]))
        except Exception:
            skipped += 1
            continue
        if g.is_empty:
            skipped += 1
            continue
        inter = g.intersection(lawrence)
        if inter.is_empty:
            continue
        # drop tiny edge slivers (< ~50 sq ft in degrees^2 rough; use area ratio)
        if inter.area < g.area * 0.05 and inter.area < 1e-8:
            continue
        props = dict(f.get("properties") or {})
        # drop owner PII from published layer
        for k in list(props):
            if k.lower().startswith("owner"):
                props.pop(k, None)
        props["clipped"] = True
        clipped.append({"type": "Feature", "properties": props, "geometry": mapping(inter)})

    out = {"type": "FeatureCollection", "features": clipped}
    out_path = RAW / "parcels_lawrence.geojson"
    out_path.write_text(json.dumps(out))
    print(f"Clipped to Lawrence: {len(clipped)} (skipped bad geom {skipped}) -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
