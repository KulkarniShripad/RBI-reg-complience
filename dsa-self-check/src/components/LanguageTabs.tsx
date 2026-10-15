import type { LangId } from '../content/types';
import { cx } from './ui';

export function LanguageTabs({
  languages,
  value,
  onChange,
}: {
  languages: { id: LangId; label: string }[];
  value: LangId;
  onChange: (l: LangId) => void;
}) {
  return (
    <div role="tablist" className="flex rounded-xl bg-slate-100 p-1">
      {languages.map((l) => {
        const selected = l.id === value;
        return (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => !selected && onChange(l.id)}
            className={cx(
              'focus-ring h-10 flex-1 rounded-lg text-[14px] font-medium transition-colors',
              selected ? 'border border-slate-200 bg-white text-accent-700' : 'text-slate-600 hover:text-slate-900',
            )}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
