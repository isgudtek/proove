/**
 * Proove Buyer Hub.
 * intake_agent -> discovery_agent -> (vendors' curator/prover agents over postMessage RPC)
 * -> verifier_agent (zero-knowledge proof + registry checks, deterministic) -> buyer choice -> negotiator_agent
 * -> place_order (your approval) -> vendor confirm_sale (vendor's approval) -> registry record_transfer (registry's approval).
 */
import { AgentRuntime, RpcClient, serveRpc, exposeGlobal, fetchJson, validateManifest, OawError, uid } from "../shared/oaw-core.js?v=c8a3d2e978";
import { h, $, money, createStream, createApproval, createConsent, createSettings, createStatusPill, createInspector } from "../shared/oaw-ui.js?v=c8a3d2e978";
import { CATEGORIES, categoryCode, listingField, PUBLIC_INPUTS } from "../shared/merkle.js?v=c8a3d2e978";
import { findImage, preload } from "../shared/image-search.js?v=c8a3d2e978";
import { createFlow } from "./flow.js?v=c8a3d2e978";
import * as H from "./hub-logic.js?v=c8a3d2e978";

const BUILD = document.querySelector('meta[name="oaw-build"]')?.content || "dev";
const get = async (f) => (await fetch(`./${f}`, { cache: "no-store" })).json();
const manifest = await get("agent-manifest.json");
const network = await get(manifest.networks[0].hocon);
const host = (u) => { try { return new URL(u).host; } catch { return u; } };
const originOf = (u) => new URL(u).origin;
const trimUrl = (u) => String(u).replace(/\/+$/, "");
const short = (n) => `${String(n).slice(0, 10)}…${String(n).slice(-6)}`;
const big = (v) => { try { return Number(BigInt(v)); } catch { return null; } };

/* ----------------------------------------------------------------- state */

const VENDORS_KEY = "proove.hub.vendors.custom.v1"; // only vendors the visitor added
const ORDERS_KEY = "proove.hub.orders.v1";
const BUYER_KEY = "proove.hub.buyer.v1";
const loadJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v ?? d; } catch { return d; } };
const isLoopback = (u) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname); } catch { return false; } };
const pageIsLocal = isLoopback(location.href);
const registryUrl = trimUrl(manifest.peers.registry);
const published = (manifest.peers?.vendors || []).map(trimUrl);
let custom = loadJson(VENDORS_KEY, []).map(trimUrl);
const skipped = custom.filter((u) => !pageIsLocal && isLoopback(u)); // a localhost vendor makes no sense on a public page
let vendors = [...new Set([...published, ...custom.filter((u) => !skipped.includes(u))])];
const saveCustom = () => localStorage.setItem(VENDORS_KEY, JSON.stringify(custom));
let orders = loadJson(ORDERS_KEY, []);
const buyerRef = loadJson(BUYER_KEY, null) || `buyer-${uid("b").slice(2, 8)}`;
localStorage.setItem(BUYER_KEY, JSON.stringify(buyerRef));
const discovered = new Map(); // url -> { url, origin, role, name, ok, manifest, network, checks, capabilities, error }
let registry = null; // { url, root, verification_key, circuit, items_certified }
const contacted = new Set();
let deal = null;
let busy = false;

const stream = createStream($("#stream"));
let flow = { local() {}, remote() {}, verdict() {}, chosen() {}, reset() {} };
const buildFlow = () => { flow = createFlow($("#flow"), { registryUrl, vendors, label: (u) => shortName(u) }); };
const approve = createApproval();
const consent = createConsent();

/* --------------------------------------------------------- zero knowledge */

let zkMod = null;
const zk = () => (zkMod ??= import("../shared/zk-client.js?v=c8a3d2e978"));
let zkReady = null;
function warmZk() {
  zkReady ??= (async () => {
    $("#zkStatus").textContent = "Loading verifier…";
    const z = await zk();
    const r = await z.warmUp();
    $("#zkStatus").textContent = `ZK verifier ready · ${(r.loadMs / 1000).toFixed(1)} s`;
    return z;
  })().catch((e) => { zkReady = null; $("#zkStatus").textContent = `Verifier failed: ${e.message}`; throw e; });
  return zkReady;
}

/* ------------------------------------------------- split view + peer windows */

// One live frame and one RPC client per site (keyed by its base URL: on GitHub Pages all sites share one origin).
const frames = new Map(); // url -> { el, wrap }
const clients = new Map(); // url -> RpcClient
const shortName = (url) => (discovered.get(trimUrl(url))?.name || host(url)).replace(/^Proove /, "");

function frameFor(url) {
  const key = trimUrl(url);
  let f = frames.get(key);
  if (!f) {
    const u = new URL(`${key}/`);
    u.searchParams.set("embedded", "1");
    if (BUILD !== "dev") u.searchParams.set("v", BUILD); // never reuse a stale cached page
    const el = h("iframe", { src: u.href, title: `${shortName(key)} (live)`, class: "peer-frame" });
    const wrap = h("div", { class: "peer" });
    wrap.append(h("div", { class: "peer-label" },
      h("strong", { text: shortName(key) }), h("span", { class: "oaw-muted small grow", text: ` ${host(key)}${new URL(key).pathname}` }),
      h("button", { class: "oaw-btn small pop-btn", type: "button", text: "Pop out", "aria-label": `Pop out ${shortName(key)}`, onclick: (e) => togglePop(wrap, key, e.currentTarget) }),
      h("a", { class: "oaw-btn small ghost", href: `${key}/`, target: "_blank", rel: "noopener", text: "New tab", title: "Opens a separate copy of the site (not connected to this deal)" })), el);
    f = { el, wrap };
    frames.set(key, f);
    $("#splitFrame").append(wrap);
    const c = clients.get(key);
    if (c) c.ready = false;
  }
  return f;
}
function openSplit(urls) {
  for (const u of [].concat(urls)) {
    const fresh = !frames.has(trimUrl(u));
    frameFor(u);
    if (fresh) setTimeout(() => peer(u).catch(() => {}), 0); // connect at once, so the site takes the hub's model settings
  }
  $("#splitFrame").dataset.count = String(frames.size);
  $("#splitTitle").textContent = `${frames.size} site${frames.size > 1 ? "s" : ""}, each running its own agents`;
  document.body.classList.add("split-on");
  $("#splitBtn").setAttribute("aria-pressed", "true");
  $("#splitBtn").textContent = "Close Split-View";
}
function closeSplit() {
  if (popped && popped.target !== $("#flowPanel")) togglePop(popped.target);
  document.body.classList.remove("split-on");
  for (const [key, f] of frames) { f.wrap.remove(); const c = clients.get(key); if (c) c.ready = false; }
  frames.clear();
  $("#splitBtn").setAttribute("aria-pressed", "false");
  $("#splitBtn").textContent = "Open Split-View";
}
$("#splitBtn").addEventListener("click", () => (document.body.classList.contains("split-on") ? closeSplit() : openSplit([registryUrl, ...vendors])));
/* Pop out: show one live pane (or the workflow) almost full screen. The iframe is never moved in the DOM, so its
   page, agents and RPC connection stay alive; the page is only asked to switch to its normal, non-compact layout. */
let popped = null;
function viewMode(key, embedded) { const f = key && frames.get(key); try { f?.el.contentWindow?.postMessage({ type: "OAW_VIEW", embedded }, originOf(key)); } catch { /* frame gone */ } }
function togglePop(target, key = null, btn = null) {
  const was = popped;
  if (was) {
    was.target.classList.remove("popped");
    was.btn?.replaceChildren("Pop out");
    viewMode(was.key, true);
    popped = null;
  }
  if (was?.target !== target) {
    target.classList.add("popped");
    btn?.replaceChildren("Close ✕");
    viewMode(key, false);
    popped = { target, key, btn };
  }
  $("#popBackdrop").hidden = !popped;
}
$("#popBackdrop").addEventListener("click", () => popped && togglePop(popped.target));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && popped) togglePop(popped.target); });
$("#flowPop").addEventListener("click", (e) => togglePop($("#flowPanel"), null, e.currentTarget));
// The whole live-sites grid: the four sites stay compact, just much larger.
$("#splitPop").addEventListener("click", (e) => togglePop($(".split-pane"), null, e.currentTarget));

const peerWindow = (url) => frames.get(trimUrl(url))?.el.contentWindow || null;

async function peer(url) {
  const key = trimUrl(url);
  if (!peerWindow(key)) openSplit(key); // RPC needs a live window of the peer site
  let c = clients.get(key);
  if (!c) {
    c = new RpcClient({ origin: originOf(key), getWindow: () => peerWindow(key), onEvent: (ev) => onRemote(ev, key) });
    clients.set(key, c);
  }
  if (!c.ready) {
    const t0 = performance.now();
    const info = await c.connect();
    c.ready = true;
    runtime.emit({ type: "rpc", direction: "out", method: "ping", origin: key, ms: Math.round(performance.now() - t0), ok: true });
    runtime.emit({ type: "note", text: `Connected to ${info.name} (${host(key)}) · it runs its own agents with: ${info.provider}` });
    await lendSettings(key, c);
  }
  return c;
}

/* Simulation: every site in the split view runs its agents with the hub's model settings (mode, model and key). */
const hubSettings = () => { const s = runtime.settings; return { mode: s.mode, otari: { ...s.otari } }; };
async function lendSettings(key, c = clients.get(key)) {
  if (!c?.ready) return;
  try {
    const r = await c.call("useSettings", { settings: hubSettings(), from: manifest.name }, { timeout: 8000 });
    runtime.emit({ type: "note", text: `${shortName(key)} now uses the hub's model settings: ${r.provider}` });
  } catch (e) { runtime.emit({ type: "note", text: `${shortName(key)} kept its own model settings (${e.message})` }); }
}
const lendAll = () => { for (const [key, c] of clients) if (c.ready && frames.has(key)) lendSettings(key, c); };

async function rpc(url, method, params) {
  const key = trimUrl(url);
  const c = await peer(key);
  runtime.emit({ type: "rpc", direction: "out", method, tool: params?.tool || null, origin: key });
  const t0 = performance.now();
  try {
    const r = await c.call(method, params);
    const failed = r && typeof r === "object" && ["failed", "rejected"].includes(r.status);
    runtime.emit({ type: "rpc", direction: "out", method: failed ? `${method} → ${r.status}` : `${method} ✓`, tool: params?.tool || null, origin: key, ms: Math.round(performance.now() - t0), ok: !failed });
    return r;
  } catch (e) {
    runtime.emit({ type: "rpc", direction: "out", method, tool: params?.tool || null, origin: key, ms: Math.round(performance.now() - t0), ok: false });
    throw e;
  }
}
const remoteTool = async (url, tool, args, what) => {
  const r = await rpc(url, "callTool", { tool, args });
  if (r.status === "succeeded") return r.result;
  if (r.status === "declined") throw new OawError("DECLINED", `${what}: the owner of ${shortName(url)} rejected it.`);
  throw new OawError(r.code || "PEER_ERROR", `${what}: ${r.error || (r.errors || []).join("; ") || r.status}`);
};

/** Events streamed from a peer during an RPC call, labelled with the site's name. */
const pendingAt = new Map();
function onRemote(ev, key) {
  if (ev.type === "rpc" && ev.direction === "in") return; // our own request echoed back
  stream.add(ev, { remote: shortName(key) });
  flow.remote(ev, key);
  if (ev.type === "approval") {
    if (ev.state === "pending") pendingAt.set(key, `${shortName(key)}: approve or reject "${ev.tool}"${ev.price != null ? ` (${money(ev.price)})` : ""}`);
    else pendingAt.delete(key);
    const bar = $("#splitAttention");
    bar.hidden = !pendingAt.size;
    bar.textContent = pendingAt.size ? `Action needed · ${[...pendingAt.values()].join(" · ")} in its pane → (Pop out makes it bigger)` : "";
    frames.get(key)?.wrap.classList.toggle("attention", ev.state === "pending");
  }
}

/* --------------------------------------------------------------- discovery */

async function contact(origin, purpose) {
  if (origin === location.origin || contacted.has(origin)) return;
  const d = await consent({ origin, purpose });
  runtime.emit({ type: "consent", origin, decision: d ? (d === "session" ? "allowed for session" : "allowed once") : "denied" });
  if (!d) throw new OawError("CONSENT_DENIED", `You did not allow contact with ${origin}.`);
  if (d === "session") contacted.add(origin);
}

async function discoverOne(url, role) {
  const base = trimUrl(url);
  const emit = (e) => runtime.emit(e);
  const entry = { url: base, origin: originOf(base), role, name: host(base), ok: false };
  try {
    await contact(entry.origin, role === "registry" ? `Fetch the registry's public manifest, commitment root and verification key from ${host(base)}.` : `Fetch ${host(base)}'s public agent manifest, then ask it for offers that carry possession proofs.`);
    let m;
    try { m = await fetchJson(`${base}/agent-manifest.json`, { emit }); }
    catch { m = await fetchJson(`${base}/.well-known/agent-manifest.json`, { emit }); }
    entry.manifest = m;
    entry.name = m.name || entry.name;
    const net = m.networks?.[0];
    if (net?.hocon) entry.network = await fetchJson(new URL(net.hocon, `${base}/`).href, { emit });
    entry.checks = validateManifest(m, entry.network);
    entry.capabilities = m.capabilities || [];
    entry.demo_notice = m.demo_notice || null;
    entry.cors = "*";
    entry.ok = entry.checks.every((c) => c.ok);
    if (!entry.ok) entry.error = `Manifest failed: ${entry.checks.filter((c) => !c.ok).map((c) => c.check).join("; ")}`;
    if (entry.ok && role === "registry") {
      if (!entry.capabilities.includes("zk.possession.verifier_key")) throw new OawError("NOT_A_REGISTRY", "Site does not publish zk.possession.verifier_key.");
      const d = await fetchJson(new URL(m.zk?.registry_data || "registry-data.json", `${base}/`).href, { emit });
      registry = { url: base, root: d.root, verification_key: d.verification_key, circuit: d.circuit, items_certified: d.items_certified, name: d.registry };
      entry.summary = `root ${short(d.root)} · ${d.items_certified} certified items · ${d.circuit.proving_system}`;
    }
  } catch (e) { entry.ok = false; entry.error = e.message; }
  discovered.set(base, entry);
  drawPeers();
  inspector.refresh();
  return entry;
}

/* --------------------------------------------------------- agents + tools */

const req = () => deal?.requirements || {};
const agentImpl = {
  intake_agent: {
    prompt: ({ request }) => `Buyer request:\n${request}`,
    deterministic: (input) => H.intakeDeterministic(input),
    normalize: (out, input) => H.normalizeRequirements(out, input),
  },
  discovery_agent: {
    prompt: ({ requirements, vendors: v }) => `Requirements:\n${JSON.stringify(requirements)}\n\nVendors:\n${JSON.stringify(v, null, 1)}`,
    deterministic: (input) => H.discoveryDeterministic(input),
    normalize: (out, input) => H.normalizeShortlist(out, input),
  },
  verifier_agent: {
    ruleBased: true,
    async run({ offers }) {
      for (const o of offers) {
        const r = await runtime.callTool("verify_offer", { vendor_url: o.vendor_url, offer: o });
        o.verdict = r.status === "succeeded" ? r.result : { ok: false, code: "error", text: r.error || r.status };
        runtime.emit({ type: "note", agent: "verifier_agent", text: `${o.vendor_name} · ${o.item?.title}: ${o.verdict.ok ? "✓" : "✗"} ${o.verdict.text}` });
        drawDeal();
      }
      const dup = H.duplicates(offers.filter((o) => o.verdict.code !== "proof_failed")); // a failed proof's nullifier means nothing
      for (const o of dup) o.duplicate = true;
      if (dup.size) runtime.emit({ type: "note", agent: "verifier_agent", text: `${dup.size} offers share one nullifier: the same certified item is listed by ${[...new Set([...dup].map((o) => o.vendor_name))].join(" and ")}. Only the registered holder can sell it.` });
      return { verified: offers.filter((o) => o.verdict.ok).length, rejected: offers.filter((o) => !o.verdict.ok).length };
    },
  },
  image_agent: {
    prompt: ({ offers }) => `Offers:\n${JSON.stringify(offers, null, 1)}`,
    deterministic: ({ offers }) => ({ queries: offers.map((o) => ({ listing_id: o.listing_id, query: "" })) }), // empty -> the rule-based queries
    normalize: (out, { offers }) => {
      const ids = new Set(offers.map((o) => o.listing_id));
      const got = new Map((Array.isArray(out?.queries) ? out.queries : []).filter((q) => ids.has(q?.listing_id)).map((q) => [q.listing_id, String(q.query || "").replace(/["'<>:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)]));
      return { queries: offers.map((o) => ({ listing_id: o.listing_id, query: got.get(o.listing_id) || "" })) };
    },
  },
  negotiator_agent: {
    prompt: ({ price, budget, round, final, history }) => `Round ${round} of ${H.MAX_ROUNDS}. Vendor's current price: ${price}. Budget: ${budget}. Final offer: ${!!final}.\nHistory: ${JSON.stringify(history)}`,
    deterministic: (input) => H.negotiatorDeterministic(input),
    normalize: (out) => ({ action: ["accept", "counter", "walk_away"].includes(out?.action) ? out.action : "counter", counter_price: Number.isFinite(Number(out?.counter_price)) ? Number(out.counter_price) : null, message: String(out?.message || "").slice(0, 300) }),
  },
};

const tools = {
  discover: {
    effect: "read", title: "Discover registry and vendors",
    input_schema: { type: "object", properties: {} },
    async handler() {
      const reg = await discoverOne(registryUrl, "registry");
      const list = [];
      for (const url of vendors) list.push(await discoverOne(url, "vendor"));
      buildFlow();
      flow.local({ type: "handoff", from: "intake_agent", to: "discovery_agent" });
      return { registry: { ok: reg.ok && !!registry, error: reg.error || null, root: registry?.root }, vendors: list.map(({ manifest: _m, network: _n, checks: _c, ...s }) => s) };
    },
  },
  request_offers: {
    effect: "read", title: "Request proven offers",
    input_schema: { type: "object", required: ["vendor_url", "requirements"], properties: { vendor_url: { type: "string" }, requirements: { type: "object" } } },
    handler: ({ vendor_url, requirements }) => remoteTool(vendor_url, "request_offers", { requirements, buyer: buyerRef }, `Offers from ${shortName(vendor_url)}`),
  },
  check_custody: {
    effect: "read", title: "Check custody at the registry",
    input_schema: { type: "object", required: ["nullifier"], properties: { nullifier: { type: "string" } } },
    handler: ({ nullifier }) => remoteTool(registryUrl, "check_custody", { nullifier }, "Custody check"),
  },
  verify_offer: {
    effect: "read", title: "Verify possession proof",
    input_schema: { type: "object", required: ["vendor_url", "offer"], properties: { vendor_url: { type: "string" }, offer: { type: "object" } } },
    async handler({ offer }) {
      if (!registry) throw new OawError("NO_REGISTRY", "Registry data is not loaded.");
      if (typeof offer.proof !== "string" || !Array.isArray(offer.public_inputs) || offer.public_inputs.length !== PUBLIC_INPUTS.length) {
        return H.verdict({ offer, crypto: { ok: false, error: "malformed proof" }, registry, custody: null, listingField: null, req: req(), categoryCode });
      }
      const z = await warmZk();
      const crypto = await z.verify({ proof: offer.proof, publicInputs: offer.public_inputs }, registry.verification_key); // the registry's key, never the vendor's
      runtime.emit({ type: "note", agent: "verifier_agent", text: `UltraHonk verify ${crypto.ok ? "passed" : "FAILED"} in ${crypto.ms} ms for ${offer.listing_id}` });
      const custody = crypto.ok ? (await runtime.callTool("check_custody", { nullifier: String(offer.public_inputs[6]) })).result : null;
      const binding = await listingField(offer.vendor, offer.listing_id);
      return { ...H.verdict({ offer, crypto, registry, custody, listingField: binding, req: req(), categoryCode }), verify_ms: crypto.ms, custody };
    },
  },
  find_reference_image: {
    effect: "read", title: "Find a reference photo",
    input_schema: { type: "object", required: ["listing_id"], properties: { listing_id: { type: "string" }, query: { type: "string" } } },
    async handler({ listing_id, query }) {
      const o = deal?.offers.find((x) => x.listing_id === listing_id);
      if (!o) throw new OawError("NO_OFFER", `No offer ${listing_id}.`);
      const img = await findImage(o.item, query ? [query] : []);
      if (img) await preload(img.thumb);
      o.image = img || false;
      drawDeal();
      if (!img) return { found: false };
      runtime.emit({ type: "note", agent: "image_agent", text: `${o.item.title}: "${img.query}" → ${img.title} (${img.license}, ${img.author})` });
      const by = runtime.describeProvider().id === "demo" ? "the buyer's image_agent (rule-based query)" : "the buyer's image_agent";
      await rpc(o.vendor_url, "callTool", { tool: "show_reference_image", args: { listing_id, image: img, found_by: by } }).catch(() => {});
      return { found: true, title: img.title, license: img.license, author: img.author, source: img.source };
    },
  },
  send_counter_offer: {
    effect: "read", title: "Send a counter-offer",
    input_schema: { type: "object", required: ["vendor_url", "listing_id", "counter_price"], properties: { vendor_url: { type: "string" }, listing_id: { type: "string" }, counter_price: { type: "number" } } },
    handler: ({ vendor_url, listing_id, counter_price }) => remoteTool(vendor_url, "negotiate_offer", { listing_id, counter_price }, "Counter-offer"),
  },
  place_order: {
    effect: "write", title: "Buy this artifact",
    input_schema: { type: "object", required: ["vendor_url", "listing_id", "price"], properties: { vendor_url: { type: "string" }, listing_id: { type: "string" }, price: { type: "number" }, max_budget: { type: ["number", "null"] } } },
    precheck({ listing_id, price, max_budget }) {
      if (max_budget != null && price > max_budget) throw new OawError("OVER_BUDGET", `Refusing to order at ${money(price)}: your budget is ${money(max_budget)}.`);
      const o = deal?.offers.find((x) => x.listing_id === listing_id);
      if (!o?.verdict?.ok) throw new OawError("NOT_VERIFIED", "Only offers whose possession proof was verified can be ordered.");
    },
    describe({ vendor_url, listing_id, price, max_budget }) {
      const o = deal.offers.find((x) => x.listing_id === listing_id);
      const others = deal.offers.filter((x) => x !== o);
      return {
        target: originOf(vendor_url), price,
        summary: `Buy from ${o.vendor_name}. The vendor then confirms the sale and the registry records the custody transfer to you; each asks its own owner first.`,
        lines: [["Artifact", o.item.title], ["Vendor", o.vendor_name], ["Proof", `${o.verdict.text}`], ["Registry holder", o.verdict.custody?.holder || "—"], ["Nullifier", short(o.nullifier)], ...(others.length ? [["Other offers", others.map((x) => `${x.vendor_name} ${x.verdict?.ok ? money(x.price) : `(${x.verdict?.code || "unverified"})`}`).join(", ")]] : []), ["Listing", listing_id], ["Your budget", money(max_budget)], ["First price", money(deal.first_price)]],
      };
    },
    async handler({ vendor_url, listing_id, price }) {
      const o = deal.offers.find((x) => x.listing_id === listing_id);
      const sale = await remoteTool(vendor_url, "confirm_sale", { listing_id, price, buyer: buyerRef }, "Sale");
      const order = { ...sale, vendor_name: o.vendor_name, vendor_url, placed: new Date().toISOString(), transfer: "pending" };
      orders.unshift(order);
      const save = () => { localStorage.setItem(ORDERS_KEY, JSON.stringify(orders)); drawOrders(); };
      save();
      step("Transfer", "active");
      try {
        const t = await remoteTool(registryUrl, "record_transfer", { nullifier: String(o.nullifier), from: o.vendor, to: buyerRef, order_id: sale.order_id }, "Custody transfer");
        order.transfer = t.recorded ? "recorded" : "failed";
      } catch (e) { order.transfer = `not recorded (${e.message})`; }
      save();
      step("Transfer", order.transfer === "recorded" ? "done" : "failed");
      return order;
    },
  },
  list_orders: {
    effect: "read", rpc: true, title: "List orders",
    input_schema: { type: "object", properties: {} },
    handler: () => ({ orders: orders.map((o) => ({ ...o })) }),
  },
};

const runtime = new AgentRuntime({ site: "hub", manifest, network, agentImpl, tools, settingsKey: "proove.hub.settings.v1", approve });
runtime.on((e) => { stream.add(e); flow.local(e); });

/* ------------------------------------------------------------- deal flow */

const STEPS = ["Intake", "Discover", "Offers", "Verify", "Choose", "Negotiate", "Approve", "Transfer"];
function step(name, state) { if (deal) { deal.steps[name] = state; drawDeal(); } }
const ok = (r, what) => { if (r.status === "succeeded") return r.result; throw new OawError(r.code || "TOOL_FAILED", `${what}: ${r.error || r.status}`); };

function awaitChoice(options) {
  return new Promise((resolve) => {
    deal.choice = { options, resolve: (o, by) => { deal.choice = null; resolve({ offer: o, by }); } };
    drawDeal();
    $("#deal").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}
function chooseOffer(which) {
  const c = deal?.choice;
  if (!c) throw new OawError("NO_CHOICE", "There is no comparison waiting for a choice.");
  if (which === "agent") return c.resolve(H.rankOffers(c.options, deal.requirements.max_budget)[0], "agent");
  const o = typeof which === "number" ? c.options[which] : c.options.find((x) => x.listing_id === which || x.vendor_url === trimUrl(which));
  if (!o) throw new OawError("BAD_CHOICE", `No verified offer ${which}.`);
  c.resolve(o, "you");
}

async function runDeal(prompt) {
  if (busy) throw new OawError("BUSY", "A request is already running.");
  busy = true;
  setBusy(true);
  deal = { prompt, steps: {}, requirements: null, vendorRows: [], offers: [], choice: null, chosen: null, history: [], first_price: null, result: null };
  for (const f of frames.values()) f.wrap.classList.remove("chosen", "rejected");
  drawDeal();
  runtime.emit({ type: "run_start", prompt });
  warmZk().catch(() => {});
  try {
    step("Intake", "active");
    const requirements = await runtime.runAgent("intake_agent", { request: prompt }, { from: "user" });
    deal.requirements = requirements;
    step("Intake", "done");

    step("Discover", "active");
    const found = ok(await runtime.callTool("discover", {}), "Discovery");
    if (!found.registry.ok) throw new OawError("NO_REGISTRY", `The registry could not be read: ${found.registry.error || "no verification key"}. Without it no proof can be checked.`);
    const eligible = found.vendors.filter((v) => v.ok && v.capabilities.includes(manifest.peers.required_capability));
    if (!eligible.length) throw new OawError("NO_VENDOR", `No vendor publishes ${manifest.peers.required_capability}. ${found.vendors.map((v) => `${v.name}: ${v.error || "missing capability"}`).join("; ")}`);
    const pick = await runtime.runAgent("discovery_agent", { requirements, vendors: eligible.map(({ url, name, capabilities }) => ({ url, name, capabilities })) }, { from: "intake_agent" });
    const shortlist = pick.shortlist.map((u) => eligible.find((v) => v.url === u)).filter(Boolean);
    runtime.emit({ type: "note", agent: "discovery_agent", text: `Registry ${short(registry.root)} · shortlisted ${shortlist.map((v) => shortName(v.url)).join(", ")}: ${pick.reason}` });
    step("Discover", "done");

    step("Offers", "active");
    openSplit([registryUrl, ...shortlist.map((v) => v.url)]); // every site runs its own agents side by side
    deal.vendorRows = shortlist.map((v) => ({ url: v.url, name: v.name, pending: true, error: null, count: 0 }));
    drawDeal();
    await Promise.all(deal.vendorRows.map(async (row) => {
      try {
        const r = ok(await runtime.callTool("request_offers", { vendor_url: row.url, requirements }), `Offers from ${shortName(row.url)}`);
        for (const o of r.offers || []) deal.offers.push({ ...o, vendor_url: row.url, vendor_name: o.vendor_name || row.name, verdict: null });
        row.count = (r.offers || []).length;
      } catch (e) { row.error = e.message; }
      row.pending = false;
      drawDeal();
    }));
    if (!deal.offers.length) throw new OawError("NO_OFFERS", `No vendor offered a matching certified item. ${deal.vendorRows.map((r) => `${shortName(r.url)}: ${r.error || "nothing matches"}`).join("; ")}`);
    runtime.emit({ type: "note", text: `${deal.offers.length} offers, each with a possession proof: ${deal.offers.map((o) => `${shortName(o.vendor_url)} ${money(o.price)}`).join(" · ")}` });
    step("Offers", "done");

    step("Verify", "active");
    runtime.emit({ type: "handoff", from: "discovery_agent", to: "verifier_agent" });
    const v = await runtime.runAgent("verifier_agent", { offers: deal.offers }, { from: "discovery_agent" });
    for (const [key, f] of frames) {
      const mine = deal.offers.filter((o) => o.vendor_url === key);
      f.wrap.classList.toggle("rejected", mine.length > 0 && mine.every((o) => !o.verdict.ok));
    }
    const options = deal.offers.filter((o) => o.verdict.ok);
    for (const r of deal.vendorRows) { const mine = deal.offers.filter((o) => o.vendor_url === r.url); if (mine.length) flow.verdict(r.url, mine.some((o) => o.verdict.ok)); }
    runtime.emit({ type: "note", agent: "verifier_agent", text: `${v.verified} verified, ${v.rejected} rejected.` });
    try { // reference photos: nice to have, never blocks the deal
      runtime.emit({ type: "handoff", from: "verifier_agent", to: "image_agent" });
      const qs = await runtime.runAgent("image_agent", { offers: deal.offers.map((o) => ({ listing_id: o.listing_id, title: o.item?.title, category: o.item?.category })) }, { from: "verifier_agent" });
      await Promise.all(qs.queries.map((q) => runtime.callTool("find_reference_image", q)));
    } catch (e) { runtime.emit({ type: "note", agent: "image_agent", text: `Reference photos skipped: ${e.message}` }); }
    step("Verify", options.length ? "done" : "failed");
    if (!options.length) {
      deal.result = { ok: false, text: "No offer passed verification. Nothing can be bought safely." };
      runtime.emit({ type: "run_end", ok: false, error: deal.result.text });
      return deal.result;
    }

    step("Choose", "active");
    runtime.emit({ type: "handoff", from: "verifier_agent", to: "negotiator_agent" });
    let chosen;
    if (options.length === 1) { chosen = { offer: options[0], by: "only verified offer" }; runtime.emit({ type: "note", text: `Only ${options[0].vendor_name}'s offer is verified; continuing with it.` }); }
    else {
      runtime.emit({ type: "approval", state: "pending", tool: "choose_offer" });
      chosen = await awaitChoice(options);
      runtime.emit({ type: "approval", state: "approved", tool: `choose_offer → ${chosen.offer.vendor_name} (picked by ${chosen.by})` });
    }
    const o = chosen.offer;
    deal.chosen = o;
    deal.first_price = o.price;
    deal.history.push({ by: "vendor", price: o.price, note: "listed price" });
    for (const [key, f] of frames) f.wrap.classList.toggle("chosen", key === o.vendor_url);
    flow.chosen(o.vendor_url);
    if (o.image) rpc(o.vendor_url, "callTool", { tool: "show_reference_image", args: { listing_id: o.listing_id, image: o.image } }).catch(() => {});
    step("Choose", "done");

    step("Negotiate", "active");
    const budget = deal.requirements.max_budget;
    let cur = { price: o.price, final: false, accepted: false }, accepted = false;
    for (let round = 1; round <= H.MAX_ROUNDS + 1 && !accepted; round++) {
      const d = await runtime.runAgent("negotiator_agent", { price: cur.price, budget, round, final: cur.final, history: deal.history }, { from: round === 1 ? "verifier_agent" : `sales_agent@${shortName(o.vendor_url)}` });
      const dec = H.enforceBuyerPolicy(d, { price: cur.price, budget, final: cur.final, round });
      if (dec.policy) runtime.emit({ type: "note", agent: "negotiator_agent", text: `Buyer policy: ${dec.policy}` });
      if (dec.action === "accept") { accepted = true; runtime.emit({ type: "negotiation", text: `Buyer accepts ${money(cur.price)}` }); break; }
      if (dec.action === "walk_away") { runtime.emit({ type: "negotiation", text: `Buyer walks away at ${money(cur.price)} (budget ${money(budget)})` }); break; }
      runtime.emit({ type: "negotiation", text: `Buyer counters ${money(dec.counter_price)}${dec.message ? `: “${dec.message}”` : ""}` });
      deal.history.push({ by: "buyer", price: dec.counter_price, note: dec.message });
      cur = ok(await runtime.callTool("send_counter_offer", { vendor_url: o.vendor_url, listing_id: o.listing_id, counter_price: dec.counter_price }), "Counter-offer");
      o.price = cur.price;
      deal.history.push({ by: "vendor", price: cur.price, note: cur.accepted ? "accepted" : cur.final ? "final offer" : cur.message || "counter" });
      drawDeal();
      if (cur.accepted) accepted = true;
    }
    step("Negotiate", accepted ? "done" : "failed");
    if (!accepted) {
      deal.result = { ok: false, text: `No deal. ${o.vendor_name}'s price of ${money(o.price)} stays above your budget of ${money(budget)}.` };
      runtime.emit({ type: "run_end", ok: false, error: deal.result.text });
      return deal.result;
    }

    step("Approve", "active");
    const r = await runtime.callTool("place_order", { vendor_url: o.vendor_url, listing_id: o.listing_id, price: o.price, max_budget: budget });
    if (r.status === "declined") {
      step("Approve", "failed");
      deal.result = { ok: false, text: "You rejected the order. Nothing was bought." };
      runtime.emit({ type: "run_end", ok: false, error: deal.result.text });
      return deal.result;
    }
    if (r.status !== "succeeded") { step("Approve", "failed"); throw new OawError(r.code || "ORDER_FAILED", r.error); }
    step("Approve", "done");
    const ord = r.result;
    deal.result = ord.transfer === "recorded"
      ? { ok: true, order: ord, text: `Bought: ${ord.title} from ${ord.vendor_name} for ${money(ord.price)} · order ${ord.order_id} · the registry now lists you (${buyerRef}) as the holder.` }
      : { ok: false, order: ord, text: `Order ${ord.order_id} placed, but the custody transfer was ${ord.transfer}.` };
    runtime.emit({ type: "run_end", ok: deal.result.ok, summary: deal.result.text, error: deal.result.ok ? undefined : deal.result.text });
    return deal.result;
  } catch (e) {
    deal.result = { ok: false, text: `${e.code || "ERROR"}: ${e.message}` };
    for (const s of STEPS) if (deal.steps[s] === "active") deal.steps[s] = "failed";
    runtime.emit({ type: "run_end", ok: false, error: deal.result.text });
    throw e;
  } finally {
    busy = false;
    setBusy(false);
    $("#splitAttention").hidden = true;
    drawDeal();
  }
}

/* -------------------------------------------------------------------- UI */

function setBusy(b) {
  $("#runBtn").disabled = b;
  $("#request").disabled = b;
  $("#runBtn").textContent = b ? "Agents working…" : "Find proven offers";
}
const kv = (rows) => h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })]));
const catLabel = (code) => CATEGORIES[code]?.label || `category ${code}`;

function drawDeal() {
  const el = $("#deal");
  if (!deal) { el.replaceChildren(h("p", { class: "oaw-muted", text: "Describe the artifact you want. Vendors answer with offers that carry zero-knowledge proofs of possession; the hub verifies each one against the registry before you can buy." })); return; }
  const r = deal.requirements, o = deal.chosen;
  el.replaceChildren(...[
    h("ol", { class: "steps" }, ...STEPS.map((s) => h("li", { class: deal.steps[s] || "todo", text: s }))),
    r ? h("div", { class: "card" }, h("p", { class: "kicker", text: "Requirements · intake_agent" }),
      kv([["Categories", r.categories.length ? r.categories.map((c) => catLabel(categoryCode(c))).join(", ") : "any"], ["Minimum mass", r.min_measure != null ? `${r.min_measure} g` : "—"], ["Certified since", r.min_year ?? "—"], ["Edition size", r.max_edition_size != null ? `at most ${r.max_edition_size}` : "—"], ["Budget", money(r.max_budget)]])) : null,
    deal.vendorRows.length ? drawOffers() : null,
    o ? h("div", { class: "card" },
      h("div", { class: "qrow" }, h("div", {}, h("p", { class: "kicker", text: deal.steps.Negotiate === "done" ? "Agreed price" : "Current price" }), h("p", { class: "price", text: money(o.price) }), deal.first_price && deal.first_price !== o.price ? h("p", { class: "oaw-muted small", text: `Listed ${money(deal.first_price)} · saved ${money(deal.first_price - o.price)}` }) : null),
        kv([["Artifact", o.item.title], ["Vendor", o.vendor_name], ["Proof", o.verdict.text]])),
      deal.history.length > 1 ? h("ol", { class: "hist" }, ...deal.history.map((x) => h("li", { class: x.by, text: `${x.by === "buyer" ? "You" : o.vendor_name}: ${money(x.price)}${x.note ? ` · ${x.note}` : ""}` }))) : null) : null,
    deal.result ? h("p", { class: `result ${deal.result.ok ? "ok" : "bad"}`, text: deal.result.text }) : null,
  ].filter(Boolean));
}

// One <img> element per photo URL, reused across re-renders, so a redraw never restarts a download.
const photoEls = new Map();
const photoEl = (img) => { let e = photoEls.get(img.thumb); if (!e) { e = h("img", { src: img.thumb, alt: `Reference photo: ${img.title}` }); photoEls.set(img.thumb, e); } return e; };

/** Offer cards: what each proof proves, the verifier's verdict, and the buttons while a choice is pending. */
function drawOffers() {
  const budget = deal.requirements?.max_budget;
  const waiting = !!deal.choice;
  const best = waiting ? H.rankOffers(deal.choice.options, budget)[0] : null;
  const pending = deal.vendorRows.filter((r) => r.pending || r.error || (!r.pending && !r.count));
  return h("div", { class: "compare" },
    h("p", { class: "kicker", text: waiting ? "Choose a verified offer · rejected offers cannot be bought" : `Offers · ${deal.offers.length} received from ${deal.vendorRows.length} vendor${deal.vendorRows.length > 1 ? "s" : ""}` }),
    pending.length ? h("p", { class: "oaw-muted small", text: pending.map((r) => `${shortName(r.url)}: ${r.pending ? "matching and generating proofs…" : r.error || "no matching certified item"}`).join(" · ") }) : null,
    h("div", { class: "ogrid" }, ...deal.offers.map((x) => {
      const v = x.verdict;
      const pi = v?.inputs || {};
      const chosen = deal.chosen === x;
      const idx = waiting ? deal.choice.options.indexOf(x) : -1;
      const proven = [catLabel(big(pi.category ?? x.public_inputs?.[1])), big(pi.min_measure) ? `≥ ${big(pi.min_measure)} g` : null, big(pi.min_year) ? `certified ≥ ${big(pi.min_year)}` : null, big(pi.edition_size) > 1 ? `edition of ${big(pi.edition_size)}` : "one of a kind"].filter(Boolean);
      return h("div", { class: `ocard ${v ? (v.ok ? "ok" : "bad") : ""} ${chosen ? "chosen" : ""} ${deal.chosen && !chosen ? "passed" : ""}` },
        x.image ? h("figure", { class: "ophoto" }, photoEl(x.image), h("figcaption", {}, "Reference photo, not the item · ", h("a", { href: x.image.source, target: "_blank", rel: "noopener", text: x.image.author }), ` · ${x.image.license}`)) : x.image === false ? h("p", { class: "oaw-muted small", text: "No openly licensed reference photo found." }) : null,
        h("p", { class: "oshop", text: x.vendor_name }),
        h("p", { class: "otitle", text: x.item?.title || x.listing_id }),
        h("p", { class: "price", text: money(x.price) }),
        h("span", { class: `badge-zk ${!v ? "pending" : v.ok ? "ok" : v.code === "proof_failed" ? "bad" : "warn"}`, text: !v ? "Waiting for verification" : v.ok ? "✓ Verified holder" : `✗ ${({ proof_failed: "Proof failed", wrong_root: "Wrong registry", not_bound: "Copied proof", nullifier_mismatch: "Nullifier mismatch", claims: "Claims not met", unknown_item: "Not registered", sold: "Already sold", not_holder: "Duplicate item" })[v.code] || "Rejected"}` }),
        v ? h("p", { class: "verdict", text: v.text }) : null,
        h("div", { class: "tags" },
          ...proven.map((t) => h("span", { class: "tag", text: t })),
          budget != null ? h("span", { class: `tag ${x.price <= budget ? "ok" : "bad"}`, text: x.price <= budget ? "Within budget" : `Over budget by ${money(x.price - budget)}` }) : null,
          x.duplicate ? h("span", { class: "tag warn", text: "Same nullifier as another offer" }) : null),
        h("details", { class: "pi" }, h("summary", { text: `Proof details · ${Math.round((x.proof.length * 3) / 4 / 1024)} KB · proved in ${x.prove_ms} ms${v?.verify_ms != null ? ` · verified in ${v.verify_ms} ms` : ""}` }),
          h("pre", { text: JSON.stringify({ listing: x.listing_id, public_inputs: Object.fromEntries(PUBLIC_INPUTS.map((k, i) => [k, x.public_inputs?.[i]])), stated_nullifier: x.nullifier, registry_custody: v?.custody || null }, null, 1) })),
        waiting && idx >= 0 ? h("button", { class: "oaw-btn primary", type: "button", text: "Choose this offer", "aria-label": `Choose ${x.vendor_name} at ${money(x.price)}`, onclick: () => chooseOffer(idx) }) : null,
        waiting && x === best ? h("p", { class: "oaw-muted small", text: "Agent's pick: verified, within budget, then lowest price." }) : null,
        chosen ? h("p", { class: "small chosen-note", text: "✓ Chosen" }) : null);
    })),
    waiting ? h("div", { class: "oaw-row" }, h("button", { class: "oaw-btn ghost", type: "button", text: "Let the agent pick", onclick: () => chooseOffer("agent") })) : null);
}

function drawPeers() {
  const row = (url, role) => {
    const d = discovered.get(url);
    const status = !d ? "not checked" : d.ok ? (role === "registry" ? `✓ ${d.summary || "manifest valid"}` : `✓ ${d.capabilities.includes("zk.possession.prover") ? "publishes zk.possession.prover" : "no zk.possession.prover"}${d.demo_notice ? " · demo: dishonest vendor" : ""}`) : `✗ ${d.error}`;
    return h("li", { class: d ? (d.ok ? "ok" : "bad") : "" },
      h("div", {}, h("p", { class: "role", text: role }), h("strong", { text: d?.name || host(url) }), h("p", { class: "oaw-muted small", text: url }), h("p", { class: "small status", text: status })),
      h("div", { class: "oaw-row" },
        h("button", { class: "oaw-btn small", type: "button", text: "Check", onclick: () => discoverOne(url, role).catch(() => {}) }),
        role === "registry" || published.includes(url) ? h("span", { class: "oaw-badge", text: "published", title: "Listed in this hub's agent-manifest.json" }) : h("button", { class: "oaw-btn small ghost", type: "button", text: "Remove", "aria-label": `Remove ${url}`, onclick: () => { custom = custom.filter((x) => x !== url); vendors = vendors.filter((x) => x !== url); saveCustom(); drawPeers(); } })));
  };
  $("#peers").replaceChildren(row(registryUrl, "registry"), ...vendors.map((u) => row(u, "vendor")));
}
$("#addVendor").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = trimUrl($("#vendorUrl").value.trim());
  try {
    const u = new URL(v);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error();
    if (u.protocol === "http:" && !isLoopback(v)) throw new Error("Use https:// for live sites (http:// only for localhost).");
    if (!pageIsLocal && isLoopback(v)) throw new Error("This hub is public; a localhost vendor only works when the hub itself runs on localhost (npm start).");
  } catch (err) { $("#vendorMsg").textContent = err.message || "Enter a valid http(s) URL."; return; }
  $("#vendorMsg").textContent = "";
  if (!vendors.includes(v)) { vendors.push(v); if (!published.includes(v)) { custom.push(v); saveCustom(); } }
  $("#vendorUrl").value = "";
  drawPeers();
});

function drawOrders() {
  $("#orders").replaceChildren(...(orders.length ? orders.map((o) => h("li", {}, h("strong", { text: o.order_id }), ` · ${o.title} · ${money(o.price)} · ${o.vendor_name} · custody transfer ${o.transfer}`)) : [h("li", { class: "oaw-muted", text: "No orders yet." })]));
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#request").value.trim();
  if (v) runDeal(v).catch(() => { /* shown in the stream and the deal panel */ });
});
for (const ex of [
  "A certified meteorite fragment, at least 50 g, budget $520",
  "A rare mineral specimen certified since 2020, budget $900",
  "A limited-edition artwork, edition of 50 or fewer, budget $1,100",
]) $("#examples").append(h("button", { class: "chip", type: "button", text: ex, onclick: () => { $("#request").value = ex; $("#request").focus(); } }));

/* ---------------------------------------------------- settings + inspector */

createStatusPill($("#pill"), runtime);
const settings = createSettings({ runtime, onSaved: () => lendAll() });
$("#settingsBtn").addEventListener("click", () => settings.open());
const inspector = createInspector({
  getEntries: () => [
    { label: "This hub", url: new URL("agent-manifest.json", location.href).href, manifest, network, cors: "*" },
    ...[...discovered.values()].map((d) => ({ label: d.name, url: `${d.url}/agent-manifest.json`, manifest: d.manifest, network: d.network, cors: d.cors, error: d.error })),
  ],
});
$("#manifestBtn").addEventListener("click", () => inspector.open());

/* ------------------------------------------------------- interoperability */

const offerView = (o) => ({ vendor: o.vendor, vendor_name: o.vendor_name, listing_id: o.listing_id, title: o.item?.title, price: o.price, nullifier: o.nullifier, verdict: o.verdict && { ok: o.verdict.ok, code: o.verdict.code, text: o.verdict.text } });
function getState() {
  return {
    site: "proove-hub", busy, buyer: buyerRef, provider: runtime.describeProvider(),
    registry: registry && { url: registry.url, root: registry.root, items_certified: registry.items_certified },
    vendors: vendors.map((u) => { const d = discovered.get(u); return { url: u, name: d?.name, ok: d?.ok ?? null, error: d?.error || null }; }),
    deal: deal && { prompt: deal.prompt, steps: deal.steps, requirements: deal.requirements, offers: deal.offers.map(offerView), awaiting_choice: !!deal.choice, chosen: deal.chosen && offerView(deal.chosen), history: deal.history, result: deal.result },
    orders: orders.map((o) => ({ ...o })), stats: { ...runtime.stats },
  };
}
serveRpc({
  runtime,
  trustedOrigins: manifest.rpc.trusted_origins || [],
  consent: (r) => consent({ ...r, direction: "inbound" }),
  methods: {
    ping: () => ({ site: "proove-hub", name: manifest.name, ready: true, provider: runtime.describeProvider().label }),
    manifest: () => manifest,
    getState: () => getState(),
    run: ({ prompt }) => runDeal(String(prompt || "")),
    callTool: ({ tool, args }, ctx) => runtime.callTool(String(tool), args || {}, ctx),
  },
});
exposeGlobal({
  manifest,
  run: (prompt) => runDeal(prompt),
  callTool: (name, args) => runtime.callTool(name, args, { origin: location.origin }),
  getState,
  extra: { openSplitView: (url) => openSplit(url || [registryUrl, ...vendors]), chooseOffer: (which) => chooseOffer(which) },
});

/* ----------------------------------------------------------------- boot */

drawDeal();
drawPeers();
drawOrders();
buildFlow();
await runtime.probeNano();
stream.add({ type: "note", text: `Build ${BUILD} · network "${network.metadata.name}" · ${runtime.describeProvider().label} · registry ${host(registryUrl)}${new URL(registryUrl).pathname.replace(/\/$/, "")} · vendors: ${vendors.map((u) => host(u) + new URL(u).pathname.replace(/\/$/, "")).join(", ")} · you are ${buyerRef}` });
if (skipped.length) stream.add({ type: "note", text: `Ignored saved localhost vendor(s) on this public page: ${skipped.join(", ")}` });
setTimeout(() => warmZk().catch(() => {}), 800);
document.body.dataset.ready = "true";
