import Link from "next/link";
import { btn, card } from "@/components/ui";

const steps = [
  { n: "1", title: "You set the rules", body: "Fill out a short Purchase Permission Form: product, size, sellers, a maximum total including fees, and a deadline." },
  { n: "2", title: "You approve the exact terms", body: "A plain-English summary and a fingerprint of the terms are shown. Nothing is active until you tick three confirmations and approve." },
  { n: "3", title: "Code checks every cart", body: "The AI may suggest products, but the server compares the final cart with the version you approved — and blocks anything outside it." },
  { n: "4", title: "PayPal handles payment", body: "You still approve checkout in PayPal. The payment IDs are linked to your approval in a verifiable Purchase Passport." },
];

export default function Home() {
  return (
    <div className="space-y-10">
      <section className="space-y-5 pt-6">
        <p className="text-sm font-semibold uppercase tracking-wider text-[var(--accent)]">Proof of human permission for AI purchases</p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Decide what your AI may buy — before it shops.
        </h1>
        <p className="max-w-2xl text-lg text-[var(--muted)]">
          The customer defines the permission. AI interprets the request. Code enforces the rules. PayPal handles the payment.
          Evidence preserves what happened.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/permissions" className={btn.primary}>
            Create a purchase permission
          </Link>
          <Link href="/login" className={btn.secondary}>
            Sign in
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {steps.map((s) => (
          <div key={s.n} className={card}>
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--accent-soft)] text-sm font-bold text-[var(--accent)]">{s.n}</span>
            <h2 className="mt-3 font-semibold">{s.title}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">{s.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
