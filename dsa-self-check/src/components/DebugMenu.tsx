// Testers only (?debug=1): jump to any step and see the session's assignment.

import { useState } from 'react';
import { cx } from './ui';

export function DebugMenu<S extends string>({
  steps,
  current,
  info,
  onJump,
  onReset,
}: {
  steps: readonly S[];
  current: S;
  info: Record<string, string>;
  onJump?: (s: S) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fixed bottom-24 left-2 z-50 md:bottom-4">
      {open && (
        <div className="mb-2 max-h-[70vh] w-60 overflow-y-auto rounded-xl border border-slate-300 bg-white p-2 text-[12px] text-slate-700">
          <dl className="mb-2 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 border-b border-slate-100 pb-2 font-mono">
            {Object.entries(info).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-slate-400">{k}</dt>
                <dd className="truncate" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
          {onJump ? (
            <ol>
              {steps.map((s, i) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onJump(s);
                    }}
                    className={cx('w-full rounded px-2 py-1 text-left font-mono hover:bg-slate-100', s === current && 'bg-accent-50 text-accent-700')}
                  >
                    {i} {s}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-2 py-1 text-slate-500">Press Start to enable step jumps.</p>
          )}
          <button type="button" onClick={onReset} className="mt-2 w-full rounded border border-red-200 px-2 py-1.5 text-red-700 hover:bg-red-50">
            Reset session (new participant)
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-[12px] text-slate-700"
      >
        debug
      </button>
    </div>
  );
}
