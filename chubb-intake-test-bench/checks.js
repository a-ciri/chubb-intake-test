/* Automatic checks that decide, field by field, whether an AI value can be accepted without a person
   ("autonomy by consequence"). A field is auto-accepted only if every check passes; otherwise it goes
   to the human review queue with the reasons. A packet that contains instructions aimed at automated
   systems is held: every field goes to review. */
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const S = node ? require("./scoring.js") : root.Scoring;

  const INJECTION = /(automated system|ignore (?:all |any )?(?:previous |prior |the above )?instructions|note (?:for|to) (?:any |the )?(?:ai|automated|bot|model)|mark (?:every|all) fields?|system prompt|you are (?:an? )?(?:ai|assistant|model))/i;
  const HEDGE = /\b(tbd|to follow|to be provided|to be confirmed|same as expiring|same limits as|still (?:waiting|confirming|finalizing)|on order|will follow|will come over|don'?t have a firm|no firm|being refreshed|requested from)\b/i;

  const RANGES = {
    effective_date: v => v >= "2026-01-01" && v <= "2028-12-31",
    annual_revenue: v => v >= 1e6 && v <= 5e10,
    employee_count: v => v >= 1 && v <= 200000,
    location_count: v => v >= 1 && v <= 1000,
    total_insured_value: v => v >= 1e5 && v <= 1e11,
    gl_occurrence_limit: v => v >= 1e5 && v <= 1e8,
    losses_5yr: v => v >= 0 && v <= 500,
    insured_name: v => v.length >= 2 && v.length <= 160,
    broker_agency: v => v.length >= 2 && v.length <= 160,
    industry: () => true
  };

  const squash = s => String(s || "").toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/\s+/g, " ").trim();

  function detectInjection(text) {
    const m = String(text || "").match(INJECTION);
    return m ? m[0] : null;
  }

  /* Is the AI's quoted source really in the packet? (allows a dropped final period) */
  function quoteFound(packet, quote) {
    const q = squash(quote).replace(/[.\s]+$/, "");
    return q.length >= 3 && squash(packet).includes(q);
  }

  const NUM_TOKEN = /(?:usd\s*)?\$?\d[\d,]*(?:\.\d+)?(?:\s*(?:mm|m|million|bn|billion|k|thousand)\b)?/gi;
  const DATE_TOKEN = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}-[a-z]{3,9}-\d{4}|[a-z]{3,9}\.? \d{1,2},? \d{4}/gi;

  /* Does the source quote actually contain this value? */
  function valueInQuote(field, value, quote) {
    if (!quote) return false;
    const v = S.normalize(field, value);
    if (v === null) return false;
    if (field.type === "money" || field.type === "int") {
      if (v === 0 && /\b(no|zero|none|nil)\b/i.test(quote)) return true;   // fix D2: "No claims reported" means 0
      return (String(quote).match(NUM_TOKEN) || []).some(tok => S.parseNumber(tok) === v);
    }
    if (field.type === "date") return (String(quote).match(DATE_TOKEN) || []).some(tok => S.parseDate(tok) === v);
    if (field.type === "industry") return true;      // a classification: checked by agreement with rules instead
    return S.normText(quote).includes(S.normText(value));
  }

  /* ai = { fields: {id: value|null}, evidence: {id: quote|null} }, rules = {id: value|null} */
  function gate(packet, ai, rules) {
    const injection = detectInjection(packet);
    const out = { held: injection ? `Packet contains an instruction aimed at automated systems (“${injection}”)` : null, fields: {} };
    for (const f of S.FIELDS) {
      const value = ai.fields ? ai.fields[f.id] : null;
      const quote = ai.evidence ? ai.evidence[f.id] : null;
      const r = rules ? rules[f.id] : null;
      const reasons = [];
      if (value === null || value === undefined) {
        // AI says the value is not in the packet
        if (r !== null && r !== undefined) reasons.push(`AI found no value, but the rule check found “${r}”`);
        if (quote && !quoteFound(packet, quote)) reasons.push("Quoted source is not in the packet");
      } else {
        const v = S.normalize(f, value);
        if (v === null) reasons.push("Not a valid value for this field");
        else if (!RANGES[f.id](v)) reasons.push("Value is outside the plausible range");
        if (!quote) reasons.push("No source quote given");
        else if (!quoteFound(packet, quote)) reasons.push("Quoted source is not in the packet");
        else {
          if (!valueInQuote(f, value, quote)) reasons.push("Value does not appear in the quoted source");
          if (HEDGE.test(quote)) reasons.push("Source says the value is pending or unchanged");
        }
        if (r === null || r === undefined) {
          if (f.type === "industry") reasons.push("Industry could not be confirmed by the rule check");
          if ((f.type === "money" || f.type === "int") && quote) {
            const nums = new Set((String(quote).match(NUM_TOKEN) || []).map(tok => S.parseNumber(tok)).filter(Number.isFinite));
            if (nums.size > 1) reasons.push("Source has more than one number and the rule check could not confirm which is right");
          }
        } else if (!S.sameValue(f, value, r)) reasons.push(`Rule check found a different value (“${r}”)`);
      }
      if (out.held) reasons.push("Packet held for review");
      out.fields[f.id] = { value: value === undefined ? null : value, evidence: quote || null, status: reasons.length ? "review" : "auto", reasons };
    }
    return out;
  }

  /* {id: value|null} -> the record shape Scoring.scoreRecord expects */
  function toRecord(values) {
    const r = {};
    for (const f of S.FIELDS) {
      const v = values ? values[f.id] : null;
      r[f.id] = v === null || v === undefined ? "" : String(v);
      r[f.id + "_missing"] = v === null || v === undefined;
    }
    return r;
  }

  /* Benchmark summary for one method over many packets.
     items: [{ key, values }] for plain methods; for the gated method also { gate }. */
  function summarize(items, gated) {
    let fields = 0, correct = 0, present = 0, presentCorrect = 0, missing = 0, missingFlagged = 0;
    let routed = 0, accepted = 0, acceptedCorrect = 0, wrongCaught = 0, wrongSlipped = 0;
    for (const it of items) {
      const s = S.scoreRecord(toRecord(it.values), it.key);
      fields += S.FIELDS.length; correct += s.presentCorrect + s.missingFlagged;
      present += s.present; presentCorrect += s.presentCorrect; missing += s.missing; missingFlagged += s.missingFlagged;
      if (gated) {
        for (const f of S.FIELDS) {
          const ok = s.perField[f.id];
          if (it.gate.fields[f.id].status === "review") { routed++; if (!ok) wrongCaught++; }
          else { accepted++; if (ok) acceptedCorrect++; else wrongSlipped++; }
        }
      }
    }
    const res = {
      packets: items.length, fields, correct,
      allFieldsCorrect: fields ? correct / fields : null,
      accuracy: present ? presentCorrect / present : null,
      recall: missing ? missingFlagged / missing : null
    };
    if (gated) Object.assign(res, {
      routed, accepted, acceptedCorrect, wrongCaught, wrongSlipped,
      reviewShare: fields ? routed / fields : null,
      acceptedAccuracy: accepted ? acceptedCorrect / accepted : null,
      // If the reviewer fixes every routed field correctly (an assumption, not measured)
      withReview: fields ? (correct + wrongCaught) / fields : null
    });
    return res;
  }

  const api = { gate, detectInjection, quoteFound, valueInQuote, toRecord, summarize };
  if (node) module.exports = api; else root.Checks = api;
})(typeof window !== "undefined" ? window : this);
