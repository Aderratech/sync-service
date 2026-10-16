import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangesResponse, SyncResponse } from '@aderratech/contracts/sync';
import { adminPool, newIdentity, opId, PLACE } from './setup.js';
import { closePool, getPool, type sql } from '../src/db/pool.js';
import { buildChanges } from '../src/changes.js';
import { findMedia } from '../src/media/access.js';
import { setMediaStore, sha256, type MediaStore } from '../src/media/store.js';
import { applyBatch } from '../src/ops/apply.js';
import { ensureUser, type UserRow } from '../src/users.js';

let pool: sql.ConnectionPool;
let admin: sql.ConnectionPool;

/** An in-memory store, so tests never touch a disk folder or OneLake. */
const files = new Map<string, Buffer>();
const memory: MediaStore = {
  put: async (path, data) => void files.set(path, data),
  get: async (path) => files.get(path) ?? null,
};

beforeAll(async () => {
  admin = await adminPool();
  pool = await getPool();
  setMediaStore(memory);
});

afterAll(async () => {
  setMediaStore(null);
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
const now = () => new Date().toISOString();

async function person(role: string, name: string) {
  const identity = newIdentity(name);
  const user = await ensureUser(pool, identity, 'en');
  await run(user, { op: 'user.update', op_id: opId(), body: { role } });
  return ensureUser(pool, identity, 'en');
}

/** A farm in the test woreda, a farmer on it, and a case from the farmer with one photo. */
async function caseWithPhoto(photo: Buffer) {
  const manager = await person('farm_manager', 'Sara Tesfaye');
  const farmId = randomUUID();
  const houseId = randomUUID();
  await run(manager,
    { op: 'farm.create', op_id: opId(), farm_id: farmId, body: { name: 'Sara Poultry', kebele_id: PLACE.kebele, lat: null, lon: null, phone: null } },
    { op: 'house.create', op_id: opId(), house_id: houseId, body: { farm_id: farmId, name: 'House 1', animal_code: 'chicken', produce_code: 'layers' } });
  const farmer = await person('farmer', 'Almaz Girma');
  await run(farmer, { op: 'member.request', op_id: opId(), body: { farm_id: farmId } });
  await run(manager, { op: 'member.decide', op_id: opId(), body: { farm_id: farmId, user_id: farmer.user_id, decision: 'approve', house_ids: [houseId] } });
  const reportId = ulid();
  const mediaId = ulid();
  const results = await run(farmer, {
    op: 'report.create', op_id: reportId, report_id: reportId,
    body: {
      farm_id: farmId, house_id: houseId, kebele_id: PLACE.kebele, animal_code: 'chicken', produce_code: 'layers',
      reporter_role: 'farmer', lat: null, lon: null, onset: 'today', medicine_given: 'no', owner_ok: true,
      created_on_device_at: now(), model_version: null, labels: [], signs: [],
      media: [{ media_id: mediaId, kind: 'droppings', seq: 1, content_type: 'image/jpeg', captured_at: now(), size_bytes: photo.length, sha256: sha256(photo) }],
    },
  });
  expect(results[0]!.result).toBe('applied');
  return { manager, farmer, reportId, mediaId };
}

describe('photos', () => {
  it('confirms an upload only when the file is there whole, then the farm manager can read it', async () => {
    const photo = Buffer.from(`droppings-${randomUUID()}`);
    const { manager, farmer, mediaId } = await caseWithPhoto(photo);
    const confirm = { op: 'media.confirm', op_id: opId(), body: { media_id: mediaId, size_bytes: photo.length, sha256: sha256(photo) } };

    // Not uploaded yet: retryable, so the phone uploads again.
    expect((await run(farmer, confirm))[0]).toMatchObject({ result: 'rejected', code: 'MEDIA_MISSING' });
    const row = await findMedia(pool, farmer, mediaId);
    expect(row?.onelake_path).toMatch(new RegExp(`${mediaId}$`));

    // A different file: still missing.
    files.set(row!.onelake_path, Buffer.from('something else'));
    expect((await run(farmer, { ...confirm, op_id: opId() }))[0]).toMatchObject({ result: 'rejected', code: 'MEDIA_MISSING' });

    files.set(row!.onelake_path, photo);
    expect((await run(farmer, { ...confirm, op_id: opId() }))[0]!.result).toBe('applied');
    expect((await findMedia(pool, farmer, mediaId))?.uploaded_at).not.toBeNull();

    // The farm's manager reads it and sees it in /changes; someone unrelated may not.
    expect((await findMedia(pool, manager, mediaId))?.can_read).toBe(true);
    const changes = ChangesResponse.parse(await buildChanges(pool, manager, null));
    expect(changes.media).toContainEqual(expect.objectContaining({ media_id: mediaId, kind: 'droppings', seq: 1, content_type: 'image/jpeg' }));
    const stranger = await person('farm_manager', 'Hana Bekele');
    expect((await findMedia(pool, stranger, mediaId))?.can_read).toBe(false);
  });

  it('lets only the reporter confirm a photo', async () => {
    const photo = Buffer.from(`droppings-${randomUUID()}`);
    const { manager, mediaId } = await caseWithPhoto(photo);
    expect((await run(manager, { op: 'media.confirm', op_id: opId(), body: { media_id: mediaId, size_bytes: photo.length, sha256: sha256(photo) } }))[0])
      .toMatchObject({ result: 'rejected', code: 'FORBIDDEN' });
  });

  it('keeps interim photos under MEDIA_FOLDER', async () => {
    process.env.MEDIA_FOLDER = 'interim';
    try {
      const photo = Buffer.from(`droppings-${randomUUID()}`);
      const { farmer, reportId, mediaId } = await caseWithPhoto(photo);
      expect((await findMedia(pool, farmer, mediaId))?.onelake_path).toBe(`Files/interim/uploads/${reportId}/${mediaId}`);
    } finally {
      delete process.env.MEDIA_FOLDER;
    }
  });
});
