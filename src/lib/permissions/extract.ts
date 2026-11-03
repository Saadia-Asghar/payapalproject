// Turns a buyer's plain-English request into SUGGESTED form values.
// Suggestions are never consent: the buyer sees every filled field, can edit it, and the
// server validates the final draft at review time like any hand-typed value.

export interface DraftSuggestion {
  product_type?: string;
  color?: string;
  size?: string;
  brand?: string;
  condition?: "NEW_ONLY" | "ANY";
  quantity?: number;
  max_total?: string;
  merchant_ids?: string[];
  /** Buyer-local calendar date (YYYY-MM-DD); the form sets 23:59 in the buyer's time zone. */
  deadline_date?: string;
  substitutions?: "NOT_ALLOWED" | "ASK_FIRST";
  notes?: string;
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COLORS = ["off-white", "white", "black", "grey", "gray", "red", "blue", "navy", "green", "yellow", "pink", "purple", "brown", "beige", "orange", "silver", "gold"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (n: number) => String(n).padStart(2, "0");
function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Resolves "before Friday", "by Nov 6", "within 3 days", "tomorrow" against the buyer's today. */
export function parseDeadline(text: string, today: string): string | undefined {
  const t = text.toLowerCase();
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  const within = /\bwithin\s+(\d{1,2}|one|two|three|four|five|six|seven|ten)\s+days?\b/.exec(t);
  if (within) return addDays(today, Number(within[1]) || NUMBER_WORDS[within[1]]);
  const wd = /\b(?:before|by|until|on)\s+(?:this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (wd) {
    const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
    let diff = (WEEKDAYS.indexOf(wd[1]) - todayDow + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(today, diff);
  }
  const md =
    /\b(?:before|by|until|on)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/.exec(t) ??
    /\b(?:before|by|until|on)\s+(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t);
  if (md) {
    const [month, day] = /\d/.test(md[1]) ? [md[2], Number(md[1])] : [md[1], Number(md[2])];
    const year = Number(today.slice(0, 4));
    let date = `${year}-${pad(MONTHS.indexOf(month) + 1)}-${pad(day)}`;
    if (date <= today) date = `${year + 1}-${date.slice(5)}`;
    return date;
  }
  return undefined;
}

/** Deterministic, offline extractor. Used directly, and as the fallback when no AI is configured. */
export function extractWithRules(text: string, ctx: { today: string; merchants: { id: string; display_name: string }[] }): DraftSuggestion {
  const s: DraftSuggestion = {};
  const t = text.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();

  const money = /\$\s?(\d{1,5}(?:\.\d{1,2})?)/.exec(t) ?? /\b(\d{1,5}(?:\.\d{1,2})?)\s?(?:usd|dollars)\b/i.exec(t);
  if (money) s.max_total = Number(money[1]).toFixed(2);

  const size = /\b(us\s*)?(?:(men'?s|women'?s|mens|womens)\s+)?size\s+(?:(us)\s*)?(?:(men'?s|women'?s|mens|womens)\s+)?(\d{1,2}(?:\.5)?)\b/i.exec(t);
  if (size) {
    const gender = (size[2] ?? size[4] ?? "").toLowerCase();
    const g = gender.startsWith("w") ? "W " : gender.startsWith("m") ? "M " : "";
    s.size = `${size[1] || size[3] ? "US " : ""}${g}${size[5]}`.trim();
  }

  const color = COLORS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(lower));
  if (color) s.color = color === "gray" ? "grey" : color;

  const qty = /\b(a|an|one|single|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s+(?:pairs?|units?|items?|pieces?)\b/i.exec(t);
  if (qty) s.quantity = Number(qty[1]) || NUMBER_WORDS[qty[1].toLowerCase()];

  const product = new RegExp(
    String.raw`\b(?:find|buy|get|order|need|want|purchase)\s+(?:me\s+)?(?:(?:a|an|one|two|three|\d+)\s+)?(?:pairs?\s+of\s+)?(?:new\s+)?(?:(?:${COLORS.join("|")})\s+)?([a-z][a-z -]{2,40}?)(?=\s+(?:in|size|for|under|from|by|before|with|that|which|at)\b|[,.;!]|$)`,
    "i",
  ).exec(t);
  if (product) s.product_type = product[1].trim().toLowerCase();

  if (/\b(?:no|not|never)\s+(?:used|refurbished|second-?hand)\b|\bnew only\b|\bbrand[- ]new\b/i.test(t)) s.condition = "NEW_ONLY";
  else if (/\b(?:used is fine|any condition|used or new|new or used)\b/i.test(t)) s.condition = "ANY";

  if (/\bno substitut|\bexact(?:ly)? (?:this|that|the)\b/i.test(t)) s.substitutions = "NOT_ALLOWED";
  else if (/\bask me\b|\bcheck with me\b/i.test(t)) s.substitutions = "ASK_FIRST";

  const merchants = ctx.merchants.filter((m) => lower.includes(m.display_name.toLowerCase())).map((m) => m.id);
  if (merchants.length) s.merchant_ids = merchants;

  const deadline = parseDeadline(t, ctx.today);
  if (deadline) s.deadline_date = deadline;

  if (/\bno (?:used|refurbished)\b/i.test(t)) s.notes = "No used or refurbished items";
  return s;
}

/** Normalizes any suggestion (rule-based or AI) to safe, form-ready values; drops anything malformed. */
export function sanitizeSuggestion(raw: Partial<Record<keyof DraftSuggestion, unknown>>, knownMerchantIds: string[]): DraftSuggestion {
  const out: DraftSuggestion = {};
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined);
  out.product_type = str(raw.product_type, 80);
  out.color = str(raw.color, 40);
  out.size = str(raw.size, 40);
  out.brand = str(raw.brand, 60);
  out.notes = str(raw.notes, 500);
  if (raw.condition === "NEW_ONLY" || raw.condition === "ANY") out.condition = raw.condition;
  if (raw.substitutions === "NOT_ALLOWED" || raw.substitutions === "ASK_FIRST") out.substitutions = raw.substitutions;
  if (typeof raw.quantity === "number" && Number.isInteger(raw.quantity) && raw.quantity >= 1 && raw.quantity <= 10) out.quantity = raw.quantity;
  const total = typeof raw.max_total === "number" ? String(raw.max_total) : raw.max_total;
  if (typeof total === "string" && /^\d{1,5}(\.\d{1,2})?$/.test(total.trim()) && Number(total) > 0) out.max_total = Number(total).toFixed(2);
  if (Array.isArray(raw.merchant_ids)) {
    const ids = raw.merchant_ids.filter((id): id is string => typeof id === "string" && knownMerchantIds.includes(id));
    if (ids.length) out.merchant_ids = [...new Set(ids)];
  }
  if (typeof raw.deadline_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.deadline_date)) out.deadline_date = raw.deadline_date;
  for (const k of Object.keys(out) as (keyof DraftSuggestion)[]) if (out[k] === undefined) delete out[k];
  return out;
}
