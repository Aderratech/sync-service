import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangesResponse } from '@aderratech/contracts/sync';
import { adminPool, newIdentity, opId, PLACE } from './setup.js';
import { closePool, getPool, type sql } from '../src/db/pool.js';
import { buildChanges } from '../src/changes.js';
import { applyBatch } from '../src/ops/apply.js';
import { ensureUser, type UserRow } from '../src/users.js';

let pool: sql.ConnectionPool;
let admin: sql.ConnectionPool;
const KEBELE = PLACE.kebele;

beforeAll(async () => {
  admin = await adminPool();
  pool = await getPool();
});

afterAll(async () => {
  const users = "SELECT user_id FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%'";
  const farms = `SELECT farm_id FROM dbo.farm WHERE manager_user_id IN (${users})`;
  await admin.query(`
    DELETE FROM dbo.notification WHERE user_id IN (${users});
    DELETE FROM dbo.farm_member_house WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm_member WHERE farm_id IN (${farms}) OR user_id IN (${users});
    DELETE FROM dbo.farm_house WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm WHERE farm_id IN (${farms});
    DELETE FROM dbo.sync_op WHERE user_id IN (${users});
    DELETE FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%';`);
  await admin.close();
  await closePool();
});

const run = async (user: UserRow, ...ops: object[]) => (await applyBatch(pool, user, ops)).results;

/** A manager who has chosen the role, created a farm and one house, in one batch, as the phone sends it after B3. */
async function managerWithFarm() {
  const identity = newIdentity('Sara Tesfaye');
  const user = await ensureUser(pool, identity, 'en');
  const farmId = randomUUID();
  const houseId = randomUUID();
  const results = await run(user,
    { op: 'user.update', op_id: opId(), body: { role: 'farm_manager' } },
    { op: 'farm.create', op_id: opId(), farm_id: farmId, body: { name: 'Sara Poultry', kebele_id: KEBELE, lat: null, lon: null, phone: null } },
    { op: 'house.create', op_id: opId(), house_id: houseId, body: { farm_id: farmId, name: 'House 1', animal_code: 'chicken', produce_code: 'layers' } },
  );
  return { identity, farmId, houseId, results, manager: await ensureUser(pool, identity, 'en') };
}

async function farmer(name = 'Almaz Girma') {
  const identity = newIdentity(name);
  const user = await ensureUser(pool, identity, 'en');
  await run(user, { op: 'user.update', op_id: opId(), body: { role: 'farmer' } });
  return ensureUser(pool, identity, 'en');
}

describe('farm set-up', () => {
  it('creates the farm and its house with the IDs the phone minted, in one batch after choosing the role', async () => {
    const { results, farmId, manager } = await managerWithFarm();
    expect(results.map((r) => r.result)).toEqual(['applied', 'applied', 'applied']);
    const server = (results[1] as { server: { farm_code: string; join_code: string } }).server;
    expect(server.farm_code).toMatch(/^F-\d{2,}$/);
    expect(server.join_code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{6}$/);

    const changes = ChangesResponse.parse(await buildChanges(pool, manager, null));
    expect(changes.farm).toMatchObject({ farm_id: farmId, name: 'Sara Poultry', join_code: server.join_code });
    expect(changes.farm!.houses).toEqual([expect.objectContaining({ name: 'House 1', animal_code: 'chicken', active: true })]);
    // The manager is the farm's first active member.
    expect(changes.memberships).toEqual([expect.objectContaining({ user_id: manager.user_id.toLowerCase(), state: 'active' })]);
  });

  it('allows one farm per manager, and only managers create farms', async () => {
    const { manager } = await managerWithFarm();
    const second = await run(manager, { op: 'farm.create', op_id: opId(), farm_id: randomUUID(), body: { name: 'Second', kebele_id: KEBELE, lat: null, lon: null, phone: null } });
    expect(second[0]).toMatchObject({ result: 'rejected', code: 'ALREADY_HAS_FARM' });
    const notManager = await run(await farmer(), { op: 'farm.create', op_id: opId(), farm_id: randomUUID(), body: { name: 'Mine', kebele_id: KEBELE, lat: null, lon: null, phone: null } });
    expect(notManager[0]).toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });
  });

  it("refuses house changes from anyone but the farm's manager", async () => {
    const { farmId, houseId } = await managerWithFarm();
    const other = await farmer();
    const results = await run(other,
      { op: 'house.create', op_id: opId(), house_id: randomUUID(), body: { farm_id: farmId, name: 'Mine', animal_code: 'chicken', produce_code: null } },
      { op: 'house.update', op_id: opId(), house_id: houseId, body: { active: false } },
    );
    expect(results.map((r) => r.result === 'rejected' && r.code)).toEqual(['FORBIDDEN', 'FORBIDDEN']);
  });
});

describe('joining a farm', () => {
  it('request by code, approve with houses, and both sides see it in /changes', async () => {
    const { manager, farmId, houseId, results } = await managerWithFarm();
    const joinCode = (results[1] as { server: { join_code: string } }).server.join_code;
    const almaz = await farmer();

    const asked = await run(almaz, { op: 'member.request', op_id: opId(), body: { join_code: joinCode.toLowerCase(), request_note: 'I work in House 1' } });
    expect(asked[0]!.result).toBe('applied');

    const forManager = ChangesResponse.parse(await buildChanges(pool, manager, null));
    expect(forManager.memberships).toContainEqual(expect.objectContaining({ user_id: almaz.user_id.toLowerCase(), state: 'requested', request_note: 'I work in House 1' }));
    expect(forManager.notifications).toContainEqual(expect.objectContaining({
      type: 'join_request', title: 'Almaz Girma wants to join', subject_user_id: almaz.user_id.toLowerCase(),
    }));

    const decided = await run(manager, { op: 'member.decide', op_id: opId(), body: { farm_id: farmId, user_id: almaz.user_id, decision: 'approve' } });
    expect(decided[0]!.result).toBe('applied');

    const forFarmer = ChangesResponse.parse(await buildChanges(pool, almaz, null));
    expect(forFarmer.farm).toMatchObject({ farm_id: farmId, join_code: null }); // the code is the manager's to share
    expect(forFarmer.memberships).toEqual([expect.objectContaining({ state: 'active', house_ids: [houseId] })]);
    expect(forFarmer.notifications).toContainEqual(expect.objectContaining({ type: 'membership_decided', title: "You're in Sara Poultry" }));
  });

  it('rejects an unknown code, and a second farm for an active farmer', async () => {
    const almaz = await farmer();
    expect((await run(almaz, { op: 'member.request', op_id: opId(), body: { join_code: 'ZZZZZZ' } }))[0])
      .toMatchObject({ result: 'rejected', code: 'JOIN_CODE_UNKNOWN' });

    const first = await managerWithFarm();
    const second = await managerWithFarm();
    await run(almaz, { op: 'member.request', op_id: opId(), body: { farm_id: first.farmId } });
    await run(first.manager, { op: 'member.decide', op_id: opId(), body: { farm_id: first.farmId, user_id: almaz.user_id, decision: 'approve' } });
    expect((await run(almaz, { op: 'member.request', op_id: opId(), body: { farm_id: second.farmId } }))[0])
      .toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });
  });

  it('removes a farmer, ending their houses without deleting the rows, and can assign houses again later', async () => {
    const { manager, farmId, houseId } = await managerWithFarm();
    const almaz = await farmer();
    await run(almaz, { op: 'member.request', op_id: opId(), body: { farm_id: farmId } });
    await run(manager, { op: 'member.decide', op_id: opId(), body: { farm_id: farmId, user_id: almaz.user_id, decision: 'approve' } });
    expect((await run(manager, { op: 'member.remove', op_id: opId(), body: { farm_id: farmId, user_id: almaz.user_id } }))[0]!.result).toBe('applied');

    const rows = await admin.query(`SELECT removed_at FROM dbo.farm_member_house WHERE user_id = '${almaz.user_id}'`);
    expect(rows.recordset).toHaveLength(1);
    expect(rows.recordset[0].removed_at).not.toBeNull();

    // Back on the farm (asks again, approved with no houses), then assigned: the ended row restarts.
    await run(almaz, { op: 'member.request', op_id: opId(), body: { farm_id: farmId } });
    await run(manager, { op: 'member.decide', op_id: opId(), body: { farm_id: farmId, user_id: almaz.user_id, decision: 'approve', house_ids: [] } });
    expect((await run(manager, { op: 'member.assign_houses', op_id: opId(), body: { farm_id: farmId, user_id: almaz.user_id, house_ids: [houseId] } }))[0]!.result).toBe('applied');
    const again = await admin.query(`SELECT removed_at FROM dbo.farm_member_house WHERE user_id = '${almaz.user_id}'`);
    expect(again.recordset).toEqual([{ removed_at: null }]);
  });

  it('lets a farmer cancel an open request', async () => {
    const { farmId, manager } = await managerWithFarm();
    const almaz = await farmer();
    await run(almaz, { op: 'member.request', op_id: opId(), body: { farm_id: farmId } });
    expect((await run(almaz, { op: 'member.cancel', op_id: opId(), body: { farm_id: farmId } }))[0]!.result).toBe('applied');
    const decided = await run(manager, { op: 'member.decide', op_id: opId(), body: { farm_id: farmId, user_id: almaz.user_id, decision: 'approve' } });
    expect(decided[0]).toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });
  });
});

describe('notifications', () => {
  it("marks the user's own notifications read, and ignores anyone else's", async () => {
    const { manager, farmId } = await managerWithFarm();
    const almaz = await farmer();
    await run(almaz, { op: 'member.request', op_id: opId(), body: { farm_id: farmId } });
    const mine = ChangesResponse.parse(await buildChanges(pool, manager, null)).notifications;
    const request = mine.find((n) => n.type === 'join_request')!;
    expect(request.read_at).toBeNull();

    // Someone else trying to mark it read changes nothing.
    expect((await run(almaz, { op: 'notification.read', op_id: opId(), body: { notification_ids: [request.notification_id] } }))[0]!.result).toBe('applied');
    expect(ChangesResponse.parse(await buildChanges(pool, manager, null)).notifications.find((n) => n.notification_id === request.notification_id)!.read_at).toBeNull();

    expect((await run(manager, { op: 'notification.read', op_id: opId(), body: { notification_ids: [request.notification_id] } }))[0]!.result).toBe('applied');
    const after = ChangesResponse.parse(await buildChanges(pool, manager, null)).notifications.find((n) => n.notification_id === request.notification_id)!;
    expect(after.read_at).not.toBeNull();
  });
});

describe('/changes', () => {
  it('sends the reference lists once, then only when their version changes', async () => {
    const user = await farmer();
    const first = ChangesResponse.parse(await buildChanges(pool, user, null));
    expect(first.reference?.woreda?.rows.length).toBeGreaterThanOrEqual(16);
    expect(first.reference?.kebele?.rows[0]).toEqual(expect.objectContaining({ lat: expect.any(Number), lon: expect.any(Number) }));
    expect(first.reference?.sign?.rows.length).toBe(10);

    const second = ChangesResponse.parse(await buildChanges(pool, user, first.cursor));
    expect(second.reference).toBeNull();

    await admin.query("UPDATE dbo.reference_version SET version = version + 1 WHERE table_name = 'sign'");
    try {
      const third = ChangesResponse.parse(await buildChanges(pool, user, second.cursor));
      expect(Object.keys(third.reference ?? {})).toEqual(['sign']);
    } finally {
      await admin.query("UPDATE dbo.reference_version SET version = version - 1 WHERE table_name = 'sign'");
    }
  });

  it('treats an unreadable cursor as a fresh start', async () => {
    const changes = ChangesResponse.parse(await buildChanges(pool, await farmer(), 'not-a-cursor'));
    expect(changes.reference).not.toBeNull();
  });
});
