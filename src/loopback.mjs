/**
 * True when a request may have come from a web page rather than the local CLI.
 *
 * Binding to 127.0.0.1 keeps other machines out, but not a page in the user's browser: with
 * DNS rebinding a page can reach the proxy under its own hostname, and a "simple" cross-site
 * POST needs no preflight. Either way it could spend the user's Jev quota. The CLIs address
 * the proxy by loopback host and send no Origin, so anything else is refused.
 */
export function isForeignRequest(headers, port) {
  const loopback = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!loopback.has(String(headers.host ?? "").toLowerCase())) return true;
  const origin = headers.origin;
  return origin !== undefined && !loopback.has(String(origin).toLowerCase().replace(/^https?:\/\//, ""));
}

/** Answers a refused request. */
export function refuseForeign(res) {
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "jev-router accepts only loopback requests", type: "forbidden" } }));
}
