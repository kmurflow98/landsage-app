// Leaflet + Leaflet Draw styles (correct for your current stack)
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";

import L from "leaflet";
import "leaflet-draw";

// Optional: fix missing default marker icons in many Vite setups.
// (Not required for your current build, but safe.)
import marker2x from "leaflet/dist/images/marker-icon-2x.png";
import marker1x from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: marker2x,
  iconUrl: marker1x,
  shadowUrl: markerShadow,
});

const resultsEl = document.getElementById("results");
const addrEl = document.getElementById("addr");
const goBtn = document.getElementById("go");

/**
 * Leaflet sizing reliability: fixes “sliced/offset” rendering when the container
 * is resized by CSS/grid changes or initial layout timing.
 */
function attachLeafletSizingGuards(map) {
  function ensureLeafletSizes() {
    map.invalidateSize();
    requestAnimationFrame(() => map.invalidateSize());
  }
  window.addEventListener("load", ensureLeafletSizes);
  window.addEventListener("resize", ensureLeafletSizes);
  ensureLeafletSizes();
}

/**
 * FEMA NFHL attribute query (decision data).
 * This performs an ArcGIS Identify request on Layer 28 (Flood Hazard Zones)
 * using a point (AOI centroid). This is a screening method.
 */
async function nfhlIdentifyPoint(lat, lon) {
  // ArcGIS REST Identify endpoint for Layer 28 (Flood Hazard Zones)
  // Note: We use the NFHL MapServer (not the WMS) to get attributes.
  const base =
    "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/identify";

  // Identify requires “mapExtent” and “imageDisplay”. Provide a small dummy extent.
  const dx = 0.002;
  const dy = 0.002;

  const params = new URLSearchParams({
    f: "json",
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    mapExtent: `${lon - dx},${lat - dy},${lon + dx},${lat + dy}`,
    imageDisplay: "800,600,96",
    tolerance: "8",
    returnGeometry: "false",
    returnFieldName: "true",
  });

  const url = `${base}?${params.toString()}`;

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`NFHL identify failed (${r.status})`);
  return r.json();
}

/**
 * Helper: safely pick likely zone field names returned by FEMA service.
 */
function extractZone(attributes) {
  if (!attributes) return null;
  const candidates = ["FLD_ZONE", "ZONE", "fld_zone", "FLOOD_ZONE", "SFHA_TF"];
  for (const k of candidates) {
    if (attributes[k] != null && String(attributes[k]).trim() !== "") return attributes[k];
  }
  return null;
}

/**
 * Helper: SFHA screening rule-of-thumb:
 * Zones A/AE/AH/AO/AR/V/VE = SFHA
 * Zone X (shaded/unshaded) generally not SFHA, Zone D unknown
 */
function inferSfhaFromZone(zone) {
  if (!zone) return null;
  const z = String(zone).toUpperCase().trim();

  if (z === "D") return null;
  if (z.startsWith("A") || z.startsWith("V")) return true;
  if (z === "X") return false;

  // Some services return "0.2 PCT ANNUAL CHANCE FLOOD HAZARD" etc.
  // If it contains "0.2" or "500-YEAR", treat as non-SFHA screening.
  if (z.includes("0.2") || z.includes("500")) return false;

  return null;
}

// --------------------- Create map ---------------------
const map = L.map("map", { zoomControl: true }).setView([39.8283, -98.5795], 4);
attachLeafletSizingGuards(map);

// Basemap (OSM dev baseline; swap to MapTiler later)
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

// FEMA NFHL WMS overlay (Flood Hazard Zones layer = 28) – visualization only
L.tileLayer
  .wms("https://hazards.fema.gov/arcgis/rest/services/public/NFHLWMS/MapServer/WMSServer", {
    layers: "28",
    format: "image/png",
    transparent: true,
    attribution: "FEMA NFHL",
  })
  .addTo(map);

// AOI draw group
const drawn = new L.FeatureGroup();
map.addLayer(drawn);

map.addControl(
  new L.Control.Draw({
    draw: {
      polygon: true,
      rectangle: true,
      circle: false,
      circlemarker: false,
      marker: false,
      polyline: false,
    },
    edit: { featureGroup: drawn },
  })
);

// --------------------- Address search ---------------------
goBtn?.addEventListener("click", async () => {
  const q = addrEl?.value?.trim();
  if (!q) return;

  resultsEl.textContent = "Searching address...";

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  try {
    const r = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
    });

    if (!r.ok) {
      resultsEl.textContent = `Search failed (${r.status}). Try again.`;
      return;
    }

    const data = await r.json();
    if (!data?.length) {
      resultsEl.textContent = "No match found.";
      return;
    }

    const lat = Number(data[0].lat);
    const lon = Number(data[0].lon);

    map.setView([lat, lon], 15);
    resultsEl.textContent = "Now draw an AOI polygon/rectangle on the map.";
  } catch (err) {
    console.error(err);
    resultsEl.textContent = "Search error. Check console and try again.";
  }
});

// --------------------- AOI created ---------------------
map.on(L.Draw.Event.CREATED, async (e) => {
  drawn.clearLayers();
  drawn.addLayer(e.layer);

  const b = e.layer.getBounds();
  const center = b.getCenter();

  // Persist AOI geometry for later API usage
  const geojson = e.layer.toGeoJSON();
  localStorage.setItem("landsage:aoi", JSON.stringify(geojson));

  resultsEl.innerHTML = `
    <div><b>AOI captured.</b></div>
    <div>West: ${b.getWest().toFixed(6)}</div>
    <div>South: ${b.getSouth().toFixed(6)}</div>
    <div>East: ${b.getEast().toFixed(6)}</div>
    <div>North: ${b.getNorth().toFixed(6)}</div>
    <div style="margin-top:10px;">Querying FEMA NFHL for zone attributes…</div>
  `;

  try {
    const data = await nfhlIdentifyPoint(center.lat, center.lng);

    const first = data?.results?.[0] ?? null;
    const attrs = first?.attributes ?? null;
    const zone = extractZone(attrs);
    const sfha = inferSfhaFromZone(zone);

    // Some potential panel-ish fields (varies by layer/service)
    const panel =
      attrs?.DFIRM_ID ?? attrs?.PANEL ?? attrs?.FIRM_PAN ?? attrs?.FIRM_PANEL ?? "—";

    resultsEl.innerHTML = `
      <div><b>AOI captured.</b></div>

      <div style="margin-top:8px;"><b>Screening sample (AOI centroid)</b></div>
      <div>Lat/Lon: ${center.lat.toFixed(6)}, ${center.lng.toFixed(6)}</div>

      <hr />

      <div><b>NFHL Flood Hazard Zones (Layer 28)</b></div>
      <div><b>Zone:</b> ${zone ?? "No result at centroid"}</div>
      <div><b>SFHA (screening):</b> ${
        sfha === null ? "Unknown" : sfha ? "Yes" : "No"
      }</div>
      <div><b>Panel / DFIRM:</b> ${panel ?? "—"}</div>

      <div style="margin-top:10px; color:#555;">
        Source: FEMA NFHL ArcGIS REST (Identify). This is a centroid screening result; next upgrade is full AOI intersection and percent coverage by zone.
      </div>
    `;
  } catch (err) {
    console.error(err);
    resultsEl.innerHTML += `
      <div style="margin-top:10px; color:#b00020;">
        <b>Error:</b> NFHL attribute query failed. Open DevTools Console to see details.
      </div>
    `;
  }
});


