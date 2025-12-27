import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";

import L from "leaflet";
import "leaflet-draw";

const resultsEl = document.getElementById("results");

// Create map
const map = L.map("map").setView([39.8283, -98.5795], 4);

// Basemap (dev only; switch to MapTiler later)
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors"
}).addTo(map);

// FEMA NFHL WMS overlay (Flood Hazard Zones layer = 28)
L.tileLayer.wms(
  "https://hazards.fema.gov/arcgis/rest/services/public/NFHLWMS/MapServer/WMSServer",
  {
    layers: "28",
    format: "image/png",
    transparent: true,
    attribution: "FEMA NFHL"
  }
).addTo(map);

// AOI draw
const drawn = new L.FeatureGroup();
map.addLayer(drawn);

map.addControl(new L.Control.Draw({
  draw: {
    polygon: true,
    rectangle: true,
    circle: false,
    circlemarker: false,
    marker: false,
    polyline: false
  },
  edit: { featureGroup: drawn }
}));

document.getElementById("go").addEventListener("click", async () => {
  const q = document.getElementById("addr").value.trim();
  if (!q) return;

  resultsEl.textContent = "Searching address...";
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const r = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  const data = await r.json();

  if (!data?.length) {
    resultsEl.textContent = "No match found.";
    return;
  }

  const lat = Number(data[0].lat);
  const lon = Number(data[0].lon);
  map.setView([lat, lon], 15);
  resultsEl.textContent = "Now draw an AOI polygon/rectangle on the map.";
});

map.on(L.Draw.Event.CREATED, (e) => {
  drawn.clearLayers();
  drawn.addLayer(e.layer);

  const b = e.layer.getBounds();
  resultsEl.innerHTML = `
    <div><b>AOI captured.</b></div>
    <div>West: ${b.getWest().toFixed(6)}</div>
    <div>South: ${b.getSouth().toFixed(6)}</div>
    <div>East: ${b.getEast().toFixed(6)}</div>
    <div>North: ${b.getNorth().toFixed(6)}</div>
    <div style="margin-top:10px;">Next: add FEMA NFHL query to return SFHA and zone attributes.</div>
  `;
});

