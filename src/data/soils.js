export async function fetchSoils(aoiFeatureOrGeometry) {
  const geometry =
    aoiFeatureOrGeometry?.type === "Feature"
      ? aoiFeatureOrGeometry.geometry
      : aoiFeatureOrGeometry;

  const res = await fetch("/api/soils", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}
