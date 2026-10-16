import type { OfficerFarmsResponse } from '@aderratech/contracts/sync';
import { sql } from './db/pool.js';
import { woredasOf } from './me.js';
import { lc } from './ops/outcome.js';
import type { UserRow } from './users.js';

type FarmRow = { farm_id: string; name: string; farm_code: string; kebele_id: number; mine: boolean; manager_invited: boolean };
type HouseRow = { farm_id: string; house_id: string; name: string; animal_code: string; produce_code: string | null; active: boolean };

/** `%`, `_` and `[` match literally in a LIKE pattern. */
const likeContains = (text: string) => `%${text.replace(/[[%_]/g, (c) => `[${c}]`)}%`;

/**
 * An officer's farms (§16 D2): with no query, the farms they report for (assigned, registered or reported
 * for); with a query of 2 or more characters, up to 10 farms in their woredas whose name contains it, so they
 * find a farm before registering it again.
 */
export async function officerFarms(pool: sql.ConnectionPool, user: UserRow, query: string): Promise<OfficerFarmsResponse> {
  const q = query.trim();
  if (q && q.length < 2) return { farms: [] };
  const fields = `f.farm_id, f.name, f.farm_code, f.kebele_id,
    CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.officer_farm o WHERE o.farm_id = f.farm_id AND o.officer_user_id = @user AND o.removed_at IS NULL)
              THEN 1 ELSE 0 END AS BIT) AS mine,
    CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.farm_invite i WHERE i.farm_id = f.farm_id AND i.claimed_at IS NULL)
              THEN 1 ELSE 0 END AS BIT) AS manager_invited`;
  const farms = await new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('woredas', sql.NVarChar(sql.MAX), JSON.stringify(await woredasOf(pool, user)))
    .input('q', sql.NVarChar(210), likeContains(q))
    .query<FarmRow>(q
      ? `SELECT TOP 10 ${fields} FROM dbo.farm f JOIN dbo.kebele k ON k.kebele_id = f.kebele_id
         WHERE k.woreda_id IN (SELECT CAST(value AS INT) FROM OPENJSON(@woredas)) AND f.name LIKE @q ORDER BY f.name`
      : `SELECT ${fields} FROM dbo.farm f
         WHERE EXISTS (SELECT 1 FROM dbo.officer_farm o WHERE o.farm_id = f.farm_id AND o.officer_user_id = @user AND o.removed_at IS NULL)
         ORDER BY f.name`);
  const ids = farms.recordset.map((f) => lc(f.farm_id));
  const houses = ids.length
    ? (await new sql.Request(pool).input('ids', sql.NVarChar(sql.MAX), JSON.stringify(ids)).query<HouseRow>(`
        SELECT farm_id, house_id, name, animal_code, produce_code, active FROM dbo.farm_house
        WHERE farm_id IN (SELECT CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids)) ORDER BY created_at`)).recordset
    : [];
  return {
    farms: farms.recordset.map((f) => ({
      farm_id: lc(f.farm_id),
      name: f.name,
      farm_code: f.farm_code,
      kebele_id: f.kebele_id,
      mine: f.mine,
      manager_invited: f.manager_invited,
      houses: houses
        .filter((h) => lc(h.farm_id) === lc(f.farm_id))
        .map((h) => ({ house_id: lc(h.house_id), name: h.name, animal_code: h.animal_code, produce_code: h.produce_code, active: h.active })),
    })),
  };
}
