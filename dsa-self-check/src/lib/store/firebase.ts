// Firestore + Anonymous Auth store. Loaded lazily so the consent screen paints
// before the Firebase SDK is downloaded.

import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth,
  signInAnonymously,
  signOut,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  initializeFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore/lite';
import type { ConfigFile } from '../../content/types';
import { beatsPct, counterId, nextBlockOrder, nextGroup, type BlockOrderCounter, type GroupCounter } from '../assignment';
import type { BlockOrder, FeedbackData, Group, Participant, ParticipantPatch } from '../model';
import { prepare, revive } from './convert';
import type { Store } from './types';

export interface FirebaseEnv {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  emulatorHost?: string;
}

const TX = { maxAttempts: 25 };

export function createFirebaseStore(env: FirebaseEnv, cfg: ConfigFile): Store {
  const app = initializeApp({
    apiKey: env.apiKey,
    authDomain: env.authDomain,
    projectId: env.projectId,
    appId: env.appId,
  });
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  const db = initializeFirestore(app, {});
  if (env.emulatorHost) {
    connectAuthEmulator(auth, `http://${env.emulatorHost}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, env.emulatorHost, 8080);
  }

  const out = (v: unknown) => prepare(v, serverTimestamp) as Record<string, unknown>;
  const participant = (uid: string) => doc(db, 'participants', uid);
  const counter = (id: string) => doc(db, 'counters', id);
  const stats = (id: string) => doc(db, 'stats', id);

  return {
    kind: 'firebase',

    async existingUid() {
      await auth.authStateReady();
      return auth.currentUser?.uid ?? null;
    },

    async signIn() {
      await auth.authStateReady();
      if (auth.currentUser) return auth.currentUser.uid;
      const cred = await signInAnonymously(auth);
      return cred.user.uid;
    },

    async signOut() {
      await signOut(auth);
    },

    async load(uid) {
      const snap = await getDoc(participant(uid));
      return snap.exists() ? (revive(snap.data()) as Participant) : null;
    },

    async create(p) {
      await setDoc(participant(p.uid), out({ ...p, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), completedAt: null }));
    },

    async save(uid, patch) {
      await setDoc(participant(uid), out({ ...patch, updatedAt: serverTimestamp() }), { merge: true });
    },

    async assignBlockOrder(uid, pilot) {
      return runTransaction(
        db,
        async (tx) => {
          const pRef = participant(uid);
          const cRef = counter(counterId('blockOrder', pilot, cfg));
          const pSnap = await tx.get(pRef);
          const existing = pSnap.data()?.blockOrder as BlockOrder | undefined;
          if (existing) return existing;
          const cSnap = await tx.get(cRef);
          const next = nextBlockOrder(cSnap.data() as BlockOrderCounter | undefined, Math.random);
          tx.set(cRef, next.counter);
          tx.set(pRef, { blockOrder: next.value, updatedAt: serverTimestamp() }, { merge: true });
          return next.value;
        },
        TX,
      );
    },

    async assignGroup(uid, pilot, stratum, extra: ParticipantPatch) {
      return runTransaction(
        db,
        async (tx) => {
          const pRef = participant(uid);
          const cRef = counter(counterId(`group_${stratum}`, pilot, cfg));
          const pSnap = await tx.get(pRef);
          const existing = pSnap.data()?.group as Group | undefined;
          if (existing) return existing;
          const cSnap = await tx.get(cRef);
          const next = nextGroup(cSnap.data() as GroupCounter | undefined, Math.random);
          tx.set(cRef, next.counter);
          tx.set(pRef, out({ ...extra, group: next.value, stratum, updatedAt: serverTimestamp() }), { merge: true });
          return next.value;
        },
        TX,
      );
    },

    async recordFeedback(uid, pilot, key, setId, score, build) {
      return runTransaction(
        db,
        async (tx) => {
          const pRef = participant(uid);
          const sRef = stats(counterId(setId, pilot, cfg));
          const pSnap = await tx.get(pRef);
          const existing = pSnap.data()?.[key];
          if (existing) return revive(existing) as FeedbackData;
          const sSnap = await tx.get(sRef);
          const raw = (sSnap.data()?.counts as number[] | undefined) ?? [];
          const counts = Array.from({ length: cfg.questionsPerBlock + 1 }, (_, i) => Number(raw[i]) || 0);
          const fb = build(beatsPct(counts, score, cfg.beatsPctFallback));
          counts[score] += 1;
          tx.set(sRef, { counts });
          tx.set(pRef, out({ [key]: fb, updatedAt: serverTimestamp() }), { merge: true });
          return fb;
        },
        TX,
      );
    },
  };
}
