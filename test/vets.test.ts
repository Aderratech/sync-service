import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangesResponse, SyncResponse } from '@aderratech/contracts/sync';
import { adminPool, newIdentity, opId, PLACE } from './setup.js';
import { closePool, getPool, type sql } from '../src/db/pool.js';
import { buildChanges } from '../src/changes.js';
import { applyBatch } from '../src/ops/apply.js';
import { ensureUser, getUser, type UserRow } from '../src/users.js';
import { vetsForFarm, vetsOfFarms } from '../src/vets.js';

let pool: sql.ConnectionPool;
let admin: sql.ConnectionPool;
let yonas: string;
const YONAS_EMAIL = 'yonas.vet@aderra.test';

beforeAll(async () => {
  admin = await adminPool();
  pool = await getPool();
  yonas = (await admin.query(`SELECT LOWER(CONVERT(CHAR(36), user_id)) AS id FROM dbo.app_user WHERE email = '${YONAS_EMAIL}'`)).recordset[0].id;
  // Dr. Yonas as a database user, so the tests can act as him under row-level security (USER_NAME() = his email).
  await admin.query(`
    IF USER_ID('${YONAS_EMAIL}') IS NULL CREATE USER [${YONAS_EMAIL}] WITHOUT LOGIN;
    IF IS_ROLEMEMBER('aderra_vet_read', '${YONAS_EMAIL}') = 0 ALTER ROLE aderra_vet_read ADD MEMBER [${YONAS_EMAIL}];`);
});

afterAll(async () => {
  // Test users, and the placeholders their invitations made (email dev-test-…@aderra.test).
  const users = "SELECT user_id FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%' OR identity_subject LIKE 'invite:dev-test-%'";
  const farms = `SELECT farm_id FROM dbo.farm WHERE manager_user_id IN (${users})`;
  await admin.query(`
    DELETE FROM dbo.notification WHERE user_id IN (${users}) OR subject_user_id IN (${users});
    DELETE FROM dbo.email_outbox WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm_vet_request WHERE farm_id IN (${farms});
    DELETE FROM dbo.vet_farm WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm_invite WHERE farm_id IN (${farms});
    DELETE FROM dbo.officer_farm WHERE farm_id IN (${farms}) OR officer_user_id IN (${users});
    DELETE FROM dbo.officer_woreda WHERE officer_user_id IN (${users});
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

async function managerWithFarm() {
  const identity = newIdentity('Sara Tesfaye');
  const user = await ensureUser(pool, identity, 'en');
  const farmId = randomUUID();
  await run(user,
    { op: 'user.update', op_id: opId(), body: { role: 'farm_manager' } },
    { op: 'farm.create', op_id: opId(), farm_id: farmId, body: { name: 'Sara Poultry', kebele_id: PLACE.kebele, lat: null, lon: null, phone: null } },
    { op: 'house.create', op_id: opId(), house_id: randomUUID(), body: { farm_id: farmId, name: 'House 1', animal_code: 'chicken', produce_code: 'layers' } });
  return { manager: await ensureUser(pool, identity, 'en'), farmId };
}

/** Acts as Dr. Yonas under row-level security, as the portal does through the delegated connector. */
async function asYonas(statement: string): Promise<number> {
  const r = await admin.query(`EXECUTE AS USER = '${YONAS_EMAIL}'; ${statement}; SELECT @@ROWCOUNT AS n; REVERT;`);
  return r.recordset[0].n;
}

const requestOf = async (farmId: string) =>
  (await admin.query(`SELECT TOP 1 request_id, state, vet_email, farm_name, houses FROM dbo.farm_vet_request WHERE farm_id = '${farmId}' ORDER BY requested_at DESC`)).recordset[0];

describe("a farm's vet", () => {
  it('offers the vets serving the woreda, and asks one, who is notified with a snapshot of the farm', async () => {
    const { manager, farmId } = await managerWithFarm();
    const vets = await vetsForFarm(pool, manager, farmId);
    expect(vets.map((v) => v.name)).toContain('Dr. Yonas');

    expect((await run(manager, { op: 'farm.vet_request', op_id: opId(), farm_id: farmId, body: { vet_user_id: yonas } }))[0]!.result).toBe('applied');
    expect(await requestOf(farmId)).toMatchObject({ state: 'requested', vet_email: YONAS_EMAIL, farm_name: 'Sara Poultry', houses: 'House 1 (chicken, layers)' });
    const told = await admin.query(`SELECT type FROM dbo.notification WHERE user_id = '${yonas}' AND subject_user_id = '${manager.user_id}'`);
    expect(told.recordset.map((r) => r.type)).toContain('vet_request');
    expect((await vetsOfFarms(pool, [farmId])).get(farmId)).toMatchObject({ state: 'requested', name: 'Dr. Yonas' });
  });

  it('lets the vet answer only their own request, and add the farm only once accepted (row-level security)', async () => {
    const { manager, farmId } = await managerWithFarm();
    await run(manager, { op: 'farm.vet_request', op_id: opId(), farm_id: farmId, body: { vet_user_id: yonas } });
    const { request_id } = await requestOf(farmId);
    const addFarm = `INSERT dbo.vet_farm (vet_user_id, vet_email, farm_id, valid_from) VALUES ('${yonas}', '${YONAS_EMAIL}', '${farmId}', CAST(SYSUTCDATETIME() AS DATE))`;

    // Not accepted yet: the assignment is refused.
    await expect(asYonas(addFarm)).rejects.toThrow(/block predicate/i);
    // Only accepted or declined.
    await expect(asYonas(`UPDATE dbo.farm_vet_request SET state = 'removed' WHERE request_id = '${request_id}'`)).rejects.toThrow(/block predicate/i);
    // Another vet's request is invisible to him.
    await admin.query(`UPDATE dbo.farm_vet_request SET vet_email = 'someone.else@aderra.test' WHERE request_id = '${request_id}'`);
    expect(await asYonas(`UPDATE dbo.farm_vet_request SET state = 'accepted' WHERE request_id = '${request_id}'`)).toBe(0);
    await admin.query(`UPDATE dbo.farm_vet_request SET vet_email = '${YONAS_EMAIL}' WHERE request_id = '${request_id}'`);

    // His own: accept, then add the farm, as the portal does.
    expect(await asYonas(`UPDATE dbo.farm_vet_request SET state = 'accepted', decided_at = SYSUTCDATETIME() WHERE request_id = '${request_id}'`)).toBe(1);
    expect(await asYonas(addFarm)).toBe(1);

    // The manager is told once, on their next pull, and sees the vet.
    const first = ChangesResponse.parse(await buildChanges(pool, manager, null));
    expect(first.notifications.filter((n) => n.type === 'vet_decided')).toHaveLength(1);
    expect(first.farms!.find((f) => f.farm_id === farmId)?.vet).toMatchObject({ state: 'accepted', name: 'Dr. Yonas' });
    const again = ChangesResponse.parse(await buildChanges(pool, manager, null));
    expect(again.notifications.filter((n) => n.type === 'vet_decided')).toHaveLength(1);
  });

  it('removes the vet (who is told), ends the assignment, and can ask the same vet again', async () => {
    const { manager, farmId } = await managerWithFarm();
    await run(manager, { op: 'farm.vet_request', op_id: opId(), farm_id: farmId, body: { vet_user_id: yonas } });
    const { request_id } = await requestOf(farmId);
    await asYonas(`UPDATE dbo.farm_vet_request SET state = 'accepted', decided_at = SYSUTCDATETIME() WHERE request_id = '${request_id}'`);
    await asYonas(`INSERT dbo.vet_farm (vet_user_id, vet_email, farm_id, valid_from) VALUES ('${yonas}', '${YONAS_EMAIL}', '${farmId}', CAST(SYSUTCDATETIME() AS DATE))`);

    // A farm with a vet removes it before asking another.
    expect((await run(manager, { op: 'farm.vet_request', op_id: opId(), farm_id: farmId, body: { vet_user_id: yonas } }))[0])
      .toMatchObject({ result: 'rejected', code: 'INVALID_PAYLOAD' });
    expect((await run(manager, { op: 'farm.vet_remove', op_id: opId(), farm_id: farmId, body: {} }))[0]!.result).toBe('applied');
    expect((await requestOf(farmId)).state).toBe('removed');
    const left = await admin.query(`SELECT COUNT(*) AS n FROM dbo.vet_farm WHERE farm_id = '${farmId}' AND valid_to IS NULL`);
    expect(left.recordset[0].n).toBe(0);
    const told = await admin.query(`SELECT COUNT(*) AS n FROM dbo.notification WHERE user_id = '${yonas}' AND type = 'vet_removed' AND subject_user_id = '${manager.user_id}'`);
    expect(told.recordset[0].n).toBe(1);

    expect((await run(manager, { op: 'farm.vet_request', op_id: opId(), farm_id: farmId, body: { vet_user_id: yonas } }))[0]!.result).toBe('applied');
    expect((await requestOf(farmId)).state).toBe('requested');
  });

  it("refuses anyone but the farm's manager, and offers a test account the test vet only", async () => {
    const { farmId } = await managerWithFarm();
    const identity = newIdentity('Almaz Girma');
    const other = await ensureUser(pool, identity, 'en');
    await run(other, { op: 'user.update', op_id: opId(), body: { role: 'farm_manager' } });
    expect((await run(await getUser(pool, other.user_id), { op: 'farm.vet_request', op_id: opId(), farm_id: farmId, body: { vet_user_id: yonas } }))[0])
      .toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });

    const { manager, farmId: ownFarm } = await managerWithFarm();
    process.env.TEST_VET_EMAIL = 'nobody.vet@aderra.test';
    try {
      expect(await vetsForFarm(pool, manager, ownFarm)).toEqual([]);
      process.env.TEST_VET_EMAIL = YONAS_EMAIL.toUpperCase();
      expect((await vetsForFarm(pool, manager, ownFarm)).map((v) => v.name)).toEqual(['Dr. Yonas']);
    } finally {
      delete process.env.TEST_VET_EMAIL;
    }
  });

  it('lets the officer who registered a farm choose its vet until its manager signs in', async () => {
    const identity = newIdentity('Kebede Alemu');
    const officer0 = await ensureUser(pool, identity, 'en');
    await run(officer0, { op: 'user.update', op_id: opId(), body: { role: 'extension_officer', woreda_id: PLACE.woreda } });
    const officer = await getUser(pool, officer0.user_id);
    const farmId = randomUUID();
    await run(officer, { op: 'farm.register', op_id: opId(), farm_id: farmId, body: {
      name: 'Abebe Poultry', kebele_id: PLACE.kebele, lat: null, lon: null, phone: null, manager_email: `dev-test-${randomUUID()}@aderra.test`,
      house: { house_id: randomUUID(), name: 'House 1', animal_code: 'chicken', produce_code: 'layers' } } });
    expect((await run(officer, { op: 'farm.vet_request', op_id: opId(), farm_id: farmId, body: { vet_user_id: yonas } }))[0]!.result).toBe('applied');
  });
});
