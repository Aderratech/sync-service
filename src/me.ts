import type { MeResponse } from '@aderratech/contracts/sync';
import { clientConfig } from './config.js';
import { sql } from './db/pool.js';
import type { UserRow } from './users.js';

type FarmRow = { farm_id: string; name: string; farm_code: string; join_code: string; kebele_id: number; phone: string | null; manager_user_id: string };

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * GET /api/v1/me (PLAN.md §8): the user, their farm (the one they manage, or
 * the one they are an active member of), memberships and config.
 */
export async function buildMe(pool: sql.ConnectionPool, user: UserRow): Promise<MeResponse> {
  const farms = await new sql.Request(pool).input('user', sql.UniqueIdentifier, user.user_id).query<FarmRow>(`
    SELECT TOP 1 f.farm_id, f.name, f.farm_code, f.join_code, f.kebele_id, f.phone, f.manager_user_id
    FROM dbo.farm f
    WHERE f.manager_user_id = @user
       OR EXISTS (SELECT 1 FROM dbo.farm_member m WHERE m.farm_id = f.farm_id AND m.user_id = @user AND m.state = 'active')
    ORDER BY CASE WHEN f.manager_user_id = @user THEN 0 ELSE 1 END`);
  const farm = farms.recordset[0] ?? null;
  const manages = farm?.manager_user_id === user.user_id;

  const houses = farm
    ? (await new sql.Request(pool).input('farm', sql.UniqueIdentifier, farm.farm_id).query<{
        house_id: string; name: string; animal_code: string; produce_code: string | null; active: boolean;
      }>(`SELECT house_id, name, animal_code, produce_code, active FROM dbo.farm_house WHERE farm_id = @farm ORDER BY created_at`)).recordset
    : [];

  // A manager sees everyone on (or asking to join) their farm; anyone else sees their own memberships.
  const members = await new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('farm', sql.UniqueIdentifier, manages ? farm!.farm_id : null)
    .query<{ farm_id: string; user_id: string; name: string; phone: string | null; state: string; request_note: string | null; requested_at: Date; house_ids: string | null }>(`
      SELECT m.farm_id, m.user_id, u.name, u.phone, m.state, m.request_note, m.requested_at,
             (SELECT STRING_AGG(CONVERT(CHAR(36), h.house_id), ',') FROM dbo.farm_member_house h
               WHERE h.farm_id = m.farm_id AND h.user_id = m.user_id AND h.removed_at IS NULL) AS house_ids
      FROM dbo.farm_member m JOIN dbo.app_user u ON u.user_id = m.user_id
      WHERE (@farm IS NOT NULL AND m.farm_id = @farm) OR (@farm IS NULL AND m.user_id = @user)
      ORDER BY m.requested_at`);

  return {
    user: {
      user_id: user.user_id.toLowerCase(),
      name: user.name,
      phone: user.phone,
      language: user.language,
      role: (user.role as MeResponse['user']['role']) ?? null,
      woreda_id: user.woreda_id,
      consent_version: user.consent_version,
    },
    farm: farm && {
      farm_id: farm.farm_id.toLowerCase(),
      name: farm.name,
      farm_code: farm.farm_code,
      join_code: manages ? farm.join_code : null,
      kebele_id: farm.kebele_id,
      phone: farm.phone,
      houses: houses.map((h) => ({ ...h, house_id: h.house_id.toLowerCase() })),
    },
    memberships: members.recordset.map((m) => ({
      farm_id: m.farm_id.toLowerCase(),
      user_id: m.user_id.toLowerCase(),
      name: m.name,
      phone: m.phone,
      state: m.state as MeResponse['memberships'][number]['state'],
      request_note: m.request_note,
      requested_at: iso(m.requested_at)!,
      house_ids: m.house_ids ? m.house_ids.split(',').map((id) => id.trim().toLowerCase()) : [],
    })),
    config: clientConfig(),
  };
}
