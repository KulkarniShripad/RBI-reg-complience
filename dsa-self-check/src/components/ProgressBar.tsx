export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className="fixed inset-x-0 top-0 z-30 h-1 bg-slate-200"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className="h-full bg-accent-600 transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SavingPill({ text }: { text: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-40 flex justify-center" role="status" aria-live="polite">
      <span className="fade-in flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-[14px] text-slate-700">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-accent-600" aria-hidden />
        {text}
      </span>
    </div>
  );
}
