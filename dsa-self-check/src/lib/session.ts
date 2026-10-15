// One participant's session: local state, a localStorage mirror for resume, and a
// write queue that merge-writes to the store after every screen.
//
// Writes are coalesced and retried with backoff until they succeed, so a flaky
// mobile connection never loses a screen's data. Assignment transactions wait for
// pending writes first.

import type { Content } from '../content/types';
import { SERVER_TIME, type BlockOrder, type FeedbackData, type Group, type Participant, type ParticipantPatch } from './model';
import { revive } from './store/convert';
import type { FeedbackKey, Store } from './store/types';
import { STEPS } from './steps';
import type { SetId } from '../content/types';

export const LS = {
  uid: 'dsa_uid',
  step: 'dsa_step',
  state: 'dsa_state',
  done: 'dsa_done',
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(15000, 500 * 2 ** attempt);

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: Firestore still has the data */
  }
}
function lsRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const isDone = () => lsGet(LS.done) === '1';
export const markDone = () => lsSet(LS.done, '1');
export const hasSavedSession = () => Boolean(lsGet(LS.uid));

export function clearLocalSession() {
  lsRemove(LS.uid);
  lsRemove(LS.step);
  lsRemove(LS.state);
}

function writeMirror(p: Participant) {
  lsSet(LS.uid, p.uid);
  lsSet(LS.step, String(p.currentStep));
  lsSet(LS.state, JSON.stringify(p));
}

function readMirror(uid: string): Participant | null {
  try {
    const raw = lsGet(LS.state);
    if (!raw) return null;
    const p = revive(JSON.parse(raw)) as Participant;
    return p.uid === uid ? p : null;
  } catch {
    return null;
  }
}

/** Replaces SERVER_TIME markers with the local time for the in-memory copy. */
function localValues(patch: ParticipantPatch): ParticipantPatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === (SERVER_TIME as unknown) ? new Date() : v;
  return out as ParticipantPatch;
}

export interface Flags {
  pilot: boolean;
  debug: boolean;
}

export function readFlags(search = window.location.search): Flags {
  const q = new URLSearchParams(search);
  return { pilot: q.get('pilot') === '1', debug: q.get('debug') === '1' };
}

function deviceInfo(): Participant['device'] {
  const ua = navigator.userAgent;
  const uaMobile = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile;
  return {
    userAgent: ua,
    screenW: window.screen?.width ?? 0,
    screenH: window.screen?.height ?? 0,
    isMobile: uaMobile ?? /Mobi|Android|iPhone|iPad|iPod/i.test(ua),
  };
}

export function newParticipant(uid: string, c: Content, flags: Flags): Participant {
  const step = STEPS.indexOf('profile');
  return {
    uid,
    status: 'started',
    withdrawn: false,
    // Debug (tester) sessions always count as pilot so they never touch the real counters, stats or export.
    pilot: flags.pilot || flags.debug,
    debug: flags.debug,
    appVersion: c.config.appVersion,
    contentVersion: c.questions.version,
    device: deviceInfo(),
    currentStep: step,
    currentStepName: STEPS[step],
    rev: 0,
    lang: c.config.defaultLanguage,
    reviewing: null,
    blockOrder: null,
    group: null,
    stratum: null,
    profile: null,
    ratingStart: null,
    ratingMid: null,
    ratingEnd: null,
    statements: null,
    rankGuessStart: null,
    scoreGuessStart: null,
    block1: null,
    block2: null,
    feedback1: null,
    feedback2: null,
    endItems: null,
    endItemsOrder: null,
    attentionPassed: null,
    packTopic: null,
    packType: null,
    close: null,
    preference: null,
    derived: null,
  };
}

// Fields written by assignment transactions: the stored value always wins on resume.
const ASSIGNED: (keyof Participant)[] = ['blockOrder', 'group', 'stratum', 'feedback1', 'feedback2'];
// Fields the store manages itself.
const STORE_MANAGED: (keyof Participant)[] = ['createdAt', 'updatedAt'];

export class Session {
  private dirty: ParticipantPatch = {};
  private loop: Promise<void> | null = null;
  private listeners = new Set<(p: Participant) => void>();

  constructor(
    readonly store: Store,
    public p: Participant,
  ) {
    writeMirror(p);
  }

  get uid() {
    return this.p.uid;
  }

  subscribe(fn: (p: Participant) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.p);
  }

  /** Applies a patch locally, mirrors it to localStorage and queues a merge-write. */
  save(patch: ParticipantPatch) {
    const rev = this.p.rev + 1;
    this.p = { ...this.p, ...localValues(patch), rev };
    this.dirty = { ...this.dirty, ...patch, rev };
    writeMirror(this.p);
    this.emit();
    this.kick();
  }

  /** Updates local state with values a transaction already stored. */
  private setLocal(patch: ParticipantPatch) {
    this.p = { ...this.p, ...patch };
    writeMirror(this.p);
    this.emit();
  }

  get pending() {
    return this.loop !== null || Object.keys(this.dirty).length > 0;
  }

  private kick() {
    if (this.loop) return;
    this.loop = (async () => {
      let attempt = 0;
      while (Object.keys(this.dirty).length) {
        const batch = this.dirty;
        this.dirty = {};
        try {
          await this.store.save(this.uid, batch);
          attempt = 0;
        } catch (err) {
          console.warn('Save failed, retrying', err);
          this.dirty = { ...batch, ...this.dirty };
          await sleep(backoff(attempt++));
        }
      }
    })().finally(() => {
      this.loop = null;
    });
  }

  /** Resolves once every queued write has reached the store. */
  async flush() {
    while (this.pending) {
      this.kick();
      await this.loop;
    }
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    await this.flush();
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        console.warn('Transaction failed, retrying', err);
        await sleep(backoff(attempt));
      }
    }
  }

  async assignBlockOrder(): Promise<BlockOrder> {
    const value = await this.retry(() => this.store.assignBlockOrder(this.uid, this.p.pilot));
    this.setLocal({ blockOrder: value });
    return value;
  }

  async assignGroup(stratum: string): Promise<Group> {
    const value = await this.retry(() => this.store.assignGroup(this.uid, this.p.pilot, stratum, {}));
    this.setLocal({ group: value, stratum: this.p.stratum ?? stratum });
    return value;
  }

  async recordFeedback(key: FeedbackKey, setId: SetId, score: number, build: (beatsPct: number) => FeedbackData) {
    const fb = await this.retry(() => this.store.recordFeedback(this.uid, this.p.pilot, key, setId, score, build));
    this.setLocal({ [key]: fb });
    return fb;
  }
}

/** Signs in anonymously and creates the participant (or picks up an existing one for this browser). */
export async function startSession(store: Store, c: Content, flags: Flags): Promise<Session | 'done'> {
  const uid = await store.signIn();
  const existing = await store.load(uid);
  if (existing) {
    if (existing.status === 'completed' || existing.withdrawn) {
      markDone();
      return 'done';
    }
    return new Session(store, existing);
  }
  const p = newParticipant(uid, c, flags);
  await store.create(p);
  return new Session(store, p);
}

/** Restores the session after a reload. Returns null when there is nothing to resume. */
export async function resumeSession(store: Store): Promise<Session | 'done' | null> {
  const savedUid = lsGet(LS.uid);
  if (!savedUid) return null;
  const uid = await store.existingUid();
  if (!uid || uid !== savedUid) {
    clearLocalSession();
    return null;
  }
  let remote: Participant | null = null;
  let remoteOk = true;
  try {
    remote = await store.load(uid);
  } catch (err) {
    console.warn('Could not load from the store; using the local copy', err);
    remoteOk = false;
  }
  const mirror = readMirror(uid);
  if (!remote && (remoteOk || !mirror)) {
    clearLocalSession();
    return null;
  }

  let p: Participant;
  let push: ParticipantPatch | null = null;
  if (remote && mirror && mirror.rev > (remote.rev ?? 0)) {
    // The local copy is ahead (a write never arrived): keep it, but keep assigned values from the store.
    p = { ...remote, ...mirror };
    for (const k of ASSIGNED) if (remote[k] != null) (p as unknown as Record<string, unknown>)[k] = remote[k];
    push = { ...p };
    for (const k of [...STORE_MANAGED, 'uid' as const]) delete (push as Record<string, unknown>)[k];
  } else {
    p = remote ?? mirror!;
  }

  const session = new Session(store, p);
  if (push) session.save(push);
  if (p.status === 'completed' || p.withdrawn) {
    // Give an unsent final write a few seconds to land before showing "already done".
    await Promise.race([session.flush(), sleep(5000)]);
    markDone();
    return 'done';
  }
  return session;
}

/** Retries an operation with backoff until it succeeds (network hiccups on Start). */
export async function retryForever<T>(fn: () => Promise<T>, onError?: (err: unknown) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn('Retrying after error', err);
      onError?.(err);
      await sleep(backoff(attempt));
    }
  }
}
