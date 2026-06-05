// Generates the self-contained picker HTML page (PRD §6.3).
// Single file: inline CSS + vanilla JS, no build step.
//
// Regeneration reuses the CURRENT CONVERSATION's model: the page does NOT call
// any LLM. "Generate variants" tells the tool to return decision:"regenerate";
// the agent then generates the next batch and re-calls the tool with the same
// token. The page shows skeletons and long-polls /api/next-batch meanwhile, then
// swaps in the agent's new variants in place (same tab, no reload).

import { DEFAULT_BATCH_SIZE } from "./types";

export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Variant Picker</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1f2430; --border: #2a2f3a;
    --text: #e7e9ee; --muted: #9aa3b2; --accent: #5b8cff; --accent-2: #3a6ad4;
    --ok: #2ecc71; --shimmer-a: #1c212b; --shimmer-b: #262c38;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column;
  }
  header {
    padding: 16px 20px; border-bottom: 1px solid var(--border);
    background: var(--panel); display: flex; align-items: center; gap: 16px;
    position: sticky; top: 0; z-index: 5;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .ctx { color: var(--muted); font-size: 13px; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .round { font-size: 12px; color: var(--muted); white-space: nowrap;
    background: var(--panel-2); padding: 4px 10px; border-radius: 999px;
    border: 1px solid var(--border); }
  main { flex: 1; overflow: auto; padding: 20px; }
  .grid {
    display: grid; gap: 16px;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .tile {
    background: var(--panel); border: 2px solid var(--border);
    border-radius: var(--radius); overflow: hidden; cursor: pointer;
    transition: border-color .12s, transform .12s, box-shadow .12s;
    display: flex; flex-direction: column; position: relative;
  }
  .tile:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.35); }
  .tile.selected { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(91,140,255,.25); }
  .tile .frame-wrap { background: #fff; height: 200px; overflow: hidden; }
  .tile iframe { width: 100%; height: 100%; border: 0; display: block;
    background: #fff; pointer-events: none; }
  .tile .meta { padding: 8px 10px; display: flex; align-items: center; gap: 8px;
    border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  .tile .check {
    width: 18px; height: 18px; border-radius: 999px; border: 1px solid var(--border);
    display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
    font-size: 11px; color: transparent;
  }
  .tile.selected .check { background: var(--accent); border-color: var(--accent); color: #fff; }
  .tile .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .skeleton .frame-wrap { background: var(--shimmer-a); position: relative; }
  .skeleton .frame-wrap::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(90deg, var(--shimmer-a) 0%, var(--shimmer-b) 50%, var(--shimmer-a) 100%);
    background-size: 200% 100%; animation: shimmer 1.2s infinite;
  }
  .skeleton { cursor: default; }
  .skeleton:hover { transform: none; box-shadow: none; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  footer {
    border-top: 1px solid var(--border); background: var(--panel);
    padding: 12px 20px; display: flex; gap: 12px; align-items: center;
    position: sticky; bottom: 0; z-index: 5;
  }
  footer input[type=text] {
    flex: 1; background: var(--panel-2); border: 1px solid var(--border);
    color: var(--text); border-radius: 8px; padding: 10px 12px; font-size: 13px;
  }
  footer input[type=text]:focus { outline: none; border-color: var(--accent); }
  .count {
    display: flex; align-items: center; gap: 6px; color: var(--muted);
    font-size: 12px; white-space: nowrap;
  }
  .count select {
    background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 9px 8px; font-size: 13px; cursor: pointer;
  }
  .count select:focus { outline: none; border-color: var(--accent); }
  button {
    border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
    padding: 10px 16px; border-radius: 8px; font-size: 13px; font-weight: 600;
    cursor: pointer; white-space: nowrap; transition: background .12s, opacity .12s;
  }
  button:hover:not(:disabled) { background: #2b3240; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent-2); color: #fff; }
  button.primary:hover:not(:disabled) { background: var(--accent-2); }

  .status { font-size: 12px; color: var(--muted); margin-right: auto; }
  .status.active { color: var(--accent); }

  .toast {
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    background: #3a1d1d; color: #ffb4b4; border: 1px solid #5a2a2a;
    padding: 10px 16px; border-radius: 8px; font-size: 13px; max-width: 80%;
    opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 10;
  }
  .toast.show { opacity: 1; }

  .done {
    position: fixed; inset: 0; background: rgba(15,17,21,.96);
    display: none; align-items: center; justify-content: center; flex-direction: column;
    gap: 14px; z-index: 20; text-align: center; padding: 24px;
  }
  .done.show { display: flex; }
  .done .ok-circle {
    width: 64px; height: 64px; border-radius: 999px; background: var(--ok);
    display: flex; align-items: center; justify-content: center; font-size: 32px; color: #fff;
  }
  .done h2 { margin: 0; font-size: 18px; }
  .done p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
  <header>
    <h1>Variant Picker</h1>
    <div class="ctx" id="ctx">Loading…</div>
    <div class="round" id="round">Round 1</div>
  </header>

  <main>
    <div class="grid" id="grid"></div>
  </main>

  <footer>
    <span class="status" id="status"></span>
    <input type="text" id="instructions" placeholder="Add instructions to steer the next round…" />
    <label class="count" for="count">Next:
      <select id="count" title="How many variants to generate next round">
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="6">6</option>
        <option value="9">9</option>
        <option value="12">12</option>
        <option value="16">16</option>
        <option value="20">20</option>
      </select>
    </label>
    <button id="regen">Generate variants of this</button>
    <button id="use" class="primary" disabled>Use this</button>
  </footer>

  <div class="toast" id="toast"></div>

  <div class="done" id="done">
    <div class="ok-circle">✓</div>
    <h2 id="done-title">Selection sent</h2>
    <p id="done-msg">You can close this tab. Control has returned to the agent.</p>
  </div>

<script>
(function () {
  "use strict";
  const TOKEN = ${JSON.stringify(token)} ||
    new URLSearchParams(location.search).get("token") || "";
  const DEFAULT_BATCH = ${DEFAULT_BATCH_SIZE};

  const els = {
    ctx: document.getElementById("ctx"),
    round: document.getElementById("round"),
    grid: document.getElementById("grid"),
    instructions: document.getElementById("instructions"),
    count: document.getElementById("count"),
    regen: document.getElementById("regen"),
    use: document.getElementById("use"),
    status: document.getElementById("status"),
    toast: document.getElementById("toast"),
    done: document.getElementById("done"),
    doneTitle: document.getElementById("done-title"),
    doneMsg: document.getElementById("done-msg"),
  };

  let state = {
    variants: [], componentContext: "", batchSize: DEFAULT_BATCH,
    round: 1, selectedId: null, busy: false, finished: false,
  };

  function api(path) {
    const u = new URL(path, location.origin);
    u.searchParams.set("token", TOKEN);
    return u.toString();
  }

  function desiredCount() {
    const n = parseInt(els.count.value, 10);
    return Number.isFinite(n) ? n : DEFAULT_BATCH;
  }

  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.remove("show"), 4500);
  }

  function setStatus(msg, active) {
    els.status.textContent = msg || "";
    els.status.classList.toggle("active", !!active);
  }

  function setRound(n) {
    state.round = n;
    els.round.textContent = "Round " + n + " — " + state.variants.length + " variants";
  }

  function updateButtons() {
    els.use.disabled = state.busy || state.finished || !state.selectedId;
    els.regen.disabled = state.busy || state.finished;
    els.instructions.disabled = state.finished;
    els.count.disabled = state.busy || state.finished;
  }

  function select(id) {
    if (state.busy || state.finished) return;
    state.selectedId = id;
    for (const tile of els.grid.children) tile.classList.toggle("selected", tile.dataset.id === id);
    updateButtons();
  }

  function makeTile(variant) {
    const tile = document.createElement("div");
    tile.className = "tile"; tile.dataset.id = variant.id;
    const wrap = document.createElement("div"); wrap.className = "frame-wrap";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", ""); // no scripts, no same-origin (PRD §8)
    iframe.setAttribute("loading", "lazy");
    iframe.srcdoc = variant.html;
    wrap.appendChild(iframe);
    const meta = document.createElement("div"); meta.className = "meta";
    const check = document.createElement("span"); check.className = "check"; check.textContent = "✓";
    const label = document.createElement("span"); label.className = "label";
    label.textContent = variant.label || variant.id;
    meta.appendChild(check); meta.appendChild(label);
    tile.appendChild(wrap); tile.appendChild(meta);
    tile.addEventListener("click", () => select(variant.id));
    return tile;
  }

  function renderVariants() {
    els.grid.innerHTML = "";
    for (const v of state.variants) els.grid.appendChild(makeTile(v));
    if (state.selectedId && !state.variants.some((v) => v.id === state.selectedId)) state.selectedId = null;
    for (const tile of els.grid.children) tile.classList.toggle("selected", tile.dataset.id === state.selectedId);
    setRound(state.round);
    updateButtons();
  }

  function renderSkeletons(n) {
    els.grid.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const tile = document.createElement("div"); tile.className = "tile skeleton";
      const wrap = document.createElement("div"); wrap.className = "frame-wrap";
      const meta = document.createElement("div"); meta.className = "meta";
      meta.innerHTML = '<span class="check"></span><span class="label">Generating…</span>';
      tile.appendChild(wrap); tile.appendChild(meta);
      els.grid.appendChild(tile);
    }
  }

  async function loadSession() {
    const res = await fetch(api("/api/session"));
    if (!res.ok) throw new Error("session load failed: " + res.status);
    const data = await res.json();
    state.variants = data.variants || [];
    state.componentContext = data.componentContext || "";
    state.batchSize = data.batchSize || DEFAULT_BATCH;
    state.round = (data.rounds || 0) + 1;
    // Reflect the session's current batch size in the selector if present.
    if (data.batchSize) {
      const opt = Array.prototype.find.call(els.count.options, (o) => parseInt(o.value, 10) === data.batchSize);
      if (opt) els.count.value = String(data.batchSize);
    }
    els.ctx.textContent = state.componentContext || "(no component context)";
    els.ctx.title = state.componentContext || "";

    // Round-1 fast open: the tab was opened with NO variants yet. Show skeletons
    // immediately and long-poll for the agent's first batch (same plumbing as a
    // regenerate round) so the user never stares at a blank screen.
    if (state.variants.length === 0) {
      await awaitFirstBatch();
      return;
    }
    renderVariants();
  }

  // Display skeletons and wait for the agent's first batch to arrive.
  async function awaitFirstBatch() {
    state.busy = true;
    renderSkeletons(state.batchSize);
    els.round.textContent = "Round 1 — waiting for the agent…";
    setStatus("Waiting for the agent to generate " + state.batchSize + " variants…", true);
    try {
      const next = await waitForNextBatch();
      if (next === null) {
        if (!state.finished) showToast("Session ended before any variants arrived.");
        return;
      }
      state.variants = next;
      state.selectedId = null;
      setStatus("");
      renderVariants();
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  // Long-poll for the agent's next batch after a regenerate request.
  async function waitForNextBatch() {
    while (!state.finished) {
      let res;
      try {
        res = await fetch(api("/api/next-batch"));
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1500)); // transient network; retry
        continue;
      }
      if (!res.ok) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      const data = await res.json();
      if (data.ended) { // session ended server-side
        return null;
      }
      if (data.retry || data.variants === null) {
        continue; // poll window elapsed; immediately re-poll
      }
      if (Array.isArray(data.variants)) {
        if (typeof data.rounds === "number") state.round = data.rounds + 1;
        return data.variants;
      }
    }
    return null;
  }

  async function regenerate() {
    if (state.busy || state.finished || !state.selectedId) return;
    const base = state.variants.find((v) => v.id === state.selectedId);
    const want = desiredCount();
    state.busy = true; updateButtons();
    renderSkeletons(want);
    els.round.textContent = "Round " + (state.round + 1) + " — waiting for the agent…";
    setStatus("Asking the agent to generate " + want + " new variants…", true);

    try {
      const res = await fetch(api("/api/select"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "regenerate",
          baseVariant: base,
          userInstructions: els.instructions.value || "",
          desiredBatchSize: want,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);

      const next = await waitForNextBatch();
      if (next === null) {
        if (!state.finished) showToast("Session ended while waiting for new variants.");
        return;
      }
      state.variants = next;
      state.selectedId = null;
      setStatus("");
      renderVariants();
    } catch (err) {
      setStatus("");
      showToast("Regeneration failed: " + (err && err.message ? err.message : err) + " — keeping previous batch.");
      renderVariants();
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  async function useThis() {
    if (state.busy || state.finished || !state.selectedId) return;
    const chosen = state.variants.find((v) => v.id === state.selectedId);
    if (!chosen) return;
    state.busy = true; updateButtons();
    try {
      const res = await fetch(api("/api/select"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "use", chosenVariant: chosen,
          userInstructions: els.instructions.value || "",
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.finished = true; stopHeartbeat();
      els.done.classList.add("show");
      setTimeout(() => { try { window.close(); } catch (e) {} }, 400);
    } catch (err) {
      showToast("Could not send selection: " + (err && err.message ? err.message : err));
      state.busy = false; updateButtons();
    }
  }

  // Graceful cancellation (PRD §9): beacon the server on tab close so the tool
  // resolves as "abandoned" immediately instead of waiting for the reaper.
  function beaconClose() {
    if (state.finished) return; // a real selection was already sent
    try {
      const url = api("/api/close");
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([], { type: "text/plain" }));
      } else {
        fetch(url, { method: "POST", keepalive: true }).catch(() => {});
      }
    } catch (e) {}
  }
  window.addEventListener("pagehide", beaconClose);
  window.addEventListener("beforeunload", beaconClose);

  let hbTimer = null;
  function startHeartbeat() {
    hbTimer = setInterval(() => { fetch(api("/api/heartbeat"), { method: "POST" }).catch(() => {}); }, 5000);
  }
  function stopHeartbeat() { if (hbTimer) clearInterval(hbTimer); hbTimer = null; }

  els.regen.addEventListener("click", regenerate);
  els.use.addEventListener("click", useThis);

  loadSession().then(startHeartbeat).catch((err) => {
    els.ctx.textContent = "Failed to load session: " + (err && err.message ? err.message : err);
  });
})();
</script>
</body>
</html>`;
}
