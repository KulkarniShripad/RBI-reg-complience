// Picks the store from the environment. Firebase is imported lazily so it is not
// part of the first download.

import type { ConfigFile } from '../../content/types';
import type { Store } from './types';

const env = import.meta.env;

export const firebaseConfigured = Boolean(
  env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_AUTH_DOMAIN && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID,
);

/** Local (browser-only) mode: explicit flag, or `npm run dev` without Firebase env vars. */
export const localMode = env.VITE_LOCAL_MODE === '1' || (env.DEV && !firebaseConfigured);

/** A production build with no Firebase config and no explicit local mode must not silently collect nothing. */
export const misconfigured = !localMode && !firebaseConfigured;

let storePromise: Promise<Store> | null = null;

export function getStore(cfg: ConfigFile): Promise<Store> {
  if (!storePromise) {
    storePromise = localMode
      ? import('./local').then((m) => m.createLocalStore(cfg))
      : import('./firebase').then((m) =>
          m.createFirebaseStore(
            {
              apiKey: env.VITE_FIREBASE_API_KEY,
              authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
              projectId: env.VITE_FIREBASE_PROJECT_ID,
              appId: env.VITE_FIREBASE_APP_ID,
              emulatorHost: env.VITE_USE_EMULATOR === '1' ? env.VITE_EMULATOR_HOST || '127.0.0.1' : undefined,
            },
            cfg,
          ),
        );
  }
  return storePromise;
}

/** Starts downloading the store code early (called on the consent screen). */
export function preloadStore(cfg: ConfigFile) {
  void getStore(cfg);
}

export type { Store } from './types';
