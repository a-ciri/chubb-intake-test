/* Intake test bench: Option A (manual checklist) vs Option B (AI draft + human review).
   Records are kept in this browser (localStorage) and exported as CSV. */
(function () {
  "use strict";
  const S = window.Scoring;
  const STORE = "intake-bench-v1";
  const main = document.getElementById("main");
  const state = { packets: null, records: [], meta: {}, storageOk: true, work: null, scored: null };

  /* ---------- small helpers ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
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
  const pct = x => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);
  function fmtMoney(n) { return Number(n).toLocaleString("en-US"); }

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      const d = raw ? JSON.parse(raw) : {};
      state.records = Array.isArray(d.records) ? d.records : [];
      state.meta = d.meta || {};
    } catch (_) { state.storageOk = false; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ records: state.records, meta: state.meta })); }
    catch (_) { state.storageOk = false; }
  }

  function toast(msg) {
    const t = h("div", { class: "toast", role: "status" }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  /* ---------- session plan ---------- */
  // Session 1: S01-S15 in Arm A, S16-S30 in Arm B. Session 2 swaps the arms.
  function plan(session) {
    return state.packets.study.map((p, i) => ({ id: p.id, arm: (i < 15) === (session === 1) ? "A" : "B" }));
  }
  const findRecord = (session, id) => state.records.find(r => Number(r.session) === session && r.packet_id === id);
  const doneCount = session => plan(session).filter(p => findRecord(session, p.id)).length;
  const packetById = id => [...state.packets.study, ...state.packets.practice].find(p => p.id === id);

  /* ---------- views ---------- */
  function setView(node, title) {
    stopTimer();
    state.work = null;
    main.replaceChildren(node);
    document.title = `${title} | Intake test bench`;
    const hash = (location.hash || "#home").slice(1).split("-")[0];
    document.querySelectorAll("[data-nav]").forEach(a =>
      a.setAttribute("aria-current", a.dataset.nav === hash || (hash === "session" && a.dataset.nav === "home") ? "page" : "false"));
    const h1 = main.querySelector("h1"); if (h1) { h1.setAttribute("tabindex", "-1"); h1.focus(); }
  }

  function viewHome() {
    const sessions = [1, 2].map(n => {
      const done = doneCount(n);
      const arms = n === 1 ? "S01–S15 manual (A), then S16–S30 AI-assisted (B)" : "S01–S15 AI-assisted (B), then S16–S30 manual (A)";
      return h("li", { class: "session-row" },
        h("div", {},
          h("h3", {}, `Session ${n}`),
          h("p", { class: "muted" }, arms),
          h("p", { class: "progress-text" }, `${done} of 30 packets done`),
          h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "30", "aria-valuenow": String(done), "aria-label": `Session ${n} progress` },
            h("span", { style: `width:${(done / 30) * 100}%` }))),
        h("a", { class: "btn" + (done === 30 ? " secondary" : ""), href: `#session-${n}` },
          done === 0 ? `Start session ${n}` : done === 30 ? `Review session ${n}` : `Continue session ${n}`));
    });
    const health = h("p", { class: "muted", "aria-live": "polite" });
    return h("section", { class: "page" },
      h("h1", {}, "Submission intake test bench"),
      h("p", { class: "lede" }, "Compare manual checklist intake (Option A) with AI-drafted, human-reviewed intake (Option B) on the same 30 synthetic Package submissions. The app times each packet and scores both arms against hidden answer keys."),
      !state.storageOk && h("p", { class: "banner error" }, "This browser is blocking local storage, so records will be lost on refresh. Export after every packet, or use another browser."),
      h("h2", {}, "Test sessions"),
      h("p", {}, "Run the two sessions on different days. Each packet is done once in each arm, with the order reversed between sessions to offset learning effects."),
      h("ol", { class: "sessions" }, sessions),
      h("h2", {}, "Entry rules for both arms"),
      h("ul", { class: "rules" },
        h("li", {}, "Enter only what the packet states. Don't calculate or guess."),
        h("li", {}, "Tick “Not in packet” when a value is missing or says TBD, to follow, to be confirmed or same as expiring."),
        h("li", {}, "Revenue means the most recent fiscal year. Employees means full-time only."),
        h("li", {}, "GL limit means the each-occurrence limit, not the aggregate or umbrella."),
        h("li", {}, "Claims means the count in the past five years. Enter 0 only when the packet says there were none.")),
      h("h2", {}, "Before your first session"),
      h("p", {}, "Try a practice packet in each arm to learn the screens. Practice packets show the answers and are never scored."),
      h("p", { class: "actions" },
        h("a", { class: "btn secondary", href: "#practice" }, "Open practice"),
        h("button", { class: "btn quiet", type: "button", onclick: () => checkHealth(health) }, "Check AI connection")),
      health);
  }

  async function checkHealth(out) {
    out.textContent = "Checking…";
    try {
      const r = await fetch("/api/extract", { method: "GET" });
      const d = await r.json();
      if (!d.keyConfigured) out.textContent = "The AI function is running, but GEMINI_API_KEY is not set in Vercel.";
      else if (!d.model) out.textContent = "The key is set, but Google returned no usable model. Check the key in Google AI Studio.";
      else out.textContent = `AI connected. Model in use: ${d.model}${d.configuredModel && d.configuredModel !== d.model ? ` (GEMINI_MODEL "${d.configuredModel}" is not available)` : ""}.`;
    } catch (_) { out.textContent = "The AI function could not be reached. On a local preview this is expected; Option B will fall back to manual entry."; }
  }

  function viewSession(n) {
    const next = plan(n).find(p => !findRecord(n, p.id));
    if (!next) {
      return h("section", { class: "page" },
        h("h1", {}, `Session ${n} complete`),
        h("p", {}, n === 1
          ? "All 30 packets are saved. Export your records on the Data page, then run Session 2 on a different day."
          : "Both arms are done for this session. Export your records on the Data page. Score them on the Results page once both sessions are complete."),
        h("p", { class: "actions" }, h("a", { class: "btn", href: "#data" }, "Go to Data"), h("a", { class: "btn secondary", href: "#results" }, "Go to Results")));
    }
    const index = plan(n).findIndex(p => p.id === next.id) + 1;
    const isA = next.arm === "A";
    return h("section", { class: "page start" },
      h("p", { class: "crumb" }, `Session ${n}, packet ${index} of 30`),
      h("h1", {}, `Packet ${next.id}`),
      h("p", { class: "arm-chip " + (isA ? "arm-a" : "arm-b") }, isA ? "Arm A: manual checklist" : "Arm B: AI draft with your review"),
      h("p", {}, isA
        ? "Read the packet and fill every field yourself."
        : "The AI fills the form first. Check each field against the packet, fix anything wrong, and tick Reviewed. You can approve only when every field is reviewed."),
      h("p", { class: "muted" }, "The timer starts when you click Start and stops when you save. Leaving this page discards the packet in progress."),
      h("button", { class: "btn big", type: "button", onclick: () => startWork({ mode: "session", session: n, packet: packetById(next.id), arm: next.arm, index }) }, `Start packet ${next.id}`));
  }

  function viewPractice() {
    let arm = "A";
    const armPick = h("fieldset", { class: "pick" }, h("legend", {}, "Arm"),
      ["A", "B"].map(a => h("label", {},
        h("input", { type: "radio", name: "arm", value: a, checked: a === "A", onchange: e => { arm = e.target.value; } }),
        a === "A" ? " A: manual checklist" : " B: AI draft with your review")));
    return h("section", { class: "page" },
      h("h1", {}, "Practice"),
      h("p", { class: "lede" }, "Practice packets show the correct answers after you save. They are not timed for the study and never appear in your results."),
      armPick,
      h("ul", { class: "practice-list" }, state.packets.practice.map(p =>
        h("li", {}, h("button", { class: "btn secondary", type: "button", onclick: () => startWork({ mode: "practice", packet: p, arm }) }, `Start practice packet ${p.id}`),
          h("span", { class: "muted" }, { P1: "Complete packet", P2: "Two values missing", P3: "Contains an instruction aimed at the AI" }[p.id] || "")))));
  }

  function viewTry() {
    const ta = h("textarea", { id: "try-text", rows: "14", maxlength: "20000", "aria-describedby": "try-count try-warn" });
    const count = h("p", { id: "try-count", class: "muted" }, "0 of 20,000 characters");
    const err = h("p", { class: "err", role: "alert" });
    ta.addEventListener("input", () => { count.textContent = `${ta.value.length.toLocaleString("en-US")} of 20,000 characters`; });
    return h("section", { class: "page" },
      h("h1", {}, "Try your own text"),
      h("p", { class: "lede" }, "Paste any submission-style text and see how the AI drafts the form. Nothing here is saved or scored."),
      h("p", { id: "try-warn", class: "banner" }, "Paste only synthetic or public text. Don't paste real customer or confidential information: the text is sent to Google's Gemini API."),
      h("label", { for: "try-text" }, "Submission text"), ta, count, err,
      h("button", { class: "btn", type: "button", onclick: () => {
        if (!ta.value.trim()) { err.textContent = "Paste some text first."; ta.focus(); return; }
        startWork({ mode: "try", packet: { id: "Your text", text: ta.value, synthetic: false }, arm: "B" });
      } }, "Draft with AI"));
  }

  /* ---------- workspace ---------- */
  let timerId = null;
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  function startWork(w) {
    stopTimer();
    w.t0 = performance.now();
    w.startedAt = new Date().toISOString();
    w.ai = { status: w.arm === "A" ? "n/a" : "pending", draft: null, latency: null };
    state.work = w;
    renderWorkspace();
    if (w.arm === "B") runAi();
  }

  function fieldRow(f, w) {
    const id = "f-" + f.id;
    const input = f.type === "industry"
      ? h("select", { id, name: f.id }, h("option", { value: "" }, "Choose…"), S.INDUSTRIES.map(i => h("option", { value: i }, i)))
      : h("input", { id, name: f.id, type: "text", autocomplete: "off", inputmode: (f.type === "money" || f.type === "int") ? "decimal" : "text", maxlength: "200" });
    const nip = h("input", { type: "checkbox", class: "nip", id: id + "-nip" });
    const rev = h("input", { type: "checkbox", class: "rev", id: id + "-rev" });
    const row = h("div", { class: "field", "data-field": f.id },
      h("label", { for: id, class: "flabel" }, f.label),
      f.help && h("p", { class: "help" }, f.help),
      h("div", { class: "control" }, input, h("label", { class: "nip-label", for: id + "-nip" }, nip, " Not in packet")),
      w.arm === "B" && h("div", { class: "review" },
        h("span", { class: "tag" }, "AI draft"),
        h("label", { for: id + "-rev" }, rev, " Reviewed")),
      h("p", { class: "err", role: "alert" }));
    const markTouched = () => {
      if (w.arm === "B" && w.ai.status === "ok") { rev.checked = true; row.classList.add("reviewed"); updateReviewCount(); }
    };
    input.addEventListener("input", () => { row.querySelector(".err").textContent = ""; markTouched(); });
    nip.addEventListener("change", () => { input.disabled = nip.checked; if (nip.checked) input.value = ""; row.querySelector(".err").textContent = ""; markTouched(); });
    rev.addEventListener("change", () => { row.classList.toggle("reviewed", rev.checked); updateReviewCount(); });
    return row;
  }

  function renderWorkspace() {
    const w = state.work;
    const isA = w.arm === "A";
    const timer = h("span", { class: "timer", role: "timer", "aria-label": "Elapsed time" }, "0:00");
    const status = h("div", { class: "ai-status", "aria-live": "polite" });
    const reviewCount = h("span", { class: "review-count", "aria-live": "polite" });
    const saveBtn = h("button", { class: "btn", type: "submit" }, isA ? "Save record" : "Approve record");
    const form = h("form", { class: "form", novalidate: true, onsubmit: e => { e.preventDefault(); submitWork(); } },
      status,
      S.FIELDS.map(f => fieldRow(f, w)),
      h("div", { class: "actionbar" }, timer, reviewCount, saveBtn));
    const head = w.mode === "session"
      ? [h("span", {}, `Session ${w.session}`), h("span", {}, `Packet ${w.packet.id}, ${w.index} of 30`)]
      : [h("span", {}, w.mode === "practice" ? `Practice packet ${w.packet.id}` : "Your text")];
    const node = h("section", { class: "work " + (isA ? "is-a" : "is-b") },
      h("div", { class: "workbar" }, head, h("span", { class: "arm-chip " + (isA ? "arm-a" : "arm-b") }, isA ? "Arm A: manual checklist" : "Arm B: AI draft with your review")),
      h("h1", { class: "sr-only" }, `Packet ${w.packet.id}`),
      h("div", { class: "split" },
        h("article", { class: "doc", "aria-label": "Submission packet" },
          h("div", { class: "doc-head" }, h("h2", {}, `Submission ${w.packet.id}`), w.packet.synthetic !== false && h("span", { class: "tag plain" }, "Synthetic")),
          h("pre", { class: "doc-text" }, w.packet.text)),
        form));
    main.replaceChildren(node);
    w.els = { timer, status, reviewCount, saveBtn, form };
    timerId = setInterval(() => { timer.textContent = fmtTime((performance.now() - w.t0) / 1000); }, 1000);
    if (!isA) setFormDisabled(true);
    updateReviewCount();
    main.querySelector("h1").focus();
  }

  function setFormDisabled(disabled) {
    state.work.els.form.querySelectorAll("input, select, button").forEach(el => { el.disabled = disabled; });
  }

  async function runAi() {
    const w = state.work;
    w.els.status.className = "ai-status working";
    w.els.status.textContent = "The AI is drafting this record…";
    const t = performance.now();
    try {
      const r = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packet: w.packet.text }) });
      let d = {};
      try { d = await r.json(); } catch (_) { /* non-JSON reply */ }
      if (state.work !== w) return; // user left
      if (!r.ok || !d.fields) throw new Error(d.error || `The AI service returned an error (${r.status}).`);
      w.ai = { status: "ok", draft: d.fields, latency: (performance.now() - t) / 1000, model: d.model || "" };
      fillDraft(d.fields);
    } catch (e) {
      if (state.work !== w) return;
      w.ai = { status: "fallback", draft: null, latency: (performance.now() - t) / 1000, error: e.message };
      showFallback(e.message || "The AI could not be reached.");
    }
  }

  function fillDraft(fields) {
    const w = state.work;
    setFormDisabled(false);
    for (const f of S.FIELDS) {
      const row = w.els.form.querySelector(`[data-field="${f.id}"]`);
      const input = row.querySelector("input:not([type=checkbox]), select");
      const nip = row.querySelector(".nip");
      const v = fields[f.id];
      if (v === null || v === undefined) { nip.checked = true; input.value = ""; input.disabled = true; }
      else {
        const n = S.normalize(f, v);
        input.value = (f.type === "money" || f.type === "int") && typeof n === "number" ? fmtMoney(n) : (f.type === "date" && n ? n : v);
      }
      row.classList.add("ai-draft");
    }
    w.els.status.className = "ai-status ready";
    w.els.status.textContent = "AI draft ready. Check every field against the packet before you approve.";
    updateReviewCount();
  }

  function showFallback(msg) {
    const w = state.work;
    setFormDisabled(false);
    w.els.form.querySelectorAll(".review").forEach(el => el.remove());
    w.els.saveBtn.textContent = "Save record";
    w.els.status.className = "ai-status failed";
    w.els.status.replaceChildren(...[
      h("strong", {}, "AI draft unavailable. "), msg + " ",
      w.mode === "session" ? "Complete this packet manually. It will be logged as a fallback. " : "Complete this packet manually. ",
      w.mode !== "practice" && h("button", { class: "btn quiet small", type: "button", onclick: () => {
        w.els.form.querySelectorAll(".field").forEach(r => r.replaceWith(fieldRow(S.FIELDS.find(f => f.id === r.dataset.field), w)));
        w.ai.status = "pending"; w.els.saveBtn.textContent = "Approve record"; setFormDisabled(true); runAi();
      } }, "Retry AI draft")].filter(Boolean));   // fix T-D1: a skipped button printed "false"
    updateReviewCount();
  }

  function updateReviewCount() {
    const w = state.work; if (!w || !w.els) return;
    if (w.arm !== "B" || w.ai.status !== "ok") { w.els.reviewCount.textContent = ""; w.els.saveBtn.disabled = w.arm === "B" && w.ai.status === "pending"; return; }
    const total = S.FIELDS.length;
    const done = w.els.form.querySelectorAll(".rev:checked").length;
    w.els.reviewCount.textContent = `${done} of ${total} fields reviewed`;
    w.els.saveBtn.disabled = done < total;
  }

  function readForm() {
    const vals = {};
    for (const f of S.FIELDS) {
      const row = state.work.els.form.querySelector(`[data-field="${f.id}"]`);
      vals[f.id] = row.querySelector("input:not([type=checkbox]), select").value.trim();
      vals[f.id + "_missing"] = row.querySelector(".nip").checked;
    }
    return vals;
  }

  function submitWork() {
    const w = state.work;
    const vals = readForm();
    let firstBad = null;
    for (const f of S.FIELDS) {
      const row = w.els.form.querySelector(`[data-field="${f.id}"]`);
      const msg = S.validateEntry(f, vals[f.id], vals[f.id + "_missing"]);
      row.querySelector(".err").textContent = msg;
      if (msg && !firstBad) firstBad = row.querySelector("input:not([type=checkbox]), select");
    }
    if (firstBad) { firstBad.focus(); return; }
    if (w.arm === "B" && w.ai.status === "ok" && w.els.form.querySelectorAll(".rev:not(:checked)").length) {
      w.els.status.textContent = "Tick Reviewed on every field before you approve."; return;
    }
    const seconds = (performance.now() - w.t0) / 1000;
    stopTimer();

    let changed = "";
    if (w.ai.status === "ok") {
      changed = S.FIELDS.filter(f => {
        const d = w.ai.draft[f.id]; const draftMissing = d === null || d === undefined;
        if (draftMissing !== vals[f.id + "_missing"]) return true;
        return !draftMissing && !S.sameValue(f, d, vals[f.id]);
      }).length;
    }

    if (w.mode === "session") {
      const rec = {
        session: w.session, packet_id: w.packet.id, arm: w.arm, started_at: w.startedAt,
        duration_s: Math.round(seconds * 10) / 10, ai_status: w.ai.status,
        ai_latency_s: w.ai.latency === null ? "" : Math.round(w.ai.latency * 10) / 10,
        ai_model: w.ai.model || "",
        fields_changed_from_ai: changed
      };
      for (const f of S.FIELDS) { rec[f.id] = vals[f.id]; rec[f.id + "_missing"] = vals[f.id + "_missing"]; }
      state.records = state.records.filter(r => !(Number(r.session) === w.session && r.packet_id === w.packet.id));
      state.records.push(rec);
      state.scored = null;
      save();
      toast(`Saved ${w.packet.id} (Arm ${w.arm}) in ${fmtTime(seconds)}.`);
      setView(viewSession(w.session), `Session ${w.session}`);
    } else if (w.mode === "practice") {
      showPracticeFeedback(vals, seconds);
    } else {
      setFormDisabled(true);
      w.els.status.className = "ai-status ready";
      w.els.status.textContent = `Approved in ${fmtTime(seconds)}${changed !== "" ? `, with ${changed} of 10 AI values changed` : ""}. Text from this page is not saved.`;
    }
  }

  function showPracticeFeedback(vals, seconds) {
    const w = state.work;
    const key = w.packet.answer;
    const s = S.scoreRecord(vals, key);
    setFormDisabled(true);
    for (const f of S.FIELDS) {
      const row = w.els.form.querySelector(`[data-field="${f.id}"]`);
      const ok = s.perField[f.id];
      const truth = key[f.id];
      row.classList.add(ok ? "right" : "wrong");
      row.querySelector(".err").textContent = ok ? "Correct." :
        `Expected: ${truth === null ? "Not in packet" : (typeof truth === "number" ? fmtMoney(truth) : truth)}.`;
    }
    w.els.status.className = "ai-status ready";
    w.els.status.replaceChildren(`Practice finished in ${fmtTime(seconds)}: ${s.presentCorrect} of ${s.present} stated values right, ${s.missingFlagged} of ${s.missing} missing values flagged. `,
      h("a", { href: "#practice", onclick: () => setTimeout(route, 0) }, "Back to practice"));
  }

  /* ---------- results ---------- */
  async function revealAndScore() {
    try {
      const r = await fetch("data/answer-keys.b64");
      const keys = JSON.parse(atob((await r.text()).trim()));
      if (!state.meta.revealedAt) {
        state.meta.revealedAt = new Date().toISOString();
        state.meta.recordsAtReveal = { s1: doneCount(1), s2: doneCount(2) };
        save();
      }
      state.scored = { keys, ...S.scoreAll(state.records, keys) };
    } catch (_) { toast("The answer keys could not be loaded."); }
    route();
  }

  function viewResults() {
    const s1 = doneCount(1), s2 = doneCount(2);
    const parts = [h("h1", {}, "Results"),
      h("p", { class: "lede" }, `Session 1: ${s1} of 30 packets. Session 2: ${s2} of 30 packets.`)];
    if (state.meta.revealedAt && state.meta.recordsAtReveal &&
        (state.meta.recordsAtReveal.s1 < 30 || state.meta.recordsAtReveal.s2 < 30)) {
      parts.push(h("p", { class: "banner" }, `The answer keys were first revealed on ${new Date(state.meta.revealedAt).toLocaleString()}, before both sessions were complete (${state.meta.recordsAtReveal.s1} and ${state.meta.recordsAtReveal.s2} of 30). Report this in your write-up.`));
    }
    if (!state.scored) {
      const confirm = h("div", { class: "confirm", hidden: true },
        h("p", {}, "Scoring reveals the answer keys. Do this only after both sessions are finished, or your later answers could be influenced."),
        h("p", { class: "actions" },
          h("button", { class: "btn", type: "button", onclick: revealAndScore }, "Reveal keys and score"),
          h("button", { class: "btn quiet", type: "button", onclick: () => { confirm.hidden = true; } }, "Cancel")));
      parts.push(
        h("p", {}, "Scoring compares your saved records with the answer keys and reports accuracy, missing-field recall and median time for each arm."),
        h("button", { class: "btn", type: "button", disabled: state.records.length === 0, onclick: () => { confirm.hidden = false; confirm.querySelector("button").focus(); } }, "Score my records"),
        state.records.length === 0 && h("p", { class: "muted" }, "No records yet. Start a session first."),
        confirm);
      return h("section", { class: "page" }, parts);
    }
    const { summary, detail } = state.scored;
    const A = summary.A, B = summary.B, F = summary.B_fallback;
    const row = (label, fa, fb, note) => h("tr", {}, h("th", { scope: "row" }, label), h("td", {}, fa), h("td", {}, fb), h("td", { class: "muted" }, note || ""));
    parts.push(
      h("div", { class: "table-wrap" }, h("table", {},
        h("caption", {}, "Arm comparison on synthetic packets"),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Measure"), h("th", { scope: "col" }, "A: manual"), h("th", { scope: "col" }, "B: AI + review"), h("th", { scope: "col" }, "Notes"))),
        h("tbody", {},
          row("Records scored", A.records, B.records, F.records ? `${F.records} Arm B fallback record(s) excluded` : ""),
          row("All fields correct", pct(A.overall), pct(B.overall), `Correct entries over all required fields: stated values right plus missing values flagged (${A.presentCorrect + A.missingFlagged}/${A.present + A.missing} vs ${B.presentCorrect + B.missingFlagged}/${B.present + B.missing})`),
          row("Field accuracy", pct(A.accuracy), pct(B.accuracy), `Stated values entered correctly (${A.presentCorrect}/${A.present} vs ${B.presentCorrect}/${B.present})`),
          row("Missing-field recall", pct(A.recall), pct(B.recall), `Missing values flagged (${A.missingFlagged}/${A.missing} vs ${B.missingFlagged}/${B.missing})`),
          row("Stated values marked missing", A.falseMissing, B.falseMissing, "Lower is better"),
          row("Median time per packet", A.medianSeconds === null ? "n/a" : fmtTime(A.medianSeconds), B.medianSeconds === null ? "n/a" : fmtTime(B.medianSeconds), "Arm B includes AI wait, review and corrections"),
          row("AI drafts approved unchanged", "n/a", B.records ? `${B.acceptedUnchanged} of ${B.records}` : "n/a", "Adoption proxy for a later pilot")))));
    if (summary.criteria) {
      const c = summary.criteria;
      const yes = ok => (ok ? "Met" : "Not met");
      parts.push(h("h2", {}, "Project 1 success criterion"),
        h("ul", { class: "rules" },
          h("li", {}, `B accuracy at least A's: ${yes(c.accuracy)}.`),
          h("li", {}, `B missing-field recall at least A's: ${yes(c.recall)}.`),
          h("li", {}, `B median time at least 30% lower: ${yes(c.time)} (${(c.timeReduction * 100).toFixed(1)}% lower).`)),
        h("p", { class: "banner " + (c.all ? "ok" : "") }, c.all ? "All three conditions are met." : "Not all conditions are met; your brief's reversal condition applies."));
    }
    parts.push(h("p", { class: "muted" }, "One reviewer and 30 synthetic packets show whether the tool works under test conditions. They do not show business impact at Chubb."),
      h("p", { class: "actions" }, h("button", { class: "btn secondary", type: "button", onclick: () => downloadScored(detail) }, "Download scored CSV")));
    return h("section", { class: "page" }, parts);
  }

  /* ---------- data: CSV export, import, reset ---------- */
  const BASE_COLS = ["session", "packet_id", "arm", "started_at", "duration_s", "ai_status", "ai_latency_s", "fields_changed_from_ai"];
  const COLS = [...BASE_COLS, "ai_model", ...S.FIELDS.flatMap(f => [f.id, f.id + "_missing"])];

  function csvCell(v) {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;   // block spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCSV(rows, cols) { return [cols.join(","), ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\r\n"); }
  function parseCSV(text) {
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.length > 1);
  }
  function download(name, text) {
    const a = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
    document.body.append(a); a.click(); a.remove();
  }
  const today = () => new Date().toISOString().slice(0, 10);

  function downloadScored(detail) {
    const rows = detail.map(({ r, s }) => {
      const o = { ...r, fields_correct: s.presentCorrect + s.missingFlagged, present: s.present, present_correct: s.presentCorrect, missing: s.missing, missing_flagged: s.missingFlagged, false_missing: s.falseMissing };
      for (const f of S.FIELDS) o[f.id + "_correct"] = s.perField[f.id];
      return o;
    });
    const cols = [...COLS, "fields_correct", "present", "present_correct", "missing", "missing_flagged", "false_missing", ...S.FIELDS.map(f => f.id + "_correct")];
    download(`intake-scored-${today()}.csv`, toCSV(rows, cols));
  }

  function viewData() {
    const msg = h("p", { "aria-live": "polite" });
    const file = h("input", { type: "file", accept: ".csv,text/csv", id: "import-file" });
    const confirmBox = h("input", { type: "text", id: "reset-confirm", autocomplete: "off" });
    return h("section", { class: "page" },
      h("h1", {}, "Data"),
      h("p", { class: "lede" }, `${state.records.length} record(s) saved in this browser.`),
      h("p", {}, "Records stay in this browser. Nothing is uploaded except the packet text sent to the AI in Arm B. Records hold no personal information: only session, packet, arm, times and the values you entered."),
      h("h2", {}, "Export"),
      h("p", {}, "Download your records after each session and keep the file as your evidence."),
      h("button", { class: "btn", type: "button", disabled: state.records.length === 0, onclick: () => download(`intake-records-${today()}.csv`, toCSV(state.records, COLS)) }, "Download records CSV"),
      h("h2", {}, "Import"),
      h("p", {}, "Moving to another computer? Import a records CSV exported from this app. Records for the same session and packet are replaced."),
      h("label", { for: "import-file" }, "Records CSV"), file,
      h("button", { class: "btn secondary", type: "button", onclick: async () => {
        if (!file.files[0]) { msg.textContent = "Choose a CSV file first."; return; }
        const rows = parseCSV(await file.files[0].text());
        const header = rows.shift() || [];
        if (!BASE_COLS.every(c => header.includes(c))) { msg.textContent = "This file is not a records CSV from this app."; return; }
        let n = 0;
        for (const cells of rows) {
          const r = {}; header.forEach((c, i) => { if (COLS.includes(c)) r[c] = cells[i] === undefined ? "" : cells[i].replace(/^'/, ""); });
          if (!["1", "2"].includes(String(r.session)) || !/^S\d\d$/.test(r.packet_id) || !["A", "B"].includes(r.arm)) continue;
          r.session = Number(r.session);
          for (const f of S.FIELDS) r[f.id + "_missing"] = r[f.id + "_missing"] === "true";
          state.records = state.records.filter(x => !(Number(x.session) === r.session && x.packet_id === r.packet_id));
          state.records.push(r); n++;
        }
        save(); state.scored = null;
        msg.textContent = `Imported ${n} record(s).`;
      } }, "Import CSV"),
      h("h2", {}, "Delete all records"),
      h("p", {}, "This can't be undone. Type DELETE to confirm."),
      h("label", { for: "reset-confirm" }, "Confirmation"), confirmBox,
      h("button", { class: "btn danger", type: "button", onclick: () => {
        if (confirmBox.value.trim() !== "DELETE") { msg.textContent = "Type DELETE in the box to confirm."; confirmBox.focus(); return; }
        state.records = []; state.meta = {}; state.scored = null; save();
        msg.textContent = "All records deleted."; confirmBox.value = "";
      } }, "Delete all records"),
      msg);
  }

  /* ---------- router ---------- */
  function route() {
    if (!state.packets) return;
    const hash = (location.hash || "#home").slice(1);
    if (hash === "session-1" || hash === "session-2") return setView(viewSession(Number(hash.slice(-1))), `Session ${hash.slice(-1)}`);
    if (hash === "practice") return setView(viewPractice(), "Practice");
    if (hash === "try") return setView(viewTry(), "Try your own text");
    if (hash === "results") return setView(viewResults(), "Results");
    if (hash === "data") return setView(viewData(), "Data");
    return setView(viewHome(), "Sessions");
  }

  window.addEventListener("hashchange", route);
  document.querySelectorAll("[data-nav]").forEach(a => a.addEventListener("click", () => {
    if (location.hash === a.getAttribute("href")) setTimeout(route, 0);
  }));
  window.addEventListener("beforeunload", e => { if (state.work && timerId) { e.preventDefault(); e.returnValue = ""; } });

  load();
  fetch("data/packets.json")
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(d => { state.packets = d; route(); })
    .catch(() => {
      main.replaceChildren(h("section", { class: "page" }, h("h1", {}, "The packets could not be loaded"),
        h("p", {}, "Open the app through a web server (the Vercel URL, or `npx vercel dev` locally), not by double-clicking index.html.")));
    });
})();
