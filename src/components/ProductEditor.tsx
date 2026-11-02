"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiCall, ApiError } from "./api-client";
import { btn, input } from "./ui";

export function ProductEditor({ sku, price, shipping, stock }: { sku: string; price: string; shipping: string; stock: number }) {
  const router = useRouter();
  const [v, setV] = useState({ price, shipping, stock: String(stock) });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = v.price !== price || v.shipping !== shipping || v.stock !== String(stock);
  const field = (k: keyof typeof v, labelText: string, width: string) => (
    <label className="flex flex-col text-xs text-[var(--muted)]">
      {labelText}
      <input
        className={`${input} mt-0.5 ${width} py-1 text-sm`}
        inputMode="decimal"
        value={v[k]}
        onChange={(e) => {
          setV({ ...v, [k]: e.target.value });
          setMsg(null);
        }}
      />
    </label>
  );
  return (
    <div className="flex flex-wrap items-end gap-2">
      {field("price", "Price $", "w-24")}
      {field("shipping", "Shipping $", "w-24")}
      {field("stock", "Stock", "w-20")}
      <button
        type="button"
        className={`${btn.secondary} px-3 py-1.5 text-xs`}
        disabled={!dirty || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await apiCall(`/api/merchant/catalog/${sku}`, "PUT", { price: v.price, shipping: v.shipping, stock: v.stock });
            setMsg({ ok: true, text: "Saved. Earlier cart checks for this item no longer apply." });
            router.refresh();
          } catch (err) {
            setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Could not save." });
          }
          setBusy(false);
        }}
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {msg && <span className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</span>}
    </div>
  );
}
