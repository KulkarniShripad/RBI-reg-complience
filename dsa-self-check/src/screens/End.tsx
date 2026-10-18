// Step 5 (feedback screen) and steps 9-11: end survey, practice pack, report.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Content, PackType, TopicId } from '../content/types';
import { FeedbackCard, RichText, TopicBreakdown } from '../components/FeedbackCard';
import { ChoiceGroup, Label, PrimaryButton, RatingScale, Screen, Sub, Title } from '../components/ui';
import { correctByTopic, reportTopicRow } from '../lib/feedback';
import type { EndSurvey, FeedbackData, Group, Participant } from '../lib/model';
import { fill, slugTitle } from '../lib/util';

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

/** Belief in the solved count again, what they used to judge, and the seriousness check. */
export function EndSurveyScreen({ c, group, onDone }: { c: Content; group: Group; onDone: (s: EndSurvey) => void }) {
  const u = c.ui.endSurvey;
  const b = c.ui.before;
  const [belief, setBelief] = useState<number | null>(null);
  const [judged, setJudged] = useState<string | null>(null);
  const [serious, setSerious] = useState<string | null>(null);
  const complete = belief !== null && judged && serious;
  return (
    <Screen
      footer={
        <PrimaryButton
          label={c.ui.question.button}
          disabled={!complete}
          onClick={() => complete && onDone({ beliefEnd: belief!, judgedBy: judged!, serious: serious === 'yes' })}
        />
      }
    >
      <Title>{u.title}</Title>
      <div className="card p-4">
        <RatingScale
          label={b.belief}
          min={c.config.rating.min}
          max={c.config.rating.max}
          low={b.beliefLow}
          high={b.beliefHigh}
          value={belief}
          onChange={setBelief}
        />
      </div>
      <div className="card p-4">
        <Label id="es-judged">{u.judgedBy.text}</Label>
        <ChoiceGroup labelledBy="es-judged" options={u.judgedBy.options.filter((o) => group === 'B' || !o.groupBOnly)} value={judged} onChange={setJudged} />
      </div>
      <div className="card p-4">
        <Label id="es-serious">{u.serious.text}</Label>
        <ChoiceGroup labelledBy="es-serious" options={u.serious.options} value={serious} onChange={setSerious} />
      </div>
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
        <ChoiceGroup labelledBy="pk-topic" options={c.ui.topics} value={topic} onChange={setTopic} />
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
  const total = c.config.questionsPerBlock;
  const blocks = [p.block1, p.block2];
  const answers = [...(p.block1?.answers ?? []), ...(p.block2?.answers ?? [])];
  const pack = p.packType && p.packTopic ? (c.packs[p.packType][p.packTopic] ?? []) : [];
  const conf = [p.derived?.meanConf1, p.derived?.meanConf2];
  const perTopic = answers.length / c.topics.length;
  return (
    <Screen footer={withdrawn ? undefined : <PrimaryButton label={c.ui.question.button} onClick={onContinue} />}>
      <Title>{u.title}</Title>
      <section className="card space-y-2 p-4 text-[15px] leading-relaxed text-slate-800">
        {blocks.map((b, i) =>
          b ? (
            <p key={i}>
              <RichText
                text={fill(u.blockLine, {
                  block: i + 1,
                  total,
                  guess: b.scoreGuess ?? '–',
                  score: b.score ?? b.answers.filter((a) => a.correct).length,
                  conf: conf[i] != null ? Math.round(conf[i]!) : '–',
                })}
              />
            </p>
          ) : null,
        )}
      </section>
      {answers.length > 0 && (
        <section className="card p-4">
          <H2>{fill(u.topicsTitle, { n: answers.length })}</H2>
          <TopicBreakdown row={reportTopicRow(answers, c)} correct={correctByTopic(answers, c)} perTopic={perTopic} c={c} />
          <p className="mt-2.5 text-[13px] text-slate-500">{u.legend}</p>
        </section>
      )}
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
