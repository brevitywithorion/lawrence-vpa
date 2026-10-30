#!/usr/bin/env python3
"""Simplify geometries, attach DEMO appraised values, emit site GeoJSON + CSV template."""
from __future__ import annotations

import csv
import json
import math
import random
from pathlib import Path

from shapely.geometry import shape, mapping, Point, box
from shapely.validation import make_valid
from shapely.ops import transform

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PROC = ROOT / "data" / "processed"
SITE = ROOT / "site" / "data"
PROC.mkdir(parents=True, exist_ok=True)
SITE.mkdir(parents=True, exist_ok=True)

SEED = 42
# Downtown Lawrence — Massachusetts St & 8th-ish
DOWNTOWN = Point(-95.2354, 38.9707)
# Mass St corridor axis (approx N-S)
MASS_LON = -95.2354

DEMO_BANNER = "DEMO DATA, not real appraisals"


def simplify_geom(g, tol):
    g = make_valid(g)
    if g.is_empty:
        return g
    s = g.simplify(tol, preserve_topology=True)
    if s.is_empty or s.area == 0:
        return g
    return s


def acres_of(props, geom):
    for key in ("SYSCALACRES", "syscalacres", "acres"):
        v = props.get(key)
        if v is not None:
            try:
                a = float(v)
                if a > 0:
                    return a
            except (TypeError, ValueError):
                pass
    # geodesic-ish approx: 1 deg^2 lat ~ 69^2 mi^2; at lat 39
    # better: use equal-area approx — 1m^2 via local projection rough
    # Web mercator meters / 4046.86
    try:
        # simple equirectangular m^2 near Lawrence
        lat = geom.centroid.y
        m_per_deg_lat = 111_320.0
        m_per_deg_lon = 111_320.0 * math.cos(math.radians(lat))
        area_m2 = geom.area * m_per_deg_lat * m_per_deg_lon
        return max(area_m2 / 4046.8564224, 0.001)
    except Exception:
        return 0.001


def dummy_value(acres: float, lon: float, lat: float, rng: random.Random) -> float:
    """Seeded synthetic appraised value. Higher near downtown / Mass St; modest size scaling."""
    dist_km = math.hypot((lon - DOWNTOWN.x) * 85.0, (lat - DOWNTOWN.y) * 111.0)  # rough km
    # proximity: 1.0 at center → ~0.15 at 8km+
    prox = 0.15 + 0.85 * math.exp(-dist_km / 2.2)
    # Mass St corridor bonus (within ~0.4 km E-W of Mass)
    mass_dist = abs(lon - MASS_LON) * 85.0
    corridor = 1.0 + 0.55 * math.exp(-mass_dist / 0.25) * math.exp(-abs(lat - DOWNTOWN.y) * 111.0 / 1.5)
    # Land value often concentrates on small lots: value scales sub-linearly with acres
    # so $/acre is higher downtown on tiny parcels
    size = max(acres, 0.01) ** 0.62
    # Base ~$180k/acre equivalent at downtown for a typical lot, scaled
    base_per_acre = 165_000.0
    noise = rng.uniform(0.72, 1.35)
    # slight bump for very small urban lots
    small_lot = 1.0 + (0.35 if acres < 0.15 else 0.0)
    value = base_per_acre * size * prox * corridor * noise * small_lot
    # floor / ceiling
    return float(max(5_000.0, min(value, 25_000_000.0)))


def load_fc(path: Path):
    return json.loads(path.read_text())


def write_fc(path: Path, features):
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print(f"  {path.name}: {len(features)} feats, {path.stat().st_size/1e6:.2f} MB")


def process_parcels():
    print("Parcels…")
    fc = load_fc(RAW / "parcels_lawrence.geojson")
    rng = random.Random(SEED)
    out = []
    csv_rows = []
    for f in fc["features"]:
        props = f.get("properties") or {}
        try:
            g = simplify_geom(shape(f["geometry"]), 0.00004)  # ~4m
        except Exception:
            continue
        if g.is_empty:
            continue
        # keep only Polygon/MultiPolygon
        if g.geom_type not in ("Polygon", "MultiPolygon"):
            if g.geom_type == "GeometryCollection":
                polys = [x for x in g.geoms if x.geom_type in ("Polygon", "MultiPolygon") and not x.is_empty]
                if not polys:
                    continue
                from shapely.ops import unary_union
                g = unary_union(polys)
            else:
                continue
        pid = props.get("PID") or props.get("JOINPIN") or props.get("PARCELNUMBER") or str(props.get("OBJECTID"))
        acres = round(acres_of(props, g), 4)
        if acres < 0.005:
            continue
        c = g.centroid
        val = round(dummy_value(acres, c.x, c.y, rng), 2)
        vpa = round(val / acres, 2) if acres > 0 else 0.0
        if vpa > 2_500_000:
            vpa = 2_500_000.0
        new_props = {
            "parcel_id": pid,
            "acres": acres,
            "appraised_value": val,
            "value_per_acre": vpa,
            "txunit": props.get("txunit"),
            "situs": props.get("situs") or props.get("address"),
            "demo": True,
            "demo_note": DEMO_BANNER,
        }
        out.append({"type": "Feature", "properties": new_props, "geometry": mapping(g)})
        csv_rows.append({"parcel_id": pid, "appraised_value": val})

    write_fc(PROC / "parcels_demo.geojson", out)
    write_fc(SITE / "parcels.geojson", out)

    # CSV template + demo CSV
    demo_csv = PROC / "values_demo.csv"
    template_csv = PROC / "values_template.csv"
    with demo_csv.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["parcel_id", "appraised_value"])
        w.writeheader()
        w.writerows(csv_rows)
    with template_csv.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["parcel_id", "appraised_value"])
        w.writeheader()
        w.writerow({"parcel_id": "023-000-00-0-00-00-000.00-0", "appraised_value": 250000})
    print(f"  CSV demo rows: {len(csv_rows)}")
    return len(out)


def process_zoning():
    print("Zoning…")
    src = RAW / "zoning_lawrence.geojson"
    if not src.exists():
        print("  skip"); return 0
    fc = load_fc(src)
    # clip-ish: keep those intersecting Lawrence bbox
    lawrence = make_valid(shape(load_fc(RAW / "lawrence_limits.geojson")["features"][0]["geometry"]))
    out = []
    for f in fc["features"]:
        props = f.get("properties") or {}
        try:
            g = simplify_geom(shape(f["geometry"]), 0.00005)
        except Exception:
            continue
        if g.is_empty or not g.intersects(lawrence):
            continue
        inter = g.intersection(lawrence)
        if inter.is_empty:
            continue
        zone = props.get("ZoningDistrict") or props.get("ZONECLASS") or "Unknown"
        out.append({
            "type": "Feature",
            "properties": {"zone": zone, "pud": props.get("PUD_CLASS"), "source": "City of Lawrence EPL Zoning"},
            "geometry": mapping(inter if inter.geom_type in ("Polygon", "MultiPolygon") else g),
        })
    write_fc(PROC / "zoning.geojson", out)
    write_fc(SITE / "zoning.geojson", out)
    return len(out)


def process_tracts():
    print("Tracts ACS…")
    fc = load_fc(RAW / "tracts_acs.geojson")
    lawrence = make_valid(shape(load_fc(RAW / "lawrence_limits.geojson")["features"][0]["geometry"]))
    out = []
    for f in fc["features"]:
        props = dict(f.get("properties") or {})
        try:
            g = make_valid(shape(f["geometry"]))
        except Exception:
            continue
        if not g.intersects(lawrence):
            continue
        inter = g.intersection(lawrence)
        if inter.is_empty:
            continue
        # area acres for density
        acres = acres_of({}, inter)
        pop = props.get("population") or 0
        props["pop_density_per_acre"] = round((pop / acres), 3) if acres else None
        props["source"] = "ACS 5-year via Census Reporter (B25077, B01003)"
        props["real_data"] = True
        out.append({"type": "Feature", "properties": props, "geometry": mapping(inter)})
    write_fc(PROC / "tracts_acs.geojson", out)
    write_fc(SITE / "tracts.geojson", out)
    return len(out)


def process_block_groups():
    print("Block groups…")
    fc = load_fc(RAW / "block_groups.geojson")
    lawrence = make_valid(shape(load_fc(RAW / "lawrence_limits.geojson")["features"][0]["geometry"]))
    out = []
    for f in fc["features"]:
        props = f.get("properties") or {}
        try:
            g = make_valid(shape(f["geometry"]))
        except Exception:
            continue
        if not g.intersects(lawrence):
            continue
        inter = simplify_geom(g.intersection(lawrence), 0.00008)
        if inter.is_empty:
            continue
        acres = acres_of({}, inter)
        pop = float(props.get("P0010001") or 0)
        out.append({
            "type": "Feature",
            "properties": {
                "geoid": props.get("GEOID20"),
                "population": pop,
                "acres": round(acres, 3),
                "pop_density_per_acre": round(pop / acres, 3) if acres else 0,
                "source": "2020 Census (Douglas County GIS block groups)",
                "real_data": True,
            },
            "geometry": mapping(inter),
        })
    write_fc(PROC / "block_groups.geojson", out)
    write_fc(SITE / "block_groups.geojson", out)
    return len(out)


def process_buildings():
    print("Buildings…")
    src = RAW / "buildings_ms.geojson"
    if not src.exists():
        print("  skip"); return 0
    fc = load_fc(src)
    lawrence = make_valid(shape(load_fc(RAW / "lawrence_limits.geojson")["features"][0]["geometry"]))
    # slightly expand so edge buildings kept
    out = []
    for f in fc["features"]:
        try:
            g = simplify_geom(shape(f["geometry"]), 0.00003)
        except Exception:
            continue
        if g.is_empty or not g.intersects(lawrence):
            continue
        out.append({
            "type": "Feature",
            "properties": {"source": "Microsoft Building Footprints (Esri Living Atlas MSBFP2)", "real_data": True},
            "geometry": mapping(g),
        })
    write_fc(PROC / "buildings.geojson", out)
    write_fc(SITE / "buildings.geojson", out)
    return len(out)


def write_meta(counts: dict):
    meta = {
        "title": "Lawrence Value per Acre (DEMO)",
        "demo_banner": DEMO_BANNER,
        "seed": SEED,
        "counts": counts,
        "dummy_model": {
            "description": (
                "Synthetic appraised_value per parcel: base ~$165k/acre scaled by "
                "sub-linear acres^0.62, exponential decay with distance from downtown "
                "Massachusetts St (~8th & Mass), corridor bonus near Mass St, "
                "small-lot bump (<0.15 ac), and seeded uniform noise 0.72–1.35. "
                "value_per_acre = appraised_value / acres. NOT real appraisals."
            ),
            "seed": SEED,
        },
        "layers": {
            "parcels_demo": "DEMO synthetic values on real Douglas County parcel polygons",
            "zoning": "REAL — City of Lawrence zoning (EPL FeatureServer)",
            "tracts": "REAL — ACS median home value + population (Census Reporter)",
            "block_groups": "REAL — 2020 Census population density (Douglas County GIS)",
            "buildings": "REAL — Microsoft Building Footprints via Esri Living Atlas",
        },
    }
    (PROC / "meta.json").write_text(json.dumps(meta, indent=2))
    (SITE / "meta.json").write_text(json.dumps(meta, indent=2))


def main():
    counts = {
        "parcels": process_parcels(),
        "zoning": process_zoning(),
        "tracts": process_tracts(),
        "block_groups": process_block_groups(),
        "buildings": process_buildings(),
    }
    write_meta(counts)
    print("Done", counts)


if __name__ == "__main__":
    main()
