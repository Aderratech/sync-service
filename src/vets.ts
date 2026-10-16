import type { FarmVetsResponse, Operation } from '@aderratech/contracts/sync';
import { sql } from './db/pool.js';
import { notify } from './notify.js';
import { applied, lc, reject, type Outcome } from './ops/outcome.js';
import type { UserRow } from './users.js';

/**
 * A farm's vet (contracts farm_vet_request). The farm manager, or the officer who registered a farm whose
 * manager is not on Aderra yet, asks a vet serving the farm's woreda; the vet answers in the portal, and on
 * accepting adds the farm assignment (vet_farm) that routes the farm's cases to them. The farm can remove its
 * vet and ask again. Test-button accounts ask, and are routed to, the test vet only (TEST_VET_EMAIL).
 */

type Db = sql.ConnectionPool | sql.Transaction;
const request = (db: Db) => new sql.Request(db as sql.ConnectionPool);

/** The test vet test accounts see and are routed to, when set (the live and interim services). */
export const testVetEmail = (): string | null => process.env.TEST_VET_EMAIL?.trim().toLowerCase() || null;

/** Who may choose the farm's vet: its manager, or the officer who registered it while its manager is not on Aderra. */
export async function mayChooseVet(db: Db, user: UserRow, farmId: string): Promise<boolean> {
  const r = await request(db)
    .input('farm', sql.UniqueIdentifier, farmId)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .query(`
      SELECT 1 AS x FROM dbo.farm f WHERE f.farm_id = @farm
        AND (f.manager_user_id = @user
             OR EXISTS (SELECT 1 FROM dbo.farm_invite i WHERE i.farm_id = f.farm_id AND i.invited_by = @user AND i.claimed_at IS NULL))`);
  return r.recordset.length > 0;
}

/** Vets serving the farm's woreda: covering it, or the vet of another farm in it. A test account sees the test vet only. */
export async function vetsForFarm(db: Db, user: UserRow, farmId: string): Promise<FarmVetsResponse['vets']> {
  const testVet = testVetEmail();
  const r = await request(db)
    .input('farm', sql.UniqueIdentifier, farmId)
    .input('test', sql.NVarChar(320), user.is_test ? testVet : null)
    .input('onlyTest', sql.Bit, user.is_test && testVet ? 1 : 0)
    .query<{ vet_user_id: string; name: string; farms_in_woreda: number }>(`
      DECLARE @woreda INT = (SELECT k.woreda_id FROM dbo.farm f JOIN dbo.kebele k ON k.kebele_id = f.kebele_id WHERE f.farm_id = @farm);
      SELECT u.user_id AS vet_user_id, u.name,
             (SELECT COUNT(DISTINCT v.farm_id) FROM dbo.vet_farm v JOIN dbo.farm f ON f.farm_id = v.farm_id JOIN dbo.kebele k ON k.kebele_id = f.kebele_id
               WHERE v.vet_user_id = u.user_id AND k.woreda_id = @woreda AND v.valid_to IS NULL) AS farms_in_woreda
      FROM dbo.app_user u
      WHERE u.role = 'vet'
        AND ((@onlyTest = 1 AND LOWER(u.email) = @test)
          OR (@onlyTest = 0 AND EXISTS (
                SELECT 1 FROM dbo.vet_farm v
                LEFT JOIN dbo.farm f ON f.farm_id = v.farm_id LEFT JOIN dbo.kebele k ON k.kebele_id = f.kebele_id
                WHERE v.vet_user_id = u.user_id AND (v.valid_to IS NULL OR v.valid_to >= CAST(SYSUTCDATETIME() AS DATE))
                  AND (v.woreda_id = @woreda OR k.woreda_id = @woreda))))
      ORDER BY u.name`);
  return r.recordset.map((v) => ({ ...v, vet_user_id: lc(v.vet_user_id) }));
}

export type FarmVet = { vet_user_id: string; name: string; state: 'requested' | 'accepted'; since: string };

/** Each farm's vet: an open request (waiting or accepted), else its current farm assignment. */
export async function vetsOfFarms(db: Db, farmIds: string[]): Promise<Map<string, FarmVet>> {
  const out = new Map<string, FarmVet>();
  if (!farmIds.length) return out;
  const r = await request(db).input('ids', sql.NVarChar(sql.MAX), JSON.stringify(farmIds)).query<{
    farm_id: string; vet_user_id: string; name: string; state: string; since: Date; rank: number;
  }>(`
    SELECT q.farm_id, q.vet_user_id, u.name, q.state, COALESCE(q.decided_at, q.requested_at) AS since, 0 AS rank
    FROM dbo.farm_vet_request q JOIN dbo.app_user u ON u.user_id = q.vet_user_id
    WHERE q.state IN ('requested', 'accepted') AND q.farm_id IN (SELECT CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids))
    UNION ALL
    SELECT v.farm_id, v.vet_user_id, u.name, 'accepted', CAST(v.valid_from AS DATETIME2(3)), 1
    FROM dbo.vet_farm v JOIN dbo.app_user u ON u.user_id = v.vet_user_id
    WHERE v.farm_id IN (SELECT CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids)) AND v.valid_to IS NULL
    ORDER BY rank, since DESC`);
  for (const row of r.recordset) {
    const farm = lc(row.farm_id);
    if (out.has(farm)) continue;
    out.set(farm, { vet_user_id: lc(row.vet_user_id), name: row.name, state: row.state as FarmVet['state'], since: row.since.toISOString() });
  }
  return out;
}

/** Ends the farm's vet assignments (vet_farm): removed today, or deleted when added today (valid_to cannot precede valid_from). */
async function endAssignments(tx: sql.Transaction, farmId: string) {
  await request(tx).input('farm', sql.UniqueIdentifier, farmId).query(`
    DELETE FROM dbo.vet_farm WHERE farm_id = @farm AND valid_to IS NULL AND valid_from >= CAST(SYSUTCDATETIME() AS DATE);
    UPDATE dbo.vet_farm SET valid_to = DATEADD(DAY, -1, CAST(SYSUTCDATETIME() AS DATE))
      WHERE farm_id = @farm AND valid_to IS NULL;`);
}

type Op<K extends Operation['op']> = Extract<Operation, { op: K }>;

/** farm.vet_request: replaces a waiting request; a farm that has a vet removes it first. */
export async function farmVetRequest(tx: sql.Transaction, user: UserRow, op: Op<'farm.vet_request'>): Promise<Outcome> {
  if (!(await mayChooseVet(tx, user, op.farm_id))) return reject('FORBIDDEN', "Only the farm's manager can choose its vet.");
  const vets = await vetsForFarm(tx, user, op.farm_id);
  const vet = vets.find((v) => v.vet_user_id === lc(op.body.vet_user_id));
  if (!vet) return reject('INVALID_PAYLOAD', "This vet doesn't serve the farm's woreda.");
  const current = (await vetsOfFarms(tx, [op.farm_id])).get(lc(op.farm_id));
  if (current?.state === 'accepted') return reject('INVALID_PAYLOAD', 'Remove the farm’s vet before asking another.');
  if (current?.state === 'requested' && current.vet_user_id === vet.vet_user_id) return applied(); // asked already

  await request(tx).input('farm', sql.UniqueIdentifier, op.farm_id).query(`
    UPDATE dbo.farm_vet_request SET state = 'cancelled', ended_at = SYSUTCDATETIME() WHERE farm_id = @farm AND state = 'requested'`);
  const farm = (await request(tx).input('farm', sql.UniqueIdentifier, op.farm_id).query<{
    name: string; farm_code: string | null; kebele_id: number; houses: string | null;
  }>(`
    SELECT f.name, f.farm_code, f.kebele_id,
           (SELECT STRING_AGG(CONCAT(h.name, ' (', h.animal_code, IIF(h.produce_code IS NULL, '', CONCAT(', ', h.produce_code)), ')'), ', ')
            FROM dbo.farm_house h WHERE h.farm_id = f.farm_id) AS houses
    FROM dbo.farm f WHERE f.farm_id = @farm`)).recordset[0]!;
  await request(tx)
    .input('farm', sql.UniqueIdentifier, op.farm_id)
    .input('vet', sql.UniqueIdentifier, vet.vet_user_id)
    .input('by', sql.UniqueIdentifier, user.user_id)
    .input('byName', sql.NVarChar(200), user.name)
    .input('byRole', sql.VarChar(20), user.role ?? 'farm_manager')
    .input('name', sql.NVarChar(200), farm.name)
    .input('code', sql.VarChar(12), farm.farm_code)
    .input('kebele', sql.Int, farm.kebele_id)
    .input('houses', sql.NVarChar(400), (farm.houses ?? '').slice(0, 400))
    .query(`
      INSERT INTO dbo.farm_vet_request (farm_id, vet_user_id, vet_email, requested_by, requested_by_name, requested_by_role,
                                        farm_name, farm_code, kebele_id, houses)
      SELECT @farm, u.user_id, u.email, @by, @byName, @byRole, @name, @code, @kebele, @houses FROM dbo.app_user u WHERE u.user_id = @vet`);
  await notify(tx, {
    userId: vet.vet_user_id,
    type: 'vet_request',
    title: 'A farm asks you to be its vet',
    text: `${farm.name} asks you to be its vet. Open Farms to accept or decline.`,
    subjectUserId: user.user_id,
  });
  return applied();
}

/** farm.vet_remove: withdraws a waiting request, or removes the farm's vet (who is told). */
export async function farmVetRemove(tx: sql.Transaction, user: UserRow, op: Op<'farm.vet_remove'>): Promise<Outcome> {
  if (!(await mayChooseVet(tx, user, op.farm_id))) return reject('FORBIDDEN', "Only the farm's manager can choose its vet.");
  const current = (await vetsOfFarms(tx, [op.farm_id])).get(lc(op.farm_id));
  if (!current) return applied();
  await request(tx).input('farm', sql.UniqueIdentifier, op.farm_id).query(`
    UPDATE dbo.farm_vet_request SET state = IIF(state = 'requested', 'cancelled', 'removed'), ended_at = SYSUTCDATETIME()
    WHERE farm_id = @farm AND state IN ('requested', 'accepted')`);
  if (current.state === 'accepted') {
    await endAssignments(tx, op.farm_id);
    const farm = (await request(tx).input('farm', sql.UniqueIdentifier, op.farm_id)
      .query<{ name: string }>('SELECT name FROM dbo.farm WHERE farm_id = @farm')).recordset[0]!;
    await notify(tx, {
      userId: current.vet_user_id,
      type: 'vet_removed',
      title: 'A farm removed you as its vet',
      text: `${farm.name} no longer has you as its vet. Its new cases go to another vet.`,
      subjectUserId: user.user_id,
    });
  }
  return applied();
}

/**
 * The vet's answer reaches the farm: requests this user made, or for farms this user manages, that the vet
 * answered since. One notification each; told_at marks it sent. Runs at the start of the user's pull.
 */
export async function tellVetAnswers(pool: sql.ConnectionPool, user: UserRow): Promise<void> {
  const r = await request(pool).input('user', sql.UniqueIdentifier, user.user_id).query<{
    request_id: string; farm_name: string; state: string; vet_name: string; vet_user_id: string;
  }>(`
    SELECT q.request_id, q.farm_name, q.state, u.name AS vet_name, q.vet_user_id
    FROM dbo.farm_vet_request q JOIN dbo.app_user u ON u.user_id = q.vet_user_id
    WHERE q.told_at IS NULL AND q.decided_at IS NOT NULL AND q.state IN ('accepted', 'declined')
      AND (q.requested_by = @user OR q.farm_id IN (SELECT farm_id FROM dbo.farm WHERE manager_user_id = @user))`);
  for (const q of r.recordset) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const claimed = await request(tx).input('id', sql.UniqueIdentifier, q.request_id)
        .query('UPDATE dbo.farm_vet_request SET told_at = SYSUTCDATETIME() WHERE request_id = @id AND told_at IS NULL');
      if (claimed.rowsAffected[0] === 1) {
        const accepted = q.state !== 'declined';
        await notify(tx, {
          userId: user.user_id,
          type: 'vet_decided',
          title: accepted ? `${q.vet_name} is your vet` : `${q.vet_name} declined`,
          text: accepted
            ? `${q.vet_name} accepted ${q.farm_name}. New cases from the farm go to them.`
            : `${q.vet_name} declined ${q.farm_name}. You can ask another vet in My farm.`,
          subjectUserId: q.vet_user_id,
        });
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
