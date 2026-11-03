import Link from "next/link";
import { SignUpForm } from "@/components/SignUpForm";
import { card } from "@/components/ui";

export default function SignUpPage() {
  return (
    <div className="mx-auto max-w-md space-y-6 pt-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Decide what your AI shopping assistant may buy. Payments run in the PayPal sandbox — no real money moves.
        </p>
      </div>
      <section className={card}>
        <SignUpForm />
      </section>
      <p className="text-sm text-[var(--muted)]">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
          Sign in
        </Link>{" "}
        · Just looking?{" "}
        <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
          Try the one-click demo
        </Link>
      </p>
    </div>
  );
}
