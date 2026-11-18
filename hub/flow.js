/**
 * flow.js: live workflow diagram for the hub. An SVG "pipe" of the five sites and their agents.
 * Nodes light up on agent handoffs, packets travel along the pipes for every RPC call, approvals pulse,
 * and verification colours each vendor. Driven only by the runtime's event stream (local and remote).
 */
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, ...kids) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); for (const c of kids) n.append(c); return n; };
const HUB_AGENTS = [["intake_agent", "Intake"], ["discovery_agent", "Discovery"], ["verifier_agent", "Verifier · ZK"], ["image_agent", "Images"], ["negotiator_agent", "Negotiator"], ["you", "You · approve"]];
const VENDOR_AGENTS = [["curator_agent", "Curator"], ["prover_agent", "Prover · ZK"], ["sales_agent", "Sales"]];
const trim = (u) => String(u).replace(/\/+$/, "");

export function createFlow(root, { registryUrl, vendors, label }) {
  const svg = el("svg", { viewBox: "0 0 1000 540", class: "flow-svg", role: "img", "aria-label": "Live workflow across the hub, the registry and the vendors" });
  const caption = document.createElement("p");
  caption.className = "flow-caption";
  caption.textContent = "Waiting for a request.";
  root.replaceChildren(svg, caption);
  const nodes = new Map(); // id -> { g, x, y }
  const lanes = new Map(); // site key -> { box, x, y, w, h }
  let activeHub = "intake_agent";

  const box = (x, y, w, h, title, cls) => {
    const g = el("g", { class: `lane ${cls}` });
    g.append(el("rect", { x, y, width: w, height: h, rx: 14 }), el("text", { x: x + 12, y: y + 20, class: "lane-title" }, title));
    svg.append(g);
    return g;
  };
  const node = (id, x, y, text, w = 112) => {
    const g = el("g", { class: "node", transform: `translate(${x} ${y})` });
    g.append(el("rect", { x: -w / 2, y: -15, width: w, height: 30, rx: 15 }), el("text", { y: 4.5, "text-anchor": "middle" }, text));
    svg.append(g);
    nodes.set(id, { g, x, y });
    return g;
  };
  const pipe = (x1, y1, x2, y2, id) => {
    const mx = (x1 + x2) / 2;
    const p = el("path", { d: `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, class: "pipe", "data-id": id });
    svg.prepend(p);
    return p;
  };

  // hub lane
  box(20, 30, 210, 490, "Buyer Hub · you", "hub");
  HUB_AGENTS.forEach(([id, t], i) => node(`hub:${id}`, 125, 80 + i * 76, t, 150));
  for (let i = 0; i < HUB_AGENTS.length - 1; i++) svg.prepend(el("path", { d: `M125 ${95 + i * 76} L125 ${141 + i * 76}`, class: "pipe chain" }));
  // registry lane
  const reg = trim(registryUrl);
  lanes.set(reg, { x: 300, y: 190, w: 200, h: 140 });
  box(300, 190, 200, 140, label(reg) || "Registry", "registry");
  node("reg:registry_clerk", 400, 245, "Registry clerk", 150);
  node("reg:custody", 400, 295, "Custody ledger", 150);
  pipe(200, 232, 300, 260, `pipe:${reg}`);
  // vendor lanes
  const vs = vendors.map(trim).slice(0, 4);
  const rowH = 490 / Math.max(3, vs.length);
  vs.forEach((u, i) => {
    const y = 30 + i * rowH, h = rowH - 14;
    lanes.set(u, { x: 560, y, w: 420, h });
    box(560, y, 420, h, label(u) || u, "vendor");
    VENDOR_AGENTS.forEach(([id, t], j) => node(`${u}:${id}`, 630 + j * 140, y + h / 2 + 8, t));
    for (let j = 0; j < 2; j++) svg.prepend(el("path", { d: `M${686 + j * 140} ${y + h / 2 + 8} L${714 + j * 140} ${y + h / 2 + 8}`, class: "pipe chain" }));
    pipe(200, 156, 560, y + h / 2, `pipe:${u}`);
  });

  const setNode = (id, state) => { const n = nodes.get(id); if (n) n.g.setAttribute("class", `node ${state || ""}`); };
  const flashPipe = (key) => { const p = svg.querySelector(`[data-id="pipe:${CSS.escape(key)}"]`); if (!p) return; p.classList.add("hot"); clearTimeout(p._t); p._t = setTimeout(() => p.classList.remove("hot"), 900); };
  const laneOf = (key) => lanes.get(trim(key));
  const say = (t) => { caption.textContent = t; };

  /** A packet travelling between the active hub agent and a site (back = site -> hub). */
  function packet(key, back, cls = "") {
    const lane = laneOf(key);
    const src = nodes.get(`hub:${activeHub}`);
    if (!lane || !src) return;
    const a = { x: 200, y: src.y }, b = { x: lane.x + 8, y: lane.y + lane.h / 2 };
    const [from, to] = back ? [b, a] : [a, b];
    const dot = el("circle", { r: 6, class: `packet ${back ? "back" : ""} ${cls}`, cx: 0, cy: 0 });
    dot.style.transform = `translate(${from.x}px, ${from.y}px)`;
    svg.append(dot);
    flashPipe(key);
    requestAnimationFrame(() => requestAnimationFrame(() => { dot.style.transform = `translate(${to.x}px, ${to.y}px)`; }));
    setTimeout(() => dot.remove(), 900);
  }

  function hubAgent(name) {
    if (!nodes.has(`hub:${name}`)) return;
    if (activeHub !== name) setNode(`hub:${activeHub}`, "done");
    activeHub = name;
    setNode(`hub:${name}`, "active");
  }

  return {
    reset() {
      for (const id of nodes.keys()) setNode(id, "");
      for (const [key] of lanes) svg.querySelector(`[data-id="pipe:${CSS.escape(key)}"]`)?.classList.remove("ok", "bad", "chosen");
      activeHub = "intake_agent";
      say("Request received.");
    },
    /** Events from this hub's runtime. */
    local(e) {
      if (e.type === "run_start") this.reset();
      if (e.type === "handoff") hubAgent(e.to);
      if (e.type === "agent_start" || e.type === "telemetry") hubAgent(e.agent);
      if (e.type === "rpc" && e.direction === "out" && e.origin) {
        const back = e.ms != null;
        packet(e.origin, back, e.ok === false ? "bad" : "");
        if (!back) say(`${label(e.origin)} ← ${e.tool || e.method}`);
      }
      if (e.type === "fetch" && e.url) { const key = [...lanes.keys()].find((k) => e.url.startsWith(k)); if (key) { packet(key, false, "fetch"); setTimeout(() => packet(key, true, "fetch"), 350); say(`Reading ${e.url.replace(/^https?:\/\//, "")}`); } }
      if (e.type === "approval" && /^(place_order|choose_offer)/.test(e.tool || "")) setNode("hub:you", e.state === "pending" ? "wait" : "done");
      if (e.type === "approval" && e.state === "pending") say(e.tool === "choose_offer" ? "Your turn: choose a verified offer." : "Your turn: approve the purchase.");
      if (e.type === "note" && e.agent && e.text) say(`${e.agent}: ${e.text}`.slice(0, 160));
      if (e.type === "run_end") { setNode(`hub:${activeHub}`, "done"); setNode("hub:you", e.ok ? "done" : "bad"); say(e.ok ? e.summary : e.error); }
    },
    /** Events streamed back from a peer site during an RPC call. */
    remote(e, key) {
      const k = trim(key);
      const prefix = k === reg ? "reg" : k;
      if (e.type === "handoff" || e.type === "agent_start" || e.type === "telemetry") {
        const name = e.to || e.agent;
        for (const [id] of VENDOR_AGENTS) if (nodes.get(`${prefix}:${id}`)?.g.classList.contains("active")) setNode(`${prefix}:${id}`, "done");
        setNode(`${prefix}:${name}`, "active");
        if (e.type === "handoff") say(`${label(k)}: ${name}`);
      }
      if (e.type === "tool" && prefix === "reg") setNode(e.tool === "record_transfer" ? "reg:custody" : "reg:registry_clerk", e.state === "start" ? "active" : "done");
      if (e.type === "tool" && e.tool === "prove_item" && e.state === "start") say(`${label(k)}: generating a zero-knowledge proof…`);
      if (e.type === "approval") {
        const id = prefix === "reg" ? "reg:custody" : `${prefix}:sales_agent`;
        setNode(id, e.state === "pending" ? "wait" : e.state === "approved" ? "ok" : "bad");
        if (e.state === "pending") say(`${label(k)}: waiting for its owner to approve ${e.tool}`);
      }
    },
    /** Verification result for a vendor: every offer rejected -> bad, any verified -> ok. */
    verdict(key, ok) {
      const k = trim(key);
      svg.querySelector(`[data-id="pipe:${CSS.escape(k)}"]`)?.classList.add(ok ? "ok" : "bad");
      setNode(`${k}:prover_agent`, ok ? "ok" : "bad");
    },
    chosen(key) { svg.querySelector(`[data-id="pipe:${CSS.escape(trim(key))}"]`)?.classList.add("chosen"); },
  };
}
