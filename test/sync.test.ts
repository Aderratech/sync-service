import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeResponse, SyncResponse } from '@aderratech/contracts/sync';
import { adminPool, newIdentity, opId, PLACE } from './setup.js';
import { closePool, getPool, type sql } from '../src/db/pool.js';
import { buildMe } from '../src/me.js';
import { applyBatch } from '../src/ops/apply.js';
import { ensureUser, testRole } from '../src/users.js';

let pool: sql.ConnectionPool;
let admin: sql.ConnectionPool;

beforeAll(async () => {
  admin = await adminPool();
  pool = await getPool();
});

afterAll(async () => {
  await admin.query("DELETE s FROM dbo.sync_op s JOIN dbo.app_user u ON u.user_id = s.user_id WHERE u.identity_subject LIKE 'dev-test-%'");
  await admin.query("DELETE p FROM dbo.push_token p JOIN dbo.app_user u ON u.user_id = p.user_id WHERE u.identity_subject LIKE 'dev-test-%'");
  await admin.query("DELETE FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%'");
  await admin.close();
  await closePool();
});

describe('first sign-in', () => {
  it('creates the user with no role, once', async () => {
    const identity = newIdentity();
    const first = await ensureUser(pool, identity, 'om');
    const again = await ensureUser(pool, identity, 'en');
    expect(first.user_id).toBe(again.user_id);
    expect(first).toMatchObject({ name: 'Almaz Girma', role: null, language: 'om' });
  });

  it("gives a test button's account that button's role", () => {
    expect(testRole('dev-manager-1')).toBe('farm_manager');
    expect(testRole('dev-farmer-1')).toBe('farmer');
    expect(testRole('dev-officer-1')).toBe('extension_officer');
    expect(testRole('dev-test-42')).toBeNull();
    expect(testRole('108234556')).toBeNull();
  });

  it('/me matches the contract for a brand-new user', async () => {
    const me = MeResponse.parse(await buildMe(pool, await ensureUser(pool, newIdentity(), 'en')));
    expect(me.user.role).toBeNull();
    expect(me.farm).toBeNull();
    expect(me.memberships).toEqual([]);
  });
});

describe('user.update', () => {
  const update = (body: object, op_id = opId()) => ({ op: 'user.update', op_id, body });

  it('sets the role at first run, and /me returns it (the step 1 gate)', async () => {
    const identity = newIdentity();
    const user = await ensureUser(pool, identity, 'en');
    const response = SyncResponse.parse(await applyBatch(pool, user, [
      update({ role: 'farm_manager', language: 'am', phone: '+251911000000', consent_version: '1.0' }),
    ]));
    expect(response.results).toEqual([expect.objectContaining({ result: 'applied' })]);

    const me = MeResponse.parse(await buildMe(pool, await ensureUser(pool, identity, 'en')));
    expect(me.user).toMatchObject({ role: 'farm_manager', language: 'am', phone: '+251911000000', consent_version: '1.0' });
  });

  it('answers a resend with duplicate and applies it once', async () => {
    const user = await ensureUser(pool, newIdentity(), 'en');
    const op = update({ name: 'Almaz G.' });
    await applyBatch(pool, user, [op]);
    const again = await applyBatch(pool, user, [op]);
    expect(again.results[0]).toMatchObject({ op_id: op.op_id, result: 'duplicate' });
  });

  it('locks the role once set', async () => {
    const identity = newIdentity();
    let user = await ensureUser(pool, identity, 'en');
    await applyBatch(pool, user, [update({ role: 'farmer' })]);
    user = await ensureUser(pool, identity, 'en');
    const response = await applyBatch(pool, user, [update({ role: 'farm_manager' })]);
    expect(response.results[0]).toMatchObject({ result: 'rejected', code: 'ROLE_LOCKED' });
    expect((await ensureUser(pool, identity, 'en')).role).toBe('farmer');
  });

  it("sets an officer's woreda, and refuses one that doesn't exist", async () => {
    const identity = newIdentity();
    const user = await ensureUser(pool, identity, 'en');
    const ok = await applyBatch(pool, user, [update({ role: 'extension_officer', woreda_id: PLACE.woreda })]);
    expect(ok.results[0]!.result).toBe('applied');
    const bad = await applyBatch(pool, user, [update({ woreda_id: 1 })]);
    expect(bad.results[0]).toMatchObject({ result: 'rejected', code: 'INVALID_PAYLOAD' });
    expect((await ensureUser(pool, identity, 'en')).woreda_id).toBe(PLACE.woreda);
  });
});

describe('the batch', () => {
  it('registers a device, and moves it to whoever signs in next on that phone', async () => {
    const device_id = randomUUID();
    const register = () => ({
      op: 'device.register', op_id: opId(),
      body: { device_id, fcm_token: 'fcm-token-0123456789', platform: 'android', os_version: '14', app_build: 10003 },
    });
    const first = await ensureUser(pool, newIdentity('First'), 'en');
    const second = await ensureUser(pool, newIdentity('Second'), 'en');
    await applyBatch(pool, first, [register()]);
    await applyBatch(pool, second, [register()]);
    const owner = await admin.query(`SELECT user_id FROM dbo.push_token WHERE device_id = '${device_id}'`);
    expect(owner.recordset[0].user_id.toLowerCase()).toBe(second.user_id.toLowerCase());
  });

  it('keeps operations this version cannot apply yet queued (retryable), and remembers nothing', async () => {
    const user = await ensureUser(pool, newIdentity(), 'en');
    const op = { op: 'report.done', op_id: opId(), report_id: opId(), body: { tapped_at: new Date().toISOString() } };
    const response = await applyBatch(pool, user, [op]);
    expect(response.results[0]).toMatchObject({ result: 'rejected', code: 'SERVER_BUSY' });
    const stored = await admin.query(`SELECT COUNT(*) AS n FROM dbo.sync_op WHERE op_id = '${op.op_id}'`);
    expect(stored.recordset[0].n).toBe(0);
  });

  it('refuses a malformed op on its own and applies the rest', async () => {
    const user = await ensureUser(pool, newIdentity(), 'en');
    const response = await applyBatch(pool, user, [
      { op: 'user.update', op_id: opId(), body: { role: 'vet' } }, // portal roles are not for the phone
      { op: 'user.update', op_id: opId(), body: { name: 'Kebede Alemu' } },
    ]);
    expect(response.results.map((r) => r.result)).toEqual(['rejected', 'applied']);
    expect(response.results[0]).toMatchObject({ code: 'INVALID_PAYLOAD' });
  });

  it("won't let one user replay another user's op_id", async () => {
    const op = { op: 'user.update', op_id: opId(), body: { name: 'Mine' } };
    await applyBatch(pool, await ensureUser(pool, newIdentity(), 'en'), [op]);
    const response = await applyBatch(pool, await ensureUser(pool, newIdentity(), 'en'), [op]);
    expect(response.results[0]).toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });
  });
});
