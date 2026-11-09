/* Field definitions, value normalization and scoring.
   Loaded by the browser (window.Scoring) and by Node tests (module.exports). */
(function (root) {
  "use strict";

  const INDUSTRIES = [
    "Industrial manufacturing", "Wholesale distribution", "Construction contracting",
    "Food and beverage production", "Hospitality", "Technology services",
    "Healthcare services", "Commercial real estate"
  ];

  const FIELDS = [
    { id: "insured_name", label: "Named insured", type: "text", help: "Applicant's legal business name." },
    { id: "broker_agency", label: "Broker agency", type: "text", help: "Agency that sent the submission." },
    { id: "effective_date", label: "Requested effective date", type: "date", help: "Use YYYY-MM-DD, e.g. 2027-03-01." },
    { id: "industry", label: "Industry", type: "industry", help: "Pick the closest match to the operations description." },
    { id: "annual_revenue", label: "Annual revenue (USD)", type: "money", help: "Most recent fiscal year, not the prior year. 412.5M or 412,500,000 both work." },
    { id: "employee_count", label: "Full-time employees", type: "int", help: "Exclude seasonal or part-time workers." },
    { id: "location_count", label: "Number of locations", type: "int", help: "" },
    { id: "total_insured_value", label: "Total insured value (USD)", type: "money", help: "From the statement of values." },
    { id: "gl_occurrence_limit", label: "GL limit, each occurrence (USD)", type: "money", help: "Not the aggregate or umbrella limit." },
    { id: "losses_5yr", label: "Claims in past 5 years", type: "int", help: "Count of claims. Enter 0 only if the packet says there were none." }
  ];

  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LEGAL = /\b(incorporated|inc|llc|l l c|corporation|corp|company|co|ltd|limited|holdings)\b/g;

  function normText(s) {
    return String(s).toLowerCase().replace(/&/g, " and ").replace(/[.,'’]/g, "")
      .replace(LEGAL, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  /* "$412.5 million", "412.5mm", "USD 412.5M", "$2,000,000", "1,240", "2M", "1.2 billion" -> number */
  function parseNumber(s) {
    if (s === null || s === undefined) return NaN;
    if (typeof s === "number") return s;
    const t = String(s).toLowerCase().replace(/usd|\$|,|\s+/g, "");
    const m = t.match(/^(\d+(?:\.\d+)?)(k|thousand|m|mm|mil|million|b|bn|billion)?$/);
    if (!m) return NaN;
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  function iso(y, mo, d) {
    if (!(y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return null; // e.g. Feb 30
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  /* ISO, M/D/YYYY, DD-Mon-YYYY, "Month D, YYYY", "D Month YYYY" -> YYYY-MM-DD or null */
  function parseDate(s) {
    if (!s) return null;
    const t = String(s).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, "");
    let m;
    if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
    if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return iso(+m[3], +m[1], +m[2]);
    if ((m = t.match(/^(\d{1,2})[- ]([a-z]+)[- ](\d{4})$/))) {
      const mo = MONTHS.indexOf(m[2].slice(0, 3)); if (mo >= 0) return iso(+m[3], mo + 1, +m[1]);
    }
    if ((m = t.match(/^([a-z]+) (\d{1,2}) (\d{4})$/))) {
      const mo = MONTHS.indexOf(m[1].slice(0, 3)); if (mo >= 0) return iso(+m[3], mo + 1, +m[2]);
    }
    return null;
  }

  /* Canonical form used for comparison; null means "cannot be read". */
  function normalize(field, value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    switch (field.type) {
      case "date": return parseDate(value);
      case "money": case "int": { const n = parseNumber(value); return Number.isFinite(n) ? n : null; }
      case "industry": return INDUSTRIES.find(i => i.toLowerCase() === String(value).trim().toLowerCase()) || null;
      default: return normText(value) || null;
    }
  }

  /* Returns an error message if the entry cannot be accepted, else "". */
  function validateEntry(field, value, notInPacket) {
    if (notInPacket) return "";
    if (value === null || String(value).trim() === "") return "Enter a value or tick “Not in packet”.";
    if (normalize(field, value) === null) {
      if (field.type === "date") return "Use a date like 2027-03-01.";
      if (field.type === "money" || field.type === "int") return "Use a number, e.g. 412500000 or 412.5M.";
      if (field.type === "industry") return "Pick an industry from the list.";
    }
    return "";
  }

  function sameValue(field, a, b) {
    const x = normalize(field, a), y = normalize(field, b);
    if (x === null || y === null) return false;
    return typeof x === "number" ? Math.abs(x - y) < 0.5 : x === y;
  }

  function median(xs) {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  /* Score one record against its answer key. */
  function scoreRecord(record, key) {
    let present = 0, presentCorrect = 0, missing = 0, missingFlagged = 0, falseMissing = 0;
    const perField = {};
    for (const f of FIELDS) {
      const truth = key[f.id];
      const flagged = record[f.id + "_missing"] === true || record[f.id + "_missing"] === "true";
      const entered = record[f.id];
      let ok;
      if (truth === null || truth === undefined) {
        missing++; ok = flagged; if (ok) missingFlagged++;
      } else {
        present++; ok = !flagged && sameValue(f, entered, truth); if (ok) presentCorrect++;
        if (flagged) falseMissing++;
      }
      perField[f.id] = ok;
    }
    return { present, presentCorrect, missing, missingFlagged, falseMissing, perField };
  }

  /* Aggregate by arm. Arm B records that fell back to manual entry are reported separately. */
  function scoreAll(records, keys) {
    const groups = { A: [], B: [], B_fallback: [] };
    for (const r of records) {
      if (!keys[r.packet_id]) continue;
      const g = r.arm === "A" ? "A" : (r.ai_status === "ok" ? "B" : "B_fallback");
      groups[g].push({ r, s: scoreRecord(r, keys[r.packet_id]) });
    }
    const summary = {};
    for (const [g, items] of Object.entries(groups)) {
      const t = items.reduce((a, { s }) => ({
        present: a.present + s.present, presentCorrect: a.presentCorrect + s.presentCorrect,
        missing: a.missing + s.missing, missingFlagged: a.missingFlagged + s.missingFlagged,
        falseMissing: a.falseMissing + s.falseMissing
      }), { present: 0, presentCorrect: 0, missing: 0, missingFlagged: 0, falseMissing: 0 });
      summary[g] = {
        records: items.length, ...t,
        accuracy: t.present ? t.presentCorrect / t.present : null,
        recall: t.missing ? t.missingFlagged / t.missing : null,
        medianSeconds: median(items.map(({ r }) => Number(r.duration_s))),
        acceptedUnchanged: g === "B" ? items.filter(({ r }) => Number(r.fields_changed_from_ai) === 0).length : null
      };
    }
    const A = summary.A, B = summary.B;
    const ready = A.records > 0 && B.records > 0;
    summary.criteria = ready ? {
      accuracy: B.accuracy >= A.accuracy,
      recall: B.recall >= A.recall,
      time: B.medianSeconds <= 0.7 * A.medianSeconds,
      timeReduction: 1 - B.medianSeconds / A.medianSeconds
    } : null;
    if (summary.criteria) {
      const c = summary.criteria; c.all = c.accuracy && c.recall && c.time;
    }
    return { summary, detail: Object.values(groups).flat() };
  }

  const api = { FIELDS, INDUSTRIES, normText, parseNumber, parseDate, normalize, validateEntry, sameValue, median, scoreRecord, scoreAll };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Scoring = api;
})(typeof window !== "undefined" ? window : this);
