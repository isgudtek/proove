/**
 * oaw-core.js: shared browser runtime for both Open Agentic Web sites.
 *
 * - Inference providers behind one interface: Mozilla Otari (BYOK, OpenAI-compatible), Gemini Nano
 *   (Chrome Prompt API), Gemini Nano (Local Sim, clearly labeled), Hybrid Auto (Nano -> Otari), Demo.
 * - Agent runtime: agents are defined by the site's network JSON (instructions + output_schema).
 *   The model proposes JSON; site code validates, normalizes and enforces business policy.
 * - Tools with effects (read | preview | write). Every write pauses for human approval.
 * - postMessage RPC (OAW_RPC_REQUEST / OAW_RPC_RESPONSE / OAW_RPC_EVENT) between sites.
 *
 * No DOM rendering here; oaw-ui.js renders events, approvals and settings.
 */

export const CORE_VERSION = "1.0.0";
export const PROFILE = "worldwide-agentic-web-mvp-0.2";

/* ------------------------------------------------------------------ utils */

export const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (v) => Math.round(v * 100) / 100;
export const estimateTokens = (s) => Math.max(1, Math.ceil(String(s ?? "").length / 4));
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
});
const abortError = () => Object.assign(new Error("Stopped"), { name: "AbortError", code: "ABORTED" });

export class OawError extends Error {
  constructor(code, message) { super(message); this.name = "OawError"; this.code = code; }
}

function redact(text, secret) {
  let s = String(text ?? "");
  if (secret) s = s.split(secret).join("[redacted]");
  return s.replace(/Bearer\s+[A-Za-z0-9._\-]{6,}/g, "Bearer [redacted]").replace(/\btk-[A-Za-z0-9_\-]{6,}/g, "tk-[redacted]");
}

/** Strict JSON extraction: whole text, fenced block, then the first balanced {...} that parses. */
export function extractJson(text) {
  if (isObj(text)) return text;
  if (typeof text !== "string") return null;
  const t = text.trim();
  const tries = [t, (t.match(/```(?:json)?\s*([\s\S]*?)```/i) || [])[1]];
  for (const c of tries) { if (!c) continue; try { const v = JSON.parse(c.trim()); if (isObj(v)) return v; } catch { /* next */ } }
  for (let i = t.indexOf("{"); i >= 0; i = t.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { try { const v = JSON.parse(t.slice(i, j + 1)); if (isObj(v)) return v; } catch { /* keep scanning */ } break; }
    }
  }
  return null;
}

/** Lenient JSON Schema subset validator. Returns a list of error strings. */
export function validate(schema, value, path = "$") {
  if (!isObj(schema)) return [];
  const errs = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types.length) {
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === "number" && t === "integer"));
    if (!ok) return [`${path}: expected ${types.join("|")}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${path}: above ${schema.maximum}`);
  }
  if (typeof value === "string" && schema.maxLength != null && value.length > schema.maxLength) errs.push(`${path}: longer than ${schema.maxLength}`);
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (isObj(value)) {
    for (const r of schema.required || []) if (!(r in value)) errs.push(`${path}.${r}: required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in value) errs.push(...validate(s, value[k], `${path}.${k}`));
  }
  return errs;
}

/* -------------------------------------------------- manifest validation */

/** Conformance checks for an agent manifest (+ optional resolved network). Returns [{ok, check, detail}]. */
export function validateManifest(m, network = null) {
  const out = [];
  const add = (ok, check, detail = "") => out.push({ ok: !!ok, check, detail });
  add(isObj(m), "manifest is a JSON object");
  if (!isObj(m)) return out;
  for (const k of ["name", "version", "description", "endpoint"]) add(typeof m[k] === "string" && m[k], `has ${k}`);
  const nets = Array.isArray(m.networks) ? m.networks : [];
  add(nets.length > 0, "publishes at least one network", nets.map((n) => n.name).join(", "));
  for (const n of nets) add(typeof n.name === "string" && typeof n.front_man === "string" && typeof n.hocon === "string", `network ${n.name}: name, front_man, hocon`);
  add(Array.isArray(m.agents) && m.agents.length > 0, "lists agents", (m.agents || []).map((a) => a.name).join(", "));
  const tools = Array.isArray(m.tools) ? m.tools : [];
  add(tools.length > 0 && tools.every((t) => t.name && ["read", "preview", "write"].includes(t.effect)), "tools declare name + effect");
  add(tools.filter((t) => t.effect === "write").every((t) => t.requires_approval === true), "every write tool requires approval");
  add(isObj(m.rpc) && m.rpc.request === "OAW_RPC_REQUEST" && m.rpc.response === "OAW_RPC_RESPONSE", "declares postMessage RPC protocol");
  add(isObj(m.peer_policy), "declares peer_policy");
  if (network) {
    const agents = Array.isArray(network.tools) ? network.tools : [];
    const names = new Set(agents.map((a) => a.name));
    add(agents.length > 0, "network defines agents", [...names].join(", "));
    const front = nets[0]?.front_man;
    add(names.has(front), `front agent "${front}" is defined`);
    const toolNames = new Set(tools.map((t) => t.name));
    const bad = agents.flatMap((a) => (a.tools || []).filter((r) => typeof r === "string" && !names.has(r) && !toolNames.has(r) && !/^https?:\/\//.test(r)));
    add(bad.length === 0, "agent references resolve", bad.join(", "));
    add(agents.every((a) => a.function?.description && (a.rule_based || typeof a.instructions === "string")), "agents have description + instructions");
  }
  return out;
}

/* --------------------------------------------------------------- settings */

/**
 * Clean a pasted API key: drop whitespace and invisible characters (zero-width, BOM, non-breaking space).
 * Throws BAD_KEY if anything else could not be sent in an HTTP header (fetch only accepts ISO-8859-1).
 */
export function cleanApiKey(key) {
  const k = String(key ?? "").replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]+/g, "");
  const bad = [...k].findIndex((ch) => ch.charCodeAt(0) < 0x21 || ch.charCodeAt(0) > 0x7e);
  if (bad >= 0) {
    const ch = [...k][bad];
    const cp = `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    throw new OawError("BAD_KEY", `The API key contains a character that cannot be sent (${cp}${ch === "\u2026" ? ' "…"' : ""} at position ${bad + 1} of ${[...k].length}). ${ch === "\u2026" ? "The key was copied truncated. " : ""}Copy the full key again from the Otari dashboard.`);
  }
  return k;
}

export const OTARI_REGIONS = { global: "https://api.otari.ai/api/v1", eu: "https://eu.api.otari.ai/api/v1" };
export const OTARI_MODELS = ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5", "meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-v4.1-flash"];
export const MODES = ["otari", "nano", "hybrid", "demo"];

export function loadSettings(key, storage = globalThis.localStorage) {
  let s = {};
  try { s = JSON.parse(storage?.getItem(key) || "{}") || {}; } catch { s = {}; }
  return {
    mode: MODES.includes(s.mode) ? s.mode : null, // null = automatic default
    otari: { baseUrl: s.otari?.baseUrl || OTARI_REGIONS.global, apiKey: s.otari?.apiKey || "", model: s.otari?.model || OTARI_MODELS[0] },
  };
}
export function saveSettings(key, s, storage = globalThis.localStorage) {
  let apiKey = String(s.otari.apiKey || "").trim();
  try { apiKey = cleanApiKey(apiKey); } catch { /* stored as typed; the provider reports BAD_KEY */ }
  storage?.setItem(key, JSON.stringify({ mode: s.mode, otari: { baseUrl: s.otari.baseUrl.trim(), apiKey, model: s.otari.model.trim() } }));
}
export function clearSettings(key, storage = globalThis.localStorage) { storage?.removeItem(key); }

/**
 * Storage for AgentRuntime that can use another site's model settings for this page session only (memory, never saved).
 * The buyer hub lends its settings to the sites it opens. Saving or deleting settings on this site ends the loan.
 */
export function lendableStorage(key, base = globalThis.localStorage) {
  let lent = null; // { settings, from }
  const clean = (s) => ({
    mode: MODES.includes(s?.mode) ? s.mode : null,
    otari: { baseUrl: String(s?.otari?.baseUrl || OTARI_REGIONS.global).slice(0, 200), apiKey: String(s?.otari?.apiKey || "").slice(0, 400), model: String(s?.otari?.model || OTARI_MODELS[0]).slice(0, 120) },
  });
  return {
    storage: {
      getItem: (k) => (k === key && lent ? JSON.stringify(lent.settings) : base?.getItem(k) ?? null),
      setItem: (k, v) => { if (k === key) lent = null; base?.setItem(k, v); },
      removeItem: (k) => { if (k === key) lent = null; base?.removeItem(k); },
    },
    lend(settings, from) { lent = settings ? { settings: clean(settings), from: String(from || "another site").slice(0, 80) } : null; },
    get from() { return lent?.from || null; },
  };
}

/* --------------------------------------------------------------- providers */

/** Demo Mode: each agent's deterministic implementation. No model, no network. */
class DemoProvider {
  constructor() { this.id = "demo"; this.label = "Demo Mode (deterministic)"; this.short = "demo"; }
  async generate({ deterministic, prompt }) {
    const t0 = performance.now();
    const json = deterministic();
    return { json, telemetry: { provider: "demo", ms: Math.round(performance.now() - t0), tokens_in: 0, tokens_out: 0, cost: 0, simulated: false } };
  }
}

/** Gemini Nano (Local Sim): same deterministic logic, with simulated on-device latency. Always labeled simulated. */
class NanoSimProvider {
  constructor() { this.id = "nano-sim"; this.label = "Gemini Nano (Local Sim)"; this.short = "nano-sim"; }
  async generate({ deterministic, system, prompt, signal }) {
    const json = deterministic();
    const tin = estimateTokens(system) + estimateTokens(prompt);
    const tout = estimateTokens(JSON.stringify(json));
    // Rough on-device profile: ~250 ms first token, ~45 tokens/s decode, capped for demo pacing.
    const ms = Math.round(clamp(250 + tout * 22 + tin * 0.15, 180, 2400));
    await sleep(ms, signal);
    return { json, telemetry: { provider: "nano-sim", ms, tokens_in: tin, tokens_out: tout, cost: 0, simulated: true, estimated: true } };
  }
}

const NANO_IO = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };

/** window.LanguageModel, falling back to the legacy window.ai.languageModel. */
export function nanoApi() {
  const g = globalThis;
  if (g.LanguageModel && typeof g.LanguageModel.create === "function") return g.LanguageModel;
  if (g.ai?.languageModel && typeof g.ai.languageModel.create === "function") return g.ai.languageModel;
  return null;
}

/** { status: available | downloadable | downloading | unavailable, reason } */
export async function nanoAvailability() {
  const api = nanoApi();
  if (!api) return { status: "unavailable", reason: "This browser has no Prompt API (window.LanguageModel)." };
  try {
    let v;
    if (typeof api.availability === "function") {
      try { v = await api.availability(NANO_IO); } catch (e) { if (e instanceof TypeError) v = await api.availability(); else throw e; }
    } else if (typeof api.capabilities === "function") v = (await api.capabilities())?.available;
    v = { readily: "available", "after-download": "downloadable", no: "unavailable" }[v] ?? v;
    return { status: ["available", "downloadable", "downloading"].includes(v) ? v : "unavailable", reason: v === "unavailable" ? "Chrome reports the on-device model as unavailable on this device." : "" };
  } catch (e) {
    return { status: "unavailable", reason: String(e?.message || e) };
  }
}

async function createNanoSession({ system, signal, onProgress }) {
  const api = nanoApi();
  if (!api) throw new OawError("NANO_UNAVAILABLE", "Gemini Nano is not available in this browser.");
  const monitor = (m) => m.addEventListener("downloadprogress", (e) => onProgress?.(e.total > 1 ? e.loaded / e.total : e.loaded));
  const variants = [
    { ...NANO_IO, signal, monitor, initialPrompts: [{ role: "system", content: system }] },
    { ...NANO_IO, signal, monitor, systemPrompt: system },
    { signal, monitor, systemPrompt: system },
  ];
  let last;
  for (const v of variants) {
    try { return await api.create(v); } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (e instanceof TypeError || e?.name === "NotSupportedError") { last = e; continue; }
      throw e;
    }
  }
  throw last;
}

/** Gemini Nano through the real Chrome Prompt API. One session per call, destroyed afterwards. */
class NanoProvider {
  constructor({ onEvent }) {
    this.id = "nano"; this.label = "Gemini Nano (On-Device)"; this.short = "nano-local";
    this.onEvent = onEvent;
    this.constraintBroken = false; // some Chrome builds reject responseConstraint with kErrorUnknown
  }
  async init(onProgress) {
    const s = await createNanoSession({ system: "init", onProgress });
    try { s.destroy?.(); } catch { /* ignore */ }
  }
  async generate({ agent, system, prompt, schema, signal }) {
    const t0 = performance.now();
    const sys = `${system}\nReply with exactly one JSON object and no other text, no markdown. Keep it compact: short strings, at most 8 items in any list.`;
    let session;
    try {
      session = await createNanoSession({ system: sys, signal });
      let raw;
      if (schema && !this.constraintBroken) {
        try {
          raw = await session.prompt(prompt, { responseConstraint: schema, signal });
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          this.constraintBroken = true;
          this.onEvent?.({ type: "note", agent, text: `This Chrome build rejected the structured-output constraint (${e?.name || "error"}: ${String(e?.message || e).slice(0, 90)}). That is a Chrome limitation, not a bad answer. Asking again with JSON instructions instead.` });
        }
      }
      if (raw == null) raw = await session.prompt(`${prompt}\n\nReturn only the JSON object.`, { signal });
      let json = extractJson(raw);
      if (!json) {
        raw = await session.prompt("That was not a valid JSON object. Reply again with only the JSON object.", { signal });
        json = extractJson(raw);
      }
      if (!json) throw new OawError("NANO_BAD_OUTPUT", `Gemini Nano did not return JSON: ${String(raw).replace(/\s+/g, " ").slice(0, 140)}`);
      const used = Number(session.inputUsage ?? session.contextUsage);
      const tin = Number.isFinite(used) && used > 0 ? used : estimateTokens(sys) + estimateTokens(prompt);
      return { json, telemetry: { provider: "nano-local", ms: Math.round(performance.now() - t0), tokens_in: tin, tokens_out: estimateTokens(raw), cost: 0, simulated: false, estimated: !(used > 0) } };
    } catch (e) {
      if (e instanceof OawError || e?.name === "AbortError") throw e;
      throw new OawError("NANO_ERROR", `Gemini Nano error: ${e?.name || ""} ${String(e?.message || e).slice(0, 160)}`);
    } finally {
      try { session?.destroy?.(); } catch { /* ignore */ }
    }
  }
}

/** Mozilla Otari gateway: OpenAI-compatible POST {baseUrl}/chat/completions with the user's key. */
class OtariProvider {
  constructor({ baseUrl, apiKey, model }, { onRegion } = {}) {
    this.id = "otari"; this.short = "otari";
    this.onRegion = onRegion;
    this.baseUrl = String(baseUrl || OTARI_REGIONS.global).replace(/\/+$/, "");
    this.apiKey = String(apiKey || "");
    this.model = String(model || OTARI_MODELS[0]);
    this.label = `Mozilla Otari · ${this.model}`;
  }
  get configured() { return !!(this.apiKey && this.baseUrl && this.model); }
  async generate({ system, prompt, signal }) {
    if (!this.apiKey) throw new OawError("SETUP", "Mozilla Otari needs an API key. Open Model settings.");
    this.apiKey = cleanApiKey(this.apiKey);
    let u;
    try { u = new URL(this.baseUrl); } catch { throw new OawError("SETUP", `Invalid Otari base URL: ${this.baseUrl}`); }
    if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new OawError("SETUP", "Otari base URL must use https:// (http:// only on localhost).");
    const t0 = performance.now();
    const body = {
      model: this.model,
      messages: [{ role: "system", content: `${system}\nRespond with a single JSON object.` }, { role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
    };
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), 60000);
    const post = (b) => fetch(`${this.baseUrl}/chat/completions`, { // reads this.baseUrl at call time
      method: "POST", signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(b),
    });
    try {
      let res = await post(body);
      let text = await res.text();
      const region = res.status === 421 ? otariRegionFrom(text) : null;
      if (region && region !== this.baseUrl) {
        // Otari says the key lives in another of its regions: retry there once and remember it.
        this.baseUrl = region;
        this.onRegion?.(region);
        res = await post(body);
        text = await res.text();
      }
      if (res.status === 400 && /response_format/i.test(text)) { delete body.response_format; res = await post(body); text = await res.text(); }
      if (!res.ok) throw otariError(res.status, text, this.apiKey, this.model);
      const j = JSON.parse(text);
      const content = j.choices?.[0]?.message?.content ?? "";
      const json = extractJson(content);
      if (!json) throw new OawError("OTARI_BAD_OUTPUT", `Otari model did not return JSON: ${String(content).slice(0, 140)}`);
      const cost = Number(j.usage?.cost ?? j.usage?.total_cost);
      return { json, baseUrl: this.baseUrl, telemetry: { provider: "otari", model: j.model || this.model, ms: Math.round(performance.now() - t0), tokens_in: j.usage?.prompt_tokens ?? estimateTokens(prompt), tokens_out: j.usage?.completion_tokens ?? estimateTokens(content), cost: Number.isFinite(cost) ? cost : null, simulated: false, estimated: !j.usage } };
    } catch (e) {
      if (e instanceof OawError) throw e;
      if (signal?.aborted) throw abortError();
      if (e?.name === "AbortError") throw new OawError("OTARI_TIMEOUT", "Otari did not answer within 60 s.");
      throw new OawError("OTARI_NETWORK", `Could not reach ${u.host}. Check the base URL and your connection. ${redact(e?.message, this.apiKey)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** One tiny request with the given (possibly unsaved) Otari settings. */
export function testOtari(otari) {
  return new OtariProvider(otari).generate({ agent: "test", system: "Connection test.", prompt: 'Reply with {"ok": true}.' });
}

/**
 * Models this key can use: GET {baseUrl}/models. Ids are catalog ids ("provider/model"), which let the
 * gateway pick any provider that serves the model. Returns [{ id, name, context_window, json }].
 */
export async function listOtariModels({ baseUrl, apiKey }) {
  let base = String(baseUrl || "").replace(/\/+$/, "");
  if (!apiKey) throw new OawError("SETUP", "Enter your Otari API key first.");
  apiKey = cleanApiKey(apiKey);
  const get = async () => {
    try { return await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, credentials: "omit", referrerPolicy: "no-referrer" }); }
    catch (e) { throw new OawError("OTARI_NETWORK", `Could not reach ${base}. ${redact(e?.message, apiKey)}`); }
  };
  let res = await get();
  let text = await res.text();
  const region = res.status === 421 ? otariRegionFrom(text) : null;
  if (region && region !== base) { base = region; res = await get(); text = await res.text(); }
  if (!res.ok) throw otariError(res.status, text, apiKey, null);
  const data = JSON.parse(text).data || [];
  const models = data
    .filter((m) => !m.type || /chat|text|llm|language/i.test(String(m.type)))
    .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id, context_window: Number(m.context_window) || null, json: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("response_format") : null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { models, baseUrl: base };
}

/** Region base URL named by a 421 response, only if it is one of Otari's own API hosts. */
export function otariRegionFrom(text) {
  const host = (String(text || "").match(/belongs to ([a-z0-9.-]+)/i) || [])[1]?.toLowerCase().replace(/\.$/, "");
  return host && /^([a-z]{2,10}\.)?api\.otari\.ai$/.test(host) ? `https://${host}/api/v1` : null;
}

/** Turn an Otari error response into a message that says what to do. */
function otariError(status, text, apiKey, model) {
  let detail = text;
  try { const j = JSON.parse(text); detail = j.detail?.message || j.detail || j.error?.message || text; } catch { /* raw */ }
  detail = redact(typeof detail === "string" ? detail : JSON.stringify(detail), apiKey).slice(0, 240);
  const regionUrl = otariRegionFrom(detail);
  const region = regionUrl ? new URL(regionUrl).host : null;
  const hint = {
    401: "Otari rejected the API key.",
    403: "This key may not use that model.",
    404: `Model "${model}" was not found. Use "Load my models" to pick one your key can use.`,
    402: "Budget exhausted for this key.",
    421: region ? `Your key is registered in another region: set the base URL to https://${region}/api/v1 (use the EU button).` : "Your key is registered in another Otari region.",
    424: `Your Otari organization has no credential for this model's provider. Use "Load my models" and pick a model your organization can run, or add the provider key in the Otari dashboard.`,
    429: "Rate or budget limit reached.",
  }[status] || "";
  const err = new OawError(`OTARI_${status}`, `Otari ${status}: ${hint} (${detail})`);
  if (region) err.region = `https://${region}/api/v1`;
  return err;
}

/** Hybrid Auto: Gemini Nano on the device first; Otari in the cloud when Nano is unavailable or fails. */
const NANO_TIMEOUT_MS = 30000;
const NANO_COOLDOWN_MS = 5 * 60 * 1000;

class HybridProvider {
  /** demoFallback: used for the automatic default, so a visitor without a key still gets an answer. */
  constructor({ nano, otari, nanoStatus, onEvent, demoFallback = false, cooldown }) {
    this.id = "hybrid"; this.short = "hybrid";
    this.nano = nano; this.otari = otari; this.nanoStatus = nanoStatus; this.onEvent = onEvent;
    this.demoFallback = demoFallback && !otari.configured;
    this.cooldown = cooldown; // { until } shared by the runtime: skip Nano for a while after it failed
    this.label = `Hybrid Auto · Nano → ${otari.configured ? `Otari ${otari.model}` : this.demoFallback ? "Demo Mode (no Otari key)" : "Otari (no key yet)"}`;
  }
  async generate(req) {
    const cooling = this.cooldown && Date.now() < this.cooldown.until;
    if (cooling) {
      this.onEvent?.({ type: "fallback", agent: req.agent, from: "Gemini Nano", to: this.otari.configured ? "Mozilla Otari" : "Demo Mode", reason: `Nano failed recently; skipping it for ${Math.ceil((this.cooldown.until - Date.now()) / 60000)} more min` });
    } else if (this.nanoStatus() === "available") {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ctl.abort(), NANO_TIMEOUT_MS);
      // Race the call: even if Nano ignores the abort signal (a stuck create() or prompt()), we move on.
      const gaveUp = new Promise((_, reject) => ctl.signal.addEventListener("abort", () => reject(abortError()), { once: true }));
      gaveUp.catch(() => {});
      try {
        const r = await Promise.race([this.nano.generate({ ...req, signal: ctl.signal }), gaveUp]);
        r.telemetry.route = "local";
        return r;
      } catch (e) {
        if (req.signal?.aborted) throw e;
        const why = ctl.signal.aborted ? `no answer within ${NANO_TIMEOUT_MS / 1000} s` : `${e.code || e.name}: ${String(e.message).slice(0, 120)}`;
        if (this.cooldown) this.cooldown.until = Date.now() + NANO_COOLDOWN_MS;
        this.onEvent?.({ type: "fallback", agent: req.agent, from: "Gemini Nano", to: this.otari.configured ? "Mozilla Otari" : this.demoFallback ? "Demo Mode" : "Mozilla Otari", reason: why });
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      }
    } else {
      this.onEvent?.({ type: "fallback", agent: req.agent, from: "Gemini Nano", to: this.otari.configured ? "Mozilla Otari" : this.demoFallback ? "Demo Mode" : "Mozilla Otari", reason: `Nano is ${this.nanoStatus()} on this device` });
    }
    if (!this.otari.configured && this.demoFallback) {
      const r = await new DemoProvider().generate(req);
      r.telemetry.route = "fallback";
      return r;
    }
    if (!this.otari.configured) throw new OawError("SETUP", "Hybrid Auto: Gemini Nano could not answer and no Mozilla Otari key is set. Add a key in Model settings or switch to Demo Mode.");
    const r = await this.otari.generate(req);
    r.telemetry.route = "cloud";
    return r;
  }
}

/* --------------------------------------------------------------- runtime */

/**
 * AgentRuntime: one per site.
 *  network: resolved network JSON ({ tools: [{ name, function, instructions, output_schema, tools }] })
 *  agentImpl: { [name]: { prompt(input), deterministic(input), normalize(output, input), ruleBased? } }
 *  tools: { [name]: { effect, rpc, input_schema, title, describe(args, ctx), handler(args, ctx) } }
 *  approve(request) -> Promise<boolean>   consent(request) -> Promise<boolean|"session">
 */
export class AgentRuntime {
  constructor({ site, manifest, network, agentImpl, tools, settingsKey, approve, storage = globalThis.localStorage }) {
    this.site = site;
    this.manifest = manifest;
    this.network = network;
    this.agentDefs = new Map((network?.tools || []).map((a) => [a.name, a]));
    this.agentImpl = agentImpl;
    this.tools = tools;
    this.settingsKey = settingsKey;
    this.approveHook = approve;
    this.storage = storage;
    this.listeners = new Set();
    this.nano = { status: "unknown", reason: "", progress: 0 };
    this.nanoProvider = new NanoProvider({ onEvent: (e) => this.emit(e) });
    this.nanoCooldown = { until: 0 };
    this.stats = { runs: 0, agentCalls: 0, toolCalls: 0, approvals: 0 };
    this.lastRun = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) {
    const e = { t: Date.now(), site: this.site, ...ev };
    for (const fn of this.listeners) { try { fn(e); } catch (err) { console.error(err); } }
    return e;
  }

  /* settings + provider selection */
  get settings() { return loadSettings(this.settingsKey, this.storage); }
  saveSettings(s) { saveSettings(this.settingsKey, s, this.storage); this.emit({ type: "provider", provider: this.describeProvider() }); }
  clearSettings() { clearSettings(this.settingsKey, this.storage); this.emit({ type: "provider", provider: this.describeProvider() }); }

  async probeNano() {
    const r = await nanoAvailability();
    this.nano = { ...this.nano, status: r.status, reason: r.reason, progress: r.status === "available" ? 1 : this.nano.progress };
    this.emit({ type: "nano_status", nano: { ...this.nano } });
    return this.nano;
  }
  /** Call from a click handler: Chrome needs user activation to download the model. */
  async initNano() {
    this.nano.status = "downloading";
    this.emit({ type: "nano_status", nano: { ...this.nano } });
    try {
      await this.nanoProvider.init((f) => { this.nano.progress = f; this.emit({ type: "nano_status", nano: { ...this.nano } }); });
    } finally { await this.probeNano(); }
  }

  /**
   * Mode actually in effect. An explicit choice wins. Automatic default: Otari when a key is set (don't make a
   * keyed visitor wait on the local model), else Nano with a Demo fallback when Nano is ready, else Demo.
   */
  effectiveMode() {
    const s = this.settings;
    if (s.mode) return s.mode;
    if (s.otari.apiKey) return "otari";
    return this.nano.status === "available" ? "hybrid" : "demo";
  }
  provider() {
    const s = this.settings;
    const otari = new OtariProvider(s.otari, {
      onRegion: (baseUrl) => {
        saveSettings(this.settingsKey, { ...s, otari: { ...s.otari, baseUrl } }, this.storage);
        this.emit({ type: "note", text: `Your Otari key belongs to ${new URL(baseUrl).host}; switched the base URL there and saved it.` });
      },
    });
    switch (this.effectiveMode()) {
      case "otari": return otari;
      case "nano": return this.nano.status === "available" ? this.nanoProvider : new NanoSimProvider();
      case "hybrid": return new HybridProvider({ nano: this.nanoProvider, otari, nanoStatus: () => this.nano.status, onEvent: (e) => this.emit(e), demoFallback: !s.mode, cooldown: this.nanoCooldown });
      default: return new DemoProvider();
    }
  }
  describeProvider() {
    const mode = this.effectiveMode();
    const p = this.provider();
    let ok = true, note = "";
    if (mode === "otari" && !p.configured) { ok = false; note = "Add an Otari API key."; }
    if (mode === "nano" && p.id === "nano-sim") note = "Chrome's on-device model is not available here, so a labeled simulation runs. No model is called.";
    if (mode === "hybrid" && this.nano.status !== "available" && !p.otari.configured && !p.demoFallback) { ok = false; note = "Nano is not ready and no Otari key is set."; }
    if (mode === "hybrid" && p.demoFallback) note = "Automatic: Gemini Nano first; without an Otari key, Demo Mode answers when Nano can't.";
    return { mode, id: p.id, label: p.label, ok, note, automatic: !this.settings.mode };
  }

  /* agents */
  async runAgent(name, input, { from = "user", signal } = {}) {
    const def = this.agentDefs.get(name);
    const impl = this.agentImpl[name];
    if (!def || !impl) throw new OawError("UNKNOWN_AGENT", `Agent "${name}" is not defined in ${this.network?.metadata?.name || "the network"}.`);
    this.stats.agentCalls++;
    this.emit({ type: "handoff", from, to: name });
    if (impl.ruleBased || def.rule_based) {
      const t0 = performance.now();
      const out = await impl.run(input);
      this.emit({ type: "telemetry", agent: name, provider: "rules", ms: Math.round(performance.now() - t0), tokens_in: 0, tokens_out: 0, cost: 0 });
      return out;
    }
    const provider = this.provider();
    const system = [`You are ${name}, an agent of ${this.manifest?.name || this.site}.`, def.instructions].join("\n");
    const prompt = impl.prompt ? impl.prompt(input) : JSON.stringify(input);
    const schema = def.output_schema;
    this.emit({ type: "agent_start", agent: name, provider: provider.label });
    let r = await provider.generate({ agent: name, system, prompt, schema, signal, deterministic: () => impl.deterministic(input) });
    let errs = validate(schema, r.json);
    if (errs.length && !["demo", "nano-sim"].includes(provider.id)) {
      this.emit({ type: "note", agent: name, text: `Output did not match the schema (${errs.slice(0, 3).join("; ")}). Asking once more.` });
      const r2 = await provider.generate({ agent: name, system, prompt: `${prompt}\n\nYour previous reply had these problems: ${errs.slice(0, 5).join("; ")}. Fix them and reply with the full JSON object.`, schema, signal, deterministic: () => impl.deterministic(input) });
      const e2 = validate(schema, r2.json);
      if (e2.length <= errs.length) { r = { json: r2.json, telemetry: { ...r2.telemetry, ms: r.telemetry.ms + r2.telemetry.ms } }; errs = e2; }
    }
    const out = impl.normalize ? impl.normalize(r.json, input, errs) : r.json;
    if (out == null) throw new OawError("BAD_OUTPUT", `${name} returned unusable output: ${errs.slice(0, 3).join("; ")}`);
    if (errs.length) this.emit({ type: "note", agent: name, text: `Repaired ${errs.length} schema issue(s) with site defaults.` });
    this.emit({ type: "telemetry", agent: name, ...r.telemetry });
    this.emit({ type: "agent_output", agent: name, output: out });
    return out;
  }

  /* tools */
  async callTool(name, args = {}, ctx = {}) {
    const tool = this.tools[name];
    if (!tool) throw new OawError("UNKNOWN_TOOL", `No tool named "${name}" on ${this.site}.`);
    if (ctx.remote && !tool.rpc) throw new OawError("TOOL_NOT_EXPOSED", `Tool "${name}" is not callable by other sites.`);
    const errs = validate(tool.input_schema, args);
    if (errs.length) return { status: "rejected", errors: errs };
    const requestId = uid("req");
    this.stats.toolCalls++;
    this.emit({ type: "tool", state: "start", tool: name, effect: tool.effect, args, caller: ctx.origin || null });
    if (tool.precheck) {
      try { await tool.precheck(args, ctx); } catch (e) {
        this.emit({ type: "tool", state: "failed", tool: name, error: e.message });
        return { status: "failed", requestId, error: e.message, code: e.code || "PRECHECK" };
      }
    }
    if (tool.effect === "write") {
      const info = tool.describe ? tool.describe(args, ctx) : {};
      this.emit({ type: "approval", state: "pending", tool: name, requestId, caller: ctx.origin || null, price: info.price ?? null });
      const ok = await this.approveHook({ tool: name, title: tool.title || name, requestId, args, target: location.origin, caller: ctx.origin || location.origin, ...info });
      this.stats.approvals++;
      this.emit({ type: "approval", state: ok ? "approved" : "rejected", tool: name, requestId });
      if (!ok) { this.emit({ type: "tool", state: "declined", tool: name }); return { status: "declined", requestId }; }
    }
    try {
      const result = await tool.handler(args, { ...ctx, requestId });
      this.emit({ type: "tool", state: "ok", tool: name, effect: tool.effect });
      return { status: "succeeded", requestId, result };
    } catch (e) {
      this.emit({ type: "tool", state: "failed", tool: name, error: e.message });
      if (e.code === "ABORTED") throw e;
      return { status: "failed", requestId, error: e.message, code: e.code || "ERROR" };
    }
  }
}

/* ----------------------------------------------------- cross-origin fetch */

/** GET a public JSON artifact from another origin (no credentials) and report it as an event. */
export async function fetchJson(url, { emit, signal } = {}) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { credentials: "omit", signal, cache: "no-store" });
  } catch (e) {
    emit?.({ type: "fetch", url, ok: false, status: 0, ms: Math.round(performance.now() - t0), error: "network or CORS error" });
    throw new OawError("FETCH_FAILED", `Could not fetch ${url}. The site must be reachable and send Access-Control-Allow-Origin.`);
  }
  const ms = Math.round(performance.now() - t0);
  const cors = res.headers.get("access-control-allow-origin");
  emit?.({ type: "fetch", url, ok: res.ok, status: res.status, ms, cors });
  if (!res.ok) throw new OawError("HTTP", `${res.status} for ${url}`);
  try { return await res.json(); } catch { throw new OawError("INVALID_JSON", `${url} is not valid JSON.`); }
}

/* ------------------------------------------------------------------ RPC */

export const RPC = { REQUEST: "OAW_RPC_REQUEST", RESPONSE: "OAW_RPC_RESPONSE", EVENT: "OAW_RPC_EVENT" };

/**
 * Answer OAW_RPC_REQUEST messages from other windows.
 * methods: { ping, manifest, getState, run, callTool } -> (params, ctx) => result
 * Origins in trustedOrigins skip the connection prompt; every write still needs local approval.
 */
export function serveRpc({ runtime, methods, trustedOrigins = [], consent }) {
  const allowed = new Set(trustedOrigins);
  const open = new Set(["ping", "manifest"]);
  let queue = Promise.resolve();
  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!isObj(m) || m.type !== RPC.REQUEST || typeof m.id !== "string" || typeof m.method !== "string") return;
    if (!event.source || event.origin === "null") return;
    const src = event.source, origin = event.origin;
    const post = (msg) => { try { src.postMessage(msg, origin); } catch { /* caller went away */ } };
    const reply = (body) => post({ type: RPC.RESPONSE, id: m.id, ...body });
    const fn = methods[m.method];
    if (!fn) return reply({ ok: false, error: { code: "UNKNOWN_METHOD", message: `Unsupported method ${m.method}` } });
    const exec = async () => {
      if (!open.has(m.method) && !allowed.has(origin)) {
        const d = await consent({ origin, method: m.method, detail: m.params?.tool || m.params?.prompt || "" });
        runtime.emit({ type: "consent", origin, decision: d ? (d === "session" ? "allowed for session" : "allowed once") : "denied", direction: "inbound" });
        if (!d) throw new OawError("CONSENT_DENIED", `The user on ${location.origin} did not allow ${origin} to use these agents.`);
        if (d === "session") allowed.add(origin);
      }
      runtime.emit({ type: "rpc", direction: "in", method: m.method, tool: m.params?.tool || null, origin });
      const off = open.has(m.method) ? () => {} : runtime.on((ev) => post({ type: RPC.EVENT, id: m.id, event: ev }));
      try { return await fn(m.params || {}, { origin, remote: true }); } finally { off(); }
    };
    const run = () => exec().then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: { code: e.code || "ERROR", message: String(e.message || e) } }));
    if (open.has(m.method)) run();
    else queue = queue.then(run);
  });
}

/** Client side: send requests to one peer window/origin and receive streamed events. */
export class RpcClient {
  constructor({ origin, getWindow, onEvent }) {
    this.origin = origin;
    this.getWindow = getWindow;
    this.onEvent = onEvent;
    this.pending = new Map();
    this.handler = (event) => {
      if (event.origin !== this.origin) return;
      const w = this.getWindow();
      if (w && event.source !== w) return; // another window on the same origin (e.g. a second shop's frame)
      const m = event.data;
      if (!isObj(m) || !this.pending.has(m.id)) return;
      if (m.type === RPC.EVENT) this.onEvent?.(m.event);
      else if (m.type === RPC.RESPONSE) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else p.reject(new OawError(m.error?.code || "RPC_ERROR", m.error?.message || "Peer error"));
      }
    };
    window.addEventListener("message", this.handler);
  }
  close() { window.removeEventListener("message", this.handler); for (const p of this.pending.values()) p.reject(new OawError("CLOSED", "RPC closed")); this.pending.clear(); }
  call(method, params = {}, { timeout = 600000 } = {}) {
    const w = this.getWindow();
    if (!w) return Promise.reject(new OawError("NO_PEER_WINDOW", `The peer window for ${this.origin} is not open.`));
    const id = uid("rpc");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new OawError("RPC_TIMEOUT", `${this.origin} did not answer ${method} in time.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { w.postMessage({ type: RPC.REQUEST, id, method, params, from: location.origin }, this.origin); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async connect({ tries = 60, interval = 250 } = {}) {
    for (let i = 0; i < tries; i++) {
      try { return await this.call("ping", {}, { timeout: 800 }); } catch { await sleep(interval); }
    }
    throw new OawError("PEER_NOT_READY", `${this.origin} did not answer. Is the site open and running the OAW runtime?`);
  }
}

/** Install window.OpenAgenticWeb with the required shape. */
export function exposeGlobal({ manifest, run, callTool, getState, extra = {} }) {
  const api = { manifest, run, callTool, getState, version: CORE_VERSION, profile: PROFILE, ...extra };
  Object.defineProperty(window, "OpenAgenticWeb", { value: Object.freeze(api), configurable: true });
  return api;
}
