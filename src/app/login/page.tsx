import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";
import { card } from "@/components/ui";

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-sm space-y-6 pt-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">Only you can approve permissions for your account.</p>
      </div>
      <div className={card}>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
      <p className="text-xs text-[var(--muted)]">
        Demo accounts are created by <code className="font-mono">npm run setup</code> (the password is in .env.local); see the README.
      </p>
    </div>
  );
}
