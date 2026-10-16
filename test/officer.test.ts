import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangesResponse, OfficerFarmsResponse, SyncResponse } from '@aderratech/contracts/sync';
import { adminPool, newIdentity, opId, PLACE } from './setup.js';
import { closePool, getPool, type sql } from '../src/db/pool.js';
import { buildChanges } from '../src/changes.js';
import { buildMe } from '../src/me.js';
import { officerFarms } from '../src/officer.js';
import { applyBatch } from '../src/ops/apply.js';
import { ensureUser, type UserRow } from '../src/users.js';

let pool: sql.ConnectionPool;
let admin: sql.ConnectionPool;

beforeAll(async () => {
  admin = await adminPool();
  pool = await getPool();
});

afterAll(async () => {
  // Test users, and the placeholders their invitations made (email dev-test-…@aderra.test).
  const users = `SELECT user_id FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%' OR identity_subject LIKE 'invite:dev-test-%'`;
  const reports = `SELECT report_id FROM dbo.report WHERE reporter_user_id IN (${users})`;
  const farms = `SELECT farm_id FROM dbo.farm WHERE manager_user_id IN (${users})`;
  await admin.query(`
    DELETE FROM dbo.notification WHERE report_id IN (${reports}) OR user_id IN (${users});
    DELETE FROM dbo.case_event WHERE report_id IN (${reports});
    DELETE FROM dbo.media WHERE report_id IN (${reports});
    DELETE FROM dbo.report_sign WHERE report_id IN (${reports});
    DELETE FROM dbo.report_label WHERE report_id IN (${reports});
    DELETE FROM dbo.report WHERE report_id IN (${reports});
    DELETE FROM dbo.email_outbox WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm_invite WHERE farm_id IN (${farms});
    DELETE FROM dbo.officer_farm WHERE farm_id IN (${farms}) OR officer_user_id IN (${users});
    DELETE FROM dbo.farm_member_house WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm_member WHERE farm_id IN (${farms}) OR user_id IN (${users});
    DELETE FROM dbo.farm_house WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm WHERE farm_id IN (${farms});
    DELETE FROM dbo.sync_op WHERE user_id IN (${users});
    DELETE FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%' OR identity_subject LIKE 'invite:dev-test-%';`);
  await admin.close();
  await closePool();
});

const run = async (user: UserRow, ...ops: object[]) => SyncResponse.parse(await applyBatch(pool, user, ops)).results;

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => '01' + Array.from({ length: 24 }, () => crockford[Math.floor(Math.random() * 32)]).join('');
const now = () => new Date().toISOString();

async function officer(woreda = PLACE.woreda) {
  const identity = newIdentity('Kebede Alemu');
  const user = await ensureUser(pool, identity, 'en');
  await run(user, { op: 'user.update', op_id: opId(), body: { role: 'extension_officer', woreda_id: woreda } });
  return ensureUser(pool, identity, 'en');
}

function registerOp(email: string, name = `Abebe Poultry ${randomUUID().slice(0, 6)}`) {
  const farmId = randomUUID();
  const houseId = randomUUID();
  return {
    farmId, houseId, name,
    op: {
      op: 'farm.register', op_id: opId(), farm_id: farmId,
      body: {
        name, kebele_id: PLACE.kebele, lat: null, lon: null, phone: null, manager_email: email,
        house: { house_id: houseId, name: 'House 1', animal_code: 'chicken', produce_code: 'layers' },
      },
    },
  };
}

function caseOp(farmId: string, houseId: string) {
  const reportId = ulid();
  return {
    op: 'report.create', op_id: reportId, report_id: reportId,
    body: {
      farm_id: farmId, house_id: houseId, kebele_id: PLACE.kebele, animal_code: 'chicken', produce_code: 'layers',
      reporter_role: 'extension_officer', lat: null, lon: null, onset: 'today', medicine_given: 'no', owner_ok: true,
      created_on_device_at: now(), model_version: null, labels: [], signs: [], media: [],
    },
  };
}

const testEmail = () => `dev-test-${randomUUID()}@aderra.test`;

describe('an officer registers a farm with its case', () => {
  it('creates the farm, its one house and the case in one batch, invites the manager, and lists the farm as his', async () => {
    const me = await officer();
    const email = testEmail();
    const r = registerOp(email.toUpperCase());
    const results = await run(me, r.op, caseOp(r.farmId, r.houseId));
    expect(results.map((x) => x.result)).toEqual(['applied', 'applied']);

    const rows = await admin.query(`
      SELECT (SELECT COUNT(*) FROM dbo.farm_house WHERE farm_id = '${r.farmId}') AS houses,
             (SELECT email FROM dbo.farm_invite WHERE farm_id = '${r.farmId}' AND claimed_at IS NULL) AS invite,
             (SELECT COUNT(*) FROM dbo.email_outbox WHERE farm_id = '${r.farmId}' AND template = 'farm_invite' AND sent_at IS NULL) AS emails,
             (SELECT u.identity_subject FROM dbo.farm f JOIN dbo.app_user u ON u.user_id = f.manager_user_id WHERE f.farm_id = '${r.farmId}') AS manager`);
    expect(rows.recordset[0]).toEqual({ houses: 1, invite: email, emails: 1, manager: `invite:${email}` });

    const mine = OfficerFarmsResponse.parse(await officerFarms(pool, me, ''));
    expect(mine.farms).toEqual([expect.objectContaining({ farm_id: r.farmId, mine: true, manager_invited: true, houses: [expect.objectContaining({ house_id: r.houseId })] })]);
  });

  it('finds farms in his woreda by part of the name, with the ones on his list marked', async () => {
    const me = await officer();
    const r = registerOp(testEmail());
    await run(me, r.op);
    const other = await officer();
    const found = OfficerFarmsResponse.parse(await officerFarms(pool, other, r.name.slice(7).toLowerCase()));
    expect(found.farms).toEqual([expect.objectContaining({ farm_id: r.farmId, name: r.name, mine: false })]);
    expect((await officerFarms(pool, other, 'A')).farms).toEqual([]);
    expect((await officerFarms(pool, other, '100%_[')).farms).toEqual([]);
  });

  it('hands the farm to the invited manager at first sign-in, who then manages its houses', async () => {
    const me = await officer();
    const email = testEmail();
    const r = registerOp(email);
    await run(me, r.op, caseOp(r.farmId, r.houseId));

    const identity = { ...newIdentity('Abebe Kebede'), email: email.toUpperCase() };
    const manager = await ensureUser(pool, identity, 'en');
    expect(manager).toMatchObject({ name: 'Abebe Kebede', role: 'farm_manager' });
    const me2 = await buildMe(pool, manager);
    expect(me2.farm).toMatchObject({ farm_id: r.farmId, houses: [expect.objectContaining({ house_id: r.houseId })] });
    expect(me2.farm!.join_code).not.toBeNull();

    const changes = ChangesResponse.parse(await buildChanges(pool, manager, null));
    expect(changes.reports.map((c) => c.farm_id)).toContain(r.farmId);

    const added = await run(manager,
      { op: 'user.update', op_id: opId(), body: { role: 'farm_manager' } },
      { op: 'house.create', op_id: opId(), house_id: randomUUID(), body: { farm_id: r.farmId, name: 'House 2', animal_code: 'chicken', produce_code: null } },
      { op: 'house.update', op_id: opId(), house_id: r.houseId, body: { name: 'Layers' } });
    expect(added.map((x) => x.result)).toEqual(['applied', 'applied', 'applied']);
    const claimed = await admin.query(`SELECT claimed_at FROM dbo.farm_invite WHERE farm_id = '${r.farmId}'`);
    expect(claimed.recordset[0].claimed_at).not.toBeNull();

    // The officer can report for the farm but not change it.
    const officerEdit = await run(me, { op: 'house.create', op_id: opId(), house_id: randomUUID(), body: { farm_id: r.farmId, name: 'X', animal_code: 'chicken', produce_code: null } });
    expect(officerEdit[0]).toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });
  });

  it('makes someone already on Aderra without a farm the manager straight away', async () => {
    const email = testEmail();
    const identity = { ...newIdentity('Hana Bekele'), email };
    const person = await ensureUser(pool, identity, 'en');
    await admin.query(`UPDATE dbo.app_user SET email = '${email}' WHERE user_id = '${person.user_id}'`);
    const r = registerOp(email);
    expect((await run(await officer(), r.op))[0]!.result).toBe('applied');
    const after = await ensureUser(pool, identity, 'en');
    expect(after.role).toBe('farm_manager');
    expect((await buildMe(pool, after)).farm?.farm_id).toBe(r.farmId);
    const second = registerOp(email);
    expect((await run(await officer(), second.op))[0]).toMatchObject({ result: 'rejected', code: 'EMAIL_HAS_FARM' });
  });

  it('refuses a farm outside his woreda, and anyone but an officer', async () => {
    const elsewhere = await officer(1001);
    expect((await run(elsewhere, registerOp(testEmail()).op))[0]).toMatchObject({ result: 'rejected', code: 'OUTSIDE_WOREDA' });
    const identity = newIdentity('Sara Tesfaye');
    const manager = await ensureUser(pool, identity, 'en');
    await run(manager, { op: 'user.update', op_id: opId(), body: { role: 'farm_manager' } });
    expect((await run(await ensureUser(pool, identity, 'en'), registerOp(testEmail()).op))[0]).toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });
  });
});
