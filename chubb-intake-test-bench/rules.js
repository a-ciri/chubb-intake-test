/* Rule-based extractor: the no-AI baseline.
   It looks for labeled lines ("Applicant:", "Revenue (...):", "Employees:") and a few common phrases,
   the way a quick in-house automation would. It is deliberately not tuned to free-form prose.
   Returns canonical strings (numbers as digits, dates as YYYY-MM-DD) or null when nothing is found. */
(function (root) {
  "use strict";
  const S = typeof module !== "undefined" && module.exports ? require("./scoring.js") : root.Scoring;

  const HEDGE = /\b(tbd|to follow|to be provided|to be confirmed|same as expiring|requested from|on order)\b/i;
  const MONEY = /(?:usd\s*)?\$?\d[\d,]*(?:\.\d+)?\s*(?:mm|m|million|bn|billion|k)?\b/i;

  const INDUSTRY_WORDS = [
    ["Wholesale distribution", /distribut|wholesale/i],
    ["Construction contracting", /contractor|construction/i],
    ["Hospitality", /hotel|hospitality|restaurant/i],
    ["Technology services", /\bit services|data[- ]center|software|technology/i],
    ["Healthcare services", /clinic|therapy|health|medical/i],
    ["Commercial real estate", /office park|real estate|property owner|flex warehouse/i],
    ["Food and beverage production", /bakery|food|beverage|bottled|juice|tea/i],
    ["Industrial manufacturing", /manufactur|machin|pumps|valves|fabricat/i]
  ];

  const line = (text, label) => {
    const m = text.match(new RegExp("^\\s*" + label + "\\s*:\\s*(.+)$", "im"));
    return m ? m[1].trim() : null;
  };
  const money = s => {
    if (!s || HEDGE.test(s)) return null;
    const m = s.match(MONEY); if (!m) return null;
    const n = S.parseNumber(m[0]); return Number.isFinite(n) ? String(n) : null;
  };
  const count = s => {
    if (!s || HEDGE.test(s)) return null;
    const m = s.match(/\d[\d,]*/); return m ? String(parseInt(m[0].replace(/,/g, ""), 10)) : null;
  };

  function extract(text) {
    const t = String(text || "");
    const out = {};

    // Named insured: "Applicant:" line, else the subject line
    let name = line(t, "Applicant");
    if (!name) { const m = t.match(/^Subject:.*?submission:\s*(.+?)\s*\(Package\)/im); name = m ? m[1] : null; }
    out.insured_name = name;

    // Broker agency: "From: Person, Agency"
    const from = line(t, "From");
    out.broker_agency = from && from.includes(",") ? from.slice(from.indexOf(",") + 1).trim() : null;

    // Effective date: "effective date of X" or "eff X" in the subject
    let eff = null;
    let m = t.match(/effective date of\s+([^.\n]+?)\.?\s*$/im) || t.match(/^Subject:.*\beff\s+(.+)$/im);
    if (m && !HEDGE.test(m[1])) eff = S.parseDate(m[1].trim());
    out.effective_date = eff;

    // Industry: keywords in the "Operations:" line
    const ops = line(t, "Operations");
    out.industry = ops ? (INDUSTRY_WORDS.find(([, re]) => re.test(ops)) || [null])[0] : null;

    // Revenue: labeled line, or "did $X in revenue"
    const revLine = line(t, "Revenue(?: \\(most recent fiscal year\\))?");
    let rev = revLine ? money(revLine.split(";")[0]) : null;
    if (!rev) { m = t.match(/did\s+(\S+(?:\s+million)?)\s+in revenue/i); if (m) rev = money(m[1]); }
    out.annual_revenue = rev;

    // Employees: "Employees: 1,240 full-time"
    out.employee_count = count(line(t, "Employees"));

    // Locations: labeled line, else "across N locations"
    let loc = count(line(t, "Number of locations"));
    if (!loc) { m = t.match(/across\s+(\d+)\s+locations?/i); if (m) loc = m[1]; }
    out.location_count = loc;

    // Total insured value: labeled line
    const tivLine = line(t, "Total insured value[^:\\n]*");
    out.total_insured_value = tivLine ? money(tivLine) : null;

    // GL each-occurrence limit: the amount before "each occurrence" on the limits line
    const gl = line(t, "General liability limits requested");
    m = gl && !HEDGE.test(gl) ? gl.match(/(\S+)\s+each occurrence/i) : null;
    out.gl_occurrence_limit = m ? money(m[1]) : null;

    // Claims: "Total claims: N" or "No claims reported"
    m = t.match(/Total claims:\s*(\d+)/i);
    out.losses_5yr = m ? m[1] : (/no claims reported/i.test(t) ? "0" : null);

    for (const f of S.FIELDS) if (out[f.id] === undefined || out[f.id] === "") out[f.id] = null;
    return out;
  }

  const api = { extract };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Rules = api;
})(typeof window !== "undefined" ? window : this);
