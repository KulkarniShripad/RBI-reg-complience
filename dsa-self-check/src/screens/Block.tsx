// Steps 5 and 8: one question per screen, then the block-end guesses.

import { useEffect, useRef, useState } from 'react';
import type { Content, LangId, Question } from '../content/types';
import { CodeBlock } from '../components/CodeBlock';
import { LanguageTabs } from '../components/LanguageTabs';
import { ChoiceGroup, Label, PrimaryButton, Screen, Slider } from '../components/ui';
import { SCALES } from '../lib/flow';
import type { Answer, PlannedQuestion } from '../lib/model';
import { fill, langText } from '../lib/util';

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
  const conf = c.config.confidence;
  const [chosen, setChosen] = useState<string | null>(null);
  const [confidence, setConfidence] = useState(conf.default);
  const [touched, setTouched] = useState(false);
  const switches = useRef(0);
  const shownAt = useRef(performance.now());
  const submitted = useRef(false);
  const sliderRef = useRef<HTMLDivElement>(null);

  const byId = Object.fromEntries(q.options.map((o) => [o.id, o]));
  const perLang = q.code !== null || q.options.some((o) => typeof o.text !== 'string');
  const langLabel = c.questions.languages.find((l) => l.id === lang)?.label ?? lang;

  // Bring the confidence slider into view the first time it appears.
  const hasChoice = chosen !== null;
  useEffect(() => {
    if (hasChoice) sliderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [hasChoice]);

  const submit = () => {
    if (!chosen || !touched || submitted.current) return;
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
      langAtAnswer: lang,
      langSwitches: switches.current,
    });
  };

  return (
    <Screen footer={<PrimaryButton label={u.button} disabled={!chosen || !touched} onClick={submit} />}>
      <p className="text-[14px] font-medium text-slate-500">
        {fill(u.counter, { n: position, total: c.config.questionsPerBlock })}
      </p>
      <p className="whitespace-pre-line text-[16px] font-medium leading-relaxed text-slate-900">{q.stem}</p>
      {perLang && (
        <div className="space-y-2">
          <LanguageTabs
            languages={c.questions.languages}
            value={lang}
            onChange={(l) => {
              switches.current += 1;
              onLang(l);
            }}
          />
          {q.code && <CodeBlock code={q.code[lang]} lang={lang} blank={c.questions.blank} showLineNumbers={q.showLineNumbers} label={langLabel} />}
        </div>
      )}
      <ChoiceGroup
        options={planned.optionOrder.map((id) => ({ id, label: langText(byId[id].text, lang) }))}
        value={chosen}
        onChange={setChosen}
        mono={q.type === 'complete'}
      />
      {hasChoice && (
        <div ref={sliderRef} className="card fade-in scroll-mb-28 p-4">
          <Slider
            label={u.confidence}
            min={conf.min}
            max={conf.max}
            step={conf.step}
            value={confidence}
            touched={touched}
            onChange={(v) => {
              setConfidence(v);
              setTouched(true);
            }}
            format={(v) => `${v}%`}
            low={u.confLow}
            high={u.confHigh}
          />
        </div>
      )}
    </Screen>
  );
}

export function BlockEnd({ c, onDone }: { c: Content; onDone: (scoreGuess: number, rankGuess: number) => void }) {
  const u = c.ui.blockEnd;
  const [score, setScore] = useState<number | null>(null);
  const [rank, setRank] = useState(SCALES.rank.default);
  const [rankTouched, setRankTouched] = useState(false);
  const scores = Array.from({ length: c.config.questionsPerBlock + 1 }, (_, i) => ({ id: i, label: String(i) }));
  const complete = score !== null && rankTouched;
  return (
    <Screen footer={<PrimaryButton label={c.ui.question.button} disabled={!complete} onClick={() => complete && onDone(score!, rank)} />}>
      <div className="card p-4">
        <Label id="be-score">{u.scoreGuess}</Label>
        <ChoiceGroup labelledBy="be-score" cols={9} compact options={scores} value={score} onChange={setScore} />
      </div>
      <div className="card p-4">
        <Slider
          label={u.rankGuess}
          {...SCALES.rank}
          value={rank}
          touched={rankTouched}
          onChange={(v) => {
            setRank(v);
            setRankTouched(true);
          }}
        />
      </div>
    </Screen>
  );
}
