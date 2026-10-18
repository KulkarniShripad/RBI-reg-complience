// The feedback card after Block 1. Both groups see the same platform-style numbers
// in the same size. Group B also sees task-level feedback built from their answers:
// a "by topic" breakdown (how am I doing), one strength, and one next step with a
// single concrete tip (where to next). No generic praise.

import type { Content, TopicId } from '../content/types';
import { conceptLine, tipLine } from '../lib/feedback';
import type { FeedbackData, TopicRecord } from '../lib/model';
import { fill } from '../lib/util';
import { cx } from './ui';

export function symbolColor(symbol: string, c: Content): string {
  const s = c.feedback.symbols;
  if (symbol === s.strong) return 'text-emerald-600';
  if (symbol === s.mid) return 'text-amber-600';
  if (symbol === s.weak) return 'text-red-600';
  return 'text-accent-600';
}

function pipColor(symbol: string, c: Content): string {
  const s = c.feedback.symbols;
  if (symbol === s.strong) return 'bg-emerald-500';
  if (symbol === s.mid) return 'bg-amber-500';
  return 'bg-red-500';
}

/** Renders **bold** markers from the content files as bold text. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.length > 4 && part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i} className="font-semibold text-slate-900">
            {part.slice(2, -2)}
          </strong>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Colours a line's leading symbol (✔ / ✘ / → …); the words always stay, so colour is never the only signal. */
export function SymbolLine({ text, c, className }: { text: string; c: Content; className?: string }) {
  const space = text.indexOf(' ');
  const head = space > 0 ? text.slice(0, space) : '';
  const isSymbol = head !== '' && !/[\p{L}\p{N}*]/u.test(head);
  if (!isSymbol)
    return (
      <p className={className}>
        <RichText text={text} />
      </p>
    );
  return (
    <p className={cx('flex gap-2', className)}>
      <span aria-hidden className={cx('w-4 flex-none text-center font-semibold', symbolColor(head, c))}>
        {head}
      </span>
      <span className="min-w-0">
        <RichText text={text.slice(space + 1)} />
      </span>
    </p>
  );
}

/** One row per topic: symbol, name, a pip per question (filled = right) and the count. */
export function TopicBreakdown({
  row,
  correct,
  perTopic,
  c,
  label,
}: {
  row: TopicRecord<string>;
  correct: TopicRecord<number>;
  perTopic: number;
  c: Content;
  label?: (t: TopicId) => string;
}) {
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
      {c.topics.map((t) => (
        <li key={t} className="flex items-center gap-2.5 px-3 py-2 text-[15px]">
          <span className={cx('w-4 flex-none text-center font-semibold', symbolColor(row[t], c))} aria-hidden>
            {row[t]}
          </span>
          <span className="min-w-0 flex-1 truncate text-slate-800">{label ? label(t) : c.feedback.topics[t].short}</span>
          <span className="flex gap-1" aria-hidden>
            {Array.from({ length: perTopic }, (_, i) => (
              <span key={i} className={cx('h-2.5 w-2.5 rounded-full', i < correct[t] ? pipColor(row[t], c) : 'bg-slate-200')} />
            ))}
          </span>
          <span className="w-9 flex-none text-right font-medium tabular-nums text-slate-700">
            {fill(c.feedback.lines.topicCount, { correct: correct[t], n: perTopic })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function FeedbackCard({
  fb,
  block,
  showGroupB,
  c,
}: {
  fb: Pick<FeedbackData, 'blockScore' | 'beatsPct' | 'profileLine' | 'strong' | 'workOn' | 'tip' | 'topicRow' | 'topicCorrect'>;
  block: number;
  showGroupB: boolean;
  c: Content;
}) {
  const L = c.feedback.lines;
  const perTopic = c.config.questionsPerBlock / c.topics.length;
  return (
    <section className="card space-y-4 p-5 text-[16px] leading-snug text-slate-800">
      <div className="space-y-1.5">
        <h2 className="text-[22px] font-semibold tracking-tight text-slate-900">{fill(L.title, { block })}</h2>
        <p className="text-[18px] text-slate-900">
          <RichText text={fill(L.score, { score: fb.blockScore, total: c.config.questionsPerBlock, beatsPct: fb.beatsPct })} />
        </p>
        <p className="text-slate-600">{fb.profileLine}</p>
      </div>
      {showGroupB && fb.topicRow && fb.topicCorrect && (
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <p className="text-[13px] font-medium uppercase tracking-wide text-slate-500">{L.byTopic}</p>
          <TopicBreakdown row={fb.topicRow} correct={fb.topicCorrect} perTopic={perTopic} c={c} />
          <div className="space-y-2">
            <SymbolLine text={fb.strong ? conceptLine(L.strong, fb.strong.topic, fb.strong.type, c) : L.strongNone} c={c} />
            <SymbolLine text={fb.workOn ? conceptLine(L.workOn, fb.workOn.topic, fb.workOn.type, c) : L.workOnNone} c={c} />
            {fb.tip && fb.workOn && (
              <p className="ml-6 rounded-lg bg-accent-50 px-3 py-2 text-slate-800">
                <RichText text={tipLine(fb.workOn.topic, fb.workOn.type, c)} />
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
