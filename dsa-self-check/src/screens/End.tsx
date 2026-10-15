// Steps 7/9 (feedback screens) and 10-14: end ratings, pack, close, report, preference.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TOPIC_IDS, type Content, type PackType, type TopicId } from '../content/types';
import { FeedbackCard, TopicRow } from '../components/FeedbackCard';
import { ChoiceGroup, Label, PrimaryButton, RatingScale, Screen, Sub, Title, cx } from '../components/ui';
import { groupBExtras, reportTopicRow } from '../lib/feedback';
import type { CloseAnswers, FeedbackData, Group, Participant, Preference } from '../lib/model';
import { fill, shuffle, slugTitle } from '../lib/util';

export function FeedbackScreen({
  c,
  block,
  fb,
  group,
  minMs,
  onDone,
}: {
  c: Content;
  block: number;
  fb: FeedbackData;
  group: Group;
  minMs: number;
  onDone: (timeOnScreenMs: number) => void;
}) {
  const shown = useRef(performance.now());
  const [ready, setReady] = useState(minMs <= 0);
  useEffect(() => {
    if (minMs <= 0) return;
    const t = setTimeout(() => setReady(true), minMs);
    return () => clearTimeout(t);
  }, [minMs]);
  return (
    <Screen
      footer={
        <PrimaryButton
          label={c.ui.question.button}
          disabled={!ready}
          progressMs={ready ? undefined : minMs}
          onClick={() => ready && onDone(Math.round(performance.now() - shown.current))}
        />
      }
    >
      <FeedbackCard fb={fb} block={block} showGroupB={group === 'B'} c={c} />
    </Screen>
  );
}

export function EndRatings({
  c,
  onDone,
}: {
  c: Content;
  onDone: (items: Record<string, number>, order: string[]) => void;
}) {
  const u = c.ui.endRatings;
  const [items] = useState(() => shuffle(u.items));
  const [v, setV] = useState<Record<string, number>>({});
  const complete = items.every((it) => v[it.id] != null);
  return (
    <Screen
      footer={
        <PrimaryButton
          label={c.ui.question.button}
          disabled={!complete}
          onClick={() => complete && onDone(v, items.map((it) => it.id))}
        />
      }
    >
      <Title>{u.title}</Title>
      {items.map((it) => (
        <div key={it.id} className="card p-4">
          <RatingScale
            label={it.text}
            min={c.config.rating.min}
            max={c.config.rating.max}
            low={u.low}
            high={u.high}
            value={v[it.id] ?? null}
            onChange={(n) => setV((prev) => ({ ...prev, [it.id]: n }))}
          />
        </div>
      ))}
    </Screen>
  );
}

export function Pack({ c, onDone }: { c: Content; onDone: (topic: TopicId, type: PackType) => void }) {
  const u = c.ui.pack;
  const [topic, setTopic] = useState<TopicId | null>(null);
  const [type, setType] = useState<PackType | null>(null);
  return (
    <Screen
      footer={
        <PrimaryButton label={c.ui.question.button} disabled={!topic || !type} onClick={() => topic && type && onDone(topic, type)} />
      }
    >
      <div className="space-y-2">
        <Title>{u.title}</Title>
        <Sub>{u.sub}</Sub>
      </div>
      <div>
        <Label id="pk-topic">{u.topicLabel}</Label>
        <ChoiceGroup labelledBy="pk-topic" options={c.ui.rateSelf.topics} value={topic} onChange={setTopic} />
      </div>
      <ChoiceGroup<PackType>
        options={[
          { id: 'easy', label: u.easy },
          { id: 'medium', label: u.medium },
        ]}
        value={type}
        onChange={setType}
      />
    </Screen>
  );
}

export function Close({ c, group, onDone }: { c: Content; group: Group; onDone: (a: CloseAnswers) => void }) {
  const u = c.ui.close;
  const isB = group === 'B';
  const [m1, setM1] = useState<string | null>(null);
  const [m2, setM2] = useState<string | null>(null);
  const [o1, setO1] = useState<number | null>(null);
  const [o2, setO2] = useState<string | null>(null);
  const [o3, setO3] = useState<number | null>(null);
  const complete = (!isB || m1) && m2 && o1 !== null && o2 && o3 !== null;
  const { min, max } = c.config.rating;
  return (
    <Screen
      footer={
        <PrimaryButton
          label={c.ui.question.button}
          disabled={!complete}
          onClick={() => complete && onDone({ M1: isB ? m1 : null, M2: m2!, O1: o1!, O2: o2!, O3: o3! })}
        />
      }
    >
      <Title>{u.title}</Title>
      {isB && (
        <div className="card p-4">
          <Label id="cl-m1">{u.M1.text}</Label>
          <ChoiceGroup
            labelledBy="cl-m1"
            options={[
              ...TOPIC_IDS.map((t) => ({ id: t as string, label: c.feedback.topics[t].name })),
              { id: 'dontRemember', label: u.M1.dontRemember },
            ]}
            value={m1}
            onChange={setM1}
          />
        </div>
      )}
      <div className="card p-4">
        <Label id="cl-m2">{u.M2.text}</Label>
        <ChoiceGroup labelledBy="cl-m2" options={u.M2.options.filter((o) => isB || !o.groupBOnly)} value={m2} onChange={setM2} />
      </div>
      <div className="card p-4">
        <RatingScale label={u.O1.text} min={min} max={max} low={u.O1.low} high={u.O1.high} value={o1} onChange={setO1} />
      </div>
      <div className="card p-4">
        <Label id="cl-o2">{u.O2.text}</Label>
        <ChoiceGroup labelledBy="cl-o2" options={u.O2.options} value={o2} onChange={setO2} />
      </div>
      <div className="card p-4">
        <RatingScale label={u.O3.text} min={min} max={max} low={u.O3.low} high={u.O3.high} value={o3} onChange={setO3} />
      </div>
    </Screen>
  );
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mb-2.5 text-[17px] font-semibold text-slate-900">{children}</h2>;
}

export function Report({
  c,
  p,
  withdrawn,
  onWithdraw,
  onContinue,
}: {
  c: Content;
  p: Participant;
  withdrawn: boolean;
  onWithdraw: () => void;
  onContinue: () => void;
}) {
  const u = c.ui.report;
  const blocks = [p.block1, p.block2];
  const answers = [...(p.block1?.answers ?? []), ...(p.block2?.answers ?? [])];
  const row = reportTopicRow(answers, c);
  const pack = p.packType && p.packTopic ? c.packs[p.packType][p.packTopic] : [];
  const conf = [p.derived?.meanConf1, p.derived?.meanConf2];
  return (
    <Screen footer={withdrawn ? undefined : <PrimaryButton label={c.ui.question.button} onClick={onContinue} />}>
      <Title>{u.title}</Title>
      <section className="card space-y-2 p-4 text-[15px] leading-relaxed text-slate-800">
        {blocks.map((b, i) =>
          b ? (
            <p key={i}>
              {fill(u.blockLine, {
                block: i + 1,
                guess: b.scoreGuess ?? '–',
                score: b.score ?? b.answers.filter((a) => a.correct).length,
                conf: conf[i] != null ? Math.round(conf[i]!) : '–',
              })}
            </p>
          ) : null,
        )}
      </section>
      <section className="card p-4">
        <H2>{u.topicsTitle}</H2>
        <TopicRow row={row} c={c} />
        <p className="mt-2.5 text-[13px] text-slate-500">{u.legend}</p>
      </section>
      {pack.length > 0 && (
        <section className="card p-4">
          <H2>{u.packTitle}</H2>
          <ol className="space-y-1">
            {pack.map((pr, i) => (
              <li key={pr.slug}>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-ring flex min-h-[44px] items-center gap-3 rounded-lg px-1 text-[15px] text-accent-700 hover:underline"
                >
                  <span className="w-5 flex-none text-right tabular-nums text-slate-400">{i + 1}</span>
                  <span>{slugTitle(pr.slug)}</span>
                  <svg viewBox="0 0 20 20" className="ml-auto h-4 w-4 flex-none text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="card p-4">
        <H2>{u.aboutTitle}</H2>
        <p className="text-[15px] leading-relaxed text-slate-700">{u.about}</p>
      </section>
      {withdrawn ? (
        <p className="card p-4 text-center text-[15px] font-medium text-slate-800" role="status">
          {u.withdrawn}
        </p>
      ) : (
        <button
          type="button"
          onClick={onWithdraw}
          className="focus-ring h-12 w-full rounded-xl border border-slate-300 bg-white text-[15px] font-medium text-slate-600 hover:border-red-300 hover:text-red-700"
        >
          {u.withdraw}
        </button>
      )}
    </Screen>
  );
}

/** Static mock-ups of the two feedback cards, built from this participant's own Block 2. */
export function PreferenceScreen({
  c,
  p,
  onDone,
}: {
  c: Content;
  p: Participant;
  onDone: (pref: Preference) => void;
}) {
  const u = c.ui.preference;
  const [pref, setPref] = useState<Preference | null>(null);
  const label = (id: string) => u.options.find((o) => o.id === id)?.label ?? id;
  const fb = p.feedback2 ?? p.feedback1;
  const blockNo = p.feedback2 ? 2 : 1;
  const mock = useMemo(() => {
    if (!fb) return null;
    const answers = (blockNo === 2 ? p.block2 : p.block1)?.answers ?? [];
    const extras = p.group === 'B' && fb.topicRow ? fb : groupBExtras(answers, c, Math.random);
    return { ...fb, strong: extras.strong, workOn: extras.workOn, tip: extras.tip, topicRow: extras.topicRow };
  }, [fb, blockNo, p.group, p.block1, p.block2, c]);

  return (
    <Screen wide footer={<PrimaryButton label={c.ui.question.button} disabled={!pref} onClick={() => pref && onDone(pref)} />}>
      <Title>{u.title}</Title>
      {mock && (
        <div className="grid gap-4 md:grid-cols-2" aria-hidden>
          {(['A', 'B'] as const).map((g) => (
            <div key={g} className={cx('space-y-2', pref === g && 'rounded-2xl ring-2 ring-accent-600 ring-offset-4 ring-offset-slate-50')}>
              <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg bg-slate-900 px-2.5 text-[15px] font-semibold text-white">
                {label(g)}
              </span>
              <div className="pointer-events-none select-none">
                <FeedbackCard fb={mock} block={blockNo} showGroupB={g === 'B'} c={c} />
              </div>
            </div>
          ))}
        </div>
      )}
      <ChoiceGroup<Preference>
        cols={3}
        options={u.options.map((o) => ({ id: o.id as Preference, label: o.label }))}
        value={pref}
        onChange={setPref}
      />
    </Screen>
  );
}
