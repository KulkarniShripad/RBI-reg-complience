// The feedback card (section 6). Both groups see the same numbers in the same
// size; Group B also sees the Strong / Work on / Tip lines and the topic row.

import { TOPIC_IDS, type Content, type TopicId } from '../content/types';
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
      <span aria-hidden className={cx('flex-none font-semibold', symbolColor(head, c))}>
        {head}
      </span>
      <span>
        <RichText text={text.slice(space + 1)} />
      </span>
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
        <RichText text={fill(L.score, { score: fb.blockScore, total: c.config.questionsPerBlock, beatsPct: fb.beatsPct })} />
      </p>
      <p>{fb.profileLine}</p>
      {showGroupB && (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <SymbolLine text={fb.strong ? conceptLine(L.strong, fb.strong.topic, fb.strong.type, c) : L.strongNone} c={c} />
          <SymbolLine text={fb.workOn ? conceptLine(L.workOn, fb.workOn.topic, fb.workOn.type, c) : L.workOnNone} c={c} />
          {fb.tip && fb.workOn && <SymbolLine text={tipLine(fb.workOn.topic, fb.workOn.type, c)} c={c} />}
          {fb.topicRow && <TopicRow row={fb.topicRow} c={c} />}
        </div>
      )}
      <p className="text-slate-500">{fb.encouragement}</p>
    </section>
  );
}
