import type { MeResponse } from '@aderratech/contracts/sync';
import { clientConfig } from './config.js';
import { sql } from './db/pool.js';
import { lc } from './ops/outcome.js';
import type { UserRow } from './users.js';

type FarmRow = { farm_id: string; name: string; farm_code: string; join_code: string; kebele_id: number; phone: string | null; manager_user_id: string };
type Farm = NonNullable<MeResponse['farm']>;

/** Every farm the user manages or is an active member of: managed ones first, then by name. */
export async function farmsFor(pool: sql.ConnectionPool, user: UserRow): Promise<Farm[]> {
  const farms = await new sql.Request(pool).input('user', sql.UniqueIdentifier, user.user_id).query<FarmRow>(`
    SELECT f.farm_id, f.name, f.farm_code, f.join_code, f.kebele_id, f.phone, f.manager_user_id
    FROM dbo.farm f
    WHERE f.manager_user_id = @user
       OR EXISTS (SELECT 1 FROM dbo.farm_member m WHERE m.farm_id = f.farm_id AND m.user_id = @user AND m.state = 'active')
    ORDER BY CASE WHEN f.manager_user_id = @user THEN 0 ELSE 1 END, f.name`);
  if (!farms.recordset.length) return [];
  const houses = await new sql.Request(pool)
    .input('ids', sql.NVarChar(sql.MAX), JSON.stringify(farms.recordset.map((f) => f.farm_id)))
    .query<{ farm_id: string; house_id: string; name: string; animal_code: string; produce_code: string | null; active: boolean }>(`
      SELECT farm_id, house_id, name, animal_code, produce_code, active FROM dbo.farm_house
      WHERE farm_id IN (SELECT CAST(value AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids)) ORDER BY created_at`);
  return farms.recordset.map((farm) => {
    const manages = lc(farm.manager_user_id) === lc(user.user_id);
    return {
      farm_id: lc(farm.farm_id),
      name: farm.name,
      farm_code: farm.farm_code,
      // Sent to the manager only.
      join_code: manages ? farm.join_code : null,
      kebele_id: farm.kebele_id,
      phone: farm.phone,
      manages,
      houses: houses.recordset
        .filter((h) => lc(h.farm_id) === lc(farm.farm_id))
        .map(({ farm_id: _farm, ...h }) => ({ ...h, house_id: lc(h.house_id) })),
    };
  });
}

/** The woredas an extension officer covers: their list, and the woreda on their profile. */
export async function woredasOf(db: sql.ConnectionPool | sql.Transaction, user: UserRow): Promise<number[]> {
  const r = await new sql.Request(db as sql.ConnectionPool).input('user', sql.UniqueIdentifier, user.user_id).query<{ woreda_id: number }>(`
    SELECT woreda_id FROM dbo.officer_woreda WHERE officer_user_id = @user AND removed_at IS NULL ORDER BY added_at`);
  const list = r.recordset.map((w) => w.woreda_id);
  return user.woreda_id !== null && !list.includes(user.woreda_id) ? [user.woreda_id, ...list] : list;
}

/** A manager sees everyone on, or asking to join, the farms they manage; everyone sees their own memberships. */
export async function membershipsFor(pool: sql.ConnectionPool, user: UserRow): Promise<MeResponse['memberships']> {
  const members = await new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .query<{ farm_id: string; user_id: string; name: string; phone: string | null; state: string; request_note: string | null; requested_at: Date; app_joined_at: Date; house_ids: string | null }>(`
      SELECT m.farm_id, m.user_id, u.name, u.phone, m.state, m.request_note, m.requested_at, u.created_at AS app_joined_at,
             (SELECT STRING_AGG(CONVERT(CHAR(36), h.house_id), ',') FROM dbo.farm_member_house h
               WHERE h.farm_id = m.farm_id AND h.user_id = m.user_id AND h.removed_at IS NULL) AS house_ids
      FROM dbo.farm_member m JOIN dbo.app_user u ON u.user_id = m.user_id
      WHERE m.farm_id IN (SELECT farm_id FROM dbo.farm WHERE manager_user_id = @user) OR m.user_id = @user
      ORDER BY m.requested_at`);
  return members.recordset.map((m) => ({
    farm_id: lc(m.farm_id),
    user_id: lc(m.user_id),
    name: m.name,
    phone: m.phone,
    state: m.state as MeResponse['memberships'][number]['state'],
    request_note: m.request_note,
    requested_at: m.requested_at.toISOString(),
    app_joined_at: m.app_joined_at.toISOString(),
    house_ids: m.house_ids ? m.house_ids.split(',').map((id) => lc(id.trim())) : [],
  }));
}

/** GET /api/v1/me (PLAN.md §8): the user, their farms, memberships and config. */
export async function buildMe(pool: sql.ConnectionPool, user: UserRow): Promise<MeResponse> {
  const farms = await farmsFor(pool, user);
  return {
    user: {
      user_id: lc(user.user_id),
      name: user.name,
      phone: user.phone,
      language: user.language,
      role: (user.role as MeResponse['user']['role']) ?? null,
      woreda_id: user.woreda_id,
      woreda_ids: user.role === 'extension_officer' ? await woredasOf(pool, user) : [],
      consent_version: user.consent_version,
    },
    farm: farms[0] ?? null,
    farms,
    memberships: await membershipsFor(pool, user),
    config: clientConfig(),
  };
}
