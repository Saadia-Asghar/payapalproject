import { Suspense } from "react";
import { DemoSignIn, LoginForm, PasskeySignIn } from "@/components/LoginForm";
import { card } from "@/components/ui";

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-md space-y-6 pt-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Only you can approve permissions for your account.</p>
      </div>
      <Suspense>
        <section className={card} aria-labelledby="demo-heading">
          <h2 id="demo-heading" className="text-sm font-semibold">
            Try it in one click
          </h2>
          <p className="mt-1 mb-4 text-xs text-[var(--muted)]">
            No sign-up. Payments are PayPal <strong>sandbox</strong> only; no real money moves.
          </p>
          <DemoSignIn />
        </section>
        <section className={`${card} space-y-4`}>
          <PasskeySignIn />
          <LoginForm />
        </section>
      </Suspense>
      <p className="text-xs text-[var(--muted)]">
        Seeded accounts: <code className="font-mono">buyer@demo.cartwitness.test</code> and{" "}
        <code className="font-mono">merchant@demo.cartwitness.test</code> (password in the submission&apos;s testing instructions, or{" "}
        <code className="font-mono">.env.local</code> after <code className="font-mono">npm run setup</code>).
      </p>
    </div>
  );
}
