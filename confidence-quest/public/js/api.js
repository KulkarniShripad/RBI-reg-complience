// Small fetch wrapper. Network failures are retried up to 3 times with the same body
// (and so the same idempotency key), then reported as a connection problem.

const RETRY_DELAYS_MS = [500, 1000, 2000];
const RETRY_STATUSES = new Set([502, 503, 504]);

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// crypto.randomUUID needs a secure context; getRandomValues also works over plain http on a LAN.
export function newKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new ApiError(0, 'NETWORK', 'Connection lost.');
    }
    if (RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      throw new ApiError(res.status, data?.error?.code ?? 'SERVER', data?.error?.message ?? 'Something went wrong.');
    }
    return data;
  }
}
