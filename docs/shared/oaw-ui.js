/**
 * oaw-ui.js: shared UI for both sites. All model/peer text is rendered with textContent, never as HTML.
 */
import { OTARI_REGIONS, OTARI_MODELS, validateManifest, testOtari, listOtariModels, cleanApiKey } from "./oaw-core.js?v=ca5ca22601";

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const money = (v, cur = "USD") => (v == null || !Number.isFinite(Number(v)) ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(Number(v)));

/* ------------------------------------------------------------- telemetry */

export function telemetryText(t) {
  const parts = [t.provider];
  if (t.model && t.provider === "otari") parts.push(t.model);
  parts.push(`${t.ms}ms`);
  if (t.route) parts.push({ local: "hybrid→local", cloud: "hybrid→cloud", fallback: "fallback" }[t.route] || t.route);
  if (t.tokens_in || t.tokens_out) parts.push(`${(t.tokens_in || 0) + (t.tokens_out || 0)} tok${t.estimated ? " est." : ""}`);
  if (t.simulated) parts.push("simulated");
  if (t.cost === 0) parts.push("$0.00");
  else if (typeof t.cost === "number") parts.push(`$${t.cost.toFixed(4)}`);
  return `[${parts.join(" • ")}]`;
}

/* -------------------------------------------------------- execution stream */

export function createStream(root, { title = "Agent Network Execution Stream" } = {}) {
  const chainEl = h("div", { class: "oaw-chain", "aria-label": "Current agent chain" });
  const list = h("div", { class: "oaw-stream-list", role: "log", "aria-live": "polite" });
  const head = h("div", { class: "oaw-stream-head" }, h("h2", { text: title }), h("button", { class: "oaw-btn ghost small", type: "button", text: "Clear", onclick: () => { list.replaceChildren(); chain = []; drawChain(); } }));
  root.replaceChildren(head, chainEl, list);
  let chain = [];
  const drawChain = () => {
    chainEl.replaceChildren(...[chain.length ? h("span", { class: "oaw-muted", text: "Chain " }) : null, ...chain.flatMap((c, i) => [i ? h("span", { class: "oaw-arrow", text: "→" }) : null, h("span", { class: `oaw-agent ${c.remote ? "remote" : ""}`, text: c.name, title: c.remote || "" })])].filter(Boolean));
  };
  const push = (el) => { list.append(el); list.scrollTop = list.scrollHeight; return el; };
  const line = (cls, ...kids) => push(h("div", { class: `oaw-ev ${cls}` }, ...kids));
  const tag = (remote) => (remote ? h("span", { class: "oaw-remote", text: remote }) : null);

  function add(ev, { remote = null } = {}) {
    const r = tag(remote);
    switch (ev.type) {
      case "run_start":
        if (!remote) { chain = []; drawChain(); }
        return line("run", r, h("strong", { text: "▶ " }), h("span", { text: ev.prompt || ev.label || "run" }));
      case "run_end":
        return line(ev.ok ? "ok" : "bad", r, h("span", { text: ev.ok ? `✓ ${ev.summary || "done"}` : `✗ ${ev.error}` }));
      case "handoff": {
        const last = chain[chain.length - 1];
        if (!chain.length && ev.from && ev.from !== "user") chain.push({ name: ev.from, remote });
        if (!last || last.name !== ev.to) chain.push({ name: ev.to, remote });
        drawChain();
        return line("handoff", r, h("span", { text: "[" }), h("span", { class: "oaw-agent", text: ev.from }), h("span", { class: "oaw-arrow", text: " → " }), h("span", { class: "oaw-agent", text: ev.to }), h("span", { text: "]" }));
      }
      case "telemetry":
        return line("telemetry", r, h("span", { class: "oaw-agent small", text: ev.agent }), h("code", { class: `oaw-tel ${ev.provider}`, text: telemetryText(ev) }));
      case "agent_output":
        return push(h("details", { class: "oaw-ev output" }, h("summary", {}, r, `${ev.agent} output`), h("pre", { text: JSON.stringify(ev.output, null, 2) })));
      case "fetch":
        return line(ev.ok ? "fetch" : "bad", r, h("code", { text: `GET ${ev.url}` }), h("span", { class: "oaw-muted", text: ` ${ev.status || "ERR"} · ${ev.ms}ms${ev.cors ? ` · CORS ${ev.cors}` : ""}${ev.error ? ` · ${ev.error}` : ""}` }));
      case "rpc":
        return line("rpc", r, h("span", { text: ev.direction === "in" ? "⇠ RPC from " : "⇢ RPC to " }), h("code", { text: ev.origin }), h("span", { text: ` ${ev.method}${ev.tool ? ` ${ev.tool}` : ""}${ev.ms != null ? ` · ${ev.ms}ms` : ""}${ev.ok === false ? " · failed" : ""}` }));
      case "tool": {
        if (ev.state === "start") return line("tool", r, h("span", { class: `oaw-badge ${ev.effect}`, text: `${ev.effect}` }), h("code", { text: `${ev.tool}(${short(ev.args)})` }), ev.caller ? h("span", { class: "oaw-muted", text: ` · from ${ev.caller}` }) : null);
        const icon = { ok: "✓", failed: "✗", declined: "⊘" }[ev.state] || "";
        return line(ev.state === "ok" ? "ok" : "bad", r, h("span", { text: `${icon} ${ev.tool} ${ev.state}${ev.error ? `: ${ev.error}` : ""}` }));
      }
      case "approval":
        return line(ev.state === "rejected" ? "bad" : ev.state === "approved" ? "ok" : "warn", r, h("span", { text: ev.state === "pending" ? `⏸ Waiting for human approval: ${ev.tool}${ev.price != null ? ` (${money(ev.price)})` : ""}` : `${ev.state === "approved" ? "✓ Approved" : "✗ Rejected"} by the user: ${ev.tool}` }));
      case "consent":
        return line(ev.decision === "denied" ? "bad" : "muted", r, h("span", { text: `consent ${ev.decision}: ${ev.origin}${ev.direction === "inbound" ? " (inbound)" : ""}` }));
      case "fallback":
        return line("warn", r, h("span", { text: `↯ ${ev.from} → ${ev.to}${ev.agent ? ` for ${ev.agent}` : ""}: ${ev.reason}` }));
      case "note":
        return line("muted", r, h("span", { text: `${ev.agent ? `${ev.agent}: ` : ""}${ev.text}` }));
      case "error":
        return line("bad", r, h("span", { text: `✗ ${ev.text}` }));
      case "negotiation":
        return line("nego", r, h("span", { text: ev.text }));
      default:
        return null;
    }
  }
  return { add, el: root };
}
const short = (o) => { const s = JSON.stringify(o ?? {}); return s.length > 110 ? s.slice(0, 110) + "…" : s; };

/* ------------------------------------------------------- approval / consent */

function modal(cls) {
  const d = h("dialog", { class: `oaw-modal ${cls}` });
  document.body.append(d);
  return d;
}

/** Approve Action? modal. One request at a time; extra requests wait in line. */
export function createApproval() {
  const dlg = modal("oaw-approval");
  let chain = Promise.resolve();
  const ask = (req) => new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    const rows = [
      ["Action", req.title || req.tool],
      ["Tool", req.tool],
      ["Target origin", req.target],
      req.caller && req.caller !== req.target ? ["Requested by", req.caller] : null,
      req.price != null ? ["Price", money(req.price, req.currency)] : null,
      ...(req.lines || []),
      ["Request id", req.requestId],
    ].filter(Boolean);
    const approveBtn = h("button", { class: "oaw-btn primary", type: "button", text: "Approve", onclick: () => done(true) });
    dlg.replaceChildren(
      h("div", { class: "oaw-modal-body" },
        h("p", { class: "oaw-kicker", text: "Human-in-the-loop" }),
        h("h2", { text: "Approve Action?" }),
        req.summary ? h("p", { class: "oaw-lead", text: req.summary }) : null,
        h("dl", { class: "oaw-kv" }, ...rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: String(v) })])),
        h("p", { class: "oaw-label", text: "Exact payload" }),
        h("pre", { class: "oaw-payload", text: JSON.stringify(req.args, null, 2) }),
        h("p", { class: "oaw-muted small", text: "Nothing has been written yet. The agent is paused until you decide." }),
        h("div", { class: "oaw-row end" }, h("button", { class: "oaw-btn danger", type: "button", text: "Reject", onclick: () => done(false) }), approveBtn),
      ),
    );
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
    approveBtn.focus();
  });
  return (req) => { const p = chain.then(() => ask(req)); chain = p.catch(() => {}); return p; };
}

/** Consent before contacting (or being used by) another origin. Resolves true | "session" | false. */
export function createConsent() {
  const dlg = modal("oaw-consent");
  let chain = Promise.resolve();
  const ask = ({ origin, purpose, method, detail, direction = "outbound" }) => new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    dlg.replaceChildren(h("div", { class: "oaw-modal-body" },
      h("p", { class: "oaw-kicker", text: direction === "inbound" ? "Another site wants to use these agents" : "Contact another site?" }),
      h("h2", { text: origin }),
      h("p", { class: "oaw-lead", text: direction === "inbound" ? `It asks to call ${method}${detail ? ` (${String(detail).slice(0, 80)})` : ""}. Any write still needs your approval here.` : purpose }),
      h("p", { class: "oaw-muted small", text: direction === "inbound" ? "Requests run with this site's model settings; the other site never sees your key." : "Only public files and the request are exchanged. No cookies or API keys are sent." }),
      h("div", { class: "oaw-row end" },
        h("button", { class: "oaw-btn danger", type: "button", text: "Deny", onclick: () => done(false) }),
        h("button", { class: "oaw-btn", type: "button", text: "Allow once", onclick: () => done(true) }),
        h("button", { class: "oaw-btn primary", type: "button", text: "Allow for this session", onclick: () => done("session") })),
    ));
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
  });
  return (req) => { const p = chain.then(() => ask(req)); chain = p.catch(() => {}); return p; };
}

/* ---------------------------------------------------- settings + status pill */

const NANO_TEXT = (n) => ({ available: "Available", downloadable: "Downloadable - click to initialize", downloading: `Downloading ${Math.round((n.progress || 0) * 100)}%`, unavailable: "Unavailable in this browser", unknown: "Checking…" }[n.status] || n.status);

export function createStatusPill(el, runtime) {
  const draw = () => {
    const d = runtime.describeProvider();
    const text = {
      otari: `Mozilla Otari · ${runtime.settings.otari.model}`,
      nano: d.id === "nano" ? "Gemini Nano · On-Device" : "Gemini Nano (Local Sim)",
      hybrid: runtime.settings.otari.apiKey ? "Hybrid Auto · Nano → Otari" : d.automatic ? "Auto · Nano → Demo" : "Hybrid Auto · Nano → Otari",
      demo: "Demo Mode · no key",
    }[d.mode];
    el.textContent = `${text}${d.automatic ? " · auto" : ""}`;
    el.className = `oaw-pill ${d.ok ? d.mode : "error"}${d.id === "nano-sim" ? " sim" : ""}`;
    el.title = [d.label, d.note].filter(Boolean).join(". ");
  };
  runtime.on((e) => { if (e.type === "provider" || e.type === "nano_status") draw(); });
  draw();
  return draw;
}

export function createSettings({ runtime, onSaved }) {
  const dlg = modal("oaw-settings");
  const modes = [
    ["otari", "Mozilla Otari Gateway (BYOK)", "One OpenAI-compatible endpoint for many providers. Your key, your budget."],
    ["nano", "Gemini Nano (Local On-Device)", "Chrome's built-in model. Free and private. A labeled simulation runs when the device can't."],
    ["hybrid", "Hybrid Auto (Nano Local → Otari Cloud)", "Nano first; Otari answers when Nano is unavailable or fails."],
    ["demo", "Demo Mode (Zero-Key Deterministic)", "Scripted agents, no model, no network. For judging without keys."],
  ];
  const radios = modes.map(([v, t, s]) => h("label", { class: "oaw-opt" }, h("input", { type: "radio", name: "oaw-mode", value: v }), h("span", {}, h("strong", { text: t }), h("small", { text: s }))));
  const baseUrl = h("input", { type: "url", id: "oaw-otari-url", spellcheck: "false" });
  const apiKey = h("input", { type: "password", id: "oaw-otari-key", autocomplete: "off", spellcheck: "false", placeholder: "tk-…" });
  const modelSel = h("select", { id: "oaw-otari-model" });
  let modelList = null; // models loaded from the key's /models, else presets
  const fillModels = (selected) => {
    const ids = modelList ? modelList.map((m) => m.id) : OTARI_MODELS;
    modelSel.replaceChildren(
      h("optgroup", { label: modelList ? `Your models (${ids.length})` : "Examples (use Load my models)" }, ...(modelList || OTARI_MODELS.map((id) => ({ id }))).map((m) => h("option", { value: m.id, text: m.json === false ? `${m.id} (no JSON mode)` : m.id }))),
      h("option", { value: "__custom", text: "Custom model string…" }));
    if (selected && ids.includes(selected)) { modelSel.value = selected; modelCustom.hidden = true; }
    else if (selected) { modelSel.value = "__custom"; modelCustom.hidden = false; modelCustom.value = selected; }
  };
  const loadBtn = h("button", { class: "oaw-btn small", type: "button", text: "Load my models", onclick: () => loadModels() });
  const modelCustom = h("input", { type: "text", id: "oaw-otari-custom", placeholder: "provider:model", spellcheck: "false", hidden: true });
  const testOut = h("p", { class: "oaw-test", role: "status" });
  const nanoChip = h("span", { class: "oaw-chip", "data-state": "unknown", text: "Checking…" });
  const nanoBar = h("progress", { max: "100", value: "0", hidden: true });
  const nanoInit = h("button", { class: "oaw-btn", type: "button", text: "Initialize Gemini Nano", hidden: true });
  const msg = h("p", { class: "oaw-msg", role: "alert" });
  const otariPanel = h("fieldset", { class: "oaw-panel" },
    h("legend", { text: "Mozilla Otari" }),
    h("label", { for: "oaw-otari-url", text: "Base URL" }),
    h("div", { class: "oaw-row" }, baseUrl,
      h("button", { class: "oaw-btn small", type: "button", text: "Global", onclick: () => { baseUrl.value = OTARI_REGIONS.global; } }),
      h("button", { class: "oaw-btn small", type: "button", text: "EU", onclick: () => { baseUrl.value = OTARI_REGIONS.eu; } })),
    h("label", { for: "oaw-otari-key", text: "API key (sent as Authorization: Bearer)" }),
    h("div", { class: "oaw-row" }, apiKey, h("button", { class: "oaw-btn small", type: "button", text: "Show", onclick: (e) => { apiKey.type = apiKey.type === "password" ? "text" : "password"; e.target.textContent = apiKey.type === "password" ? "Show" : "Hide"; } })),
    h("label", { for: "oaw-otari-model", text: "Model" }),
    h("div", { class: "oaw-row" }, modelSel, loadBtn), modelCustom,
    h("p", { class: "oaw-muted small", text: "provider/model (catalog id) lets Otari route to any provider your organization has; provider:model pins one provider." }),
    h("div", { class: "oaw-row" }, h("button", { class: "oaw-btn", type: "button", text: "Test connection", onclick: () => test() })),
    testOut,
    h("p", { class: "oaw-muted small", text: "The key is stored in this site's localStorage and sent only to the base URL above, from your browser. It never appears in prompts, traces, manifests or requests to other sites." }));
  const nanoPanel = h("fieldset", { class: "oaw-panel" },
    h("legend", { text: "Gemini Nano" }),
    h("p", {}, "On this device: ", nanoChip), nanoBar, nanoInit,
    h("p", { class: "oaw-muted small", text: "Needs desktop Chrome with built-in AI (about 22 GB free disk, a GPU with more than 4 GB VRAM or 16 GB RAM). Check chrome://on-device-internals. When it is unavailable, Nano mode runs the labeled \"Gemini Nano (Local Sim)\" profile: scripted answers with simulated latency, marked \"simulated\" in every trace." }));
  const demoPanel = h("fieldset", { class: "oaw-panel" }, h("legend", { text: "Demo Mode" }), h("p", { class: "oaw-muted small", text: "Every agent uses its deterministic implementation. Approvals, cross-site RPC, the 3D preview and the boards behave exactly as with a real model." }));
  dlg.replaceChildren(h("form", { class: "oaw-modal-body", method: "dialog" },
    h("h2", { text: "Model settings" }),
    h("p", { class: "oaw-muted", text: `${runtime.manifest?.name || ""}: you choose who runs the agents. The site host pays for nothing.` }),
    h("div", { class: "oaw-opts", role: "radiogroup", "aria-label": "Inference provider" }, ...radios),
    otariPanel, nanoPanel, demoPanel, msg,
    h("div", { class: "oaw-row end" },
      h("button", { class: "oaw-btn danger", type: "button", text: "Delete saved settings", onclick: () => { runtime.clearSettings(); fill(); msg.className = "oaw-msg ok"; msg.textContent = "Deleted. The automatic default is active."; onSaved?.(); } }),
      h("button", { class: "oaw-btn ghost", type: "button", text: "Cancel", onclick: () => dlg.close() }),
      h("button", { class: "oaw-btn primary", type: "submit", text: "Save" }))));

  const mode = () => radios.map((r) => r.querySelector("input")).find((i) => i.checked)?.value;
  const model = () => (modelSel.value === "__custom" ? modelCustom.value.trim() : modelSel.value);
  const showPanels = () => {
    const m = mode();
    otariPanel.hidden = !(m === "otari" || m === "hybrid");
    nanoPanel.hidden = !(m === "nano" || m === "hybrid");
    demoPanel.hidden = m !== "demo";
  };
  const drawNano = () => {
    const n = runtime.nano;
    nanoChip.textContent = NANO_TEXT(n);
    nanoChip.dataset.state = n.status;
    nanoChip.title = n.reason || "";
    nanoBar.hidden = n.status !== "downloading";
    nanoBar.value = Math.round((n.progress || 0) * 100);
    nanoInit.hidden = !["downloadable", "downloading"].includes(n.status);
    nanoInit.disabled = n.status === "downloading";
  };
  const fill = () => {
    const s = runtime.settings;
    const m = s.mode || runtime.effectiveMode();
    radios.forEach((r) => { const i = r.querySelector("input"); i.checked = i.value === m; });
    baseUrl.value = s.otari.baseUrl;
    apiKey.value = s.otari.apiKey;
    modelCustom.value = "";
    fillModels(s.otari.model);
    testOut.textContent = ""; msg.textContent = "";
    showPanels(); drawNano();
  };
  const collect = () => ({ mode: mode(), otari: { baseUrl: baseUrl.value.trim(), apiKey: apiKey.value.trim(), model: model() } });
  async function loadModels(opts = {}) {
    testOut.className = "oaw-test busy";
    testOut.textContent = "Loading models…";
    loadBtn.disabled = true;
    try {
      const keep = model();
      const r = await listOtariModels(collect().otari);
      modelList = r.models;
      const switched = r.baseUrl !== baseUrl.value.trim().replace(/\/+$/, "");
      if (switched) baseUrl.value = r.baseUrl;
      if (!modelList.length) throw new Error("This key has no models. Add a provider in the Otari dashboard.");
      fillModels(modelList.some((m) => m.id === keep) ? keep : (modelList.find((m) => m.json) || modelList[0]).id);
      testOut.className = "oaw-test ok";
      testOut.textContent = `${switched ? `Your key is in ${new URL(r.baseUrl).host}; switched there. ` : ""}Loaded ${modelList.length} models your key can use${opts.thenTest ? "; testing the selected one…" : ". Pick one, then Test connection."}`;
      return true;
    } catch (e) {
      showError(e);
      return false;
    } finally { loadBtn.disabled = false; }
  }
  function showError(e) {
    testOut.className = "oaw-test bad";
    testOut.replaceChildren(`${e.code || "ERROR"}: ${e.message} `);
    if (e.region) testOut.append(h("button", { class: "oaw-btn small", type: "button", text: `Switch to ${new URL(e.region).host} and retry`, onclick: () => { baseUrl.value = e.region; test(); } }));
    if (e.code === "OTARI_424" || e.code === "OTARI_404") testOut.append(h("button", { class: "oaw-btn small", type: "button", text: "Load my models", onclick: () => loadModels() }));
  }
  async function test(retried = false) {
    testOut.className = "oaw-test busy";
    testOut.textContent = "Testing…";
    try {
      const r = await testOtari(collect().otari); // unsaved values; nothing is stored by a test
      const switched = r.baseUrl && r.baseUrl !== baseUrl.value.trim().replace(/\/+$/, "");
      if (switched) baseUrl.value = r.baseUrl;
      testOut.className = "oaw-test ok";
      testOut.textContent = `Connected${switched ? ` (switched to ${new URL(r.baseUrl).host}, where your key lives)` : ""}: ${r.telemetry.model || model()} answered in ${r.telemetry.ms} ms ${JSON.stringify(r.json)}. Press Save to use it.`;
    } catch (e) {
      // No credential for this model's provider, or unknown model: load the key's own models and retry once.
      if ((e.code === "OTARI_424" || e.code === "OTARI_404") && !retried) {
        if (await loadModels({ thenTest: true })) return test(true);
      }
      showError(e);
    }
  }
  radios.forEach((r) => r.querySelector("input").addEventListener("change", showPanels));
  apiKey.addEventListener("change", () => {
    try { apiKey.value = cleanApiKey(apiKey.value); } catch (e) { showError(e); return; }
    if (apiKey.value.length >= 8) loadModels();
  });
  modelSel.addEventListener("change", () => { modelCustom.hidden = modelSel.value !== "__custom"; if (!modelCustom.hidden) modelCustom.focus(); });
  nanoInit.addEventListener("click", async () => { try { await runtime.initNano(); } catch (e) { msg.className = "oaw-msg"; msg.textContent = e.message; } });
  runtime.on((e) => { if (e.type === "nano_status") drawNano(); });
  dlg.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const s = collect();
    msg.className = "oaw-msg";
    if (!s.mode) { msg.textContent = "Choose a provider."; return; }
    if (s.mode === "otari" || (s.mode === "hybrid" && s.otari.apiKey)) {
      try { s.otari.apiKey = cleanApiKey(s.otari.apiKey); apiKey.value = s.otari.apiKey; } catch (err) { msg.textContent = err.message; return; }
    }
    if (s.mode === "otari") {
      if (!s.otari.apiKey) { msg.textContent = "Mozilla Otari needs an API key."; return; }
      if (!s.otari.model) { msg.textContent = "Enter a model string."; return; }
      try { const u = new URL(s.otari.baseUrl); if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error(); } catch { msg.textContent = "Base URL must be a valid https:// URL."; return; }
    }
    runtime.saveSettings(s);
    dlg.close();
    onSaved?.();
  });
  return { open: async () => { fill(); dlg.showModal(); await runtime.probeNano(); drawNano(); } };
}

/* ------------------------------------------------------- manifest inspector */

export function createInspector({ getEntries }) {
  const drawer = h("aside", { class: "oaw-drawer", "aria-label": "Manifest Inspector", hidden: true });
  document.body.append(drawer);
  const tabs = h("div", { class: "oaw-tabs", role: "tablist" });
  const body = h("div", { class: "oaw-drawer-body" });
  drawer.append(h("div", { class: "oaw-drawer-head" }, h("h2", { text: "Manifest Inspector" }), h("button", { class: "oaw-btn ghost small", type: "button", text: "Close", onclick: () => { drawer.hidden = true; } })), tabs, body);
  let current = 0;
  const draw = () => {
    const entries = getEntries();
    current = Math.min(current, Math.max(0, entries.length - 1));
    tabs.replaceChildren(...entries.map((e, i) => h("button", { class: `oaw-tab ${i === current ? "on" : ""}`, role: "tab", type: "button", text: e.label, onclick: () => { current = i; draw(); } })));
    const e = entries[current];
    if (!e) { body.replaceChildren(h("p", { class: "oaw-muted", text: "No manifests loaded yet." })); return; }
    const checks = e.manifest ? validateManifest(e.manifest, e.network) : [];
    const pass = checks.filter((c) => c.ok).length;
    body.replaceChildren(...[
      h("p", {}, h("code", { text: e.url })),
      e.cors ? h("p", { class: "oaw-muted small", text: `Access-Control-Allow-Origin: ${e.cors}` }) : null,
      e.error ? h("p", { class: "oaw-bad", text: e.error }) : null,
      e.manifest ? h("p", { class: "oaw-label", text: `Conformance ${pass}/${checks.length}` }) : null,
      e.manifest ? h("ul", { class: "oaw-checks" }, ...checks.map((c) => h("li", { class: c.ok ? "ok" : "bad" }, h("span", { text: c.ok ? "✓ " : "✗ " }), c.check, c.detail ? h("span", { class: "oaw-muted", text: ` · ${c.detail}` }) : null))) : null,
      e.manifest ? h("p", { class: "oaw-label", text: "Agents" }) : null,
      e.manifest ? h("ul", { class: "oaw-list" }, ...(e.manifest.agents || []).map((a) => h("li", {}, h("strong", { text: a.name }), ` · ${a.role || ""}`))) : null,
      e.manifest ? h("p", { class: "oaw-label", text: "Tools" }) : null,
      e.manifest ? h("ul", { class: "oaw-list" }, ...(e.manifest.tools || []).map((t) => h("li", {}, h("code", { text: t.name }), h("span", { class: `oaw-badge ${t.effect}`, text: t.effect }), t.rpc_callable ? h("span", { class: "oaw-badge rpc", text: "rpc" }) : null, ` ${t.description || ""}`))) : null,
      h("details", {}, h("summary", { text: "agent-manifest.json" }), h("pre", { class: "oaw-payload", text: JSON.stringify(e.manifest, null, 2) })),
      e.network ? h("details", {}, h("summary", { text: "network definition" }), h("pre", { class: "oaw-payload", text: JSON.stringify(e.network, null, 2) })) : null,
    ].filter(Boolean));
  };
  return { open: () => { draw(); drawer.hidden = false; }, refresh: () => { if (!drawer.hidden) draw(); } };
}
