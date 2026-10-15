import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangesResponse, SyncResponse } from '@aderratech/contracts/sync';
import { adminPool, newIdentity, opId, PLACE } from './setup.js';
import { closePool, getPool, type sql } from '../src/db/pool.js';
import { buildChanges } from '../src/changes.js';
import { applyBatch } from '../src/ops/apply.js';
import { ensureUser, type UserRow } from '../src/users.js';

let pool: sql.ConnectionPool;
let admin: sql.ConnectionPool;

beforeAll(async () => {
  admin = await adminPool();
  pool = await getPool();
});

afterAll(async () => {
  const users = "SELECT user_id FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%'";
  const reports = `SELECT report_id FROM dbo.report WHERE reporter_user_id IN (${users})`;
  const farms = `SELECT farm_id FROM dbo.farm WHERE manager_user_id IN (${users})`;
  await admin.query(`
    DELETE FROM dbo.notification WHERE report_id IN (${reports}) OR user_id IN (${users});
    DELETE FROM dbo.case_event WHERE report_id IN (${reports});
    DELETE FROM dbo.media WHERE report_id IN (${reports});
    DELETE FROM dbo.report_sign WHERE report_id IN (${reports});
    DELETE FROM dbo.report_label WHERE report_id IN (${reports});
    DELETE FROM dbo.report WHERE report_id IN (${reports});
    DELETE FROM dbo.vet_farm WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm_member_house WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm_member WHERE farm_id IN (${farms}) OR user_id IN (${users});
    DELETE FROM dbo.farm_house WHERE farm_id IN (${farms});
    DELETE FROM dbo.farm WHERE farm_id IN (${farms});
    DELETE FROM dbo.sync_op WHERE user_id IN (${users});
    DELETE FROM dbo.app_user WHERE identity_subject LIKE 'dev-test-%';`);
  await admin.close();
  await closePool();
});

const run = async (user: UserRow, ...ops: object[]) => SyncResponse.parse(await applyBatch(pool, user, ops)).results;

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => '01' + Array.from({ length: 24 }, () => crockford[Math.floor(Math.random() * 32)]).join('');
const sha = 'a'.repeat(64);
const now = () => new Date().toISOString();

async function farmWithHouses(kebele = PLACE.kebele) {
  const identity = newIdentity('Sara Tesfaye');
  let manager = await ensureUser(pool, identity, 'en');
  const farmId = randomUUID();
  const houses = [randomUUID(), randomUUID()];
  await run(manager,
    { op: 'user.update', op_id: opId(), body: { role: 'farm_manager' } },
    { op: 'farm.create', op_id: opId(), farm_id: farmId, body: { name: 'Sara Poultry', kebele_id: kebele, lat: null, lon: null, phone: null } },
    ...houses.map((id, i) => ({ op: 'house.create', op_id: opId(), house_id: id, body: { farm_id: farmId, name: `House ${i + 1}`, animal_code: 'chicken', produce_code: 'layers' } })),
  );
  manager = await ensureUser(pool, identity, 'en');
  return { manager, farmId, houses };
}

async function farmerOn(farmId: string, manager: UserRow, houseIds: string[]) {
  const identity = newIdentity('Almaz Girma');
  let farmer = await ensureUser(pool, identity, 'en');
  await run(farmer, { op: 'user.update', op_id: opId(), body: { role: 'farmer' } });
  farmer = await ensureUser(pool, identity, 'en');
  await run(farmer, { op: 'member.request', op_id: opId(), body: { farm_id: farmId } });
  await run(manager, { op: 'member.decide', op_id: opId(), body: { farm_id: farmId, user_id: farmer.user_id, decision: 'approve', house_ids: houseIds } });
  return farmer;
}

function reportOp(farmId: string | null, houseId: string | null, overrides: Record<string, unknown> = {}) {
  const reportId = ulid();
  return {
    op: 'report.create', op_id: reportId, report_id: reportId,
    body: {
      farm_id: farmId, house_id: houseId, kebele_id: PLACE.kebele, animal_code: 'chicken', produce_code: 'layers',
      reporter_role: 'farm_manager', lat: 8.62, lon: 39.12, onset: '2_3_days', medicine_given: 'no', owner_ok: true,
      created_on_device_at: now(), model_version: 'droppings-1.0.0',
      labels: [{ rank: 1, disease_code: 'newcastle_disease', score: 0.71 }, { rank: 2, disease_code: 'salmonellosis', score: 0.18 }],
      signs: [{ sign_code: 'coughing', source: 'tapped' }],
      media: [{ media_id: ulid(), kind: 'droppings', seq: 1, content_type: 'image/jpeg', captured_at: now(), size_bytes: 312004, sha256: sha }],
      ...overrides,
    },
  };
}

describe('report.create', () => {
  it("files the manager's case with a case number, the woreda's vet, labels, signs, media and history", async () => {
    const { manager, farmId, houses } = await farmWithHouses();
    const op = reportOp(farmId, houses[0]!);
    const [result] = await run(manager, op);
    expect(result).toMatchObject({ result: 'applied', server: { report_id: op.report_id, status: 'new', vet_name: 'Dr. Yonas' } });
    const server = (result as { server: { case_code: string } }).server;
    expect(server.case_code).toMatch(/^S-\d{4,}$/);

    const row = (await admin.query(`
      SELECT r.suspected_code, r.reporter_role, r.animal_code, r.vet_email,
             (SELECT COUNT(*) FROM dbo.report_label l WHERE l.report_id = r.report_id) AS labels,
             (SELECT COUNT(*) FROM dbo.report_sign s WHERE s.report_id = r.report_id) AS signs,
             (SELECT MAX(onelake_path) FROM dbo.media m WHERE m.report_id = r.report_id) AS path,
             (SELECT COUNT(*) FROM dbo.case_event e WHERE e.report_id = r.report_id AND e.type = 'received') AS received,
             (SELECT COUNT(*) FROM dbo.notification n WHERE n.report_id = r.report_id AND n.type = 'new_report') AS told
      FROM dbo.report r WHERE r.report_id = '${op.report_id}'`)).recordset[0];
    expect(row).toMatchObject({
      suspected_code: 'newcastle_disease', reporter_role: 'farm_manager', animal_code: 'chicken',
      vet_email: 'yonas.vet@aderra.test', labels: 2, signs: 1, received: 1, told: 1,
    });
    expect(row.path).toBe(`Files/global_ingress_uploads/${op.report_id}/${op.body.media[0]!.media_id}`);
  });

  it('answers a resend with the same case, stored once', async () => {
    const { manager, farmId, houses } = await farmWithHouses();
    const op = reportOp(farmId, houses[0]!);
    const [first] = await run(manager, op);
    const [again] = await run(manager, op);
    expect(again).toMatchObject({ result: 'duplicate', server: (first as { server: object }).server });
    const count = await admin.query(`SELECT COUNT(*) AS n FROM dbo.report WHERE report_id = '${op.report_id}'`);
    expect(count.recordset[0].n).toBe(1);
  });

  it('lets a farmer report only for assigned houses (T3)', async () => {
    const { manager, farmId, houses } = await farmWithHouses();
    const farmer = await farmerOn(farmId, manager, [houses[0]!]);
    expect((await run(farmer, reportOp(farmId, houses[0]!, { reporter_role: 'farmer' })))[0]!.result).toBe('applied');
    expect((await run(farmer, reportOp(farmId, houses[1]!, { reporter_role: 'farmer' })))[0]).toMatchObject({ result: 'rejected', code: 'NOT_ASSIGNED' });
  });

  it('refuses a removed farmer and a house no longer in use', async () => {
    const { manager, farmId, houses } = await farmWithHouses();
    const farmer = await farmerOn(farmId, manager, houses);
    await run(manager, { op: 'member.remove', op_id: opId(), body: { farm_id: farmId, user_id: farmer.user_id } });
    expect((await run(farmer, reportOp(farmId, houses[0]!)))[0]).toMatchObject({ result: 'rejected', code: 'NOT_MEMBER' });
    await run(manager, { op: 'house.update', op_id: opId(), house_id: houses[1], body: { active: false } });
    expect((await run(manager, reportOp(farmId, houses[1]!)))[0]).toMatchObject({ result: 'rejected', code: 'HOUSE_INACTIVE' });
  });

  it("keeps location off and accepts no media when the owner said no", async () => {
    const { manager, farmId, houses } = await farmWithHouses();
    const op = reportOp(farmId, houses[0]!, { owner_ok: false, lat: null, lon: null, media: [] });
    expect((await run(manager, op))[0]!.result).toBe('applied');
    const row = (await admin.query(`SELECT lat, lon, owner_ok FROM dbo.report WHERE report_id = '${op.report_id}'`)).recordset[0];
    expect(row).toEqual({ lat: null, lon: null, owner_ok: false });
  });

  it('keeps a case queued (retryable) when no vet covers the place', async () => {
    // A woreda the development seed gives no vet.
    await admin.query(`
      IF NOT EXISTS (SELECT 1 FROM dbo.woreda WHERE woreda_id = 99010) INSERT dbo.woreda (woreda_id, zone_id, name_en) VALUES (99010, 101, N'No-vet woreda');
      IF NOT EXISTS (SELECT 1 FROM dbo.kebele WHERE kebele_id = 9901001) INSERT dbo.kebele (kebele_id, woreda_id, name_en) VALUES (9901001, 99010, N'Kebele 01');`);
    try {
      const { manager, farmId, houses } = await farmWithHouses(9901001);
      const [result] = await run(manager, reportOp(farmId, houses[0]!));
      expect(result).toMatchObject({ result: 'rejected', code: 'NO_VET_ASSIGNED' });
      const stored = await admin.query(`SELECT COUNT(*) AS n FROM dbo.sync_op WHERE op_id = '${result!.op_id}'`);
      expect(stored.recordset[0].n).toBe(0); // not remembered, so the retry can apply
    } finally {
      const farms = "SELECT farm_id FROM dbo.farm WHERE kebele_id = 9901001";
      await admin.query(`
        DELETE FROM dbo.farm_member WHERE farm_id IN (${farms}); DELETE FROM dbo.farm_house WHERE farm_id IN (${farms});
        DELETE FROM dbo.farm WHERE kebele_id = 9901001; DELETE FROM dbo.kebele WHERE kebele_id = 9901001; DELETE FROM dbo.woreda WHERE woreda_id = 99010;`);
    }
  });
});

describe('/changes reports', () => {
  it("gives the manager the farmer's case with what was reported and by whom", async () => {
    const { manager, farmId, houses } = await farmWithHouses();
    const farmer = await farmerOn(farmId, manager, houses);
    const op = reportOp(farmId, houses[0]!, { reporter_role: 'farmer' });
    await run(farmer, op);
    const changes = ChangesResponse.parse(await buildChanges(pool, manager, null));
    expect(changes.reports).toContainEqual(expect.objectContaining({
      report_id: op.report_id, status: 'new', reporter_name: 'Almaz Girma', animal_code: 'chicken',
      onset: '2_3_days', medicine_given: 'no', owner_ok: true, house_id: houses[0],
    }));
  });
});
