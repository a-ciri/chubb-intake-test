/* Autonomous intake with exception routing.
   The AI extracts every field and quotes its source; automatic checks (checks.js) accept a field or route
   it to a person. The benchmark scores a rule-based baseline, the raw AI and the AI with checks against
   hidden answer keys. Records stay in this browser (localStorage) and export as CSV. */
(function () {
  "use strict";
  const S = window.Scoring, R = window.Rules, C = window.Checks;
  const STORE = "intake-auto-v1";
  const main = document.getElementById("main");
  const state = { packets: null, keys: null, log: [], bench: { results: {} }, storageOk: true, work: null, running: false, stop: false };

  /* ---------- helpers ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const pct = x => (x === null || x === undefined || Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const fmtNum = n => Number(n).toLocaleString("en-US");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const median = xs => S.median(xs.filter(x => Number.isFinite(x)));
  const today = () => new Date().toISOString().slice(0, 10);
  const display = (f, v) => {
    if (v === null || v === undefined || v === "") return "Not in packet";
    if (f.type === "text" || f.type === "industry") return String(v);   // show names exactly as extracted
    const n = S.normalize(f, v);
    return (f.type === "money" || f.type === "int") && typeof n === "number" ? fmtNum(n) : (n || String(v));
  };

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE) || "{}");
      state.log = Array.isArray(d.log) ? d.log : [];
      state.bench = d.bench && d.bench.results ? d.bench : { results: {} };
    } catch (_) { state.storageOk = false; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ log: state.log, bench: state.bench })); }
    catch (_) { state.storageOk = false; }
  }
  function toast(msg) {
    const t = h("div", { class: "toast", role: "status" }, msg);
    document.body.append(t); setTimeout(() => t.remove(), 4000);
  }
  async function loadKeys() {
    if (state.keys) return state.keys;
    const r = await fetch("data/answer-keys.b64");
    state.keys = JSON.parse(atob((await r.text()).trim()));
    return state.keys;
  }
  const allPackets = () => [...state.packets.practice, ...state.packets.study];
  const packetById = id => allPackets().find(p => p.id === id);

  /* Call the AI function. Returns {ok, data} or {ok:false, error, status, data}. */
  async function callAi(text) {
    const t0 = performance.now();
    try {
      const r = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packet: text }) });
      let d = {}; try { d = await r.json(); } catch (_) { /* non-JSON */ }
      const seconds = (performance.now() - t0) / 1000;
      if (!r.ok || !d.fields) {
        const why = Array.isArray(d.tried) && d.tried.length
          ? ` [${d.tried.map(x => `${x.model}: ${x.status}${x.ms ? ` at ${Math.round(x.ms / 1000)}s` : ""}`).join("; ")}]` : "";
        return { ok: false, status: r.status, seconds, error: (d.error || `The AI service returned an error (${r.status}).`) + why };
      }
      return { ok: true, seconds, data: d };
    } catch (_) {
      return { ok: false, status: 0, seconds: (performance.now() - t0) / 1000, error: "The AI service could not be reached." };
    }
  }

  /* ---------- views ---------- */
  function setView(node, title) {
    stopTimer(); state.work = null;
    main.replaceChildren(node);
    document.title = `${title} | Intake autopilot`;
    const hash = (location.hash || "#home").slice(1);
    document.querySelectorAll("[data-nav]").forEach(a => a.setAttribute("aria-current", a.dataset.nav === hash ? "page" : "false"));
    const h1 = main.querySelector("h1"); if (h1) { h1.setAttribute("tabindex", "-1"); h1.focus(); }
  }

  function viewHome() {
    const health = h("p", { class: "muted", "aria-live": "polite" });
    const done = Object.values(state.bench.results).filter(r => r.ai_status === "ok").length;
    return h("section", { class: "page" },
      h("h1", {}, "Intake autopilot"),
      h("p", { class: "lede" }, "An AI reads each broker submission and fills the 10-field intake record on its own. Automatic checks accept the values they can confirm and send only the doubtful ones to a person."),
      !state.storageOk && h("p", { class: "banner error" }, "This browser is blocking local storage, so results will be lost on refresh. Use another browser."),
      h("h2", {}, "How a packet is processed"),
      h("ol", { class: "steps" },
        h("li", {}, h("strong", {}, "The AI extracts. "), "Gemini fills all 10 fields and quotes the line of the packet each value came from."),
        h("li", {}, h("strong", {}, "The checks decide. "), "A value is accepted only if its quote is really in the packet, the value appears in that quote, it is plausible, and an independent rule-based reader does not disagree."),
        h("li", {}, h("strong", {}, "A person handles the exceptions. "), "Fields that fail a check go to review with the reason. A packet with instructions aimed at the AI is held entirely. If the AI is unavailable, the packet falls back to manual entry.")),
      h("p", { class: "actions" },
        h("a", { class: "btn", href: "#process" }, "Process a packet"),
        h("a", { class: "btn secondary", href: "#benchmark" }, done ? `Benchmark (${done} of 30 run)` : "Run the benchmark")),
      h("h2", {}, "The benchmark"),
      h("p", {}, "The benchmark runs all 30 synthetic packets through three approaches and scores them against hidden answer keys: a rule-based extractor with no AI (the baseline), the AI on its own, and the AI with automatic checks."),
      h("p", { class: "actions" }, h("button", { class: "btn quiet", type: "button", onclick: () => checkHealth(health) }, "Check AI connection")),
      health);
  }

  async function checkHealth(out) {
    out.textContent = "Checking…";
    try {
      const d = await (await fetch("/api/extract", { method: "GET" })).json();
      if (!d.keyConfigured) out.textContent = "The AI function is running, but GEMINI_API_KEY is not set in Vercel.";
      else if (!d.model) out.textContent = "The key is set, but Google returned no usable model. Check the key in Google AI Studio.";
      else out.textContent = `AI connected. Model in use: ${d.model}${d.configuredModel && d.configuredModel !== d.model ? ` (GEMINI_MODEL "${d.configuredModel}" is not available)` : ""}.`;
    } catch (_) { out.textContent = "The AI function could not be reached. On a local preview this is expected."; }
  }

  function viewProcess() {
    const processed = new Set(state.log.map(r => r.packet_id));
    const notes = { P1: "Labeled packet, nothing missing", P2: "Conversational email, two values missing", P3: "Contains an instruction aimed at the AI" };
    const item = p => h("li", {},
      h("button", { class: "linkish", type: "button", onclick: () => startWork(p) }, p.id),
      h("span", { class: "tag plain" }, p.style === "narrative" ? "Conversational" : "Labeled"),
      p.answer ? h("span", { class: "muted" }, notes[p.id] || "") : processed.has(p.id) && h("span", { class: "muted" }, "Processed"));
    return h("section", { class: "page" },
      h("h1", {}, "Process a packet"),
      h("p", { class: "lede" }, "Pick a submission. The AI drafts the record, the checks accept what they can confirm, and you review only the flagged fields."),
      h("h2", {}, "Practice packets"),
      h("p", {}, "These show the correct answers after you approve, so you can see what the checks caught."),
      h("ul", { class: "packet-list" }, state.packets.practice.map(item)),
      h("h2", {}, "Study packets"),
      h("p", {}, "These are the 30 packets used in the benchmark. Approved records are saved to the intake log on the Data page."),
      h("ul", { class: "packet-grid" }, state.packets.study.map(item)));
  }

  function viewTry() {
    const ta = h("textarea", { id: "try-text", rows: "14", maxlength: "20000", "aria-describedby": "try-count try-warn" });
    const count = h("p", { id: "try-count", class: "muted" }, "0 of 20,000 characters");
    const err = h("p", { class: "err", role: "alert" });
    ta.addEventListener("input", () => { count.textContent = `${ta.value.length.toLocaleString("en-US")} of 20,000 characters`; });
    return h("section", { class: "page" },
      h("h1", {}, "Try your own text"),
      h("p", { class: "lede" }, "Paste any submission-style text and see what the AI and the checks do with it. Nothing here is saved."),
      h("p", { id: "try-warn", class: "banner" }, "Paste only synthetic or public text. Don't paste real customer or confidential information: the text is sent to Google's Gemini API."),
      h("label", { for: "try-text" }, "Submission text"), ta, count, err,
      h("button", { class: "btn", type: "button", onclick: () => {
        if (!ta.value.trim()) { err.textContent = "Paste some text first."; ta.focus(); return; }
        startWork({ id: "Your text", text: ta.value, synthetic: false }, "try");
      } }, "Process with AI"));
  }

  /* ---------- workspace ---------- */
  let timerId = null;
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  function startWork(packet, forceMode) {
    stopTimer();
    const mode = forceMode || (packet.answer ? "practice" : "intake");
    state.work = { packet, mode, t0: performance.now(), startedAt: new Date().toISOString(), ai: { status: "pending" }, gate: null };
    history.replaceState(null, "", "#work");   // its own address, so Back and the menu always navigate away
    document.querySelectorAll("[data-nav]").forEach(a => a.setAttribute("aria-current", "false"));
    renderWorkspace();
    runAi();
  }

  function fieldRow(f) {
    const id = "f-" + f.id;
    const input = f.type === "industry"
      ? h("select", { id, name: f.id }, h("option", { value: "" }, "Choose…"), S.INDUSTRIES.map(i => h("option", { value: i }, i)))
      : h("input", { id, name: f.id, type: "text", autocomplete: "off", inputmode: (f.type === "money" || f.type === "int") ? "decimal" : "text", maxlength: "200" });
    const nip = h("input", { type: "checkbox", class: "nip", id: id + "-nip" });
    const rev = h("input", { type: "checkbox", class: "rev", id: id + "-rev" });
    const row = h("div", { class: "field", "data-field": f.id },
      h("div", { class: "fhead" }, h("label", { for: id, class: "flabel" }, f.label), h("span", { class: "status-tag" })),
      h("div", { class: "control" }, input, h("label", { class: "nip-label", for: id + "-nip" }, nip, " Not in packet")),
      h("p", { class: "evidence" }),
      h("ul", { class: "reasons" }),
      h("div", { class: "review" }, h("label", { for: id + "-rev" }, rev, " Checked")),
      h("p", { class: "err", role: "alert" }));
    const touched = () => { if (state.work && state.work.ai.status === "ok") { rev.checked = true; row.classList.add("checked"); updateCount(); } };
    input.addEventListener("input", () => { row.querySelector(".err").textContent = ""; touched(); });
    nip.addEventListener("change", () => { input.disabled = nip.checked; if (nip.checked) input.value = ""; row.querySelector(".err").textContent = ""; touched(); });
    rev.addEventListener("change", () => { row.classList.toggle("checked", rev.checked); updateCount(); });
    return row;
  }

  function renderWorkspace() {
    const w = state.work;
    const timer = h("span", { class: "timer", role: "timer", "aria-label": "Elapsed time" }, "0:00");
    const status = h("div", { class: "ai-status working", "aria-live": "polite" }, "The AI is reading the packet…");
    const count = h("span", { class: "review-count", "aria-live": "polite" });
    const saveBtn = h("button", { class: "btn", type: "submit", disabled: true }, "Approve record");
    const form = h("form", { class: "form", novalidate: true, onsubmit: e => { e.preventDefault(); submitWork(); } },
      status, S.FIELDS.map(fieldRow), h("div", { class: "actionbar" }, timer, count, saveBtn));
    const label = w.mode === "practice" ? `Practice packet ${w.packet.id}` : w.mode === "try" ? "Your text" : `Study packet ${w.packet.id}`;
    main.replaceChildren(h("section", { class: "work" },
      h("div", { class: "workbar" }, h("a", { href: w.mode === "try" ? "#try" : "#process" }, "← Back"), h("span", {}, label),
        w.packet.style && h("span", { class: "tag plain" }, w.packet.style === "narrative" ? "Conversational" : "Labeled")),
      h("h1", { class: "sr-only" }, label),
      h("div", { class: "split" },
        h("article", { class: "doc", "aria-label": "Submission packet" },
          h("div", { class: "doc-head" }, h("h2", {}, `Submission ${w.packet.id}`), w.packet.synthetic !== false && h("span", { class: "tag plain" }, "Synthetic")),
          h("pre", { class: "doc-text" }, w.packet.text)),
        form)));
    w.els = { timer, status, count, saveBtn, form };
    timerId = setInterval(() => { timer.textContent = fmtTime((performance.now() - w.t0) / 1000); }, 1000);
    form.querySelectorAll("input, select").forEach(el => { el.disabled = true; });
    main.querySelector("h1").focus();
  }

  const rowOf = id => state.work.els.form.querySelector(`[data-field="${id}"]`);
  const inputOf = row => row.querySelector("input:not([type=checkbox]), select");

  async function runAi() {
    const w = state.work;
    w.els.status.className = "ai-status working";
    w.els.status.textContent = "The AI is reading the packet…";
    const res = await callAi(w.packet.text);
    if (state.work !== w) return;
    if (!res.ok) {
      w.ai = { status: "fallback", seconds: res.seconds, error: res.error };
      return showFallback(res.error);
    }
    const d = res.data;
    w.ai = { status: "ok", seconds: res.seconds, model: d.model || "", attempts: d.attempts || 1, tokens: d.usage ? d.usage.total_tokens : "", fields: d.fields, evidence: d.evidence || {} };
    w.rules = R.extract(w.packet.text);
    w.gate = C.gate(w.packet.text, { fields: d.fields, evidence: d.evidence || {} }, w.rules);
    applyGate();
  }

  function applyGate() {
    const w = state.work, g = w.gate;
    let review = 0;
    for (const f of S.FIELDS) {
      const row = rowOf(f.id), input = inputOf(row), nip = row.querySelector(".nip"), rev = row.querySelector(".rev");
      const gf = g.fields[f.id];
      row.querySelectorAll("input, select").forEach(el => { el.disabled = false; });
      if (gf.value === null) { nip.checked = true; input.value = ""; input.disabled = true; }
      else input.value = display(f, gf.value);
      row.querySelector(".evidence").replaceChildren(gf.evidence ? h("span", {}, "Source: ", h("q", {}, gf.evidence)) : h("span", { class: "muted" }, "No source quoted"));
      const tag = row.querySelector(".status-tag");
      if (gf.status === "auto") {
        row.classList.add("auto-ok", "checked"); rev.checked = true;
        tag.className = "status-tag tag ok"; tag.textContent = "Auto-accepted";
      } else {
        review++;
        row.classList.add("needs-check");
        tag.className = "status-tag tag check"; tag.textContent = "Check";
        row.querySelector(".reasons").replaceChildren(...gf.reasons.filter(r => r !== "Packet held for review").map(r => h("li", {}, r)));
      }
    }
    const s = w.els.status;
    if (g.held) {
      s.className = "ai-status failed";
      s.replaceChildren(h("strong", {}, "Packet held. "), g.held + ". Every field needs a person's check.");
    } else {
      s.className = "ai-status ready";
      s.textContent = review === 0
        ? "All 10 fields were auto-accepted. You can approve, or open any field to change it."
        : `${10 - review} of 10 fields auto-accepted. Check the ${review} flagged field${review === 1 ? "" : "s"} against the packet.`;
    }
    w.reviewNeeded = review;
    updateCount();
  }

  function showFallback(msg) {
    const w = state.work;
    w.els.form.querySelectorAll("input, select").forEach(el => { el.disabled = false; });
    w.els.form.querySelectorAll(".review").forEach(el => el.remove());
    w.els.saveBtn.textContent = "Save record"; w.els.saveBtn.disabled = false;
    w.els.status.className = "ai-status failed";
    w.els.status.replaceChildren(h("strong", {}, "AI unavailable, so the system stopped safely. "), msg + " ",
      "Retry, or enter this packet manually. ",
      h("button", { class: "btn quiet small", type: "button", onclick: () => { stopTimer(); startWork(w.packet, w.mode === "try" ? "try" : undefined); } }, "Retry AI"));
    updateCount();
  }

  function updateCount() {
    const w = state.work; if (!w || !w.els) return;
    if (w.ai.status !== "ok") { w.els.count.textContent = ""; w.els.saveBtn.disabled = w.ai.status === "pending"; return; }
    const pending = w.els.form.querySelectorAll(".rev:not(:checked)").length;
    w.els.count.textContent = pending ? `${pending} field${pending === 1 ? "" : "s"} left to check` : "Ready to approve";
    w.els.saveBtn.disabled = pending > 0;
  }

  function readForm() {
    const vals = {};
    for (const f of S.FIELDS) {
      const row = rowOf(f.id);
      vals[f.id] = inputOf(row).value.trim();
      vals[f.id + "_missing"] = row.querySelector(".nip").checked;
    }
    return vals;
  }

  function submitWork() {
    const w = state.work, vals = readForm();
    let firstBad = null;
    for (const f of S.FIELDS) {
      const row = rowOf(f.id), msg = S.validateEntry(f, vals[f.id], vals[f.id + "_missing"]);
      row.querySelector(".err").textContent = msg;
      if (msg && !firstBad) firstBad = inputOf(row);
    }
    if (firstBad) { firstBad.focus(); return; }
    const seconds = (performance.now() - w.t0) / 1000;
    stopTimer();
    let changed = "", auto = "", review = "";
    if (w.ai.status === "ok") {
      changed = S.FIELDS.filter(f => {
        const d = w.gate.fields[f.id].value, dm = d === null;
        if (dm !== vals[f.id + "_missing"]) return true;
        return !dm && !S.sameValue(f, d, vals[f.id]);
      }).length;
      auto = S.FIELDS.filter(f => w.gate.fields[f.id].status === "auto").length;
      review = 10 - auto;
    }
    if (w.mode === "intake") {
      const rec = {
        packet_id: w.packet.id, style: w.packet.style || "", approved_at: new Date().toISOString(),
        duration_s: Math.round(seconds * 10) / 10, ai_status: w.ai.status, ai_model: w.ai.model || "",
        ai_latency_s: w.ai.seconds ? Math.round(w.ai.seconds * 10) / 10 : "", ai_attempts: w.ai.attempts || "", ai_tokens: w.ai.tokens || "",
        held: w.gate && w.gate.held ? "yes" : "no", fields_auto: auto, fields_review: review, fields_changed: changed
      };
      for (const f of S.FIELDS) { rec[f.id] = vals[f.id]; rec[f.id + "_missing"] = vals[f.id + "_missing"]; }
      state.log = state.log.filter(r => r.packet_id !== w.packet.id);
      state.log.push(rec); save();
      toast(`Approved ${w.packet.id} in ${fmtTime(seconds)}.`);
      location.hash = "#process";
    } else if (w.mode === "practice") {
      practiceFeedback(vals, seconds, changed);
    } else {
      w.els.form.querySelectorAll("input, select, button").forEach(el => { el.disabled = true; });
      w.els.status.className = "ai-status ready";
      w.els.status.textContent = `Approved in ${fmtTime(seconds)}${changed !== "" ? `; you changed ${changed} of 10 AI values` : ""}. Nothing from this page is saved.`;
    }
  }

  function practiceFeedback(vals, seconds, changed) {
    const w = state.work, key = w.packet.answer;
    const finalScore = S.scoreRecord(vals, key);
    const aiScore = w.ai.status === "ok" ? S.scoreRecord(C.toRecord(w.ai.fields), key) : null;
    w.els.form.querySelectorAll("input, select, button").forEach(el => { el.disabled = true; });
    let caught = 0, slipped = 0;
    for (const f of S.FIELDS) {
      const row = rowOf(f.id), ok = finalScore.perField[f.id], truth = key[f.id];
      row.classList.add(ok ? "right" : "wrong");
      if (aiScore && !aiScore.perField[f.id]) { if (w.gate.fields[f.id].status === "review") caught++; else slipped++; }
      row.querySelector(".err").textContent = ok ? "Correct." : `Expected: ${truth === null ? "Not in packet" : display(f, truth)}.`;
    }
    const aiRight = aiScore ? aiScore.presentCorrect + aiScore.missingFlagged : null;
    w.els.status.className = "ai-status ready";
    w.els.status.replaceChildren(
      `Approved in ${fmtTime(seconds)}. Final record: ${finalScore.presentCorrect + finalScore.missingFlagged} of 10 correct.`,
      aiScore ? ` The AI alone had ${aiRight} of 10 right; the checks flagged ${caught} of its ${10 - aiRight} mistake${10 - aiRight === 1 ? "" : "s"}${slipped ? ` and missed ${slipped}` : ""}.` : "",
      " ", h("a", { href: "#process" }, "Back to packets"));
  }

  /* ---------- benchmark ---------- */
  function benchItems() {
    const keys = state.keys || {};
    return state.packets.study.map(p => ({ p, r: state.bench.results[p.id] })).filter(x => x.r && x.r.ai_status === "ok" && keys[x.p.id]);
  }

  function computeBench() {
    const keys = state.keys, ok = benchItems();
    const rows = sel => ({
      rules: C.summarize(sel.map(({ p, r }) => ({ key: keys[p.id], values: r.rules }))),
      ai: C.summarize(sel.map(({ p, r }) => ({ key: keys[p.id], values: r.ai_fields }))),
      gated: C.summarize(sel.map(({ p, r }) => ({ key: keys[p.id], values: r.ai_fields, gate: { fields: r.gate } })), true)
    });
    const all = rows(ok);
    const byStyle = { labeled: rows(ok.filter(x => x.p.style === "labeled")), narrative: rows(ok.filter(x => x.p.style === "narrative")) };
    const perField = S.FIELDS.map(f => {
      let rulesOk = 0, aiOk = 0, routed = 0, slipped = 0;
      for (const { p, r } of ok) {
        const key = keys[p.id];
        const rs = S.scoreRecord(C.toRecord(r.rules), key).perField[f.id];
        const as = S.scoreRecord(C.toRecord(r.ai_fields), key).perField[f.id];
        rulesOk += rs; aiOk += as;
        if (r.gate[f.id].status === "review") routed++; else if (!as) slipped++;
      }
      return { f, n: ok.length, rulesOk, aiOk, routed, slipped };
    });
    const timing = {
      aiSeconds: median(ok.map(x => x.r.ai_latency_s)),
      rulesMs: median(ok.map(x => x.r.rules_ms)),
      tokens: median(ok.map(x => x.r.tokens)),
      models: [...new Set(ok.map(x => x.r.ai_model).filter(Boolean))]
    };
    const failed = state.packets.study.filter(p => state.bench.results[p.id] && state.bench.results[p.id].ai_status !== "ok").length;
    return { n: ok.length, failed, all, byStyle, perField, timing };
  }

  async function runBenchmark(ui) {
    if (state.running) return;
    state.running = true; state.stop = false;
    try { await loadKeys(); } catch (_) { ui.log("The answer keys could not be loaded."); state.running = false; return; }
    if (!state.bench.startedAt) state.bench.startedAt = new Date().toISOString();
    const todo = state.packets.study.filter(p => !(state.bench.results[p.id] && state.bench.results[p.id].ai_status === "ok"));
    for (const p of todo) {
      if (state.stop) { ui.log("Stopped. Click Continue to resume."); break; }
      ui.progress();
      const t0 = performance.now(); const rules = R.extract(p.text); const rulesMs = performance.now() - t0;
      ui.log(`${p.id}: asking the AI…`);
      let res = await callAi(p.text);
      if (!res.ok && res.status === 429 && !state.stop) {
        for (let s = 30; s > 0 && !state.stop; s--) { ui.log(`${p.id}: free-tier rate limit; waiting ${s}s…`, true); await sleep(1000); }
        res = await callAi(p.text);
      }
      if (res.ok) {
        const g = C.gate(p.text, { fields: res.data.fields, evidence: res.data.evidence || {} }, rules);
        state.bench.results[p.id] = {
          ai_status: "ok", ai_model: res.data.model || "", ai_attempts: res.data.attempts || 1,
          ai_latency_s: Math.round(res.seconds * 10) / 10, rules_ms: Math.round(rulesMs * 100) / 100,
          tokens: res.data.usage ? res.data.usage.total_tokens : null,
          rules, ai_fields: res.data.fields, ai_evidence: res.data.evidence || {}, held: g.held,
          gate: Object.fromEntries(S.FIELDS.map(f => [f.id, { status: g.fields[f.id].status, reasons: g.fields[f.id].reasons }]))
        };
        const routed = Object.values(g.fields).filter(x => x.status === "review").length;
        ui.log(`${p.id}: done in ${res.seconds.toFixed(1)}s, ${10 - routed} auto-accepted, ${routed} flagged${g.held ? " (held)" : ""}.`);
      } else {
        state.bench.results[p.id] = { ai_status: "failed", error: res.error, ai_latency_s: Math.round(res.seconds * 10) / 10, rules, rules_ms: rulesMs };
        ui.log(`${p.id}: AI failed: ${res.error}`);
      }
      save(); ui.progress();
      await sleep(window.__fast ? 50 : 2500);                  // stay under free-tier request limits
    }
    if (state.packets.study.every(p => state.bench.results[p.id] && state.bench.results[p.id].ai_status === "ok")) state.bench.finishedAt = new Date().toISOString();
    save(); state.running = false; ui.done();
  }

  function viewBenchmark() {
    const okCount = () => Object.values(state.bench.results).filter(r => r.ai_status === "ok").length;
    const bar = h("span", {});
    const progressText = h("p", { class: "progress-text" });
    const logBox = h("ol", { class: "runlog", "aria-live": "polite" });
    const results = h("div", {});
    const runBtn = h("button", { class: "btn", type: "button" });
    const stopBtn = h("button", { class: "btn secondary", type: "button", hidden: true }, "Stop");
    const ui = {
      log(msg, replace) {
        if (replace && logBox.lastChild && logBox.lastChild.dataset.wait) logBox.lastChild.textContent = msg;
        else { const li = h("li", { "data-wait": replace ? "1" : null }, msg); logBox.append(li); }
        while (logBox.children.length > 8) logBox.firstChild.remove();
      },
      progress() {
        const n = okCount();
        progressText.textContent = `${n} of 30 packets processed by the AI${state.running ? "…" : "."}`;
        bar.style.width = `${(n / 30) * 100}%`;
      },
      done() { stopBtn.hidden = true; setRunLabel(); ui.progress(); renderResults(); }
    };
    function setRunLabel() {
      const n = okCount();
      runBtn.textContent = n === 0 ? "Run benchmark on 30 packets" : n < 30 ? `Continue (${30 - n} left)` : "Run again (clears these results)";
      runBtn.disabled = false;
    }
    runBtn.addEventListener("click", () => {
      if (okCount() === 30) {
        if (!window.confirm("Clear these results and run all 30 packets again? Download the CSV first if you need it.")) return;
        state.bench = { results: {} }; save(); logBox.replaceChildren(); results.replaceChildren(); ui.progress();
      }
      runBtn.disabled = true; stopBtn.hidden = false;
      runBenchmark(ui);
    });
    stopBtn.addEventListener("click", () => { state.stop = true; stopBtn.hidden = true; });

    async function renderResults() {
      if (okCount() === 0) { results.replaceChildren(); return; }
      try { await loadKeys(); } catch (_) { return; }
      const b = computeBench(), A = b.all;
      const row = (label, r, a, g, note) => h("tr", {}, h("th", { scope: "row" }, label), h("td", {}, r), h("td", {}, a), h("td", {}, g), h("td", { class: "muted" }, note || ""));
      const n = b.n;
      results.replaceChildren(
        h("h2", {}, "Results"),
        h("p", {}, `Scored on ${n} packet${n === 1 ? "" : "s"} (${n * 10} fields) where the AI answered${b.failed ? `; ${b.failed} packet${b.failed === 1 ? "" : "s"} failed and ${b.failed === 1 ? "is" : "are"} excluded` : ""}. Model: ${b.timing.models.join(", ") || "n/a"}.`),
        h("div", { class: "table-wrap" }, h("table", {},
          h("caption", {}, "Three approaches on the same synthetic packets"),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Measure"), h("th", { scope: "col" }, "Rules (baseline)"), h("th", { scope: "col" }, "AI alone"), h("th", { scope: "col" }, "AI + checks"), h("th", { scope: "col" }, "Notes"))),
          h("tbody", {},
            row("All fields correct, no human", pct(A.rules.allFieldsCorrect), pct(A.ai.allFieldsCorrect), "n/a", "Correct values plus correctly flagged missing values"),
            row("Stated values correct", pct(A.rules.accuracy), pct(A.ai.accuracy), "n/a", ""),
            row("Missing values detected", pct(A.rules.recall), pct(A.ai.recall), "n/a", ""),
            row("Fields sent to a person", "0%", "0%", pct(A.gated.reviewShare), `${A.gated.routed} of ${A.gated.fields} fields; manual entry would be 100%`),
            row("Accuracy of fields nobody checks", pct(A.rules.allFieldsCorrect), pct(A.ai.allFieldsCorrect), pct(A.gated.acceptedAccuracy), `AI + checks: ${A.gated.acceptedCorrect} of ${A.gated.accepted} auto-accepted fields`),
            row("AI mistakes caught by the checks", "n/a", "n/a", `${A.gated.wrongCaught} of ${A.gated.wrongCaught + A.gated.wrongSlipped}`, `${A.gated.wrongSlipped} slipped through`),
            row("Final accuracy if reviewers fix flagged fields", "n/a", "n/a", pct(A.gated.withReview), "Assumes reviewers are always right"),
            row("Time per packet (median)", b.timing.rulesMs === null ? "n/a" : `${b.timing.rulesMs.toFixed(1)} ms`, b.timing.aiSeconds === null ? "n/a" : `${b.timing.aiSeconds.toFixed(1)} s`, "same as AI", "AI time includes network and model wait"),
            row("Cost per packet", "$0", b.timing.tokens ? `$0 (free tier), ${fmtNum(Math.round(b.timing.tokens))} tokens` : "$0 (free tier)", "same as AI", "Tokens shown so paid pricing can be applied"))),
        ),
        h("h3", {}, "By packet style"),
        h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Style"), h("th", { scope: "col" }, "Packets"), h("th", { scope: "col" }, "Rules: all correct"), h("th", { scope: "col" }, "AI alone: all correct"), h("th", { scope: "col" }, "Sent to a person"), h("th", { scope: "col" }, "Accuracy nobody checks"))),
          h("tbody", {}, ["labeled", "narrative"].map(st => {
            const x = b.byStyle[st];
            return h("tr", {}, h("th", { scope: "row" }, st === "labeled" ? "Labeled" : "Conversational"), h("td", {}, x.rules.packets),
              h("td", {}, pct(x.rules.allFieldsCorrect)), h("td", {}, pct(x.ai.allFieldsCorrect)), h("td", {}, pct(x.gated.reviewShare)), h("td", {}, pct(x.gated.acceptedAccuracy)));
          })))),
        h("h3", {}, "By field"),
        h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Field"), h("th", { scope: "col" }, "Rules correct"), h("th", { scope: "col" }, "AI correct"), h("th", { scope: "col" }, "Sent to a person"), h("th", { scope: "col" }, "AI errors that slipped through"))),
          h("tbody", {}, b.perField.map(x => h("tr", {}, h("th", { scope: "row" }, x.f.label),
            h("td", {}, `${x.rulesOk} of ${x.n}`), h("td", {}, `${x.aiOk} of ${x.n}`), h("td", {}, `${x.routed} of ${x.n}`), h("td", {}, x.slipped)))))),
        h("p", { class: "muted" }, "Synthetic packets written for this test. The rule-based extractor and the packets share an author, so its labeled-packet score is optimistic. Results show how the approaches behave on these packets, not business impact at Chubb."),
        h("p", { class: "actions" }, h("button", { class: "btn secondary", type: "button", onclick: downloadBench }, "Download benchmark CSV")));
    }

    setRunLabel(); ui.progress(); renderResults();
    return h("section", { class: "page wide" },
      h("h1", {}, "Benchmark"),
      h("p", { class: "lede" }, "Runs all 30 synthetic packets through the rule-based baseline, the AI on its own and the AI with automatic checks, then scores each against the answer keys."),
      h("p", {}, "It sends one request at a time with a short pause to stay within Gemini's free tier, so expect about 5–15 minutes. You can stop and continue later; finished packets are kept in this browser."),
      h("p", { class: "actions" }, runBtn, stopBtn),
      h("div", { class: "bar wide", role: "progressbar", "aria-label": "Benchmark progress" }, bar), progressText, logBox,
      results);
  }

  /* ---------- data ---------- */
  function csvCell(v) {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;   // block spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const toCSV = (rows, cols) => [cols.join(","), ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\r\n");
  function download(name, text) {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
    document.body.append(a); a.click(); a.remove();
  }
  const LOG_COLS = ["packet_id", "style", "approved_at", "duration_s", "ai_status", "ai_model", "ai_latency_s", "ai_attempts", "ai_tokens", "held", "fields_auto", "fields_review", "fields_changed", ...S.FIELDS.flatMap(f => [f.id, f.id + "_missing"])];
  const BENCH_COLS = ["packet_id", "style", "field", "truth", "rules_value", "rules_correct", "ai_value", "ai_correct", "ai_source_quote", "check_result", "check_reasons", "ai_model", "ai_latency_s", "tokens"];

  async function downloadBench() {
    await loadKeys();
    const rows = [];
    for (const p of state.packets.study) {
      const r = state.bench.results[p.id]; if (!r || r.ai_status !== "ok") continue;
      const key = state.keys[p.id];
      const rs = S.scoreRecord(C.toRecord(r.rules), key).perField, as = S.scoreRecord(C.toRecord(r.ai_fields), key).perField;
      for (const f of S.FIELDS) rows.push({
        packet_id: p.id, style: p.style, field: f.id, truth: key[f.id] === null ? "(not in packet)" : key[f.id],
        rules_value: r.rules[f.id] === null ? "(not found)" : r.rules[f.id], rules_correct: rs[f.id],
        ai_value: r.ai_fields[f.id] === null ? "(not in packet)" : r.ai_fields[f.id], ai_correct: as[f.id],
        ai_source_quote: r.ai_evidence[f.id] || "", check_result: r.gate[f.id].status === "auto" ? "auto-accepted" : "sent to person",
        check_reasons: r.gate[f.id].reasons.join("; "), ai_model: r.ai_model, ai_latency_s: r.ai_latency_s, tokens: r.tokens
      });
    }
    download(`benchmark-${today()}.csv`, toCSV(rows, BENCH_COLS));
  }

  function viewData() {
    const msg = h("p", { "aria-live": "polite" });
    const confirmBox = h("input", { type: "text", id: "reset-confirm", autocomplete: "off" });
    const benchN = Object.values(state.bench.results).filter(r => r.ai_status === "ok").length;
    return h("section", { class: "page" },
      h("h1", {}, "Data"),
      h("p", { class: "lede" }, `${state.log.length} approved record(s) in the intake log. ${benchN} of 30 packets in the benchmark.`),
      h("p", {}, "Everything stays in this browser. The only data sent anywhere is packet text, to Google's Gemini API. Records hold no personal information."),
      h("h2", {}, "Intake log"),
      h("p", {}, "One row per approved study packet: timing, AI status and model, how many fields were auto-accepted, flagged and changed, and the final values."),
      h("button", { class: "btn", type: "button", disabled: state.log.length === 0, onclick: () => download(`intake-log-${today()}.csv`, toCSV(state.log, LOG_COLS)) }, "Download intake log CSV"),
      h("h2", {}, "Benchmark"),
      h("p", {}, "One row per packet and field: the correct value, the rule-based and AI values, the AI's source quote, and whether the checks accepted the field or sent it to a person, with reasons."),
      h("button", { class: "btn", type: "button", disabled: benchN === 0, onclick: downloadBench }, "Download benchmark CSV"),
      h("h2", {}, "Delete everything"),
      h("p", {}, "Deletes the intake log and the benchmark results from this browser. This can't be undone. Type DELETE to confirm."),
      h("label", { for: "reset-confirm" }, "Confirmation"), confirmBox,
      h("button", { class: "btn danger", type: "button", onclick: () => {
        if (confirmBox.value.trim() !== "DELETE") { msg.textContent = "Type DELETE in the box to confirm."; confirmBox.focus(); return; }
        state.log = []; state.bench = { results: {} }; save();
        msg.textContent = "Everything deleted."; confirmBox.value = "";
      } }, "Delete everything"),
      msg);
  }

  /* ---------- router ---------- */
  function route() {
    if (!state.packets) return;
    const hash = (location.hash || "#home").slice(1);
    if (hash === "process" || hash === "work") return setView(viewProcess(), "Process a packet");
    if (hash === "benchmark") return setView(viewBenchmark(), "Benchmark");
    if (hash === "try") return setView(viewTry(), "Try your own text");
    if (hash === "data") return setView(viewData(), "Data");
    return setView(viewHome(), "Overview");
  }

  window.addEventListener("hashchange", () => { if (!state.running) route(); else if (location.hash !== "#benchmark") { toast("The benchmark keeps running on this page. Stop it first to leave."); location.hash = "#benchmark"; } });
  document.querySelectorAll("[data-nav]").forEach(a => a.addEventListener("click", () => {
    if (location.hash === a.getAttribute("href") && !state.running) setTimeout(route, 0);
  }));
  window.addEventListener("beforeunload", e => { if (state.running || (state.work && timerId)) { e.preventDefault(); e.returnValue = ""; } });

  load();
  fetch("data/packets.json")
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(d => { state.packets = d; route(); })
    .catch(() => {
      main.replaceChildren(h("section", { class: "page" }, h("h1", {}, "The packets could not be loaded"),
        h("p", {}, "Open the app through a web server (the Vercel URL, or `npx vercel dev` locally), not by double-clicking index.html.")));
    });
})();
