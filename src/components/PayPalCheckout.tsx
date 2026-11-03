"use client";
// PayPal JS SDK buttons. The browser only relays: our server creates the order from the
// trusted cart and captures it; payment counts only after PayPal's server response is verified.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiCall, ApiError } from "./api-client";
import { btn } from "./ui";

interface PayPalButtons {
  render(el: HTMLElement): Promise<void>;
  close?(): Promise<void>;
}
interface PayPalNamespace {
  Buttons(options: Record<string, unknown>): PayPalButtons;
}
declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

function loadSdk(clientId: string): Promise<PayPalNamespace> {
  if (window.paypal) return Promise.resolve(window.paypal);
  return new Promise((resolve, reject) => {
    const existing = document.getElementById("paypal-sdk") as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => (window.paypal ? resolve(window.paypal) : reject(new Error("PayPal SDK missing"))));
    script.addEventListener("error", () => reject(new Error("PayPal SDK failed to load")));
    if (!existing) {
      script.id = "paypal-sdk";
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

export function PayPalCheckout({ attemptId, clientId, total }: { attemptId: string; clientId: string | null; total: string }) {
  const router = useRouter();
  const container = useRef<HTMLDivElement>(null);
  const paymentOrderId = useRef<string | null>(null);
  const lastError = useRef<string | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    let buttons: PayPalButtons | undefined;
    loadSdk(clientId)
      .then((paypal) => {
        if (cancelled || !container.current) return;
        buttons = paypal.Buttons({
          style: { layout: "vertical", label: "pay", shape: "rect" },
          createOrder: async () => {
            setMessage(null);
            lastError.current = null;
            try {
              const r = await apiCall<{ paymentOrderId: string; paypalOrderId: string }>("/api/checkout/create", "POST", { attempt_id: attemptId });
              paymentOrderId.current = r.paymentOrderId;
              return r.paypalOrderId;
            } catch (err) {
              lastError.current = err instanceof ApiError ? err.message : "Could not start checkout.";
              throw err;
            }
          },
          onApprove: async () => {
            setBusy(true);
            setMessage({ tone: "info", text: "Confirming your payment with PayPal…" });
            try {
              const r = await apiCall<{ status: string; passportId: string | null }>(`/api/checkout/${paymentOrderId.current}/capture`, "POST");
              if (r.status === "CAPTURED" && r.passportId) {
                router.push(`/passports/${r.passportId}`);
                return;
              }
              setMessage({ tone: "info", text: "PayPal is still processing this payment. Your Purchase Passport appears here once PayPal confirms it." });
            } catch (err) {
              setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Payment could not be confirmed." });
            }
            setBusy(false);
          },
          onCancel: () => {
            // The order stays open, so the buyer can simply click Pay again.
            setMessage({ tone: "info", text: "Payment cancelled. Nothing was charged — you can try again." });
          },
          onError: () => {
            setMessage({ tone: "error", text: lastError.current ?? "PayPal reported an error. Nothing was charged." });
          },
        });
        return buttons.render(container.current);
      })
      .catch(() => {
        if (!cancelled) setMessage({ tone: "error", text: "Could not load PayPal. Check your connection and reload the page." });
      });
    return () => {
      cancelled = true;
      void buttons?.close?.().catch(() => undefined);
    };
  }, [attemptId, clientId, router]);

  if (!clientId) {
    return (
      <div className="space-y-2">
        <button type="button" className={btn.primary} disabled>
          Pay ${total} with PayPal
        </button>
        <p className="text-xs text-[var(--muted)]">
          PayPal checkout is not configured on this server yet (sandbox keys missing — see /setup). No payment can be taken.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-sm space-y-3">
      <p className="text-sm">
        Pay <strong>${total} USD</strong> in PayPal (sandbox). You approve the payment in PayPal; CartWitness confirms it with PayPal before issuing your
        Passport.
      </p>
      <div ref={container} aria-busy={busy} className={busy ? "pointer-events-none opacity-60" : undefined} />
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "error" ? "bg-red-50 text-red-800" : "bg-[var(--surface-2)]"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
