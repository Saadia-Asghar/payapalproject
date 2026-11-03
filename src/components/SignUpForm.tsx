"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { passwordProblem, PASSWORD_MIN } from "@/lib/auth/password-rules";
import { apiCall, ApiError } from "./api-client";
import { btn, fieldError, hint, input, label } from "./ui";

type Errors = Partial<Record<"display_name" | "email" | "password" | "confirm", string>>;

export function SignUpForm() {
  const router = useRouter();
  const [values, setValues] = useState({ display_name: "", email: "", password: "", confirm: "" });
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const local: Errors = {};
  if (!values.display_name.trim()) local.display_name = "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) local.email = "Enter a valid email address.";
  const weak = passwordProblem(values.password, values.email.trim());
  if (weak) local.password = weak;
  if (values.confirm !== values.password) local.confirm = "Passwords don't match.";
  const errors: Errors = touched ? { ...local, ...serverErrors } : serverErrors;

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    setServerErrors((s) => ({ ...s, [k]: undefined }));
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    setMessage(null);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await apiCall("/api/auth/signup", "POST", { display_name: values.display_name, email: values.email, password: values.password });
      router.push("/account?welcome=1");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setServerErrors((err.details as Errors) ?? {});
        setMessage(err.message);
      } else {
        setMessage("Could not create the account.");
      }
      setBusy(false);
    }
  }

  const field = (k: keyof typeof values, text: string, type: string, autoComplete: string, help?: string) => (
    <div>
      <label htmlFor={k} className={label}>
        {text}
      </label>
      <input
        id={k}
        name={k}
        type={type}
        autoComplete={autoComplete}
        value={values[k]}
        onChange={set(k)}
        aria-invalid={!!errors[k]}
        aria-describedby={errors[k] ? `${k}-error` : help ? `${k}-hint` : undefined}
        className={`${input} mt-1`}
      />
      {errors[k] ? (
        <p id={`${k}-error`} className={fieldError}>
          {errors[k]}
        </p>
      ) : help ? (
        <p id={`${k}-hint`} className={hint}>
          {help}
        </p>
      ) : null}
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {field("display_name", "Your name", "text", "name")}
      {field("email", "Email", "email", "email")}
      {field("password", "Password", "password", "new-password", `At least ${PASSWORD_MIN} characters. A passphrase works well.`)}
      {field("confirm", "Confirm password", "password", "new-password")}
      {message && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {message}
        </p>
      )}
      <button type="submit" disabled={busy} className={`${btn.primary} w-full`}>
        {busy ? "Creating your account…" : "Create account"}
      </button>
      <p className="text-xs text-[var(--muted)]">
        Next you can add a passkey, so every approval is signed by your own device.
      </p>
    </form>
  );
}
