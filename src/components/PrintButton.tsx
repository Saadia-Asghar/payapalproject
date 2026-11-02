"use client";
import { btn } from "./ui";

export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className={btn.secondary} onClick={() => window.print()}>
      {label}
    </button>
  );
}
