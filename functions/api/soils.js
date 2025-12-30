import { arcgisToGeoJSON } from "@terraformer/arcgis";

/**
 * Indiana SSURGO Soil Map Units (polygon layer).
 * If you want to swap to a county GIS service later, just replace this URL.
 *
 * Must be a FeatureServer layer query endpoint:
 *   .../FeatureServer/<layerId>/query
 */
const DEFAULT_SOILS_QUERY_URL =
  "https://gisdata.in.gov/server/rest/services/Hosted/Soil_Map_Units_SSURGO/FeatureServer/4/query";

/** Hard cap to prevent runaway response sizes */
const MAX_FEATURES_TOTAL = 20000;

/** ArcGIS max record count is typically 2000; keep it conservative */
const PAGE_SIZE = 2000;

/** Fetch timeout (ms) for upstream ArcGIS request */
const UPSTREAM_TIMEOUT_MS = 15000;

/**
 * Convert incoming GeoJSON Feature / Geometry into ESRI polygon geometry with WKID 4326.
 * We accept Polygon and MultiPolygon.
 */
function toEsriPolygonFromGeoJSON(input) {
  if (!input) throw new Error("Missing geometry");

  const g = input.type === "Feature" ? input.geometry : input;

  let rings = null;

  if (g.type === "Polygon") rings = g.coordinates;
  if (g.type === "MultiPolygon") {
    // v0 policy: if multipolygon, use the first polygon’s rings
    // (You can expand to union/iterate later.)
    rings = g.coordinates[0];
  }

  if (!rings) throw new Error("Geometry must be Polygon or MultiPolygon");

  return {
    rings,
    spatialReference: { wkid: 4326 },
  };
}

/**
 * A few “consulting-friendly” boolean flags derived from common SSURGO fields.
 * These fields can be null/undefined depending on data coverage.
 */
function deriveFlags(props) {
  const dr = (props?.drclassdcd || "").toUpperCase(); // drainage class
  const hydric = (props?.hydclprs || "").toString().toLowerCase(); // hydric likelihood (often Yes/No/%)
  const flod = (props?.flodfreqdcd || "").toUpperCase(); // flooding frequency
  const pond = (props?.pondfreqprs || "").toString().toLowerCase(); // ponding frequency

  const poorDrainage =
    dr.includes("POORLY") || dr.includes("VERY POORLY") || dr.includes("SOMEWHAT POORLY");

  const hydricLikely =
    hydric === "yes" ||
    hydric === "y" ||
    hydric.includes("hydric") ||
    hydric.includes("%") || // many services store percent-like strings
    hydric.includes("likely");

  const floodingRisk =
    flod.includes("FREQUENT") || flod.includes("OCCASIONAL") || flod.includes("COMMON");

  const pondingRisk =
    pond.includes("FREQUENT") || pond.includes("OCCASIONAL") || pond.includes("COMMON");

  return {
    poorDrainage,
    hydricLikely,
    floodingRisk,
    pondingRisk,
  };
}

/**
 * Fetch with timeout using AbortController (Cloudflare Workers compatible).
 */
async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Query ArcGIS FeatureServer in pages until exhausted or cap reached.
 */
async function querySoilsPaged({ queryUrl, esriGeom, outFields }) {
  let allFeatures = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      f: "json",
      where: "1=1",
      geometry: JSON.stringify(esriGeom),
      geometryType: "esriGeometryPolygon",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      returnGeometry: "true",
      outFields,
      resultRecordCount: String(PAGE_SIZE),
      resultOffset: String(offset),
    });

    const url = `${queryUrl}?${params.toString()}`;
    const resp = await fetchWithTimeout(url, UPSTREAM_TIMEOUT_MS);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Soils upstream failed (${resp.status}): ${text}`);
    }

    const arc = await resp.json();
    const page = arc?.features || [];

    allFeatures = allFeatures.concat(page);

    if (allFeatures.length > MAX_FEATURES_TOTAL) {
      throw new Error(
        `Soils result too large (>${MAX_FEATURES_TOTAL} features). Reduce AOI size or implement geometry simplification.`
      );
    }

    const exceeded = Boolean(arc?.exceededTransferLimit);
    const gotFullPage = page.length === PAGE_SIZE;

    // If ArcGIS tells us we exceeded transfer limit, keep paging.
    // If we got fewer than PAGE_SIZE, we’re done.
    // Some services don’t set exceededTransferLimit reliably; this double-check helps.
    if (!exceeded && !gotFullPage) break;

    offset += PAGE_SIZE;
  }

  return allFeatures;
}

export async function onRequest(context) {
  try {
    // Health check (useful for browser testing)
    if (context.request.method === "GET") {
      return new Response(
        JSON.stringify({
          status: "ok",
          endpoint: "/api/soils",
          methods: ["GET", "POST"],
          note: "POST GeoJSON Polygon/MultiPolygon in { geometry: ... } to retrieve soils.",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (context.request.method !== "POST") {
      return new Response("Use POST", { status: 405 });
    }

    const body = await context.request.json();
    const { geometry } = body || {};
    const esriGeom = toEsriPolygonFromGeoJSON(geometry);

    // Allow overriding the service URL via environment variable (optional)
    const envUrl = context.env?.SOILS_QUERY_URL;
    const queryUrl = (envUrl && String(envUrl).trim()) || DEFAULT_SOILS_QUERY_URL;

    // Broad but useful fields for immediate consulting value.
    // If your upstream service lacks some, it will just return nulls.
    const outFields = [
      "mukey",
      "musym",
      "muname",
      "hydgrpdcd",
      "hydclprs",
      "drclassdcd",
      "wtdepannmin",
      "wtdepaprjunmin",
      "flodfreqdcd",
      "pondfreqprs",
      "engstafdcd",
      "engstafll",
      "engstafml",
      "wss_link",
    ].join(",");

    const arcFeatures = await querySoilsPaged({ queryUrl, esriGeom, outFields });

    // Convert ArcGIS features -> GeoJSON features
    const gjFeatures = arcFeatures.map((f) => arcgisToGeoJSON(f));
    const geojson = { type: "FeatureCollection", features: gjFeatures };

    // Unique map units + flags summary (bounded)
    const unique = new Map();

    for (const ft of gjFeatures) {
      const p = ft.properties || {};
      const key = `${p.musym ?? ""}|${p.muname ?? ""}|${p.mukey ?? ""}`;

      if (!unique.has(key)) {
        const flags = deriveFlags(p);
        unique.set(key, {
          mukey: p.mukey ?? null,
          musym: p.musym ?? null,
          muname: p.muname ?? null,
          // keep a few “headline” properties for quick UI display
          drclassdcd: p.drclassdcd ?? null,
          hydgrpdcd: p.hydgrpdcd ?? null,
          hydclprs: p.hydclprs ?? null,
          flodfreqdcd: p.flodfreqdcd ?? null,
          pondfreqprs: p.pondfreqprs ?? null,
          wtdepannmin: p.wtdepannmin ?? null,
          wtdepaprjunmin: p.wtdepaprjunmin ?? null,
          wss_link: p.wss_link ?? null,
          flags,
        });
      }
    }

    // A second-level aggregate summary for the report/UI
    const agg = {
      poorDrainage: 0,
      hydricLikely: 0,
      floodingRisk: 0,
      pondingRisk: 0,
    };

    for (const u of unique.values()) {
      if (u.flags?.poorDrainage) agg.poorDrainage += 1;
      if (u.flags?.hydricLikely) agg.hydricLikely += 1;
      if (u.flags?.floodingRisk) agg.floodingRisk += 1;
      if (u.flags?.pondingRisk) agg.pondingRisk += 1;
    }

    const payload = {
      layer: "soils",
      source: queryUrl,
      count: gjFeatures.length,
      distinctMapUnits: unique.size,
      aggregateFlagsByMapUnit: agg,
      uniqueMapUnits: Array.from(unique.values()).slice(0, 50),
      geojson,
    };

    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json",
        // CORS for local dev convenience (safe for public data)
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response(`Server error: ${e?.message || String(e)}`, {
      status: 500,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    });
  }
}

