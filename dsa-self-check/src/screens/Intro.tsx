// Steps 0-2: consent, profile, "before you start" (topic ratings, belief, prediction),
// plus the topic re-rating used after the first feedback.

import { useState } from 'react';
import type { Content, LangId, TopicId } from '../content/types';
import { ChoiceGroup, Label, NumberField, PrimaryButton, RatingScale, Screen, Sub, Title, parseCount } from '../components/ui';
import type { Profile, TopicRecord } from '../lib/model';
import { fill } from '../lib/util';

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
      <p className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-[15px] font-medium text-amber-900">
        <svg viewBox="0 0 24 24" className="mt-0.5 h-5 w-5 flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7l8-4z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
        <span>{u.honesty}</span>
      </p>
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
  const [ownPct, setOwnPct] = useState<string | null>(null);
  const [language, setLanguage] = useState<LangId | null>(null);

  const solvedN = parseCount(solved, lim.solvedCountMax);
  const streakN = parseCount(streak, lim.streakMax);
  const complete = year && platform && solvedN !== null && streakN !== null && ownPct && language;

  return (
    <Screen
      footer={
        <PrimaryButton
          label={c.ui.question.button}
          disabled={!complete}
          onClick={() =>
            complete &&
            onDone({ year: year!, platform: platform!, solvedCount: solvedN!, streak: streakN!, ownPct: ownPct!, language: language! })
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
      <div className="grid grid-cols-2 gap-3">
        <NumberField label={u.solvedCount} value={solved} onChange={setSolved} max={lim.solvedCountMax} />
        <NumberField label={u.streak} value={streak} onChange={setStreak} max={lim.streakMax} />
      </div>
      <div>
        <Label id="pf-own">{u.ownPct.label}</Label>
        <ChoiceGroup labelledBy="pf-own" cols={2} options={u.ownPct.options} value={ownPct} onChange={setOwnPct} />
      </div>
      <div>
        <Label id="pf-lang">{u.language.label}</Label>
        <ChoiceGroup labelledBy="pf-lang" cols={3} options={u.language.options} value={language} onChange={setLanguage} />
      </div>
    </Screen>
  );
}

function TopicRatingCards({
  c,
  value,
  onChange,
}: {
  c: Content;
  value: Partial<TopicRecord<number>>;
  onChange: (t: TopicId, v: number) => void;
}) {
  const b = c.ui.before;
  return (
    <>
      {c.ui.topics.map((t) => (
        <div key={t.id} className="card p-4">
          <RatingScale
            label={t.label}
            min={c.config.rating.min}
            max={c.config.rating.max}
            low={b.low}
            high={b.high}
            value={value[t.id] ?? null}
            onChange={(v) => onChange(t.id, v)}
          />
        </div>
      ))}
    </>
  );
}

/** Topic self-ratings, belief in the solved count, and a score prediction, all on one screen. */
export function BeforeScreen({
  c,
  onDone,
}: {
  c: Content;
  onDone: (ratings: TopicRecord<number>, belief: number, scoreGuess: number) => void;
}) {
  const b = c.ui.before;
  const [r, setR] = useState<Partial<TopicRecord<number>>>({});
  const [belief, setBelief] = useState<number | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const n = c.config.questionsPerBlock;
  const scores = Array.from({ length: n + 1 }, (_, i) => ({ id: i, label: String(i) }));
  const complete = c.topics.every((t) => r[t] != null) && belief !== null && score !== null;
  return (
    <Screen
      footer={
        <PrimaryButton label={c.ui.question.button} disabled={!complete} onClick={() => complete && onDone(r as TopicRecord<number>, belief!, score!)} />
      }
    >
      <div className="space-y-2">
        <Title>{b.title}</Title>
        <Sub>{b.ratingQ}</Sub>
      </div>
      <TopicRatingCards c={c} value={r} onChange={(t, v) => setR((prev) => ({ ...prev, [t]: v }))} />
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
        <Label id="bf-score">{fill(b.scoreGuess, { n })}</Label>
        <ChoiceGroup labelledBy="bf-score" cols={n + 1 <= 9 ? n + 1 : 1} compact options={scores} value={score} onChange={setScore} />
      </div>
    </Screen>
  );
}

/** The topic ratings again (after the first feedback). */
export function TopicRatings({ c, onDone }: { c: Content; onDone: (r: TopicRecord<number>) => void }) {
  const u = c.ui.rateAgain;
  const [r, setR] = useState<Partial<TopicRecord<number>>>({});
  const complete = c.topics.every((t) => r[t] != null);
  return (
    <Screen footer={<PrimaryButton label={c.ui.question.button} disabled={!complete} onClick={() => complete && onDone(r as TopicRecord<number>)} />}>
      <div className="space-y-2">
        <Title>{u.title}</Title>
        <Sub>{u.sub}</Sub>
      </div>
      <TopicRatingCards c={c} value={r} onChange={(t, v) => setR((prev) => ({ ...prev, [t]: v }))} />
    </Screen>
  );
}
