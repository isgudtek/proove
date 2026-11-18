#!/usr/bin/env node
/**
 * Conformance check over HTTP for Proove's five sites (no dependencies).
 *   node scripts/verify.mjs                                         -> localhost:62270..62274 (npm start)
 *   node scripts/verify.mjs --base https://isgudtek.github.io/proove/
 * Checks: manifests are valid JSON with CORS *, .well-known alias, network definitions resolve, conformance rules
 * (shared/oaw-core.js validateManifest), the registry's verification key and circuit fingerprint match the published
 * circuit, the zero-knowledge assets are served, the hub's peers publish the capabilities it needs, and every
 * registry/vendor trusts the hub's origin for RPC.
 */
import { createHash } from "node:crypto";
import { validateManifest } from "../shared/oaw-core.js";

const i = process.argv.indexOf("--base");
const base = i > 0 ? new URL(process.argv[i + 1].replace(/\/?$/, "/")) : null;
const DIRS = [["registry", 62270], ["vendor-northlight", 62271], ["vendor-atelier", 62272], ["vendor-shady", 62273], ["hub", 62274]];
const sites = DIRS.map(([dir, port]) => ({ dir, url: base ? new URL(`${dir}/`, base).href : `http://localhost:${port}/` }));
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`); if (!cond) failed++; return cond; };

async function get(url, binary = false) {
  const res = await fetch(url, { headers: { Origin: "https://judge.example" } });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (!binary) try { json = JSON.parse(buf.toString("utf8")); } catch { /* not JSON */ }
  return { status: res.status, cors: res.headers.get("access-control-allow-origin"), type: res.headers.get("content-type") || "", json, size: buf.length, buf };
}

const loaded = {};
for (const s of sites) {
  console.log(`\n${s.dir}  ${s.url}`);
  let m;
  try { m = await get(new URL("agent-manifest.json", s.url).href); } catch (e) { ok(false, `reachable (${e.message})`); continue; }
  ok(m.status === 200, `GET agent-manifest.json → ${m.status}`);
  ok(m.json !== null, "manifest is valid JSON");
  ok(m.cors === "*", `Access-Control-Allow-Origin: ${m.cors}`);
  const wk = await get(new URL(".well-known/agent-manifest.json", s.url).href);
  ok(wk.status === 200 && JSON.stringify(wk.json) === JSON.stringify(m.json), `.well-known/agent-manifest.json alias → ${wk.status}`);
  const net = m.json?.networks?.[0];
  let n = null;
  if (net) {
    n = await get(new URL(net.hocon, s.url).href);
    ok(n.status === 200 && n.json && n.cors === "*", `network ${net.hocon} → ${n.status}, CORS ${n.cors}`);
  }
  const page = await get(s.url);
  ok(page.status === 200 && page.type.includes("text/html"), `index.html → ${page.status}`);
  for (const c of validateManifest(m.json, n?.json)) ok(c.ok, `${c.check}${c.detail ? ` (${c.detail})` : ""}`);
  ok(m.json?.endpoint === s.url, `endpoint is ${s.url}`);
  if (m.json?.name) console.log(`  · ${m.json.name}`);
  loaded[s.dir] = m.json;
}

console.log("\nZero-knowledge assets");
const shared = new URL("../shared/", sites[0].url);
const circuit = await get(new URL("zk/possession.json", shared).href);
ok(circuit.status === 200 && circuit.json?.bytecode, `shared/zk/possession.json → ${circuit.status}`);
for (const [f, min] of [["zk/vendor/zk.js", 1e5], ["zk/vendor/main.worker.js", 1e3], ["zk/vendor/acvm_js_bg.wasm", 1e6], ["zk/vendor/crs/g1_compressed.dat", 4194304], ["zk/vendor/crs/g2.dat", 128], ["zk/vendor/crs/grumpkin_g1_v2.dat", 4194304], ["zk-client.js", 1e3], ["oaw-core.js", 1e3]]) {
  const r = await get(new URL(f, shared).href, true);
  ok(r.status === 200 && r.size >= min, `shared/${f} → ${r.status}, ${r.size} bytes`);
}
const data = await get(new URL("registry-data.json", sites[0].url).href);
ok(data.status === 200 && data.cors === "*", `registry-data.json → ${data.status}, CORS ${data.cors}`);
if (data.json && circuit.json) {
  const sha = createHash("sha256").update(circuit.json.bytecode).digest("hex");
  ok(sha === data.json.circuit.sha256, `published circuit matches the registry's fingerprint ${data.json.circuit.sha256.slice(0, 12)}…`);
  ok(Buffer.from(data.json.verification_key, "base64").length > 1000, `verification key ${Buffer.from(data.json.verification_key, "base64").length} bytes`);
  ok(/^0x[0-9a-f]{64}$/.test(data.json.root), `commitment root ${data.json.root.slice(0, 12)}…`);
}
const custody = await get(new URL("custody.json", sites[0].url).href);
ok(custody.status === 200 && custody.json?.records?.length === data.json?.items_certified, `custody.json: ${custody.json?.records?.length} records for ${data.json?.items_certified} certified items`);
const secrets = await get(new URL("../registry-secrets/ledger.json", sites[0].url).href);
ok(secrets.status === 404, `registry-secrets/ledger.json is not published (${secrets.status})`);

console.log("\nCross-site");
const hub = loaded.hub;
if (hub) {
  const hubOrigin = new URL(sites.at(-1).url).origin;
  const reg = await get(`${hub.peers.registry.replace(/\/+$/, "")}/agent-manifest.json`);
  ok(reg.status === 200 && (reg.json?.capabilities || []).includes("zk.possession.verifier_key"), `registry ${hub.peers.registry}: publishes zk.possession.verifier_key`);
  ok((hub.peers.vendors || []).length === 3, `hub lists ${(hub.peers.vendors || []).length} vendors`);
  for (const v of hub.peers.vendors || []) {
    const vm = await get(`${v.replace(/\/+$/, "")}/agent-manifest.json`);
    ok(vm.status === 200 && (vm.json?.capabilities || []).includes(hub.peers.required_capability), `${v}: publishes ${hub.peers.required_capability}`);
    ok(vm.json?.registry?.url === hub.peers.registry, `${v}: proves against the same registry`);
  }
  for (const s of sites.filter((x) => x.dir !== "hub" && loaded[x.dir])) ok((loaded[s.dir].rpc?.trusted_origins || []).includes(hubOrigin), `${loaded[s.dir].name} trusts the hub origin ${hubOrigin}`);
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
