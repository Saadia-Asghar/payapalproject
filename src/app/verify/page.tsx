import { VerifyLookupForm, VerifyPasteForm } from "@/components/VerifyForms";
import { card } from "@/components/ui";

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--accent)]">Public verification</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Verify a Purchase Passport</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Checks the CartWitness signatures and hash links. Shows a yes/no result only — never the buyer, address or full cart.
        </p>
      </div>
      <div className={card}>
        <h2 className="text-base font-semibold">Look up by Passport ID</h2>
        <div className="mt-3">
          <VerifyLookupForm />
        </div>
      </div>
      <VerifyPasteForm />
      <p className="text-xs text-[var(--muted)]">
        Server-verified: checks run on CartWitness using the public Ed25519 keys at <code className="font-mono">/api/keys</code>. Signatures are
        application signatures — they prove records are unchanged since CartWitness signed them, not which person approved.
      </p>
    </div>
  );
}
