// Steps 0-4: consent, profile, self-ratings, statements, how it works.

import { useState } from 'react';
import type { Content, LangId, TopicId } from '../content/types';
import { ChoiceGroup, Label, NumberField, PrimaryButton, RatingScale, Screen, Slider, Sub, Title, parseCount } from '../components/ui';
import { SCALES } from '../lib/flow';
import type { Profile, TopicRecord } from '../lib/model';

export function Consent({ c, onStart }: { c: Content; onStart: () => void }) {
  const u = c.ui.consent;
  const [agree, setAgree] = useState(false);
  const points = u.points
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <Screen footer={<PrimaryButton label={u.button} disabled={!agree} onClick={onStart} />}>
      <div className="pt-4">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-600" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </div>
        <Title>{u.title}</Title>
      </div>
      <Sub>{u.body}</Sub>
      <ul className="card divide-y divide-slate-100">
        {points.map((pt) => (
          <li key={pt} className="flex items-start gap-3 px-4 py-3.5 text-[15px] text-slate-700">
            <svg viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 flex-none text-accent-600" fill="currentColor" aria-hidden>
              <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
            </svg>
            <span>{pt}</span>
          </li>
        ))}
      </ul>
      <label className="card flex cursor-pointer items-center gap-3 px-4 py-3.5 text-[15px] font-medium text-slate-800">
        <input
          type="checkbox"
          checked={agree}
          onChange={(e) => setAgree(e.target.checked)}
          className="focus-ring h-5 w-5 flex-none rounded accent-accent-600"
        />
        <span>{u.checkbox}</span>
      </label>
    </Screen>
  );
}

export function Message({ text }: { text: string }) {
  return (
    <Screen>
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-5 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-7 w-7 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </div>
        <p className="text-[18px] font-medium leading-relaxed text-slate-800">{text}</p>
      </div>
    </Screen>
  );
}

export function ProfileScreen({ c, onDone }: { c: Content; onDone: (p: Profile) => void }) {
  const u = c.ui.profile;
  const lim = c.config.profileLimits;
  const [year, setYear] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [solved, setSolved] = useState('');
  const [streak, setStreak] = useState('');
  const [ownPct, setOwnPct] = useState(SCALES.ownPct.default);
  const [ownTouched, setOwnTouched] = useState(false);
  const [language, setLanguage] = useState<LangId | null>(null);

  const solvedN = parseCount(solved, lim.solvedCountMax);
  const streakN = parseCount(streak, lim.streakMax);
  const complete = year && platform && solvedN !== null && streakN !== null && ownTouched && language;

  return (
    <Screen
      footer={
        <PrimaryButton
          label={c.ui.question.button}
          disabled={!complete}
          onClick={() =>
            complete &&
            onDone({ year: year!, platform: platform!, solvedCount: solvedN!, streak: streakN!, ownPct, language: language! })
          }
        />
      }
    >
      <Title>{u.title}</Title>
      <div>
        <Label id="pf-year">{u.year.label}</Label>
        <ChoiceGroup labelledBy="pf-year" cols={2} options={u.year.options} value={year} onChange={setYear} />
      </div>
      <div>
        <Label id="pf-platform">{u.platform.label}</Label>
        <ChoiceGroup
          labelledBy="pf-platform"
          cols={3}
          options={u.platform.options.map((o) => ({ id: o, label: o }))}
          value={platform}
          onChange={setPlatform}
        />
      </div>
      <NumberField label={u.solvedCount} value={solved} onChange={setSolved} max={lim.solvedCountMax} />
      <NumberField label={u.streak} value={streak} onChange={setStreak} max={lim.streakMax} />
      <Slider
        label={u.ownPct}
        {...SCALES.ownPct}
        value={ownPct}
        touched={ownTouched}
        onChange={(v) => {
          setOwnPct(v);
          setOwnTouched(true);
        }}
        format={(v) => `${v}%`}
      />
      <div>
        <Label id="pf-lang">{u.language.label}</Label>
        <ChoiceGroup labelledBy="pf-lang" cols={3} options={u.language.options} value={language} onChange={setLanguage} />
      </div>
    </Screen>
  );
}

/** The 4 topic ratings (rateSelf, then rateAgain twice). */
export function TopicRatings({
  c,
  title,
  sub,
  onDone,
}: {
  c: Content;
  title: string;
  sub: string;
  onDone: (r: TopicRecord<number>) => void;
}) {
  const u = c.ui.rateSelf;
  const [r, setR] = useState<Partial<Record<TopicId, number>>>({});
  const complete = u.topics.every((t) => r[t.id] != null);
  return (
    <Screen footer={<PrimaryButton label={c.ui.question.button} disabled={!complete} onClick={() => complete && onDone(r as TopicRecord<number>)} />}>
      <div className="space-y-2">
        <Title>{title}</Title>
        <Sub>{sub}</Sub>
      </div>
      {u.topics.map((t) => (
        <div key={t.id} className="card p-4">
          <RatingScale
            label={t.label}
            min={c.config.rating.min}
            max={c.config.rating.max}
            low={u.low}
            high={u.high}
            value={r[t.id] ?? null}
            onChange={(v) => setR((prev) => ({ ...prev, [t.id]: v }))}
          />
        </div>
      ))}
    </Screen>
  );
}

export function Statements({
  c,
  onDone,
}: {
  c: Content;
  onDone: (statements: Record<string, number>, rankGuessStart: number, scoreGuessStart: number) => void;
}) {
  const u = c.ui.statements;
  const [g, setG] = useState<Record<string, number>>({});
  const [rank, setRank] = useState(SCALES.rank.default);
  const [rankTouched, setRankTouched] = useState(false);
  const [score, setScore] = useState<number | null>(null);
  const complete = u.items.every((it) => g[it.id] != null) && rankTouched && score !== null;
  const scores = Array.from({ length: c.config.questionsPerBlock + 1 }, (_, i) => ({ id: i, label: String(i) }));
  return (
    <Screen footer={<PrimaryButton label={c.ui.question.button} disabled={!complete} onClick={() => complete && onDone(g, rank, score!)} />}>
      <Title>{u.title}</Title>
      {u.items.map((it) => (
        <div key={it.id} className="card p-4">
          <RatingScale
            label={it.text}
            min={c.config.rating.min}
            max={c.config.rating.max}
            low={u.low}
            high={u.high}
            value={g[it.id] ?? null}
            onChange={(v) => setG((prev) => ({ ...prev, [it.id]: v }))}
          />
        </div>
      ))}
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
      <div className="card p-4">
        <Label id="st-score">{u.scoreGuess}</Label>
        <ChoiceGroup labelledBy="st-score" cols={9} compact options={scores} value={score} onChange={setScore} />
      </div>
    </Screen>
  );
}

export function HowItWorks({ c, onBegin }: { c: Content; onBegin: () => void }) {
  const u = c.ui.howItWorks;
  return (
    <Screen footer={<PrimaryButton label={u.button} onClick={onBegin} />}>
      <div className="pt-4">
        <Title>{u.title}</Title>
      </div>
      <div className="card divide-y divide-slate-100 text-[16px] text-slate-700">
        <p className="flex items-start gap-3 p-4">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none text-accent-600" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M4 15a8 8 0 0116 0" />
            <path d="M12 15l4-5" />
          </svg>
          {u.line}
        </p>
        <p className="flex items-start gap-3 p-4">
          <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none text-accent-600" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
          </svg>
          {u.langNote}
        </p>
      </div>
    </Screen>
  );
}
