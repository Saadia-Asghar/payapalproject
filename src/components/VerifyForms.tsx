"use client";
// Public verification: look up a passport id, or paste a downloaded bundle (edit it to see tampering fail).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckList } from "./CheckList";
import { btn, card, input, label } from "./ui";

export function VerifyLookupForm() {
  const router = useRouter();
  const [id, setId] = useState("");
  return (
    <form
      className="flex flex-wrap gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const clean = id.trim().toUpperCase();
        if (clean) router.push(`/verify/${encodeURIComponent(clean)}`);
      }}
    >
      <label htmlFor="pp" className="sr-only">
        Passport ID
      </label>
      <input id="pp" className={`${input} max-w-xs font-mono`} placeholder="CW-PP-00001" value={id} onChange={(e) => setId(e.target.value)} />
      <button type="submit" className={btn.primary}>
        Verify
      </button>
    </form>
  );
}

interface Result {
  valid: boolean;
  checks: { label: string; ok: boolean }[];
}

export function VerifyPasteForm() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Sent as raw text: the server parses it, so edited JSON is checked exactly as pasted.
      const res = await fetch("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Verification failed.");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    }
    setBusy(false);
  }

  return (
    <div className={card}>
      <label htmlFor="bundle" className={label}>
        Paste a downloaded proof bundle
      </label>
      <p className="mt-1 text-xs text-[var(--muted)]">Try changing any value — the amount, a hash, a date — and verify again.</p>
      <textarea
        id="bundle"
        rows={10}
        className={`${input} mt-2 font-mono text-xs`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{ "bundle": { … }, "signature": "…", "signing_key_id": "…" }'
      />
      <button type="button" className={`${btn.primary} mt-3`} disabled={busy || !text.trim()} onClick={() => void verify()}>
        {busy ? "Verifying…" : "Verify bundle"}
      </button>
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {result && (
        <div className="mt-4">
          <p className={`text-sm font-semibold ${result.valid ? "text-emerald-800" : "text-red-700"}`}>
            {result.valid ? "✓ Verified: this bundle is unchanged since CartWitness signed it." : "✗ Tamper detected: this bundle does not verify."}
          </p>
          <div className="mt-3">
            <CheckList checks={result.checks} />
          </div>
        </div>
      )}
    </div>
  );
}
