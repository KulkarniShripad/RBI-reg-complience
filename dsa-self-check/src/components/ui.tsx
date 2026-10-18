// Shared building blocks. No study text lives here: every label is passed in
// from the content files.

import { useId, type ReactNode } from 'react';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/** Page column plus the primary button, fixed to the bottom on mobile. */
export function Screen({ children, footer, wide }: { children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <>
      <main className={cx('fade-in mx-auto px-4 pb-32 pt-7 md:pb-12', wide ? 'max-w-[480px] md:max-w-[760px]' : 'max-w-[480px]')}>
        <div className="space-y-5">{children}</div>
        {footer && (
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white md:static md:mt-7 md:border-0 md:bg-transparent">
            <div className={cx('mx-auto px-4 py-3 md:p-0', wide ? 'max-w-[480px] md:max-w-[760px]' : 'max-w-[480px]')} style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
              {footer}
            </div>
          </div>
        )}
      </main>
    </>
  );
}

export function Title({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h1 id={id} className="text-[22px] font-semibold leading-snug tracking-tight text-slate-900">
      {children}
    </h1>
  );
}

export function Sub({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-slate-600">{children}</p>;
}

export function Label({ children, id, htmlFor }: { children: ReactNode; id?: string; htmlFor?: string }) {
  return (
    <label id={id} htmlFor={htmlFor} className="mb-2 block text-[15px] font-medium leading-snug text-slate-800">
      {children}
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('card p-4', className)}>{children}</section>;
}

/**
 * Primary action. While `progressMs` is set the button is locked and a bar fills
 * across it, so a minimum viewing time needs no extra text.
 */
export function PrimaryButton({
  label,
  disabled,
  onClick,
  progressMs,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  progressMs?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'focus-ring relative h-12 w-full overflow-hidden rounded-xl text-[16px] font-semibold transition-colors',
        disabled ? 'cursor-not-allowed bg-slate-200 text-slate-500' : 'bg-accent-600 text-white hover:bg-accent-700 active:bg-accent-700',
      )}
    >
      {progressMs ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-slate-300"
          style={{ animation: `fill-bar ${progressMs}ms linear forwards` }}
        />
      ) : null}
      <span className="relative">{label}</span>
    </button>
  );
}

export interface ChoiceOption<T extends string | number> {
  id: T;
  label: ReactNode;
}

/** Full-width (or grid) single-choice buttons. */
export function ChoiceGroup<T extends string | number>({
  options,
  value,
  onChange,
  cols = 1,
  labelledBy,
  mono,
  compact,
}: {
  options: ChoiceOption<T>[];
  value: T | null;
  onChange: (v: T) => void;
  cols?: number;
  labelledBy?: string;
  mono?: boolean;
  compact?: boolean;
}) {
  const grid: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    5: 'grid-cols-5',
    6: 'grid-cols-6',
    7: 'grid-cols-7',
    8: 'grid-cols-8',
    9: 'grid-cols-9',
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={cx('grid', grid[cols] ?? 'grid-cols-1', compact ? 'gap-1' : 'gap-2')}>
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.id)}
            className={cx(
              'focus-ring min-h-[48px] rounded-xl border text-[15px] leading-snug transition-colors',
              compact ? 'px-0 text-center font-medium' : cols === 1 ? 'flex items-center gap-3 px-4 py-3 text-left' : 'px-2 py-2 text-center',
              selected
                ? 'border-accent-600 bg-accent-50 text-accent-700 ring-1 ring-accent-600'
                : 'border-slate-200 bg-white text-slate-800 hover:border-slate-300',
            )}
          >
            {cols === 1 && !compact && (
              <span
                aria-hidden
                className={cx(
                  'flex h-5 w-5 flex-none items-center justify-center rounded-full border-2',
                  selected ? 'border-accent-600' : 'border-slate-300',
                )}
              >
                {selected && <span className="h-2.5 w-2.5 rounded-full bg-accent-600" />}
              </span>
            )}
            <span className={cx(mono && 'font-mono text-[14px] [overflow-wrap:anywhere]', 'min-w-0')}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 1-7 rating: tappable circles in a row with end labels. */
export function RatingScale({
  label,
  value,
  onChange,
  min,
  max,
  low,
  high,
}: {
  label: ReactNode;
  value: number | null;
  onChange: (v: number) => void;
  min: number;
  max: number;
  low: string;
  high: string;
}) {
  const id = useId();
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div>
      <p id={id} className="mb-2.5 text-[15px] font-medium leading-snug text-slate-800">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} className="flex justify-between gap-1 sm:gap-2">
        {values.map((v) => {
          const selected = value === v;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={String(v)}
              onClick={() => onChange(v)}
              className={cx(
                'focus-ring flex aspect-square min-w-0 max-w-[44px] flex-1 items-center justify-center rounded-full border text-[15px] font-medium transition-colors',
                selected
                  ? 'border-accent-600 bg-accent-600 text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-accent-500',
              )}
            >
              {v}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[13px] text-slate-500" aria-hidden>
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

/**
 * Confidence in one tap: one button per level (e.g. 25% Guess … 100% Certain).
 * Nothing is pre-selected, so a default can never be recorded by accident.
 */
export function ConfidencePicker({
  label,
  levels,
  names,
  value,
  onChange,
}: {
  label: ReactNode;
  levels: number[];
  names: string[];
  value: number | null;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <p id={id} className="mb-2.5 text-[15px] font-medium leading-snug text-slate-800">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}>
        {levels.map((v, i) => {
          const selected = value === v;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(v)}
              className={cx(
                'focus-ring flex min-h-[56px] flex-col items-center justify-center rounded-xl border px-1 py-1.5 transition-colors',
                selected ? 'border-accent-600 bg-accent-600 text-white' : 'border-slate-200 bg-white text-slate-800 hover:border-accent-500',
              )}
            >
              <span className="text-[16px] font-semibold tabular-nums leading-tight">{v}%</span>
              <span className={cx('text-[12px] leading-tight', selected ? 'text-accent-100' : 'text-slate-500')}>{names[i]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
}) {
  const id = useId();
  const invalid = value !== '' && parseCount(value, max) === null;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        aria-invalid={invalid}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, String(max).length))}
        className={cx(
          'focus-ring h-12 w-full rounded-xl border bg-white px-4 text-[16px] tabular-nums text-slate-900',
          invalid ? 'border-red-500' : 'border-slate-300 focus:border-accent-500',
        )}
      />
    </div>
  );
}

/** Parses a whole number in [0, max]; null if empty or out of range. */
export function parseCount(raw: string, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 0 && n <= max ? n : null;
}
