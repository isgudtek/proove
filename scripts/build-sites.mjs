#!/usr/bin/env node
/**
 * Static build for Proove's five sites.
 *
 *   node scripts/build-sites.mjs                                       -> dist/, localhost URLs kept
 *   node scripts/build-sites.mjs --base https://isgudtek.github.io/proove/ --out docs
 *
 * Output: <out>/index.html (landing), <out>/shared/ (once: runtime, circuits, prover WASM, CRS),
 * <out>/registry/, <out>/vendor-northlight/, <out>/vendor-atelier/, <out>/vendor-shady/ (overlays on vendor/), <out>/hub/,
 * each with .well-known/agent-manifest.json, plus <out>/.nojekyll so GitHub Pages publishes the .well-known folders.
 * registry-secrets/ is never copied.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(ROOT, arg("out", "dist"));
const baseArg = arg("base", null);
const base = baseArg ? new URL(baseArg.endsWith("/") ? baseArg : `${baseArg}/`) : null;
if (!out.startsWith(ROOT + sep)) throw new Error(`Refusing to write outside the project: ${out}`);

const SITES = [
  { dir: "registry", port: 62270 },
  { dir: "vendor-northlight", base: "vendor", port: 62271 },
  { dir: "vendor-atelier", base: "vendor", port: 62272 },
  { dir: "vendor-shady", base: "vendor", port: 62273 },
  { dir: "hub", port: 62274 },
].map((s) => ({ ...s, url: base ? new URL(`${s.dir}/`, base).href : `http://localhost:${s.port}/` }));
const HUB = SITES.find((s) => s.dir === "hub");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

/** Replace every http://localhost:<site port> URL with that site's deployed URL. */
function rewrite(text) {
  if (!base) return text;
  for (const s of SITES) text = text.replaceAll(`http://localhost:${s.port}/`, s.url).replaceAll(`http://localhost:${s.port}`, s.url.replace(/\/$/, ""));
  return text;
}

cpSync(join(ROOT, "shared"), join(out, "shared"), { recursive: true });
for (const site of SITES) {
  const dest = join(out, site.dir);
  if (site.base) cpSync(join(ROOT, site.base), dest, { recursive: true }); // shared vendor code first
  cpSync(join(ROOT, site.dir), dest, { recursive: true }); // then the site's own files on top
  for (const f of readdirSync(dest).filter((f) => f.endsWith(".json"))) writeFileSync(join(dest, f), rewrite(readFileSync(join(dest, f), "utf8")));
  const mPath = join(dest, "agent-manifest.json");
  const m = readJson(mPath);
  if (site.dir !== "hub") m.rpc.trusted_origins = [new URL(HUB.url).origin]; // origins, not URLs
  writeJson(mPath, m);
  mkdirSync(join(dest, ".well-known"), { recursive: true });
  writeJson(join(dest, ".well-known", "agent-manifest.json"), m);
}
writeFileSync(join(out, ".nojekyll"), "");

/*
 * Cache busting. GitHub Pages serves everything with Cache-Control: max-age=600, so a browser can keep old modules
 * for 10 minutes after a deploy. Local .js/.css references get ?v=<content hash> (the prebuilt prover bundle in
 * shared/zk/vendor is left as is). The hash also goes into <meta name="oaw-build"> for the UI and the iframes.
 */
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(out);
const build = createHash("sha256").update(files.sort().map((f) => readFileSync(f)).join("\u0000")).digest("hex").slice(0, 10);
const stampJs = (src) => src.replace(/((?:from|import)\s*\(?\s*)"(\.{1,2}\/[^"?]+\.js)"/g, `$1"$2?v=${build}"`);
const ZK_VENDOR = join(out, "shared", "zk", "vendor") + sep;
for (const f of files) {
  if (f.startsWith(ZK_VENDOR)) continue;
  if (f.endsWith(".js")) writeFileSync(f, stampJs(readFileSync(f, "utf8")));
  if (f.endsWith("index.html")) {
    const html = readFileSync(f, "utf8")
      .replace(/(href|src)="((?!https?:|data:|\/\/)[^"?]+\.(?:css|js))"/g, `$1="$2?v=${build}"`)
      .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="oaw-build" content="${build}">`);
    writeFileSync(f, html);
  }
}

const links = [
  ["https://github.com/isgudtek/proove", "Source code on GitHub"],
  ...(process.env.PROOVE_VIDEO ? [[process.env.PROOVE_VIDEO, "Watch the demo video", "video"]] : []),
  ...(process.env.PROOVE_DEVPOST ? [[process.env.PROOVE_DEVPOST, "Devpost project page"]] : []),
];
writeFileSync(join(out, "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="oaw-build" content="${build}">
  <title>Proove: unique artifacts, proven in zero knowledge</title>
  <meta name="description" content="An open agentic marketplace where every vendor must prove in zero knowledge that it holds a registry-certified unique artifact. Buyers verify each proof in the browser.">
  <style>
    body { margin: 0; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0d1014; color: #e8ecf1; display: grid; place-items: center; min-height: 100vh; }
    main { max-width: 860px; padding: 32px; }
    h1 { font-size: 30px; margin: 0 0 8px; }
    p { color: #a9b4c2; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 22px; }
    a.card { display: block; padding: 16px; border-radius: 14px; text-decoration: none; color: inherit; border: 1px solid #263040; background: #151a21; }
    a.card:hover { border-color: #3fcf8e; }
    a.card.hub { border-color: #3fcf8e88; grid-column: 1 / -1; }
    a.card.bad { border-color: #f2b84b55; }
    strong { display: block; font-size: 17px; margin-bottom: 4px; }
    code { background: rgba(255,255,255,.08); padding: 1px 6px; border-radius: 5px; }
    .links { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .links a { color: #e8ecf1; text-decoration: none; padding: 8px 14px; border-radius: 999px; border: 1px solid #263040; background: #151a21; font-size: 14px; }
    .links a.video { background: #3fcf8e; border-color: #3fcf8e; color: #0d1014; }
  </style>
</head>
<body>
  <main>
    <h1>Proove</h1>
    <p>An open agentic marketplace for unique artifacts: meteorite fragments, rare minerals, precious metals, antique coins, limited-edition art and historic documents. A vendor cannot just say it has an item. Each offer carries a zero-knowledge proof (Noir circuit, UltraHonk) that the vendor knows the secret code of an item certified by the registry, bound to that one listing. The buyer's hub verifies every proof in the browser with the registry's own verification key and checks custody at the registry before anything is bought.</p>
    <div class="cards">
      <a class="card hub" href="hub/"><strong>Proove Buyer Hub</strong>Start here. Ask for an artifact; agents discover the vendors, collect proven offers, verify them, negotiate within your budget and ask for your approval.</a>
      <a class="card" href="registry/"><strong>Proove Artifact Registry</strong>Publishes the commitment root and verification key, answers custody checks and records transfers.</a>
      <a class="card" href="vendor-northlight/"><strong>Northlight Collectibles</strong>Honest vendor: coins, documents and meteorites.</a>
      <a class="card" href="vendor-atelier/"><strong>Atelier Unique</strong>Honest vendor: minerals, art editions, a pallasite and a gold nugget.</a>
      <a class="card bad" href="vendor-shady/"><strong>Shady Rocks</strong>Deliberately dishonest demo vendor: a copied item code and a counterfeit with a forged proof.</a>
    </div>
    <nav class="links" aria-label="Project links">
${links.map(([href, text, cls]) => `      <a ${cls ? `class="${cls}" ` : ""}href="${href}" target="_blank" rel="noopener">${text}</a>`).join("\n")}
    </nav>
    <p>Every site publishes <code>agent-manifest.json</code> and runs its own agents in your browser. Demo Mode needs no key; bring a Mozilla Otari key or use Chrome's Gemini Nano for model-driven agents. Proof verification never depends on a model.</p>
  </main>
</body>
</html>
`);

if (!existsSync(join(out, "shared", "zk", "vendor", "zk.js"))) throw new Error("shared/zk was not copied (run npm run build:zk)");
if (existsSync(join(out, "registry-secrets"))) throw new Error("registry-secrets must never be published");
console.log(`Built ${out}  (build ${build}, ${files.length} files)`);
for (const s of SITES) console.log(`  ${s.dir.padEnd(18)} ${s.url}`);
console.log(`  RPC trusted origin: ${new URL(HUB.url).origin}`);
