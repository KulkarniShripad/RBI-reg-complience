// The feedback card (section 6). Both groups see the same numbers in the same
// size; Group B also sees the Strong / Work on / Tip lines and the topic row.

import { TOPIC_IDS, type Content, type TopicId } from '../content/types';
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

/** Colours a line's leading symbol (✔ / ✘ / → …); the words always stay, so colour is never the only signal. */
function SymbolLine({ text, c }: { text: string; c: Content }) {
  const space = text.indexOf(' ');
  const head = space > 0 ? text.slice(0, space) : '';
  const isSymbol = head !== '' && !/[\p{L}\p{N}]/u.test(head);
  if (!isSymbol) return <p>{text}</p>;
  return (
    <p className="flex gap-2">
      <span aria-hidden className={cx('flex-none font-semibold', symbolColor(head, c))}>
        {head}
      </span>
      <span>{text.slice(space + 1)}</span>
    </p>
  );
}

export function TopicRow({ row, c }: { row: TopicRecord<string>; c: Content }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {TOPIC_IDS.map((t: TopicId) => (
        <li key={t} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[15px]">
          <span className={cx('font-semibold', symbolColor(row[t], c))}>{row[t]}</span>
          <span className="text-slate-700">{c.feedback.topics[t].short}</span>
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
  fb: Pick<FeedbackData, 'blockScore' | 'beatsPct' | 'profileLine' | 'encouragement' | 'strong' | 'workOn' | 'tip' | 'topicRow'>;
  block: number;
  showGroupB: boolean;
  c: Content;
}) {
  const L = c.feedback.lines;
  return (
    <section className="card space-y-3 p-5 text-[17px] leading-snug text-slate-800">
      <h2 className="text-[22px] font-semibold tracking-tight text-slate-900">{fill(L.title, { block })}</h2>
      <p className="font-semibold text-slate-900">
        {fill(L.score, { score: fb.blockScore, total: c.config.questionsPerBlock, beatsPct: fb.beatsPct })}
      </p>
      <p>{fb.profileLine}</p>
      {showGroupB && (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <SymbolLine text={fb.strong?.text ?? L.strongNone} c={c} />
          <SymbolLine text={fb.workOn?.text ?? L.workOnNone} c={c} />
          {fb.tip && <SymbolLine text={fb.tip} c={c} />}
          {fb.topicRow && <TopicRow row={fb.topicRow} c={c} />}
        </div>
      )}
      <p className="text-slate-500">{fb.encouragement}</p>
    </section>
  );
}
