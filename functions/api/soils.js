export async function onRequest(context) {
  return new Response(
    JSON.stringify({
      status: "ok",
      message: "Soils API endpoint is alive",
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}
