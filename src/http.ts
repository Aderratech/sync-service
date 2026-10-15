import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CONTRACT_VERSION, type ErrorCode } from '@aderratech/contracts';
import { HEADERS } from '@aderratech/contracts/sync';
import { identify, type Identity } from './auth/identity.js';
import { clientConfig } from './config.js';
import { getPool, sql } from './db/pool.js';

export type Call = {
  request: HttpRequest;
  context: InvocationContext;
  identity: Identity;
  pool: sql.ConnectionPool;
};

export const json = (status: number, body: unknown): HttpResponseInit => ({ status, jsonBody: body });

export const fail = (status: number, code: ErrorCode, reason: string): HttpResponseInit => json(status, { code, reason });

const major = (version: string) => Number(version.split('.')[0]);

/**
 * The phone's contract and build may be old (PLAN.md §4): accept this
 * contract's major and the one before it, and any build at or above
 * min_app_build. Anything older gets 426 and keeps its outbox.
 */
export function compatible(contract: string | null, appBuild: string | null): boolean {
  if (!contract || !/^\d+\.\d+\.\d+$/.test(contract)) return false;
  const current = major(CONTRACT_VERSION);
  const theirs = major(contract);
  if (theirs > current || theirs < current - 1) return false;
  return Number(appBuild) >= clientConfig().min_app_build;
}

/** Every endpoint: compatibility, then sign-in, then the database. Failures are explicit, never a hang. */
export function endpoint(handler: (call: Call) => Promise<HttpResponseInit>) {
  return async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    if (!compatible(request.headers.get(HEADERS.contract), request.headers.get(HEADERS.appBuild))) {
      return fail(426, 'UPGRADE_REQUIRED', 'Update Aderra to keep sending.');
    }
    const identity = identify(request.headers);
    if (!identity) return fail(401, 'UNAUTHENTICATED', 'Sign in again to send.');
    let pool: sql.ConnectionPool;
    try {
      pool = await getPool();
    } catch (error) {
      context.error('Database connection failed', error);
      return fail(503, 'SERVER_BUSY', 'Aderra is busy. Your reports are safe and will send later.');
    }
    try {
      return await handler({ request, context, identity, pool });
    } catch (error) {
      context.error('Request failed', error);
      return fail(500, 'SERVER_BUSY', 'Aderra is busy. Your reports are safe and will send later.');
    }
  };
}
