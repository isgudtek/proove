#!/usr/bin/env node
/**
 * Zero-dependency dev server for Proove's five agentic sites.
 *   http://localhost:62270 -> registry/                    Proove Artifact Registry
 *   http://localhost:62271 -> vendor-northlight/ + vendor/ Northlight Collectibles (honest)
 *   http://localhost:62272 -> vendor-atelier/ + vendor/    Atelier Unique (honest)
 *   http://localhost:62273 -> vendor-shady/ + vendor/      Shady Rocks (dishonest, for the demo)
 *   http://localhost:62274 -> hub/                         Proove Buyer Hub
 * All serve /shared/* from shared/, alias /.well-known/agent-manifest.json, and send CORS *.
 * Env: PORT_BASE (default 62270), HOST (default 127.0.0.1).
 */
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const HOST = process.env.HOST || "127.0.0.1";
const PORT_BASE = Number(process.env.PORT_BASE || 62270);
const SITES = [
  { name: "Registry", dir: "registry", port: PORT_BASE },
  { name: "Northlight", dir: "vendor-northlight", base: "vendor", port: PORT_BASE + 1 },
  { name: "Atelier Unique", dir: "vendor-atelier", base: "vendor", port: PORT_BASE + 2 },
  { name: "Shady Rocks", dir: "vendor-shady", base: "vendor", port: PORT_BASE + 3 },
  { name: "Buyer Hub", dir: "hub", port: PORT_BASE + 4 },
];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".wasm": "application/wasm", ".dat": "application/octet-stream",
};
const BASE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Map a URL path to a file inside the allowed roots, or null. Blocks traversal and dotfiles. */
function resolveFile(site, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  if (p === "/.well-known/agent-manifest.json") p = "/agent-manifest.json";
  if (p.endsWith("/")) p += "index.html";
  const shared = p.startsWith("/shared/");
  const rel = shared ? p.slice("/shared/".length) : p.slice(1);
  if (rel.split("/").some((seg) => seg.startsWith(".") || seg === "")) return null;
  // An overlay site (site.base) serves its own files first, then the base site's.
  const roots = shared ? [join(ROOT, "shared")] : [join(ROOT, site.dir), ...(site.base ? [join(ROOT, site.base)] : [])];
  for (const base of roots) {
    const file = normalize(join(base, rel));
    if (!file.startsWith(base + sep)) return null;
    try { if (statSync(file).isFile()) return file; } catch { /* try the next root */ }
  }
  return null;
}

function handler(site) {
  return (req, res) => {
    const t0 = Date.now();
    const done = (status) => process.env.QUIET || console.log(`${site.port} ${req.method} ${req.url} ${status} ${Date.now() - t0}ms`);
    if (req.method === "OPTIONS") { res.writeHead(204, BASE_HEADERS); res.end(); return done(204); }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { ...BASE_HEADERS, Allow: "GET, HEAD, OPTIONS" }); res.end(); return done(405); }
    const file = resolveFile(site, req.url || "/");
    if (!file) {
      res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return done(404);
    }
    const { size } = statSync(file);
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": MIME[extname(file)] || "application/octet-stream", "Content-Length": size });
    if (req.method === "HEAD") { res.end(); return done(200); }
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
    done(200);
  };
}

for (const site of SITES) {
  const server = http.createServer(handler(site));
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${site.port} is already in use (${site.name}). Stop that process or set ${"PORT_BASE"}.` : e.message);
    process.exit(1);
  });
  server.listen(site.port, HOST, () => console.log(`${site.name.padEnd(18)} http://localhost:${site.port}/   (${site.dir}/)`));
}
