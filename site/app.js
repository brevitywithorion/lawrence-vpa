/* Lawrence VPA — Douglas County Appraiser 2026 values (KORA) */
const SOURCE_CREDIT = "Douglas County Appraiser's Office, 2026 values, via KORA request";

const VIEWS = {
  vpa: {
    kind: "parcel-numeric",
    prop: "value_per_acre",
    heightProp: "value_per_acre",
    heightScale: 0.000015,  // fallback only
    demo: false,
    note: "Default view: $/acre. Height and color use continuous log scaling so outliers taper (popups show true $/acre).",
    stops: null, // filled after load
    format: (v) => "$" + Math.round(v).toLocaleString() + "/ac",
  },
  total: {
    kind: "parcel-numeric",
    prop: "appraised_value",
    heightProp: "appraised_value",
    heightScale: 0.000041,  // fallback only
    demo: false,
    note: "Total appraised (log-scaled height/color so huge parcels don't flat-top). Popups show true dollars.",
    format: (v) => "$" + Math.round(v).toLocaleString(),
  },
  acres: {
    kind: "parcel-numeric",
    prop: "acres",
    heightProp: "acres",
    heightScale: 21.7,  // fallback only
    demo: false,
    note: "REAL parcel acreage with log-scaled height so giant lots don't dominate.",
    format: (v) => Number(v).toFixed(3) + " ac",
  },
  zoning: {
    kind: "categorical",
    source: "zoning",
    prop: "zone",
    demo: false,
    note: "REAL City of Lawrence zoning districts (EPL FeatureServer).",
  },
  medvalue: {
    kind: "choropleth",
    source: "tracts",
    prop: "median_home_value",
    demo: false,
    note: "REAL ACS 5-year median home value (B25077) via Census Reporter, clipped to city.",
    format: (v) => (v == null ? "n/a" : "$" + Math.round(v).toLocaleString()),
  },
  popdens: {
    kind: "choropleth",
    source: "block_groups",
    prop: "pop_density_per_acre",
    heightProp: "pop_density_per_acre",
    heightScale: 15.0,  // fallback only
    demo: false,
    note: "REAL 2020 Census population / acre (log-scaled height).",
    format: (v) => Number(v).toFixed(2) + " people/ac",
  },
  buildings: {
    kind: "buildings",
    source: "buildings",
    demo: false,
    note: "REAL Microsoft Building Footprints (Esri Living Atlas MSBFP2), clipped to Lawrence.",
  },
};

const ZONE_COLORS = {
  "R-1": "#f7e39a", "R-2": "#f0d060", "R-3": "#e0b020", "R-4": "#c99200", "R-5": "#a67400",
  "M-1": "#f4a6a6", "M-2": "#e87878", "M-3": "#d05050",
  "P-1": "#a8d4ff", "P-2": "#6eb0f0",
  "IL": "#c4b5fd", "IG": "#8b5cf6", "IBP": "#7c3aed",
  "CC": "#86efac", "CD": "#22c55e", "CN": "#4ade80",
  "PD": "#f9a8d4", "UR": "#94a3b8", "U": "#64748b", "RMG": "#fb923c", "RMG-UC": "#ea580c",
  "T5": "#2dd4bf",
};

const RAMP = ["#0d0887", "#6a00a8", "#b12a90", "#e16462", "#fca636", "#f0f921"];

function quantileStops(values, n = 5) {
  const v = values.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return [0, 1];
  const stops = [];
  for (let i = 0; i <= n; i++) {
    const q = i / n;
    const idx = Math.min(v.length - 1, Math.floor(q * (v.length - 1)));
    stops.push(v[idx]);
  }
  return [...new Set(stops)];
}

/** Continuous color: interpolate in log1p(value) space using log-spaced true-value stops. */
function colorExpr(prop, stops) {
  const input = ["ln", ["+", 1, ["max", 0, ["to-number", ["get", prop]]]]];
  const expr = ["interpolate", ["linear"], input];
  const n = Math.max(stops.length - 1, 1);
  for (let i = 0; i < stops.length; i++) {
    const v = Math.max(0, Number(stops[i]) || 0);
    const t = Math.log1p(v);
    const color = RAMP[Math.min(RAMP.length - 1, Math.round((i / n) * (RAMP.length - 1)))];
    expr.push(t, color);
  }
  return expr;
}

function money(n) {
  if (n == null || !isFinite(n)) return "—";
  return "$" + Math.round(n).toLocaleString();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: [-95.2354, 38.9637],
  zoom: 12.2,
  pitch: 40,
  bearing: -20,
  maxPitch: 70,
  hash: true,
  dragRotate: true,
  touchZoomRotate: true,
  touchPitch: true,
  pitchWithRotate: true,
});
// Desktop yaw: right-drag + Ctrl/Shift+left-drag; touch keeps two-finger rotate
map.dragRotate.enable();
map.touchZoomRotate.enable();
map.touchZoomRotate.enableRotation();
if (map.touchPitch) map.touchPitch.enable();
map.keyboard.enable();

map.addControl(new maplibregl.NavigationControl({
  showCompass: true,
  showZoom: true,
  visualizePitch: true,
}), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");

const YAW_STEP = 15;

function rotateBy(deltaDeg, opts = {}) {
  const duration = opts.duration ?? 250;
  map.easeTo({ bearing: map.getBearing() + deltaDeg, duration, easing: (x) => x });
}

function wireYawControls() {
  const left = document.getElementById("btnYawLeft");
  const right = document.getElementById("btnYawRight");
  if (left) left.addEventListener("click", () => rotateBy(-YAW_STEP));
  if (right) right.addEventListener("click", () => rotateBy(YAW_STEP));

  // Q/E and Shift+ArrowLeft/Right — skip when typing in form fields
  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.metaKey || e.altKey) return;
    let delta = 0;
    if (e.key === "q" || e.key === "Q") delta = -YAW_STEP;
    else if (e.key === "e" || e.key === "E") delta = YAW_STEP;
    else if (e.shiftKey && e.key === "ArrowLeft") delta = -YAW_STEP;
    else if (e.shiftKey && e.key === "ArrowRight") delta = YAW_STEP;
    else return;
    e.preventDefault();
    rotateBy(delta);
  });
}
wireYawControls();
window.__lawrenceMap = map;

const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "280px" });
let currentView = "vpa";
let hideTaxExempt = false;
const EXEMPT_FILTER_KEY = "lawrenceVpaHideExempt";
const PARCEL_FILTER_EXEMPT = ["!=", ["get", "prop_class"], "E"];

function applyParcelFilter() {
  const filter = hideTaxExempt ? PARCEL_FILTER_EXEMPT : null;
  for (const id of ["parcels-extrusion", "parcels-fill", "parcels-outline"]) {
    if (map.getLayer(id)) map.setFilter(id, filter);
  }
}

function setHideTaxExempt(on, { persist = true } = {}) {
  hideTaxExempt = !!on;
  const el = document.getElementById("hideExempt");
  if (el) el.checked = hideTaxExempt;
  if (persist) {
    try { localStorage.setItem(EXEMPT_FILTER_KEY, hideTaxExempt ? "1" : "0"); } catch (_) {}
  }
  if (map.getLayer("parcels-extrusion")) applyParcelFilter();
}

let parcelStops = {};
let heightMultiplier = 1.0; // default; slider 0.05–2×
let heightNorm = {}; // prop → { max, log1p_max, transform }
let heightTargetM = 1400; // meters for the dataset max at multiplier 1.0 (after log1p)
const HEIGHT_NOTE =
  "Height & color: continuous log scale (outliers taper; no flat cap). Popups show true values.";

/** log1p(value) / log1p(max) * targetM * multiplier — continuous, no plateau. */
function extrusionHeight(prop, fallbackScale) {
  const norm = heightNorm[prop];
  const raw = ["max", 0, ["to-number", ["get", prop]]];
  const logv = ["ln", ["+", 1, raw]];
  if (norm && norm.log1p_max > 0) {
    const scale = (heightTargetM / norm.log1p_max) * heightMultiplier;
    return ["*", logv, scale];
  }
  // fallback linear
  return ["*", raw, fallbackScale * heightMultiplier];
}

function setLegendNumeric(stops, formatter) {
  document.getElementById("legendBar").hidden = false;
  document.getElementById("legendCat").hidden = true;
  document.getElementById("legMin").textContent = formatter(stops[0]);
  document.getElementById("legMax").textContent = formatter(stops[stops.length - 1]);
  const note = document.getElementById("legendHeightNote");
  if (note) {
    note.hidden = false;
    note.textContent = HEIGHT_NOTE;
  }
}

function setLegendCategories(cats) {
  document.getElementById("legendBar").hidden = true;
  const el = document.getElementById("legendCat");
  el.hidden = false;
  el.innerHTML = cats
    .map(([z, c]) => `<span class="swatch" style="background:${escapeHtml(c)}"></span><span>${escapeHtml(z)}</span>`)
    .join("");
}

function hideAllDataLayers() {
  for (const id of [
    "parcels-extrusion", "parcels-fill", "parcels-outline",
    "zoning-fill", "zoning-outline",
    "tracts-fill", "tracts-outline",
    "bg-fill", "bg-outline", "bg-extrusion",
    "buildings-fill", "buildings-outline",
  ]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  }
}

function applyView(name) {
  currentView = name;
  const cfg = VIEWS[name];
  document.getElementById("viewNote").textContent = cfg.note;
  hideAllDataLayers();

  if (cfg.kind === "parcel-numeric") {
    const stops = parcelStops[cfg.prop];
    const color = colorExpr(cfg.prop, stops);
    map.setPaintProperty("parcels-extrusion", "fill-extrusion-color", color);
    map.setPaintProperty("parcels-extrusion", "fill-extrusion-height",
      extrusionHeight(cfg.heightProp, cfg.heightScale));
    map.setPaintProperty("parcels-fill", "fill-color", color);
    map.setLayoutProperty("parcels-extrusion", "visibility", map.getPitch() > 5 ? "visible" : "none");
    map.setLayoutProperty("parcels-fill", "visibility", map.getPitch() > 5 ? "none" : "visible");
    map.setLayoutProperty("parcels-outline", "visibility", "visible");
    applyParcelFilter();
    setLegendNumeric(stops, cfg.format);
  } else if (cfg.kind === "categorical") {
    const hn = document.getElementById("legendHeightNote");
    if (hn) hn.hidden = true;
    const match = ["match", ["get", "zone"]];
    const cats = Object.entries(ZONE_COLORS);
    for (const [z, c] of cats) match.push(z, c);
    match.push("#8899aa");
    map.setPaintProperty("zoning-fill", "fill-color", match);
    map.setLayoutProperty("zoning-fill", "visibility", "visible");
    map.setLayoutProperty("zoning-outline", "visibility", "visible");
    setLegendCategories(cats);
  } else if (name === "medvalue") {
    const feats = map.querySourceFeatures("tracts"); // may be empty before tiles; use precomputed
    const stops = parcelStops.median_home_value || [100000, 500000];
    const color = colorExpr("median_home_value", stops);
    map.setPaintProperty("tracts-fill", "fill-color", color);
    map.setLayoutProperty("tracts-fill", "visibility", "visible");
    map.setLayoutProperty("tracts-outline", "visibility", "visible");
    setLegendNumeric(stops, cfg.format);
  } else if (name === "popdens") {
    const stops = parcelStops.pop_density_per_acre || [0, 20];
    const color = colorExpr("pop_density_per_acre", stops);
    map.setPaintProperty("bg-extrusion", "fill-extrusion-color", color);
    map.setPaintProperty("bg-extrusion", "fill-extrusion-height",
      extrusionHeight("pop_density_per_acre", cfg.heightScale));
    map.setPaintProperty("bg-fill", "fill-color", color);
    map.setLayoutProperty("bg-extrusion", "visibility", map.getPitch() > 5 ? "visible" : "none");
    map.setLayoutProperty("bg-fill", "visibility", map.getPitch() > 5 ? "none" : "visible");
    map.setLayoutProperty("bg-outline", "visibility", "visible");
    setLegendNumeric(stops, cfg.format);
  } else if (cfg.kind === "buildings") {
    map.setLayoutProperty("buildings-fill", "visibility", "visible");
    map.setLayoutProperty("buildings-outline", "visibility", "visible");
    document.getElementById("legendBar").hidden = true;
    document.getElementById("legendCat").hidden = false;
    const hn = document.getElementById("legendHeightNote");
    if (hn) hn.hidden = true;
    document.getElementById("legendCat").innerHTML =
      `<span class="swatch" style="background:#f8d48b"></span><span>Building footprint</span>`;
  }
}

function featurePopup(e, kind) {
  const f = e.features && e.features[0];
  if (!f) return;
  const p = f.properties || {};
  let html = `<div class="popup">`;
  if (kind === "parcel") {
    html += `<div class="warn">${escapeHtml(SOURCE_CREDIT)}</div>`;
    html += `<h3>Parcel ${escapeHtml(p.parcel_id || "")}</h3><dl>
      <dt>Acres</dt><dd>${p.acres != null ? Number(p.acres).toFixed(3) : "—"}</dd>
      <dt>Appraised</dt><dd>${p.appraised_value != null ? money(+p.appraised_value) : "—"}</dd>
      <dt>$/acre</dt><dd>${p.value_per_acre != null ? money(+p.value_per_acre) : "—"}</dd>
      <dt>Class</dt><dd>${escapeHtml(p.prop_class || "—")}</dd>
      <dt>Situs</dt><dd>${escapeHtml(p.situs || "—")}</dd>
    </dl>`;
  } else if (kind === "zoning") {
    html += `<h3>Zoning ${escapeHtml(p.zone || "")}</h3><dl><dt>Source</dt><dd>${escapeHtml(p.source || "City of Lawrence")}</dd></dl>`;
  } else if (kind === "tract") {
    html += `<h3>Census tract ${escapeHtml(p.geoid || "")}</h3><dl>
      <dt>Median home value</dt><dd>${money(+p.median_home_value)}</dd>
      <dt>Population</dt><dd>${p.population != null ? Number(p.population).toLocaleString() : "—"}</dd>
      <dt>Source</dt><dd>ACS (Census Reporter)</dd>
    </dl>`;
  } else if (kind === "bg") {
    html += `<h3>Block group ${escapeHtml(p.geoid || "")}</h3><dl>
      <dt>Population</dt><dd>${Number(p.population).toLocaleString()}</dd>
      <dt>Density</dt><dd>${Number(p.pop_density_per_acre).toFixed(2)} / acre</dd>
      <dt>Source</dt><dd>2020 Census</dd>
    </dl>`;
  } else if (kind === "building") {
    html += `<h3>Building footprint</h3><dl><dt>Source</dt><dd>Microsoft Building Footprints</dd></dl>`;
  }
  html += `</div>`;
  popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
}

map.on("load", async () => {
  const meta = await fetch("data/meta.json").then((r) => r.json()).catch(() => ({}));

  // Precompute stops from meta counts + sample via fetching geojson properties only is heavy;
  // load parcels as source then compute from a lightweight stats endpoint — compute client-side from first paint.
  map.addSource("parcels", { type: "geojson", data: "data/parcels.geojson", generateId: true });
  map.addSource("zoning", { type: "geojson", data: "data/zoning.geojson" });
  map.addSource("tracts", { type: "geojson", data: "data/tracts.geojson" });
  map.addSource("block_groups", { type: "geojson", data: "data/block_groups.geojson" });
  map.addSource("buildings", { type: "geojson", data: "data/buildings.geojson" });

  map.addLayer({
    id: "parcels-extrusion",
    type: "fill-extrusion",
    source: "parcels",
    paint: {
      "fill-extrusion-color": "#888",
      "fill-extrusion-height": 0,
      "fill-extrusion-opacity": 0.92,
      "fill-extrusion-base": 0,
    },
  });
  map.addLayer({
    id: "parcels-fill",
    type: "fill",
    source: "parcels",
    layout: { visibility: "none" },
    paint: { "fill-color": "#888", "fill-opacity": 0.85 },
  });
  map.addLayer({
    id: "parcels-outline",
    type: "line",
    source: "parcels",
    paint: { "line-color": "rgba(0,0,0,0.25)", "line-width": 0.2 },
  });

  map.addLayer({
    id: "zoning-fill", type: "fill", source: "zoning",
    layout: { visibility: "none" },
    paint: { "fill-color": "#888", "fill-opacity": 0.75 },
  });
  map.addLayer({
    id: "zoning-outline", type: "line", source: "zoning",
    layout: { visibility: "none" },
    paint: { "line-color": "rgba(0,0,0,0.4)", "line-width": 0.4 },
  });

  map.addLayer({
    id: "tracts-fill", type: "fill", source: "tracts",
    layout: { visibility: "none" },
    paint: { "fill-color": "#888", "fill-opacity": 0.7 },
  });
  map.addLayer({
    id: "tracts-outline", type: "line", source: "tracts",
    layout: { visibility: "none" },
    paint: { "line-color": "#fff", "line-width": 1 },
  });

  map.addLayer({
    id: "bg-extrusion", type: "fill-extrusion", source: "block_groups",
    layout: { visibility: "none" },
    paint: { "fill-extrusion-color": "#888", "fill-extrusion-height": 0, "fill-extrusion-opacity": 0.85 },
  });
  map.addLayer({
    id: "bg-fill", type: "fill", source: "block_groups",
    layout: { visibility: "none" },
    paint: { "fill-color": "#888", "fill-opacity": 0.75 },
  });
  map.addLayer({
    id: "bg-outline", type: "line", source: "block_groups",
    layout: { visibility: "none" },
    paint: { "line-color": "#fff", "line-width": 0.8 },
  });

  map.addLayer({
    id: "buildings-fill", type: "fill", source: "buildings",
    layout: { visibility: "none" },
    paint: { "fill-color": "#f8d48b", "fill-opacity": 0.85 },
  });
  map.addLayer({
    id: "buildings-outline", type: "line", source: "buildings",
    layout: { visibility: "none" },
    paint: { "line-color": "#8a6914", "line-width": 0.3 },
  });

  // Compute quantile stops once parcels load
  map.on("data", (e) => {
    if (e.sourceId === "parcels" && e.isSourceLoaded && !parcelStops.value_per_acre) {
      const feats = map.querySourceFeatures("parcels");
      // querySourceFeatures may be tile-limited for geojson; fetch stats from a prebuilt file
    }
  });

  // Load stats via fetching geojson properties with a lightweight precomputed stats
  const stats = await fetch("data/stats.json").then((r) => r.json());
  parcelStops = stats;
  heightNorm = stats.height_norm || {};
  if (stats.height_target_m) heightTargetM = Number(stats.height_target_m) || heightTargetM;
  if (stats.height_note) {
    // legend uses HEIGHT_NOTE; stats.height_note is the longer prose
  }
  // Sync slider default UI (HTML default is 0.5)
  const heightSliderInit = document.getElementById("heightScale");
  if (heightSliderInit) {
    heightMultiplier = parseFloat(heightSliderInit.value) || 1.0;
    document.getElementById("heightLabel").textContent = heightMultiplier.toFixed(2) + "×";
  }
  // Tax-exempt (class E) omit toggle — shared with Findings via localStorage
  try { hideTaxExempt = localStorage.getItem(EXEMPT_FILTER_KEY) === "1"; } catch (_) {}
  const hideEl = document.getElementById("hideExempt");
  if (hideEl) {
    hideEl.checked = hideTaxExempt;
    hideEl.addEventListener("change", () => setHideTaxExempt(hideEl.checked));
  }
  applyParcelFilter();

  const viewSel = document.getElementById("view");
  if (viewSel) viewSel.value = "vpa";
  applyView("vpa");

  for (const [layer, kind] of [
    ["parcels-extrusion", "parcel"], ["parcels-fill", "parcel"],
    ["zoning-fill", "zoning"], ["tracts-fill", "tract"],
    ["bg-fill", "bg"], ["bg-extrusion", "bg"],
    ["buildings-fill", "building"],
  ]) {
    map.on("click", layer, (e) => featurePopup(e, kind));
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }

  document.getElementById("view").addEventListener("change", (e) => applyView(e.target.value));
  const heightSlider = document.getElementById("heightScale");
  const heightLabel = document.getElementById("heightLabel");
  const syncHeightUI = () => {
    heightMultiplier = parseFloat(heightSlider.value) || 1;
    heightLabel.textContent = heightMultiplier.toFixed(2) + "×";
    heightSlider.setAttribute("aria-valuenow", String(heightMultiplier));
    applyView(currentView);
  };
  heightSlider.addEventListener("input", syncHeightUI);
  document.getElementById("btn3d").addEventListener("click", () => {
    map.easeTo({ pitch: 40, duration: 600 });
    document.getElementById("btn3d").classList.add("active");
    document.getElementById("btn2d").classList.remove("active");
    setTimeout(() => applyView(currentView), 650);
  });
  document.getElementById("btn2d").addEventListener("click", () => {
    map.easeTo({ pitch: 0, duration: 600 });
    document.getElementById("btn2d").classList.add("active");
    document.getElementById("btn3d").classList.remove("active");
    setTimeout(() => applyView(currentView), 650);
  });

  const banner = document.querySelector(".banner");
  if (meta.source_credit) {
    banner.textContent = meta.source_credit + (meta.note ? " — " + meta.note.split(".")[0] + "." : "");
  } else if (meta.demo_banner) {
    banner.textContent = meta.demo_banner;
  }
  const chip = document.getElementById("sourceChip");
  if (chip && meta.source_credit) chip.textContent = "2026 Appraiser values · KORA";
});
