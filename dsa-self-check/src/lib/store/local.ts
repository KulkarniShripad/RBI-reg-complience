// Browser-only store for development and demos (VITE_LOCAL_MODE=1, or `npm run dev`
// without Firebase env vars). Same semantics as the Firestore store, but all data
// lives in this browser's localStorage. Never use it for real data collection.

import type { ConfigFile } from '../../content/types';
import { beatsPct, counterId, nextBlockOrder, nextGroup, type BlockOrderCounter, type GroupCounter } from '../assignment';
import type { FeedbackData, Participant } from '../model';
import { prepare, revive } from './convert';
import type { Store } from './types';

const PREFIX = 'dsa_localdb:';
const AUTH_KEY = `${PREFIX}auth`;

// Falls back to memory when localStorage is blocked (e.g. some private windows).
const memory = new Map<string, string>();
const getItem = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
};
const setItem = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
};
const removeItem = (key: string) => {
  try {
    localStorage.removeItem(key);
  } catch {
    memory.delete(key);
  }
};

function read<T>(path: string): T | null {
  try {
    const raw = getItem(PREFIX + path);
    return raw ? (revive(JSON.parse(raw)) as T) : null;
  } catch {
    return null;
  }
}

function write(path: string, value: unknown) {
  setItem(PREFIX + path, JSON.stringify(prepare(value, () => new Date())));
}

function newUid(): string {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return 'local' + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 23);
}

export function createLocalStore(cfg: ConfigFile): Store {
  const participant = (uid: string) => `participants/${uid}`;
  const merge = (uid: string, patch: object) => {
    const cur = read<Participant>(participant(uid)) ?? ({} as Participant);
    write(participant(uid), { ...cur, ...patch, updatedAt: new Date() });
  };

  return {
    kind: 'local',

    async existingUid() {
      return getItem(AUTH_KEY);
    },

    async signIn() {
      let uid = getItem(AUTH_KEY);
      if (!uid) {
        uid = newUid();
        setItem(AUTH_KEY, uid);
      }
      return uid;
    },

    async signOut() {
      removeItem(AUTH_KEY);
    },

    async load(uid) {
      return read<Participant>(participant(uid));
    },

    async create(p) {
      write(participant(p.uid), { ...p, createdAt: new Date(), updatedAt: new Date(), completedAt: null });
    },

    async save(uid, patch) {
      merge(uid, patch);
    },

    async assignBlockOrder(uid, pilot) {
      const existing = read<Participant>(participant(uid))?.blockOrder;
      if (existing) return existing;
      const id = `counters/${counterId('blockOrder', pilot, cfg)}`;
      const next = nextBlockOrder(read<BlockOrderCounter>(id) ?? undefined, Math.random);
      write(id, next.counter);
      merge(uid, { blockOrder: next.value });
      return next.value;
    },

    async assignGroup(uid, pilot, stratum, extra) {
      const existing = read<Participant>(participant(uid))?.group;
      if (existing) return existing;
      const id = `counters/${counterId(`group_${stratum}`, pilot, cfg)}`;
      const next = nextGroup(read<GroupCounter>(id) ?? undefined, Math.random);
      write(id, next.counter);
      merge(uid, { ...extra, group: next.value, stratum });
      return next.value;
    },

    async recordFeedback(uid, pilot, key, setId, score, build) {
      const existing = read<Participant>(participant(uid))?.[key];
      if (existing) return existing as FeedbackData;
      const id = `stats/${counterId(setId, pilot, cfg)}`;
      const raw = read<{ counts: number[] }>(id)?.counts ?? [];
      const counts = Array.from({ length: cfg.questionsPerBlock + 1 }, (_, i) => Number(raw[i]) || 0);
      const fb = build(beatsPct(counts, score, cfg.beatsPctFallback));
      counts[score] += 1;
      write(id, { counts });
      merge(uid, { [key]: fb });
      return fb;
    },
  };
}
