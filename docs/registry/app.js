/**
 * Proove Artifact Registry: publishes the commitment root and verification key, answers custody checks,
 * and records custody transfers (with the registry owner's approval).
 */
import { AgentRuntime, serveRpc, exposeGlobal, OawError } from "../shared/oaw-core.js?v=183292c3d7";
import { h, $, createStream, createApproval, createConsent, createSettings, createStatusPill, createInspector } from "../shared/oaw-ui.js?v=183292c3d7";

const BUILD = document.querySelector('meta[name="oaw-build"]')?.content || "dev";
const embedded = window.parent !== window || new URLSearchParams(location.search).has("embedded");
document.body.classList.toggle("embedded", embedded);
const get = async (f) => (await fetch(`./${f}`, { cache: "no-store" })).json();
const [manifest, network, data, seed] = await Promise.all([get("agent-manifest.json"), get("registry.network.json"), get("registry-data.json"), get("custody.json")]);

// Custody lives in this browser (a static site has no database). Seeded from custody.json for this root.
const KEY = `proove.registry.custody.${data.root.slice(2, 14)}`;
const load = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); return Array.isArray(v) ? v : null; } catch { return null; } };
let custody = load() || seed.records.map((r) => ({ ...r, changed: data.issued }));
const save = () => localStorage.setItem(KEY, JSON.stringify(custody));
const short = (n) => `${String(n).slice(0, 10)}…${String(n).slice(-6)}`;
const find = (nullifier) => custody.find((r) => { try { return BigInt(r.nullifier) === BigInt(nullifier); } catch { return false; } });
let flashed = null;

const stream = createStream($("#stream"));
const approve = createApproval();
const consent = createConsent();

function draw() {
  $("#facts").replaceChildren(...[
    ["Commitment root", data.root],
    ["Items certified", String(data.items_certified)],
    ["Categories", data.categories.join(", ").replaceAll("_", " ")],
    ["Circuit", `${data.circuit.name} · ${data.circuit.proving_system}`],
    ["Circuit SHA-256", data.circuit.sha256],
    ["Verification key", `${Math.round((data.verification_key.length * 3) / 4)} bytes · in registry-data.json`],
  ].flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { class: /root|SHA/.test(k) ? "mono" : "", text: v })]));
  $("#custodyCount").textContent = `${custody.filter((r) => r.status === "held").length} held · ${custody.filter((r) => r.status === "transferred").length} transferred`;
  $("#custody").replaceChildren(...custody.map((r) => h("tr", { class: r.nullifier === flashed ? "flash" : "" },
    h("td", { class: "mono", text: short(r.nullifier), title: r.nullifier }),
    h("td", { text: r.holder }),
    h("td", { class: `st-${r.status}`, text: r.status }),
    h("td", { class: "oaw-muted", text: r.changed || "" }))));
}

const tools = {
  get_registry: {
    effect: "read", rpc: true, title: "Registry facts",
    input_schema: { type: "object", properties: {} },
    handler: () => ({ registry: data.registry, root: data.root, depth: data.depth, items_certified: data.items_certified, categories: data.categories, circuit: data.circuit, verification_key: data.verification_key }),
  },
  check_custody: {
    effect: "read", rpc: true, title: "Check custody",
    input_schema: { type: "object", required: ["nullifier"], properties: { nullifier: { type: "string" } } },
    handler({ nullifier }) {
      const r = find(nullifier);
      return r ? { registered: true, holder: r.holder, status: r.status, changed: r.changed } : { registered: false };
    },
  },
  record_transfer: {
    effect: "write", rpc: true, title: "Record custody transfer",
    input_schema: { type: "object", required: ["nullifier", "from", "to", "order_id"], properties: { nullifier: { type: "string" }, from: { type: "string" }, to: { type: "string" }, order_id: { type: "string" } } },
    precheck({ nullifier, from }) {
      const r = find(nullifier);
      if (!r) throw new OawError("UNKNOWN_ITEM", "No certified item has this nullifier.");
      if (r.status !== "held") throw new OawError("ALREADY_TRANSFERRED", `This item was already transferred to ${r.holder}.`);
      if (r.holder !== from) throw new OawError("NOT_HOLDER", `The registered holder is ${r.holder}, not ${from}.`);
    },
    describe({ nullifier, from, to, order_id }) {
      return { summary: "Move this certified item from the vendor to the buyer. Afterwards no vendor can list it again.", lines: [["Nullifier", short(nullifier)], ["From (holder)", from], ["To (buyer)", to], ["Order", order_id]] };
    },
    handler({ nullifier, to, order_id }) {
      const r = find(nullifier);
      Object.assign(r, { holder: to, status: "transferred", changed: new Date().toISOString().slice(0, 10), order_id });
      flashed = r.nullifier;
      save(); draw();
      return { recorded: true, nullifier: r.nullifier, holder: r.holder, status: r.status, order_id };
    },
  },
};

const agentImpl = {
  registry_clerk: {
    ruleBased: true,
    async run({ nullifier }) {
      return nullifier ? (await runtime.callTool("check_custody", { nullifier })).result : (await runtime.callTool("get_registry", {})).result;
    },
  },
};

const runtime = new AgentRuntime({ site: "registry", manifest, network, agentImpl, tools, settingsKey: "proove.registry.settings.v1", approve });
runtime.on((e) => stream.add(e));
createStatusPill($("#pill"), runtime);
const settings = createSettings({ runtime });
$("#settingsBtn").addEventListener("click", () => settings.open());
const inspector = createInspector({ getEntries: () => [{ label: "This registry", url: new URL("agent-manifest.json", location.href).href, manifest, network, cors: "*" }] });
$("#manifestBtn").addEventListener("click", () => inspector.open());

const getState = () => ({ site: "registry", root: data.root, custody: custody.map((r) => ({ ...r })), stats: { ...runtime.stats } });
serveRpc({
  runtime,
  trustedOrigins: manifest.rpc.trusted_origins || [],
  consent: (r) => consent({ ...r, direction: "inbound" }),
  methods: {
    ping: () => ({ site: "registry", name: manifest.name, ready: true, provider: "deterministic registry clerk" }),
    manifest: () => manifest,
    getState: () => getState(),
    run: ({ nullifier }, ctx) => runtime.runAgent("registry_clerk", { nullifier }, { from: ctx.origin }),
    callTool: ({ tool, args }, ctx) => runtime.callTool(String(tool), args || {}, ctx),
  },
});
exposeGlobal({ manifest, run: (q) => runtime.runAgent("registry_clerk", typeof q === "string" ? { nullifier: q } : q || {}), callTool: (n, a) => runtime.callTool(n, a, { origin: location.origin }), getState });

draw();
stream.add({ type: "note", text: `Build ${BUILD} · registry root ${short(data.root)} · ${data.items_certified} certified items · ${custody.length} custody records` });
document.body.dataset.ready = "true";
