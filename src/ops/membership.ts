import type { Operation } from '@aderratech/contracts/sync';
import { sql } from '../db/pool.js';
import { notify } from '../notify.js';
import type { UserRow } from '../users.js';
import { managerOf } from './farm.js';
import { applied, reject, type Outcome } from './outcome.js';

type Op<K extends Operation['op']> = Extract<Operation, { op: K }>;

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

async function membership(tx: sql.Transaction, farmId: string, userId: string) {
  const r = await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, farmId)
    .input('user', sql.UniqueIdentifier, userId)
    .query<{ state: string; name: string; farm_name: string }>(`
      SELECT m.state, u.name, f.name AS farm_name
      FROM dbo.farm_member m JOIN dbo.app_user u ON u.user_id = m.user_id JOIN dbo.farm f ON f.farm_id = m.farm_id
      WHERE m.farm_id = @farm AND m.user_id = @user`);
  return r.recordset[0] ?? null;
}

/** A farmer asks to join, by join code or by picking the farm (§15 C1). One active farm per farmer (open question 4). */
export async function memberRequest(tx: sql.Transaction, user: UserRow, op: Op<'member.request'>): Promise<Outcome> {
  if (user.role !== 'farmer') return reject('FORBIDDEN', 'Only a farmer can ask to join a farm.');
  const b = op.body;
  const found = await new sql.Request(tx)
    .input('code', sql.VarChar(12), b.join_code?.trim().toUpperCase() ?? null)
    .input('farm', sql.UniqueIdentifier, b.farm_id ?? null)
    .query<{ farm_id: string; name: string; manager_user_id: string }>(`
      SELECT farm_id, name, manager_user_id FROM dbo.farm
      WHERE (@code IS NOT NULL AND join_code = @code) OR (@farm IS NOT NULL AND farm_id = @farm)`);
  const farm = found.recordset[0];
  if (!farm) return reject('JOIN_CODE_UNKNOWN', 'No farm has this code.');

  await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, farm.farm_id)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('note', sql.NVarChar(500), b.request_note ?? null)
    .query(`
      MERGE dbo.farm_member AS t USING (SELECT @farm AS farm_id, @user AS user_id) AS s
        ON t.farm_id = s.farm_id AND t.user_id = s.user_id
      WHEN MATCHED THEN UPDATE SET state = 'requested', request_note = @note, requested_at = SYSUTCDATETIME(),
                                   decided_by = NULL, decided_at = NULL
      WHEN NOT MATCHED THEN INSERT (farm_id, user_id, state, request_note) VALUES (@farm, @user, 'requested', @note);`);
  await notify(tx, {
    userId: farm.manager_user_id,
    type: 'join_request',
    subjectUserId: user.user_id, // so the manager's phone knows when this request has been decided
    title: `${user.name} wants to join`,
    text: `${farm.name}: approve or decline in Farmers.`,
  });
  return applied();
}

export async function memberCancel(tx: sql.Transaction, user: UserRow, op: Op<'member.cancel'>): Promise<Outcome> {
  const current = await membership(tx, op.body.farm_id, user.user_id);
  if (current?.state !== 'requested') return reject('FORBIDDEN', 'There is no open request to cancel.');
  await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, op.body.farm_id)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .query("UPDATE dbo.farm_member SET state = 'cancelled' WHERE farm_id = @farm AND user_id = @user");
  return applied();
}

/** The houses a member may report for: ended rows are kept with removed_at (no deletes). */
async function setHouses(tx: sql.Transaction, farmId: string, userId: string, houseIds: string[]): Promise<Outcome | null> {
  const valid = await new sql.Request(tx).input('farm', sql.UniqueIdentifier, farmId)
    .query<{ house_id: string }>('SELECT house_id FROM dbo.farm_house WHERE farm_id = @farm');
  const ofFarm = new Set(valid.recordset.map((h) => h.house_id.toLowerCase()));
  const wanted = [...new Set(houseIds.map((id) => id.toLowerCase()))];
  if (wanted.some((id) => !ofFarm.has(id))) return reject('INVALID_PAYLOAD', 'A house is not on this farm.');

  const current = await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, farmId)
    .input('user', sql.UniqueIdentifier, userId)
    .query<{ house_id: string; removed_at: Date | null }>(
      'SELECT house_id, removed_at FROM dbo.farm_member_house WHERE farm_id = @farm AND user_id = @user');
  const rows = new Map(current.recordset.map((r) => [r.house_id.toLowerCase(), r.removed_at]));

  for (const [houseId, removedAt] of rows) {
    if (!removedAt && !wanted.includes(houseId)) {
      await new sql.Request(tx).input('f', sql.UniqueIdentifier, farmId).input('u', sql.UniqueIdentifier, userId).input('h', sql.UniqueIdentifier, houseId)
        .query('UPDATE dbo.farm_member_house SET removed_at = SYSUTCDATETIME() WHERE farm_id = @f AND user_id = @u AND house_id = @h');
    }
  }
  for (const houseId of wanted) {
    const request = new sql.Request(tx).input('f', sql.UniqueIdentifier, farmId).input('u', sql.UniqueIdentifier, userId).input('h', sql.UniqueIdentifier, houseId);
    if (!rows.has(houseId)) {
      await request.query('INSERT INTO dbo.farm_member_house (farm_id, user_id, house_id) VALUES (@f, @u, @h)');
    } else if (rows.get(houseId)) {
      await request.query('UPDATE dbo.farm_member_house SET removed_at = NULL, assigned_at = SYSUTCDATETIME() WHERE farm_id = @f AND user_id = @u AND house_id = @h');
    }
  }
  return null;
}

export async function memberDecide(tx: sql.Transaction, user: UserRow, op: Op<'member.decide'>): Promise<Outcome> {
  const b = op.body;
  if (!same(await managerOf(tx, b.farm_id), user.user_id)) return reject('FORBIDDEN', 'Only the farm manager can do this.');
  const current = await membership(tx, b.farm_id, b.user_id);
  if (current?.state !== 'requested') return reject('FORBIDDEN', 'This request is no longer open.');

  const approve = b.decision === 'approve';
  await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, b.farm_id)
    .input('member', sql.UniqueIdentifier, b.user_id)
    .input('manager', sql.UniqueIdentifier, user.user_id)
    .input('state', sql.VarChar(10), approve ? 'active' : 'declined')
    .query(`UPDATE dbo.farm_member SET state = @state, decided_by = @manager, decided_at = SYSUTCDATETIME()
            WHERE farm_id = @farm AND user_id = @member`);
  if (approve) {
    // Approve asks which houses; the default is all active houses (§15 B5).
    let houses = b.house_ids;
    if (!houses) {
      const all = await new sql.Request(tx).input('farm', sql.UniqueIdentifier, b.farm_id)
        .query<{ house_id: string }>('SELECT house_id FROM dbo.farm_house WHERE farm_id = @farm AND active = 1');
      houses = all.recordset.map((h) => h.house_id);
    }
    const problem = await setHouses(tx, b.farm_id, b.user_id, houses);
    if (problem) return problem;
  }
  await notify(tx, {
    userId: b.user_id,
    type: 'membership_decided',
    title: approve ? `You're in ${current.farm_name}` : 'Your request was declined',
    text: approve ? "The cases you report now go to the farm's vet." : `${current.farm_name} declined your request to join.`,
  });
  return applied();
}

export async function memberRemove(tx: sql.Transaction, user: UserRow, op: Op<'member.remove'>): Promise<Outcome> {
  const b = op.body;
  if (!same(await managerOf(tx, b.farm_id), user.user_id)) return reject('FORBIDDEN', 'Only the farm manager can do this.');
  if (same(b.user_id, user.user_id)) return reject('FORBIDDEN', 'The farm manager cannot be removed.');
  const current = await membership(tx, b.farm_id, b.user_id);
  if (current?.state !== 'active') return reject('NOT_MEMBER', 'This person is not on the farm.');
  await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, b.farm_id)
    .input('member', sql.UniqueIdentifier, b.user_id)
    .input('manager', sql.UniqueIdentifier, user.user_id)
    .query(`UPDATE dbo.farm_member SET state = 'removed', decided_by = @manager, decided_at = SYSUTCDATETIME()
            WHERE farm_id = @farm AND user_id = @member;
            UPDATE dbo.farm_member_house SET removed_at = SYSUTCDATETIME()
            WHERE farm_id = @farm AND user_id = @member AND removed_at IS NULL;`);
  return applied();
}

export async function memberAssignHouses(tx: sql.Transaction, user: UserRow, op: Op<'member.assign_houses'>): Promise<Outcome> {
  const b = op.body;
  if (!same(await managerOf(tx, b.farm_id), user.user_id)) return reject('FORBIDDEN', 'Only the farm manager can do this.');
  const current = await membership(tx, b.farm_id, b.user_id);
  if (current?.state !== 'active') return reject('NOT_MEMBER', 'This person is not on the farm.');
  return (await setHouses(tx, b.farm_id, b.user_id, b.house_ids)) ?? applied();
}
