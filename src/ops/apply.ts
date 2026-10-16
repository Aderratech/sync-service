import type { ErrorCode } from '@aderratech/contracts';
import { Operation, type OpResult, type SyncResponse } from '@aderratech/contracts/sync';
import { z } from 'zod';
import { sql } from '../db/pool.js';
import { getUser, type UserRow } from '../users.js';
import { farmCreate, farmRegister, farmUpdate, houseCreate, houseUpdate } from './farm.js';
import { memberAssignHouses, memberCancel, memberDecide, memberRemove, memberRequest } from './membership.js';
import { mediaConfirm } from './media.js';
import { farmVetRemove, farmVetRequest } from '../vets.js';
import { notificationRead } from './notifications.js';
import { reportCreate } from './report.js';
import { reject, type Outcome } from './outcome.js';

/** SQL Server errors that mean the data broke a rule: FK, unique key, value too long. */
const CONSTRAINT_ERRORS = [547, 2627, 2601, 8152];

// ── Operations ──────────────────────────────────────────────────────────────

async function userUpdate(tx: sql.Transaction, user: UserRow, op: Extract<Operation, { op: 'user.update' }>): Promise<Outcome> {
  const b = op.body;
  if (b.role && user.role && b.role !== user.role) {
    return reject('ROLE_LOCKED', 'Your role can be changed only by Aderra.');
  }
  const sets: string[] = [];
  const request = new sql.Request(tx).input('user', sql.UniqueIdentifier, user.user_id);
  if (b.name !== undefined) { sets.push('name = @name'); request.input('name', sql.NVarChar(200), b.name); }
  if (b.phone !== undefined) { sets.push('phone = @phone'); request.input('phone', sql.VarChar(20), b.phone); }
  if (b.language !== undefined) { sets.push('language = @language'); request.input('language', sql.Char(2), b.language); }
  if (b.role !== undefined && !user.role) { sets.push('role = @role'); request.input('role', sql.VarChar(20), b.role); }
  // An officer's list of woredas replaces the old one; the first is the profile's woreda_id.
  const woredaId = b.woreda_ids?.[0] ?? b.woreda_id;
  if (woredaId !== undefined) { sets.push('woreda_id = @woreda'); request.input('woreda', sql.Int, woredaId); }
  const role = user.role ?? b.role ?? null;
  if (b.woreda_ids && role === 'extension_officer') {
    await new sql.Request(tx).input('user', sql.UniqueIdentifier, user.user_id).input('list', sql.NVarChar(sql.MAX), JSON.stringify(b.woreda_ids))
      .query(`UPDATE dbo.officer_woreda SET removed_at = SYSUTCDATETIME()
                WHERE officer_user_id = @user AND removed_at IS NULL AND woreda_id NOT IN (SELECT CAST(value AS INT) FROM OPENJSON(@list));
              UPDATE dbo.officer_woreda SET removed_at = NULL
                WHERE officer_user_id = @user AND woreda_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@list));
              INSERT INTO dbo.officer_woreda (officer_user_id, woreda_id)
                SELECT @user, w.value FROM (SELECT DISTINCT CAST(value AS INT) AS value FROM OPENJSON(@list)) w
                WHERE NOT EXISTS (SELECT 1 FROM dbo.officer_woreda o WHERE o.officer_user_id = @user AND o.woreda_id = w.value)`);
  }
  if (b.consent_version !== undefined) {
    sets.push('consent_version = @consent, consent_at = SYSUTCDATETIME()');
    request.input('consent', sql.VarChar(16), b.consent_version);
  }
  if (sets.length) {
    await request.query(`UPDATE dbo.app_user SET ${sets.join(', ')}, updated_at = SYSUTCDATETIME() WHERE user_id = @user`);
  }
  return { result: 'applied' };
}

async function deviceRegister(tx: sql.Transaction, user: UserRow, op: Extract<Operation, { op: 'device.register' }>): Promise<Outcome> {
  const b = op.body;
  // A shared phone moves to whoever signed in last on it (§8).
  await new sql.Request(tx)
    .input('device', sql.UniqueIdentifier, b.device_id)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('token', sql.VarChar(512), b.fcm_token)
    .input('platform', sql.VarChar(10), b.platform)
    .input('os', sql.VarChar(32), b.os_version)
    .input('build', sql.Int, b.app_build)
    .query(`
      MERGE dbo.push_token AS t
      USING (SELECT @device AS device_id) AS s ON t.device_id = s.device_id
      WHEN MATCHED THEN UPDATE SET user_id = @user, token = @token, platform = @platform, os_version = @os,
                                   app_build = @build, last_seen_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (device_id, user_id, token, platform, os_version, app_build)
                            VALUES (@device, @user, @token, @platform, @os, @build);`);
  return { result: 'applied' };
}

const HANDLERS: Partial<{
  [K in Operation['op']]: (tx: sql.Transaction, user: UserRow, op: Extract<Operation, { op: K }>) => Promise<Outcome>;
}> = {
  'user.update': userUpdate,
  'device.register': deviceRegister,
  'farm.create': farmCreate,
  'farm.register': farmRegister,
  'farm.vet_request': farmVetRequest,
  'farm.vet_remove': farmVetRemove,
  'farm.update': farmUpdate,
  'house.create': houseCreate,
  'house.update': houseUpdate,
  'member.request': memberRequest,
  'member.cancel': memberCancel,
  'member.decide': memberDecide,
  'member.remove': memberRemove,
  'member.assign_houses': memberAssignHouses,
  'notification.read': notificationRead,
  'media.confirm': mediaConfirm,
  'report.create': reportCreate,
};

// ── Batch ───────────────────────────────────────────────────────────────────

/** The envelope is checked as a whole; each op on its own, so one bad op doesn't sink the batch. */
export const SyncEnvelope = z.object({
  device_id: z.guid(),
  app_build: z.number().int(),
  contract: z.string(),
  ops: z.array(z.unknown()).min(1).max(50),
});

const OpId = z.object({ op_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

async function previous(pool: sql.ConnectionPool, opId: string) {
  const r = await new sql.Request(pool).input('op', sql.Char(26), opId).query<{
    user_id: string; result: 'applied' | 'rejected'; code: ErrorCode | null; server_ref: string | null;
  }>('SELECT user_id, result, code, server_ref FROM dbo.sync_op WHERE op_id = @op');
  return r.recordset[0] ?? null;
}

async function applyOne(pool: sql.ConnectionPool, user: UserRow, raw: unknown): Promise<OpResult | null> {
  const id = OpId.safeParse(raw);
  if (!id.success) return null; // no op_id to answer to
  const op_id = id.data.op_id;

  const parsed = Operation.safeParse(raw);
  if (!parsed.success) {
    return { op_id, result: 'rejected', code: 'INVALID_PAYLOAD', reason: 'Something in this report could not be read.' };
  }
  const op = parsed.data;

  // A resend: answer exactly as the first time.
  const seen = await previous(pool, op_id);
  if (seen) {
    if (seen.user_id.toLowerCase() !== user.user_id.toLowerCase()) {
      return { op_id, result: 'rejected', code: 'FORBIDDEN', reason: "You can't do this." };
    }
    return seen.result === 'applied'
      ? { op_id, result: 'duplicate', ...(seen.server_ref ? { server: JSON.parse(seen.server_ref) } : {}) }
      : { op_id, result: 'rejected', code: seen.code ?? 'INVALID_PAYLOAD', reason: 'Already refused.' };
  }

  const handler = HANDLERS[op.op] as ((tx: sql.Transaction, u: UserRow, o: Operation) => Promise<Outcome>) | undefined;
  if (!handler) {
    // Not handled by this server version yet: retryable, so the phone keeps it queued and nothing is lost.
    return { op_id, result: 'rejected', code: 'SERVER_BUSY', reason: `${op.op} is not available yet.` };
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  let outcome: Outcome;
  try {
    outcome = await handler(tx, user, op);
  } catch (error) {
    await tx.rollback();
    // A constraint (unknown woreda, house, code…): the data can't be stored.
    if (!(error instanceof sql.RequestError && CONSTRAINT_ERRORS.includes(error.number ?? 0))) throw error;
    outcome = reject('INVALID_PAYLOAD', 'Something in this report could not be read.');
    await record(pool, op_id, user, op.op, outcome);
    return toResult(op_id, outcome);
  }
  if (outcome.result === 'applied') {
    await record(tx, op_id, user, op.op, outcome); // in the same transaction as its effect
    await tx.commit();
  } else {
    await tx.rollback();
    if (outcome.final) await record(pool, op_id, user, op.op, outcome);
  }
  return toResult(op_id, outcome);
}

async function record(target: sql.ConnectionPool | sql.Transaction, opId: string, user: UserRow, op: string, outcome: Outcome) {
  const request = target instanceof sql.Transaction ? new sql.Request(target) : new sql.Request(target);
  await request
    .input('op_id', sql.Char(26), opId)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('op', sql.VarChar(32), op)
    .input('result', sql.VarChar(10), outcome.result)
    .input('code', sql.VarChar(32), outcome.result === 'rejected' ? outcome.code : null)
    .input('server', sql.NVarChar(1000), outcome.result === 'applied' && outcome.server ? JSON.stringify(outcome.server) : null)
    .query('INSERT INTO dbo.sync_op (op_id, user_id, op, result, code, server_ref) VALUES (@op_id, @user, @op, @result, @code, @server)');
}

function toResult(op_id: string, outcome: Outcome): OpResult {
  return outcome.result === 'applied'
    ? { op_id, result: 'applied', ...(outcome.server ? { server: outcome.server } : {}) }
    : { op_id, result: 'rejected', code: outcome.code, reason: outcome.reason };
}

/**
 * POST /api/v1/sync: ops apply in the order sent, each in its own transaction.
 * The user is re-read after a user.update, so a role chosen earlier in the
 * batch counts for the farm.create after it.
 */
export async function applyBatch(pool: sql.ConnectionPool, user: UserRow, ops: unknown[]): Promise<SyncResponse> {
  const results: OpResult[] = [];
  let current = user;
  for (const raw of ops) {
    const result = await applyOne(pool, current, raw);
    if (!result) continue;
    results.push(result);
    if (result.result === 'applied' && (raw as { op?: string }).op === 'user.update') current = await getUser(pool, current.user_id);
  }
  return { results, server_time: new Date().toISOString() };
}
