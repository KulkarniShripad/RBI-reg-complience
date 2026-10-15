// Value conversion shared by the stores.

import { SERVER_TIME } from '../model';

/** Deep copy that drops undefined values (Firestore rejects them) and maps the SERVER_TIME marker. */
export function prepare(value: unknown, serverTime: () => unknown): unknown {
  if (value === (SERVER_TIME as unknown)) return serverTime();
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => prepare(v, serverTime)).filter((v) => v !== undefined);
  // Dates, Firestore sentinels (serverTimestamp()) and other class instances pass through untouched.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const pv = prepare(v, serverTime);
    if (pv !== undefined) out[k] = pv;
  }
  return out;
}

/** Converts anything with toDate() (Firestore Timestamps) and ISO date strings back to Date. */
export function revive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) ? new Date(value) : value;
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate: () => Date }).toDate();
  if (Array.isArray(value)) return value.map(revive);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = revive(v);
  return out;
}
