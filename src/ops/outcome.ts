import type { ErrorCode } from '@aderratech/contracts';

/** What applying an operation produced: a result for the phone, and whether to remember it. */
export type Outcome =
  | { result: 'applied'; server?: Record<string, unknown> }
  | { result: 'rejected'; code: ErrorCode; reason: string; final: boolean };

export const applied = (server?: Record<string, unknown>): Outcome => ({ result: 'applied', ...(server ? { server } : {}) });

/** Final by default: the same op will never apply. Pass final=false for "try again later". */
export const reject = (code: ErrorCode, reason: string, final = true): Outcome => ({ result: 'rejected', code, reason, final });

/** GUIDs leave the service in lower case, as the phone mints them, so ids compare equal on the phone. */
export const lc = (id: string): string => id.toLowerCase();
