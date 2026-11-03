"use client";
// Screen 1 — "What can your AI buy?"
// Rendered client-side only (see PermissionFormLoader) so the deadline is shown in the
// buyer's own time zone without server/browser hydration differences.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DraftSuggestion } from "@/lib/permissions/extract";
import { DELIVERY_REFS, validateTerms, type FieldErrors, type TermsFormValues } from "@/lib/permissions/terms";
import { apiCall, ApiError } from "./api-client";
import { btn, fieldError, hint, input, label } from "./ui";

export interface Merchant {
  id: string;
  display_name: string;
}

interface Props {
  permissionId: string;
  policyId: string;
  nextVersion: number;
  initial: Partial<TermsFormValues> | null;
  merchants: Merchant[];
}

interface FormState {
  request_text: string;
  product_type: string;
  color: string;
  size: string;
  brand: string;
  condition: "NEW_ONLY" | "ANY";
  quantity: string;
  max_total: string;
  merchant_ids: string[];
  delivery_ref: string;
  deadline_local: string;
  substitutions: "NOT_ALLOWED" | "ASK_FIRST";
  notes: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Date → value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultDeadline() {
  const d = new Date();
  d.setDate(d.getDate() + 4);
  d.setHours(23, 59, 0, 0);
  return toLocalInput(d);
}

function initialState(v: Partial<TermsFormValues> | null): FormState {
  return {
    request_text: v?.request_text ?? "",
    product_type: v?.product_type ?? "",
    color: v?.color ?? "",
    size: v?.size ?? "",
    brand: v?.brand ?? "",
    condition: v?.condition ?? "NEW_ONLY",
    quantity: v?.quantity !== undefined ? String(v.quantity) : "1",
    max_total: v?.max_total ?? "",
    merchant_ids: v?.merchant_ids ?? [],
    delivery_ref: v?.delivery_ref ?? "",
    deadline_local: v?.expires_at && !Number.isNaN(Date.parse(v.expires_at)) ? toLocalInput(new Date(v.expires_at)) : defaultDeadline(),
    substitutions: v?.substitutions ?? "ASK_FIRST",
    notes: v?.notes ?? "",
  };
}

/** Form field → the field key used for errors, badges and the approval evidence. */
const fieldKey = (k: keyof FormState) => (k === "deadline_local" ? "expires_at" : k);

function toPayload(s: FormState, timeZone: string, aiSuggested: string[]) {
  const deadline = s.deadline_local ? new Date(s.deadline_local) : null;
  return {
    // Which values the AI pre-filled and the buyer kept; recorded with the approval.
    ai_suggested_fields: aiSuggested,
    request_text: s.request_text,
    product_type: s.product_type,
    color: s.color,
    size: s.size,
    brand: s.brand,
    condition: s.condition,
    quantity: s.quantity,
    max_total: s.max_total,
    currency: "USD",
    merchant_ids: s.merchant_ids,
    delivery_ref: s.delivery_ref || undefined,
    expires_at: deadline && !Number.isNaN(deadline.getTime()) ? deadline.toISOString() : "",
    display_timezone: timeZone,
    substitutions: s.substitutions,
    recurring: false,
    review_mode: "APPROVE_FINAL_CART",
    single_use: true,
    notes: s.notes,
  };
}

export default function PermissionForm({ permissionId, policyId, nextVersion, initial, merchants }: Props) {
  const router = useRouter();
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [s, setS] = useState<FormState>(() => initialState(initial));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState<"save" | "review" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiFilled, setAiFilled] = useState<string[]>(() => {
    const prev = (initial as { ai_suggested_fields?: unknown } | null)?.ai_suggested_fields;
    return Array.isArray(prev) ? prev.filter((x): x is string => typeof x === "string") : [];
  });
  const [suggesting, setSuggesting] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setS((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[fieldKey(key)];
      return next;
    });
    // Once the buyer edits a field it is their own value, not an AI suggestion.
    setAiFilled((prev) => prev.filter((f) => f !== fieldKey(key)));
  };

  async function suggest() {
    setSuggesting(true);
    setAiNote(null);
    try {
      const today = toLocalInput(new Date()).slice(0, 10);
      const r = await apiCall<{ source: "CLAUDE" | "RULES"; suggestion: DraftSuggestion; notice?: string }>("/api/permissions/draft", "POST", {
        request_text: s.request_text,
        today,
      });
      const g = r.suggestion;
      const next: Partial<FormState> = {};
      if (g.product_type) next.product_type = g.product_type;
      if (g.color) next.color = g.color;
      if (g.size) next.size = g.size;
      if (g.brand) next.brand = g.brand;
      if (g.condition) next.condition = g.condition;
      if (g.quantity) next.quantity = String(g.quantity);
      if (g.max_total) next.max_total = g.max_total;
      if (g.merchant_ids?.length) next.merchant_ids = g.merchant_ids;
      if (g.deadline_date) next.deadline_local = `${g.deadline_date}T23:59`;
      if (g.substitutions) next.substitutions = g.substitutions;
      if (g.notes) next.notes = g.notes;
      const keys = (Object.keys(next) as (keyof FormState)[]).map(fieldKey);
      setS((prev) => ({ ...prev, ...next }));
      setAiFilled(keys);
      setErrors({});
      const by = r.source === "CLAUDE" ? "Claude" : "a rule-based parser";
      setAiNote(
        keys.length
          ? `${keys.length} field(s) pre-filled by ${by} and marked below. Check each one — nothing is approved until you review and approve.${r.notice ? ` ${r.notice}` : ""}`
          : `No fields could be suggested from that text. Please fill the form below.${r.notice ? ` ${r.notice}` : ""}`,
      );
    } catch (e) {
      setAiNote(e instanceof ApiError ? e.message : "Suggestions are unavailable right now.");
    }
    setSuggesting(false);
  }

  async function save(goToReview: boolean) {
    setBusy(goToReview ? "review" : "save");
    setNotice(null);
    const payload = toPayload(s, timeZone, aiFilled);
    const local = validateTerms(payload);
    try {
      // Always save so the buyer never loses work; the server re-validates authoritatively.
      const res = await apiCall<{ errors: FieldErrors }>(`/api/permissions/${permissionId}/draft`, "PUT", payload);
      const combined = { ...(local.ok ? {} : local.errors), ...res.errors };
      setErrors(combined);
      if (Object.keys(combined).length) {
        setNotice(goToReview ? "Saved as draft. Fix the highlighted fields to continue." : "Draft saved — some fields still need attention.");
        document.querySelector("[aria-invalid=true]")?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (goToReview) {
        router.push(`/permissions/${permissionId}/review`);
        return;
      } else {
        setNotice("Draft saved.");
      }
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Could not save. Please try again.");
    }
    setBusy(null);
  }

  const err = (k: string) => errors[k];
  const aria = (k: string) => ({ "aria-invalid": !!err(k), "aria-describedby": err(k) ? `${k}-error` : undefined });
  const errorText = (k: string) => (
    <>
      {aiFilled.includes(k) && <p className="mt-1 inline-flex rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">AI-suggested · please check</p>}
      {err(k) && (
        <p id={`${k}-error`} className={fieldError}>
          {err(k)}
        </p>
      )}
    </>
  );

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
      className="space-y-8"
    >
      <p className="text-sm text-[var(--muted)]">
        {policyId} · {nextVersion === 1 ? "New permission" : `Editing creates version ${nextVersion}; version ${nextVersion - 1} stays on record unchanged.`}{" "}
        Fields marked <span className="text-red-600">*</span> are required.
      </p>

      <Section title="Your shopping request" subtitle="Optional. Describe what you want in your own words — it is saved with the permission for context.">
        <textarea
          id="request_text"
          rows={3}
          className={input}
          placeholder="e.g. Find one pair of white running shoes in US size 10. My total budget is $150. I need them before Friday."
          value={s.request_text}
          onChange={(e) => set("request_text", e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" className={btn.secondary} disabled={suggesting || s.request_text.trim().length < 5} onClick={() => void suggest()}>
            {suggesting ? "Reading your request…" : "✨ Suggest fields from my request"}
          </button>
          <span className={hint}>Only the structured fields below are enforced. Suggestions are never approved for you.</span>
        </div>
        {aiNote && (
          <p role="status" className="mt-2 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">
            {aiNote}
          </p>
        )}
      </Section>

      <Section title="What can your AI buy?">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="product_type" labelText="Product type" required error={errorText("product_type")}>
            <input id="product_type" className={input} placeholder="Running shoes" value={s.product_type} onChange={(e) => set("product_type", e.target.value)} {...aria("product_type")} />
            <p className={hint}>Be specific — broad terms like “anything” are rejected.</p>
          </Field>
          <Field id="quantity" labelText="Quantity" required error={errorText("quantity")}>
            <input id="quantity" type="number" min={1} max={10} step={1} inputMode="numeric" className={input} value={s.quantity} onChange={(e) => set("quantity", e.target.value)} {...aria("quantity")} />
          </Field>
          <Field id="color" labelText="Colour" error={errorText("color")}>
            <input id="color" className={input} placeholder="White" value={s.color} onChange={(e) => set("color", e.target.value)} />
          </Field>
          <Field id="size" labelText="Size" error={errorText("size")}>
            <input id="size" className={input} placeholder="US men's 10" value={s.size} onChange={(e) => set("size", e.target.value)} />
            <p className={hint}>Size must match exactly.</p>
          </Field>
          <Field id="brand" labelText="Brand" error={errorText("brand")}>
            <input id="brand" className={input} placeholder="Any brand" value={s.brand} onChange={(e) => set("brand", e.target.value)} />
          </Field>
          <fieldset>
            <legend className={label}>Condition</legend>
            <div className="mt-2 flex gap-4 text-sm">
              <Radio name="condition" checked={s.condition === "NEW_ONLY"} onChange={() => set("condition", "NEW_ONLY")} text="New only" />
              <Radio name="condition" checked={s.condition === "ANY"} onChange={() => set("condition", "ANY")} text="New or used" />
            </div>
          </fieldset>
        </div>
      </Section>

      <Section title="Budget">
        <Field id="max_total" labelText="Maximum TOTAL" required error={errorText("max_total")}>
          <div className="relative max-w-xs">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-[var(--muted)]">$</span>
            <input id="max_total" inputMode="decimal" className={`${input} pl-7 pr-14`} placeholder="150.00" value={s.max_total} onChange={(e) => set("max_total", e.target.value)} {...aria("max_total")} />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-[var(--muted)]">USD</span>
          </div>
          <p className={hint}>
            <strong>Includes</strong> item price, shipping, taxes and every mandatory fee. Currency is never switched silently.
          </p>
        </Field>
      </Section>

      <Section title="Allowed sellers" required subtitle="Matched by verified seller ID, not by name — a look-alike store name will not pass.">
        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-describedby={err("merchant_ids") ? "merchant_ids-error" : undefined}>
          {merchants.map((m) => {
            const checked = s.merchant_ids.includes(m.id);
            return (
              <label key={m.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${checked ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--line)] bg-white"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                  checked={checked}
                  onChange={(e) => set("merchant_ids", e.target.checked ? [...s.merchant_ids, m.id] : s.merchant_ids.filter((x) => x !== m.id))}
                />
                <span>
                  <span className="block font-medium">{m.display_name}</span>
                  <span className="font-mono text-xs text-[var(--muted)]">{m.id}</span>
                </span>
              </label>
            );
          })}
        </div>
        {errorText("merchant_ids")}
      </Section>

      <Section title="Delivery and deadline">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="delivery_ref" labelText="Delivery location" error={errorText("delivery_ref")}>
            <select id="delivery_ref" className={input} value={s.delivery_ref} onChange={(e) => set("delivery_ref", e.target.value)}>
              <option value="">Not specified</option>
              {Object.entries(DELIVERY_REFS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <p className={hint}>Only a reference is stored — your address is never shown on public proof pages.</p>
          </Field>
          <Field id="deadline" labelText="Purchase deadline" required error={errorText("expires_at")}>
            <input id="deadline" type="datetime-local" className={input} value={s.deadline_local} onChange={(e) => set("deadline_local", e.target.value)} {...aria("expires_at")} />
            <p className={hint}>Your time zone: {timeZone}. Enforced by the server before any order is created or captured.</p>
          </Field>
        </div>
      </Section>

      <Section title="Rules">
        <div className="grid gap-5 sm:grid-cols-2">
          <fieldset>
            <legend className={label}>Substitutions</legend>
            <div className="mt-2 space-y-2 text-sm">
              <Radio name="substitutions" checked={s.substitutions === "ASK_FIRST"} onChange={() => set("substitutions", "ASK_FIRST")} text="Ask me first" />
              <Radio name="substitutions" checked={s.substitutions === "NOT_ALLOWED"} onChange={() => set("substitutions", "NOT_ALLOWED")} text="Not allowed" />
            </div>
          </fieldset>
          <dl className="space-y-3 text-sm">
            <Fixed term="Recurring billing" value="Not allowed" />
            <Fixed term="Review mode" value="Ask me to approve the final cart" />
            <Fixed term="Permission use" value="One purchase only" />
          </dl>
        </div>
        <p className={hint}>Fixed rules can’t be loosened in this version: no subscriptions, no unattended PayPal charges, no repeat purchases.</p>
      </Section>

      <Section title="Extra notes">
        <textarea id="notes" rows={2} className={input} placeholder="No used or refurbished items" value={s.notes} onChange={(e) => set("notes", e.target.value)} />
        <p className={hint}>Recorded with your permission. Use the fields above for anything that must be checked automatically.</p>
      </Section>

      {notice && (
        <p role="status" className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--ink)]">
          {notice}
        </p>
      )}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-[var(--line)] bg-[var(--surface)]/95 px-4 py-4 backdrop-blur">
        <button type="button" className={btn.secondary} disabled={!!busy} onClick={() => void save(false)}>
          {busy === "save" ? "Saving…" : "Save draft"}
        </button>
        <button type="submit" className={btn.primary} disabled={!!busy}>
          {busy === "review" ? "Checking…" : "Review what I’m allowing →"}
        </button>
      </div>
    </form>
  );
}

function Section({ title, subtitle, required, children }: { title: string; subtitle?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-[var(--ink)]">
          {title}
          {required && <span className="text-red-600"> *</span>}
        </h2>
        {subtitle && <p className="text-sm text-[var(--muted)]">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ id, labelText, required, error, children }: { id: string; labelText: string; required?: boolean; error?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {labelText}
        {required && <span className="text-red-600"> *</span>}
      </label>
      <div className="mt-1">{children}</div>
      {error}
    </div>
  );
}

function Radio({ name, checked, onChange, text }: { name: string; checked: boolean; onChange: () => void; text: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="h-4 w-4 accent-[var(--accent)]" />
      {text}
    </label>
  );
}

function Fixed({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="font-medium text-[var(--ink)]">{term}</dt>
      <dd className="text-[var(--muted)]">🔒 {value}</dd>
    </div>
  );
}
