// Steps 3 and 7: one question per screen (with right/wrong feedback after each answer in the
// blocks listed in config.questionFeedbackBlocks), then the block-end guess.

import { useEffect, useRef, useState } from 'react';
import type { Content, LangId, Question } from '../content/types';
import { CodeBlock } from '../components/CodeBlock';
import { SymbolLine } from '../components/FeedbackCard';
import { LanguageTabs } from '../components/LanguageTabs';
import { ChoiceGroup, ConfidencePicker, Label, PrimaryButton, Screen, cx } from '../components/ui';
import type { Answer, PlannedQuestion } from '../lib/model';
import { fill, langText } from '../lib/util';

/** Stem, language tabs and code: shared by the question and its review. */
function StemAndCode({ c, q, lang, onLang }: { c: Content; q: Question; lang: LangId; onLang: (l: LangId) => void }) {
  const perLang = q.code !== null || q.options.some((o) => typeof o.text !== 'string');
  const langLabel = c.questions.languages.find((l) => l.id === lang)?.label ?? lang;
  return (
    <>
      <p className="whitespace-pre-line text-[16px] font-medium leading-relaxed text-slate-900">{q.stem}</p>
      {perLang && (
        <div className="space-y-2">
          <LanguageTabs languages={c.questions.languages} value={lang} onChange={onLang} />
          {q.code && <CodeBlock code={q.code[lang]} lang={lang} blank={c.questions.blank} showLineNumbers={q.showLineNumbers} label={langLabel} />}
        </div>
      )}
    </>
  );
}

/** Counts how often and how long the page is hidden (tab or app switch) while mounted. */
function useAwayTracker() {
  const away = useRef({ count: 0, ms: 0, since: 0 });
  useEffect(() => {
    const onVis = () => {
      const a = away.current;
      if (document.visibilityState === 'hidden') {
        a.count += 1;
        a.since = performance.now();
      } else if (a.since) {
        a.ms += performance.now() - a.since;
        a.since = 0;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  return () => ({ awayCount: away.current.count, awayMs: Math.round(away.current.ms) });
}

export function QuestionScreen({
  c,
  q,
  planned,
  position,
  lang,
  onLang,
  onSubmit,
}: {
  c: Content;
  q: Question;
  planned: PlannedQuestion;
  position: number;
  lang: LangId;
  onLang: (l: LangId) => void;
  onSubmit: (a: Answer) => void;
}) {
  const u = c.ui.question;
  const [chosen, setChosen] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const switches = useRef(0);
  const shownAt = useRef(performance.now());
  const submitted = useRef(false);
  const confRef = useRef<HTMLDivElement>(null);
  const awayNow = useAwayTracker();

  const byId = Object.fromEntries(q.options.map((o) => [o.id, o]));

  // Bring the confidence buttons into view the first time they appear.
  const hasChoice = chosen !== null;
  useEffect(() => {
    if (hasChoice) confRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [hasChoice]);

  const submit = () => {
    if (!chosen || confidence === null || submitted.current) return;
    submitted.current = true;
    onSubmit({
      qid: q.id,
      topic: q.topic,
      type: q.type,
      position,
      optionOrder: planned.optionOrder,
      chosen,
      correct: chosen === q.correct,
      confidence,
      timeMs: Math.round(performance.now() - shownAt.current),
      ...awayNow(),
      langAtAnswer: lang,
      langSwitches: switches.current,
    });
  };

  return (
    <Screen footer={<PrimaryButton label={u.button} disabled={!chosen || confidence === null} onClick={submit} />}>
      <p className="text-[14px] font-medium text-slate-500">
        {fill(u.counter, { n: position, total: c.config.questionsPerBlock })}
      </p>
      <StemAndCode
        c={c}
        q={q}
        lang={lang}
        onLang={(l) => {
          switches.current += 1;
          onLang(l);
        }}
      />
      <ChoiceGroup
        options={planned.optionOrder.map((id) => ({ id, label: langText(byId[id].text, lang) }))}
        value={chosen}
        onChange={setChosen}
        mono={q.type === 'complete'}
      />
      {hasChoice && (
        <div ref={confRef} className="card fade-in scroll-mb-28 p-4">
          <ConfidencePicker
            label={u.confidence}
            levels={c.config.confidence.levels}
            names={u.confLevels}
            value={confidence}
            onChange={setConfidence}
          />
        </div>
      )}
    </Screen>
  );
}

/**
 * Shown after Continue in a block with per-question feedback: right / wrong, the running
 * score (and Group B's topic line and tip) on top, then the question with the right option marked.
 */
export function QuestionReview({
  c,
  q,
  answer,
  position,
  lines,
  lang,
  onLang,
  onNext,
}: {
  c: Content;
  q: Question;
  answer: Answer;
  position: number;
  /** From questionFeedbackLines(): verdict, score so far, then any Group B lines. */
  lines: string[];
  lang: LangId;
  onLang: (l: LangId) => void;
  onNext: (feedbackMs: number) => void;
}) {
  const u = c.ui.questionFeedback;
  const sym = c.feedback.symbols;
  const shownAt = useRef(performance.now());
  const done = useRef(false);
  const byId = Object.fromEntries(q.options.map((o) => [o.id, o]));
  const [verdict, soFar, concept, tip] = lines;
  const next = () => {
    if (done.current) return;
    done.current = true;
    onNext(Math.round(performance.now() - shownAt.current));
  };
  return (
    <Screen footer={<PrimaryButton label={u.button} onClick={next} />}>
      <p className="text-[14px] font-medium text-slate-500">
        {fill(c.ui.question.counter, { n: position, total: c.config.questionsPerBlock })}
      </p>
      <section
        role="status"
        className={cx(
          'space-y-2 rounded-2xl border p-4 text-[16px] leading-snug text-slate-800',
          answer.correct ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50',
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <SymbolLine text={verdict} c={c} className="text-[19px] font-semibold text-slate-900" />
          {soFar && <SymbolLine text={soFar} c={c} className="text-[15px] text-slate-700" />}
        </div>
        {concept && (
          <div className="space-y-2 border-t border-black/5 pt-2.5">
            <SymbolLine text={concept} c={c} />
            {tip && (
              <p className="ml-6 rounded-lg bg-white/70 px-3 py-2">
                <SymbolLine text={tip} c={c} />
              </p>
            )}
          </div>
        )}
      </section>
      <StemAndCode c={c} q={q} lang={lang} onLang={onLang} />
      <ul className="grid gap-2">
        {answer.optionOrder.map((id) => {
          const isRight = id === q.correct;
          const isPicked = id === answer.chosen;
          return (
            <li
              key={id}
              className={cx(
                'flex min-h-[48px] items-center gap-3 rounded-xl border px-4 py-3 text-[15px] leading-snug',
                isRight
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-900 ring-1 ring-emerald-500'
                  : isPicked
                    ? 'border-red-400 bg-red-50 text-red-900'
                    : 'border-slate-200 bg-white text-slate-500',
              )}
            >
              <span className={cx('w-5 flex-none text-center font-semibold', isRight ? 'text-emerald-600' : 'text-red-600')}>
                {isRight ? sym.strong : isPicked ? sym.weak : ''}
              </span>
              <span className={cx('min-w-0', q.type === 'complete' && 'font-mono text-[14px] [overflow-wrap:anywhere]')}>
                {langText(byId[id].text, lang)}
              </span>
            </li>
          );
        })}
      </ul>
    </Screen>
  );
}

export function BlockEnd({ c, onDone }: { c: Content; onDone: (scoreGuess: number) => void }) {
  const n = c.config.questionsPerBlock;
  const [score, setScore] = useState<number | null>(null);
  const scores = Array.from({ length: n + 1 }, (_, i) => ({ id: i, label: String(i) }));
  return (
    <Screen footer={<PrimaryButton label={c.ui.question.button} disabled={score === null} onClick={() => score !== null && onDone(score)} />}>
      <div className="card p-4">
        <Label id="be-score">{fill(c.ui.blockEnd.scoreGuess, { n })}</Label>
        <ChoiceGroup labelledBy="be-score" cols={n + 1 <= 9 ? n + 1 : 1} compact options={scores} value={score} onChange={setScore} />
      </div>
    </Screen>
  );
}
