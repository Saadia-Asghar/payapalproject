import Link from "next/link";
import { Suspense } from "react";
import { getSessionUser } from "@/server/auth/session";
import { SignOutButton } from "./SignOutButton";

async function Account() {
  const s = await getSessionUser();
  const verify = (
    <Link href="/verify" className="font-medium text-[var(--ink)] hover:text-[var(--accent)]">
      Verify
    </Link>
  );
  if (!s) {
    return (
      <div className="flex items-center gap-4 text-sm">
        {verify}
        <Link href="/login" className="font-semibold text-[var(--accent)] hover:underline">
          Sign in
        </Link>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4 text-sm">
      {s.user.role === "MERCHANT" ? (
        <Link href="/merchant" className="font-medium text-[var(--ink)] hover:text-[var(--accent)]">
          Merchant workspace
        </Link>
      ) : (
        <Link href="/permissions" className="font-medium text-[var(--ink)] hover:text-[var(--accent)]">
          My permissions
        </Link>
      )}
      {verify}
      <span className="hidden text-[var(--muted)] sm:inline">{s.user.display_name}</span>
      <SignOutButton />
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-[var(--line)] bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-[var(--ink)]">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-[var(--accent)] text-xs font-bold text-white">
            CW
          </span>
          CartWitness
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
            Sandbox demo
          </span>
        </Link>
        <Suspense fallback={<span className="h-5 w-24 animate-pulse rounded bg-[var(--surface-2)]" />}>
          <Account />
        </Suspense>
      </div>
    </header>
  );
}
