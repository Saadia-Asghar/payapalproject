"use client";
import { useRouter } from "next/navigation";
import { apiCall } from "./api-client";
import { PasskeyApproveButton } from "./PasskeyApproveButton";

export function CartApproveButton({ attemptId, cartHash, total, hasPasskey }: { attemptId: string; cartHash: string; total: string; hasPasskey: boolean }) {
  const router = useRouter();
  return (
    <PasskeyApproveButton
      label={`Approve this exact cart — $${total} USD`}
      hasPasskey={hasPasskey}
      optionsUrl={`/api/carts/${attemptId}/approve/options`}
      optionsBody={{ cart_hash: cartHash }}
      onApprove={async (passkey) => {
        await apiCall(`/api/carts/${attemptId}/approve`, "POST", { cart_hash: cartHash, passkey });
        router.refresh();
      }}
    />
  );
}
