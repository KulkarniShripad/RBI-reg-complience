// The experiment as a single-page step machine (no URL routes).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Content, LangId } from './content/types';
import { DebugMenu } from './components/DebugMenu';
import { ProgressBar, SavingPill } from './components/ProgressBar';
import { PrimaryButton, Screen } from './components/ui';
import { stratumKey } from './lib/assignment';
import { computeDerived } from './lib/derived';
import { buildFeedback, questionFeedbackLines } from './lib/feedback';
import { blockScore, debugFill, makeBlock } from './lib/flow';
import { SERVER_TIME, type Answer, type Participant, type ParticipantPatch } from './lib/model';
import {
  clearLocalSession,
  hasSavedSession,
  isDone,
  markDone,
  readFlags,
  resumeSession,
  retryForever,
  startSession,
  type Session,
} from './lib/session';
import { STEPS, progressOf, stepIndex, type StepId } from './lib/steps';
import { getStore, localMode, preloadStore } from './lib/store';
import { plain } from './lib/util';
import { BlockEnd, QuestionReview, QuestionScreen } from './screens/Block';
import { EndSurveyScreen, FeedbackScreen, Pack, Report } from './screens/End';
import { BeforeScreen, Consent, Message, ProfileScreen, TopicRatings } from './screens/Intro';

type Phase = 'boot' | 'run' | 'done';

export default function App({ c }: { c: Content }) {
  const flags = useMemo(() => readFlags(), []);
  const [phase, setPhase] = useState<Phase>(() => (isDone() ? 'done' : hasSavedSession() ? 'boot' : 'run'));
  const [session, setSession] = useState<Session | null>(null);
  const [p, setP] = useState<Participant | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSaving, setShowSaving] = useState(false);
  const [withdrawnNow, setWithdrawnNow] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const debug = flags.debug || p?.debug === true;

  const step: StepId = p ? (STEPS[p.currentStep] ?? 'profile') : 'consent';
  const finished = step === 'thanks' || withdrawnNow;

  const attach = useCallback((s: Session) => {
    setSession(s);
    setP(s.p);
    s.subscribe(setP);
  }, []);

  const onError = useCallback((err: unknown) => setLastError(err instanceof Error ? err.message : String(err)), []);

  // Resume a saved session after a reload.
  useEffect(() => {
    if (phase !== 'boot') {
      if (phase === 'run') preloadStore(c.config);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const store = await getStore(c.config);
        const res = await resumeSession(store);
        if (cancelled) return;
        if (res === 'done') setPhase('done');
        else {
          if (res) attach(res);
          setPhase('run');
        }
      } catch (err) {
        console.error(err);
        onError(err);
        clearLocalSession();
        if (!cancelled) setPhase('run');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, c.config, attach, onError]);

  // "Saving…" only when an operation takes longer than 300 ms.
  useEffect(() => {
    if (!busy) {
      setShowSaving(false);
      return;
    }
    const t = setTimeout(() => setShowSaving(true), 300);
    return () => clearTimeout(t);
  }, [busy]);

  // The back button never moves between steps.
  useEffect(() => {
    history.pushState({ dsa: true }, '', location.href);
    const onPop = () => history.pushState({ dsa: true }, '', location.href);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Warn before leaving while a session is in progress (or a write is still pending).
  useEffect(() => {
    if (!p || phase !== 'run') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if ((finished || step === 'report') && !session?.pending) return;
      e.preventDefault();
      e.returnValue = c.ui.leaveWarning;
      return c.ui.leaveWarning;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [p, phase, finished, step, session, c.ui.leaveWarning]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  const runBusy = useCallback(
    async (fn: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        console.error(err);
        onError(err);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onError],
  );

  const go = useCallback(
    (next: StepId, patch: ParticipantPatch = {}) => {
      session!.save({ ...patch, currentStep: stepIndex(next), currentStepName: next });
    },
    [session],
  );

  /** Recomputes the derived measures from the participant plus a pending patch. */
  const derive = (patch: ParticipantPatch) => computeDerived({ ...session!.p, ...patch }, c);

  // ---------- step handlers ----------

  const onStart = () =>
    runBusy(async () => {
      const store = await getStore(c.config);
      const res = await retryForever(() => startSession(store, c, flags), onError);
      if (res === 'done') setPhase('done');
      else attach(res);
    });

  /** Saves the "before you start" answers, assigns the block order and opens Block 1. */
  const onBefore = (patch: ParticipantPatch) =>
    runBusy(async () => {
      session!.save(patch);
      await session!.assignBlockOrder();
      const cur = session!.p;
      go('block1', { block1: cur.block1 ?? makeBlock(1, cur, c) });
    });

  const onLang = (lang: LangId) => session!.save({ lang });

  const withQuestionFeedback = (n: 1 | 2) => c.config.questionFeedbackBlocks.includes(n);

  const onAnswer = (n: 1 | 2, a: Answer) => {
    const key = n === 1 ? 'block1' : 'block2';
    const cur = session!.p;
    const b = cur[key]!;
    if (b.answers.some((x) => x.qid === a.qid)) return; // already answered
    const showFeedback = withQuestionFeedback(n);
    // Store exactly what the participant is about to see after this answer.
    const answer = showFeedback ? { ...a, feedbackShown: questionFeedbackLines(a, [...b.answers, a], cur.group, c).map(plain) } : a;
    const answers = [...b.answers, answer];
    const complete = answers.length >= b.plan.length;
    const block = complete ? { ...b, answers, endedAt: new Date(), score: answers.filter((x) => x.correct).length } : { ...b, answers };
    if (showFeedback) {
      session!.save({ [key]: block, lang: cur.lang, reviewing: a.qid });
      window.scrollTo(0, 0);
    } else if (complete) go(n === 1 ? 'block1End' : 'block2End', { [key]: block, lang: cur.lang });
    else {
      session!.save({ [key]: block, lang: cur.lang });
      window.scrollTo(0, 0);
    }
  };

  const onReviewNext = (n: 1 | 2, feedbackMs: number) => {
    const key = n === 1 ? 'block1' : 'block2';
    const b = session!.p[key]!;
    const qid = session!.p.reviewing;
    const block = { ...b, answers: b.answers.map((x) => (x.qid === qid ? { ...x, feedbackMs } : x)) };
    if (block.answers.length >= block.plan.length) go(n === 1 ? 'block1End' : 'block2End', { [key]: block, reviewing: null });
    else {
      session!.save({ [key]: block, reviewing: null });
      window.scrollTo(0, 0);
    }
  };

  // A finished block with nothing left to review always moves on to its block-end screen.
  const blockDone =
    (step === 'block1' || step === 'block2') &&
    p !== null &&
    !p.reviewing &&
    (() => {
      const b = step === 'block1' ? p.block1 : p.block2;
      return !!b && b.answers.length >= b.plan.length;
    })();
  useEffect(() => {
    if (blockDone && session) go(step === 'block1' ? 'block1End' : 'block2End');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockDone, session]);

  const assignGroupFromBlock1 = async () => {
    const cur = session!.p;
    const d = cur.derived ?? computeDerived(cur, c);
    const stratum = stratumKey(cur.profile?.year ?? 'unknown', d.score1 ?? 0, d.gapLabel1 ?? 'accurate', c.config);
    await session!.assignGroup(stratum);
  };

  const onBlockEnd = (n: 1 | 2, scoreGuess: number) => {
    const key = n === 1 ? 'block1' : 'block2';
    const block = { ...session!.p[key]!, scoreGuess };
    const derived = derive({ [key]: block });
    if (n === 2) {
      go('endSurvey', { block2: block, derived });
      return;
    }
    runBusy(async () => {
      session!.save({ block1: block, derived });
      await assignGroupFromBlock1();
      go('feedback1');
    });
  };

  // Build and store the Block 1 feedback when its step is reached without one (first visit).
  const fbMissing = step === 'feedback1' && p !== null && !p.feedback1;
  useEffect(() => {
    if (!fbMissing || busy || !session) return;
    runBusy(async () => {
      if (!session.p.group) await assignGroupFromBlock1();
      const cur = session.p;
      const block = cur.block1!;
      const score = blockScore(block);
      await session.recordFeedback('feedback1', block.setId, score, (beatsPct) =>
        buildFeedback({ block: 1, group: cur.group!, answers: block.answers, beatsPct, profile: cur.profile, sessionCorrect: score, rng: Math.random }, c),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbMissing, busy, session]);

  const onFeedbackDone = (timeOnScreenMs: number) => go('rateMid', { feedback1: { ...session!.p.feedback1!, timeOnScreenMs } });

  const onWithdraw = () =>
    runBusy(async () => {
      session!.save({ withdrawn: true, withdrawnAt: SERVER_TIME });
      setWithdrawnNow(true);
      await session!.flush();
      markDone();
    });

  const onFinish = () =>
    runBusy(async () => {
      go('thanks');
      await session!.flush();
      markDone();
    });

  // ---------- debug ----------

  const debugJump = (target: StepId) =>
    runBusy(async () => {
      if (!session) return;
      const idx = stepIndex(target);
      if (idx >= stepIndex('block1') && !session.p.blockOrder) await session.assignBlockOrder();
      session.save(debugFill(idx, session.p, c, (id) => stepIndex(id as StepId)));
      if (idx > stepIndex('block1End') && !session.p.group) await assignGroupFromBlock1();
      setWithdrawnNow(false);
      go(target, { withdrawn: false, status: idx >= stepIndex('report') ? 'completed' : 'started', reviewing: null });
    });

  const debugReset = async () => {
    try {
      const store = await getStore(c.config);
      await store.signOut();
    } catch (err) {
      console.warn(err);
    }
    clearLocalSession();
    localStorage.removeItem('dsa_done');
    location.reload();
  };

  // ---------- render ----------

  const answeredInBlock = step === 'block1' ? (p?.block1?.answers.length ?? 0) : step === 'block2' ? (p?.block2?.answers.length ?? 0) : 0;
  const progress = phase === 'done' ? 1 : progressOf(step, answeredInBlock, c.config.questionsPerBlock);

  let screen: ReactNode = null;
  if (phase === 'done') screen = <Message text={c.ui.consent.alreadyDone} />;
  else if (phase === 'boot') screen = null;
  else if (!p) screen = <Consent c={c} onStart={onStart} />;
  else screen = renderStep();

  function renderStep(): ReactNode {
    const cur = p!;
    switch (step) {
      case 'consent':
      case 'profile':
        return <ProfileScreen key="profile" c={c} onDone={(profile) => go('before', { profile, lang: profile.language })} />;
      case 'before':
        return (
          <BeforeScreen c={c} onDone={(ratingStart, beliefStart, scoreGuessStart) => onBefore({ ratingStart, beliefStart, scoreGuessStart })} />
        );
      case 'block1':
      case 'block2': {
        const n = step === 'block1' ? 1 : 2;
        const b = n === 1 ? cur.block1 : cur.block2;
        if (!b) return null;
        const reviewIdx = cur.reviewing ? b.answers.findIndex((x) => x.qid === cur.reviewing) : -1;
        if (reviewIdx >= 0) {
          const ans = b.answers[reviewIdx];
          return (
            <QuestionReview
              key={`review-${ans.qid}`}
              c={c}
              q={c.byId[ans.qid]}
              answer={ans}
              position={reviewIdx + 1}
              lines={questionFeedbackLines(ans, b.answers.slice(0, reviewIdx + 1), cur.group, c)}
              lang={cur.lang}
              onLang={onLang}
              onNext={(ms) => onReviewNext(n, ms)}
            />
          );
        }
        const planned = b.plan[b.answers.length];
        if (!planned) return null;
        return (
          <QuestionScreen
            key={planned.qid}
            c={c}
            q={c.byId[planned.qid]}
            planned={planned}
            position={b.answers.length + 1}
            lang={cur.lang}
            onLang={onLang}
            onSubmit={(a) => onAnswer(n, a)}
          />
        );
      }
      case 'block1End':
        return <BlockEnd key="be1" c={c} onDone={(s) => onBlockEnd(1, s)} />;
      case 'block2End':
        return <BlockEnd key="be2" c={c} onDone={(s) => onBlockEnd(2, s)} />;
      case 'feedback1': {
        const fb = cur.feedback1;
        if (!fb || !cur.group) return <Screen>{null}</Screen>;
        return (
          <FeedbackScreen
            key="fb1"
            c={c}
            block={1}
            fb={fb}
            group={cur.group}
            minMs={debug ? 0 : c.config.feedbackMinSeconds * 1000}
            onDone={onFeedbackDone}
          />
        );
      }
      case 'rateMid':
        return (
          <TopicRatings
            key="rateMid"
            c={c}
            onDone={(r) => go('block2', { ratingMid: r, block2: session!.p.block2 ?? makeBlock(2, session!.p, c) })}
          />
        );
      case 'endSurvey':
        return (
          <EndSurveyScreen
            c={c}
            group={cur.group ?? 'A'}
            onDone={(endSurvey) => go('pack', { endSurvey, derived: derive({ endSurvey }) })}
          />
        );
      case 'pack':
        return (
          <Pack
            c={c}
            onDone={(packTopic, packType) =>
              // All study data is in: the session counts as completed even if they close the report.
              go('report', { packTopic, packType, derived: derive({ packTopic }), status: 'completed', completedAt: SERVER_TIME })
            }
          />
        );
      case 'report':
        return <Report c={c} p={cur} withdrawn={withdrawnNow || cur.withdrawn} onWithdraw={onWithdraw} onContinue={onFinish} />;
      case 'thanks':
        return <Message text={c.ui.thanks} />;
    }
  }

  return (
    <>
      <ProgressBar value={progress} label={c.config.studyName} />
      {showSaving && <SavingPill text={c.ui.saving} />}
      {localMode && (
        <div className="mx-auto max-w-[480px] px-4 pt-3 md:max-w-[760px]">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1 text-center text-[12px] font-medium text-amber-800">
            Local test mode · data stays in this browser
          </p>
        </div>
      )}
      {phase === 'boot' && (
        <div className="flex min-h-[70vh] items-center justify-center" aria-busy>
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-accent-600" />
        </div>
      )}
      <div key={`${step}-${answeredInBlock}-${p?.reviewing ?? ''}`} className={busy ? 'pointer-events-none' : undefined}>
        {screen}
      </div>
      {debug && (
        <DebugMenu
          steps={STEPS}
          current={step}
          info={{
            store: localMode ? 'local' : 'firebase',
            uid: p?.uid ?? '-',
            group: p?.group ?? '-',
            blockOrder: p?.blockOrder ?? '-',
            stratum: p?.stratum ?? '-',
            pilot: String(p ? p.pilot : flags.pilot || flags.debug),
            error: lastError ?? '-',
          }}
          onJump={p ? debugJump : undefined}
          onReset={debugReset}
        />
      )}
    </>
  );
}

/** Shown instead of the app when the build has no data store configured. */
export function ConfigError() {
  return (
    <Screen>
      <div className="card space-y-3 p-5 text-[15px] text-slate-800">
        <p className="font-semibold">Firebase is not configured.</p>
        <p>
          Set <code>VITE_FIREBASE_API_KEY</code>, <code>VITE_FIREBASE_AUTH_DOMAIN</code>, <code>VITE_FIREBASE_PROJECT_ID</code> and{' '}
          <code>VITE_FIREBASE_APP_ID</code> (see README), or build with <code>VITE_LOCAL_MODE=1</code> for a browser-only demo.
        </p>
      </div>
      <PrimaryButton label="Reload" onClick={() => location.reload()} />
    </Screen>
  );
}
