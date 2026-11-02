export function CheckList({ checks }: { checks: { label: string; ok: boolean }[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {checks.map((c) => (
        <li key={c.label} className={`flex items-start gap-2 ${c.ok ? "text-emerald-800" : "text-red-700"}`}>
          <span aria-hidden className="font-bold">
            {c.ok ? "✓" : "✗"}
          </span>
          <span>
            {c.label}
            <span className="sr-only">{c.ok ? " — passed" : " — failed"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
