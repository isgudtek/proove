/**
 * Proove vendor storefront (one codebase; vendor-<id>/ supplies shop.json, manifest, network, vault and theme).
 * curator_agent -> prover_agent (zero-knowledge, in this browser) -> sales_agent.
 */
import { AgentRuntime, serveRpc, exposeGlobal, fetchJson, OawError, uid } from "../shared/oaw-core.js";
import { h, $, money, createStream, createApproval, createConsent, createSettings, createStatusPill, createInspector } from "../shared/oaw-ui.js";
import { CATEGORIES, listingField } from "../shared/merkle.js";
import * as V from "./vendor-logic.js";

const BUILD = document.querySelector('meta[name="oaw-build"]')?.content || "dev";
const embedded = window.parent !== window || new URLSearchParams(location.search).has("embedded");
document.body.classList.toggle("embedded", embedded);
const get = async (f) => (await fetch(`./${f}`, { cache: "no-store" })).json();
const [shop, manifest, vault] = await Promise.all([get("shop.json"), get("agent-manifest.json"), get("vault.json")]);
const network = await get(manifest.networks[0].hocon);
document.title = `${shop.name} · Proove vendor`;
$("#shopName").textContent = shop.name;
$("#shopTag").textContent = shop.tagline;
if (manifest.demo_notice) { $("#demoNotice").hidden = false; $("#demoNotice").textContent = `Demo: ${manifest.demo_notice}`; }

const stream = createStream($("#stream"));
const approve = createApproval();
const consent = createConsent();

/* -------------------------------------------------------- registry + zk */

const registryUrl = String(manifest.registry?.url || "").replace(/\/+$/, "");
let registry = { root: vault.root, source: "vault" };
async function loadRegistry(emit) {
  try {
    const d = await fetchJson(`${registryUrl}/registry-data.json`, { emit });
    registry = { root: d.root, source: registryUrl, items: d.items_certified };
  } catch (e) { stream.add({ type: "note", text: `Registry not reachable (${e.message}); using the root stored with the vault.` }); }
  return registry;
}
let zkMod = null;
const zk = () => (zkMod ??= import("../shared/zk-client.js"));
async function warmZk() {
  const z = await zk();
  $("#zkStatus").textContent = "Loading prover…";
  const r = await z.warmUp();
  $("#zkStatus").textContent = `Prover ready · ${r.threads} thread${r.threads > 1 ? "s" : ""} · loaded in ${(r.loadMs / 1000).toFixed(1)} s`;
  return r;
}

/* -------------------------------------------------------- state */

const loadSold = () => { try { return new Set(JSON.parse(localStorage.getItem(shop.store_key) || "[]")); } catch { return new Set(); } };
let sold = loadSold();
const saveSold = () => localStorage.setItem(shop.store_key, JSON.stringify([...sold]));
const items = vault.items.map((it) => ({ ...it, sold: sold.has(it.id) }));
const catalog = () => items.map(({ secret, path, bits, index, cheat, ...pub }) => pub); // never exposes codes
const listings = new Map(); // listing_id -> { item, buyer, price, rounds, status, history, proof }
let current = null;

/* -------------------------------------------------------- 3D */

let viewer = null, pendingItem = null;
import("../shared/specimen.js").then(({ createSpecimenViewer }) => {
  viewer = createSpecimenViewer($("#viewer"));
  if (pendingItem) showItem(pendingItem);
}).catch((e) => { $("#vEmpty").textContent = `3D preview unavailable (${e.message}).`; });
function showItem(item, proofInfo) {
  current = item;
  if (viewer) { viewer.show(item); $("#vEmpty").hidden = true; } else pendingItem = item;
  $("#curKicker").textContent = CATEGORIES[item.category_code]?.label || item.category;
  $("#curTitle").textContent = item.title;
  $("#curMeta").textContent = `${item.measure > 1 ? `${item.measure} g · ` : ""}certified ${item.cert_year}${item.edition_size > 1 ? ` · edition of ${item.edition_size}` : ""} · ${money(item.list)}`;
  drawProof(proofInfo);
  drawCatalog();
}
function drawProof(p) {
  const box = $("#curProof");
  if (!p) { box.replaceChildren(); return; }
  if (p.pending) { box.replaceChildren(h("span", { class: "badge-zk pending", text: "Generating zero-knowledge proof…" })); return; }
  if (p.error) { box.replaceChildren(h("span", { class: "badge-zk bad", text: `No proof possible: ${p.error}` })); return; }
  box.replaceChildren(...[
    h("div", { class: "row" }, h("span", { class: `badge-zk ${p.forged ? "warn" : "ok"}`, text: p.forged ? "Proof attached (forged by this vendor)" : `Possession proof generated · ${p.proveMs} ms` }), h("span", { class: "oaw-muted small", text: `${Math.round((p.proof.length * 3) / 4 / 1024)} KB · UltraHonk` })),
    h("pre", { text: JSON.stringify({ claims: p.claims, listing: p.listing_id, nullifier: p.nullifier, public_inputs: p.publicInputs.length }, null, 1) }),
  ]);
}
function drawCatalog() {
  $("#catalog").replaceChildren(...items.map((it) => h("li", { class: `item ${it.sold ? "sold" : ""} ${current?.id === it.id ? "active" : ""}` },
    h("p", { class: "m", text: `${CATEGORIES[it.category_code]?.label || it.category}${it.edition_size > 1 ? ` · ${it.edition_no}/${it.edition_size}` : ""}` }),
    h("p", { class: "t", text: it.title }),
    h("p", { class: "m", text: `${it.measure > 1 ? `${it.measure} g · ` : ""}certified ${it.cert_year}` }),
    h("p", { class: "price", text: it.sold ? "Sold" : money(it.list) }),
    it.sold ? null : h("button", { class: "oaw-btn small", type: "button", text: "Prove possession", onclick: () => proveLocal(it) }))));
}
function drawOffers() {
  const rows = [...listings.values()].reverse();
  $("#offers").replaceChildren(...(rows.length ? rows.map((l) => h("li", { class: l.status === "sold" ? "sold" : "" },
    h("span", { text: `${l.item.title} → ${l.buyer}` }),
    h("span", { class: "oaw-muted", text: `${l.status} · ${money(l.price)}${l.rounds ? ` · ${l.rounds} round(s)` : ""}` }))) : [h("li", { class: "oaw-muted", text: "No offers yet. Buyer agents request offers over postMessage." })]));
}

/* -------------------------------------------------------- proofs */

async function proveFor(item, req, listingId) {
  const z = await zk();
  const claims = V.claimsFor(item, req);
  const listing = await listingField(shop.id, listingId);
  try {
    const p = await z.prove({ item, path: item.path, bits: item.bits, root: registry.root, claims, listing });
    return { ...p, claims, listing, listing_id: listingId };
  } catch (e) {
    if (e.code !== "NOT_PROVABLE" || shop.honest) throw e;
    // Dishonest demo vendor: it cannot prove this item, so it attaches a proof made for another item and edits its claims.
    const donor = items.find((x) => x.cheat === "copied_code");
    const p = await z.prove({ item: donor, path: donor.path, bits: donor.bits, root: registry.root, claims: V.claimsFor(donor, req), listing });
    const inputs = [...p.publicInputs];
    inputs[3] = "0x" + BigInt(Math.max(claims.min_measure, 90)).toString(16).padStart(64, "0"); // pretend it proves the counterfeit's 95 g
    return { ...p, publicInputs: inputs, claims: { ...claims, min_measure: Math.max(claims.min_measure, 90) }, listing, listing_id: listingId, forged: true };
  }
}

async function proveLocal(item) {
  showItem(item, { pending: true });
  runtime.emit({ type: "run_start", prompt: `Prove possession of ${item.title}` });
  const r = await runtime.callTool("prove_item", { item_id: item.id, requirements: {}, listing_id: `${item.id}.store` });
  if (r.status === "succeeded") { showItem(item, r.result); runtime.emit({ type: "run_end", ok: true, summary: r.result.forged ? "Forged proof attached (it will fail verification)" : `Proof ready in ${r.result.proveMs} ms` }); }
  else { showItem(item, { error: r.error }); runtime.emit({ type: "run_end", ok: false, error: r.error }); }
}

/* -------------------------------------------------------- agents + tools */

const agentImpl = {
  curator_agent: {
    prompt: ({ requirements, catalog: c }) => `Buyer requirements: ${JSON.stringify(requirements)}\nCatalog: ${JSON.stringify(c)}`,
    deterministic: (input) => V.curatorDeterministic(input),
    normalize: (out, input) => {
      const ok = new Set(V.matchItems(input.requirements, input.catalog).map((i) => i.id));
      const picked = (Array.isArray(out?.matches) ? out.matches : []).filter((m) => ok.has(m.item_id));
      return picked.length || !ok.size ? { matches: picked } : V.curatorDeterministic(input); // the catalog rules win over the model
    },
  },
  prover_agent: {
    ruleBased: true,
    async run({ matches, requirements, buyer }) {
      const offers = [];
      for (const m of matches) {
        const item = items.find((i) => i.id === m.item_id);
        const listingId = `${item.id}.${uid("L").slice(2, 8)}`;
        const r = await runtime.callTool("prove_item", { item_id: item.id, requirements, listing_id: listingId });
        if (r.status !== "succeeded") { stream.add({ type: "note", agent: "prover_agent", text: `${item.title}: ${r.error}. Not offered.` }); continue; }
        listings.set(listingId, { item, buyer, price: item.list, rounds: 0, status: "offered", history: [{ by: "vendor", price: item.list }], proof: r.result });
        offers.push({ listing_id: listingId, pitch: m.pitch, item: catalog().find((c) => c.id === item.id), price: item.list, currency: "USD", proof: r.result.proof, public_inputs: r.result.publicInputs, claims: r.result.claims, nullifier: r.result.nullifier, prove_ms: r.result.proveMs, vendor: shop.id, vendor_name: shop.name });
        showItem(item, r.result);
      }
      drawOffers();
      return { offers };
    },
  },
  sales_agent: {
    prompt: (input) => JSON.stringify(input),
    deterministic: (input) => V.salesDeterministic(input),
    normalize: (out) => ({ decision: out?.decision === "accept" ? "accept" : "counter", price: Number(out?.price), message: String(out?.message || "").slice(0, 300) }),
  },
};

const need = (id) => { const l = listings.get(id); if (!l) throw new OawError("NO_LISTING", `Unknown listing ${id}.`); return l; };
const tools = {
  get_catalog: { effect: "read", rpc: true, title: "Catalog", input_schema: { type: "object", properties: {} }, handler: () => ({ vendor: shop.id, name: shop.name, items: catalog() }) },
  prove_item: {
    effect: "preview", rpc: false, title: "Prove possession",
    input_schema: { type: "object", required: ["item_id", "listing_id"], properties: { item_id: { type: "string" }, requirements: { type: "object" }, listing_id: { type: "string" } } },
    async handler({ item_id, requirements, listing_id }) {
      const item = items.find((i) => i.id === item_id);
      if (!item) throw new OawError("NO_ITEM", `No item ${item_id}.`);
      if (item.sold) throw new OawError("SOLD", "This item has been sold.");
      return proveFor(item, requirements || {}, listing_id);
    },
  },
  request_offers: {
    effect: "preview", rpc: true, title: "Offers with possession proofs",
    input_schema: { type: "object", required: ["requirements"], properties: { requirements: { type: "object" }, buyer: { type: "string" } } },
    async handler({ requirements, buyer }, ctx) {
      const from = ctx.remote ? `discovery_agent@${new URL(ctx.origin).host}` : "user";
      await loadRegistry((e) => runtime.emit(e));
      warmZk().catch(() => {});
      const pick = await runtime.runAgent("curator_agent", { requirements, catalog: catalog() }, { from });
      runtime.emit({ type: "note", agent: "curator_agent", text: pick.matches.length ? `${pick.matches.length} certified item(s) match.` : "No item in this vault matches." });
      if (!pick.matches.length) return { vendor: shop.id, vendor_name: shop.name, offers: [] };
      const out = await runtime.runAgent("prover_agent", { matches: pick.matches, requirements, buyer: buyer || ctx.origin || "buyer" }, { from: "curator_agent" });
      return { vendor: shop.id, vendor_name: shop.name, registry_root: registry.root, ...out };
    },
  },
  negotiate_offer: {
    effect: "preview", rpc: true, title: "Counter-offer",
    input_schema: { type: "object", required: ["listing_id", "counter_price"], properties: { listing_id: { type: "string" }, counter_price: { type: "number", minimum: 1 } } },
    async handler({ listing_id, counter_price }, ctx) {
      const l = need(listing_id);
      if (l.status !== "offered") return { listing_id, price: l.price, accepted: l.status === "accepted", final: true };
      l.rounds++;
      const counter = Math.round(counter_price), floor = V.floorOf(l.item);
      l.history.push({ by: "buyer", price: counter });
      runtime.emit({ type: "negotiation", text: `Round ${l.rounds}/${V.MAX_ROUNDS}: buyer offers ${money(counter)} against ${money(l.price)}` });
      const out = await runtime.runAgent("sales_agent", { counter_price: counter, floor_price: floor, current: l.price, round: l.rounds }, { from: ctx.remote ? `negotiator_agent@${new URL(ctx.origin).host}` : "user" });
      const r = V.enforceNegotiation(out, { counter, floor, current: l.price, round: l.rounds });
      if (r.policy) runtime.emit({ type: "note", agent: "sales_agent", text: `Vendor policy: ${r.policy}` });
      l.price = r.price;
      if (r.accepted) l.status = "accepted";
      l.history.push({ by: "vendor", price: l.price });
      runtime.emit({ type: "negotiation", text: r.accepted ? `Vendor accepts ${money(l.price)}` : `Vendor counters ${money(l.price)}${r.final ? " (final offer)" : ""}` });
      drawOffers();
      return { listing_id, price: l.price, accepted: r.accepted, final: r.final, message: r.policy ? V.salesDeterministic({ counter_price: counter, floor_price: floor, current: l.price }).message : out.message };
    },
  },
  confirm_sale: {
    effect: "write", rpc: true, title: "Sell this artifact",
    input_schema: { type: "object", required: ["listing_id", "price", "buyer"], properties: { listing_id: { type: "string" }, price: { type: "number" }, buyer: { type: "string" } } },
    precheck({ listing_id, price }) {
      const l = need(listing_id);
      if (l.item.sold) throw new OawError("SOLD", "This item has already been sold.");
      if (Math.abs(price - l.price) > 0.5) throw new OawError("PRICE_MISMATCH", `Price ${money(price)} does not match the agreed ${money(l.price)}.`);
    },
    describe({ listing_id, price, buyer }) {
      const l = listings.get(listing_id);
      return { price, summary: "Sell this artifact. It leaves the vault; the registry then records the transfer to the buyer.", lines: [["Artifact", l.item.title], ["Buyer", buyer], ["Listing", listing_id], ["Proof nullifier", `${String(l.proof.nullifier).slice(0, 12)}…`]] };
    },
    handler({ listing_id, price, buyer }) {
      const l = need(listing_id);
      l.item.sold = true; l.status = "sold"; l.price = price;
      sold.add(l.item.id); saveSold();
      drawCatalog(); drawOffers();
      return { order_id: uid(shop.id_prefix).toUpperCase(), listing_id, price, buyer, vendor: shop.id, nullifier: l.proof.nullifier, title: l.item.title };
    },
  },
};

const runtime = new AgentRuntime({ site: shop.id, manifest, network, agentImpl, tools, settingsKey: shop.settings_key, approve });
runtime.on((e) => stream.add(e));
createStatusPill($("#pill"), runtime);
const settings = createSettings({ runtime });
$("#settingsBtn").addEventListener("click", () => settings.open());
const inspector = createInspector({ getEntries: () => [{ label: shop.name, url: new URL("agent-manifest.json", location.href).href, manifest, network, cors: "*" }] });
$("#manifestBtn").addEventListener("click", () => inspector.open());

const getState = () => ({ site: shop.id, honest: shop.honest, registry_root: registry.root, catalog: catalog(), listings: [...listings.entries()].map(([id, l]) => ({ id, item: l.item.id, status: l.status, price: l.price })), stats: { ...runtime.stats } });
serveRpc({
  runtime,
  trustedOrigins: manifest.rpc.trusted_origins || [],
  consent: (r) => consent({ ...r, direction: "inbound" }),
  methods: {
    ping: () => ({ site: shop.id, name: shop.name, ready: true, provider: runtime.describeProvider().label }),
    manifest: () => manifest,
    getState: () => getState(),
    run: ({ requirements }, ctx) => runtime.callTool("request_offers", { requirements: requirements || {} }, ctx),
    callTool: ({ tool, args }, ctx) => runtime.callTool(String(tool), args || {}, ctx),
  },
});
exposeGlobal({ manifest, run: (req) => runtime.callTool("request_offers", { requirements: req || {} }, { origin: location.origin }), callTool: (n, a) => runtime.callTool(n, a, { origin: location.origin }), getState });

drawCatalog();
drawOffers();
await runtime.probeNano();
loadRegistry((e) => runtime.emit(e)).then(() => stream.add({ type: "note", text: `Build ${BUILD} · ${shop.name} · ${items.length} items in vault · registry root ${String(registry.root).slice(0, 10)}… (${registry.source === "vault" ? "from vault" : "live"})` }));
setTimeout(() => warmZk().catch((e) => { $("#zkStatus").textContent = `Prover failed to load: ${e.message}`; }), embedded ? 300 : 1200);
document.body.dataset.ready = "true";
