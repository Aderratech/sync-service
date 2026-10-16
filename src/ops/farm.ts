import { randomInt } from 'node:crypto';
import type { Operation } from '@aderratech/contracts/sync';
import { sql } from '../db/pool.js';
import { woredasOf } from '../me.js';
import type { UserRow } from '../users.js';
import { applied, reject, type Outcome } from './outcome.js';

type Op<K extends Operation['op']> = Extract<Operation, { op: K }>;

/** The farm's manager, or null if there is no such farm. */
export async function managerOf(tx: sql.Transaction, farmId: string): Promise<string | null> {
  const r = await new sql.Request(tx).input('farm', sql.UniqueIdentifier, farmId)
    .query<{ manager_user_id: string }>('SELECT manager_user_id FROM dbo.farm WHERE farm_id = @farm');
  return r.recordset[0]?.manager_user_id ?? null;
}

const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

const NOT_MANAGER = () => reject('FORBIDDEN', 'Only the farm manager can do this.');

/** The officer who registered a farm may edit it until its manager signs in (farm_invite unclaimed). */
async function registeredByAndUnclaimed(tx: sql.Transaction, user: UserRow, farmId: string): Promise<boolean> {
  if (user.role !== 'extension_officer') return false;
  const r = await new sql.Request(tx).input('farm', sql.UniqueIdentifier, farmId).input('user', sql.UniqueIdentifier, user.user_id)
    .query('SELECT 1 AS x FROM dbo.farm_invite WHERE farm_id = @farm AND invited_by = @user AND claimed_at IS NULL');
  return r.recordset.length > 0;
}

/** 6 characters with no lookalikes (no 0/O, 1/I), shared by the manager for farmers to join (§7). */
const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newJoinCode = () => Array.from({ length: 6 }, () => JOIN_ALPHABET[randomInt(JOIN_ALPHABET.length)]).join('');

type FarmFields = { name: string; kebele_id: number; lat: number | null; lon: number | null; phone: string | null };

/** Inserts the farm with a fresh join code; returns the join code. */
async function insertFarm(tx: sql.Transaction, farmId: string, b: FarmFields, managerId: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const joinCode = newJoinCode();
    try {
      await new sql.Request(tx)
        .input('farm', sql.UniqueIdentifier, farmId)
        .input('name', sql.NVarChar(200), b.name)
        .input('code', sql.VarChar(12), joinCode)
        .input('kebele', sql.Int, b.kebele_id)
        .input('lat', sql.Decimal(9, 6), b.lat)
        .input('lon', sql.Decimal(9, 6), b.lon)
        .input('phone', sql.VarChar(20), b.phone)
        .input('manager', sql.UniqueIdentifier, managerId)
        .query(`INSERT INTO dbo.farm (farm_id, name, join_code, kebele_id, lat, lon, phone, manager_user_id)
                VALUES (@farm, @name, @code, @kebele, @lat, @lon, @phone, @manager)`);
      return joinCode;
    } catch (error) {
      // A join code already in use: draw another (32^6 codes, so this is rare).
      const clash = error instanceof sql.RequestError && error.number === 2627 && /join_code/.test(error.message);
      if (!clash || attempt === 5) throw error;
    }
  }
}

/** The manager is the farm's first active member. */
async function addManagerMember(tx: sql.Transaction, farmId: string, managerId: string, decidedBy: string) {
  await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, farmId)
    .input('user', sql.UniqueIdentifier, managerId)
    .input('by', sql.UniqueIdentifier, decidedBy)
    .query(`INSERT INTO dbo.farm_member (farm_id, user_id, state, decided_by, decided_at)
            VALUES (@farm, @user, 'active', @by, SYSUTCDATETIME())`);
}

async function farmCode(tx: sql.Transaction, farmId: string): Promise<string> {
  const code = await new sql.Request(tx).input('farm', sql.UniqueIdentifier, farmId)
    .query<{ farm_code: string }>('SELECT farm_code FROM dbo.farm WHERE farm_id = @farm');
  return code.recordset[0]!.farm_code;
}

export async function farmCreate(tx: sql.Transaction, user: UserRow, op: Op<'farm.create'>): Promise<Outcome> {
  if (user.role !== 'farm_manager') return reject('FORBIDDEN', 'Only a farm manager can create a farm.');
  const joinCode = await insertFarm(tx, op.farm_id, op.body, user.user_id);
  await addManagerMember(tx, op.farm_id, user.user_id, user.user_id);
  return applied({ farm_code: await farmCode(tx, op.farm_id), join_code: joinCode });
}

/** The app_user that holds an invitation until its owner signs in (identity_subject 'invite:<email>'). */
export const inviteSubject = (email: string) => `invite:${email.trim().toLowerCase()}`;

/**
 * farm.register (§16 D2): an extension officer adds a farm that is not on Aderra, with exactly one house,
 * for the case that follows it in the outbox. The manager is whoever holds the email: a farm manager already
 * on Aderra (who may manage several farms), or else a placeholder user that they receive when they first sign in with that
 * email (users.ts). The invitation email waits in email_outbox.
 */
export async function farmRegister(tx: sql.Transaction, user: UserRow, op: Op<'farm.register'>): Promise<Outcome> {
  if (user.role !== 'extension_officer') return reject('FORBIDDEN', 'Only an extension officer can register a farm.');
  const b = op.body;
  const place = await new sql.Request(tx).input('kebele', sql.Int, b.kebele_id)
    .query<{ woreda_id: number }>('SELECT woreda_id FROM dbo.kebele WHERE kebele_id = @kebele');
  const woreda = place.recordset[0]?.woreda_id;
  if (woreda === undefined) return reject('INVALID_PAYLOAD', 'This kebele does not exist.');
  if (!(await woredasOf(tx, user)).includes(woreda)) return reject('OUTSIDE_WOREDA', 'This farm is outside your woredas.');

  const email = b.manager_email.trim().toLowerCase();
  const holder = await new sql.Request(tx)
    .input('email', sql.NVarChar(320), email)
    .input('subject', sql.NVarChar(256), inviteSubject(email))
    .query<{ user_id: string; role: string | null; invited: number }>(`
      SELECT TOP 1 u.user_id, u.role, CASE WHEN u.identity_subject = @subject THEN 1 ELSE 0 END AS invited
      FROM dbo.app_user u
      WHERE LOWER(u.email) = @email OR u.identity_subject = @subject
      ORDER BY CASE WHEN u.identity_subject = @subject THEN 1 ELSE 0 END`);
  let manager = holder.recordset[0];
  if (manager && manager.role !== null && manager.role !== 'farm_manager') {
    return reject('FORBIDDEN', 'This email belongs to someone on Aderra who is not a farm manager.');
  }
  if (!manager) {
    const created = await new sql.Request(tx)
      .input('subject', sql.NVarChar(256), inviteSubject(email))
      .input('email', sql.NVarChar(320), email)
      .input('language', sql.Char(2), user.language)
      .query<{ user_id: string }>(`
        INSERT INTO dbo.app_user (identity_provider, identity_subject, email, name, language, role)
        OUTPUT inserted.user_id
        VALUES ('google', @subject, @email, @email, @language, 'farm_manager')`);
    manager = { user_id: created.recordset[0]!.user_id, role: 'farm_manager', invited: 1 };
  } else if (manager.role === null) {
    await new sql.Request(tx).input('user', sql.UniqueIdentifier, manager.user_id)
      .query("UPDATE dbo.app_user SET role = 'farm_manager', updated_at = SYSUTCDATETIME() WHERE user_id = @user");
  }

  const joinCode = await insertFarm(tx, op.farm_id, b, manager.user_id);
  await addManagerMember(tx, op.farm_id, manager.user_id, user.user_id);
  await new sql.Request(tx)
    .input('house', sql.UniqueIdentifier, b.house.house_id)
    .input('farm', sql.UniqueIdentifier, op.farm_id)
    .input('name', sql.NVarChar(100), b.house.name)
    .input('animal', sql.VarChar(20), b.house.animal_code)
    .input('produce', sql.VarChar(20), b.house.produce_code)
    .query(`INSERT INTO dbo.farm_house (house_id, farm_id, name, animal_code, produce_code)
            VALUES (@house, @farm, @name, @animal, @produce)`);
  await new sql.Request(tx)
    .input('officer', sql.UniqueIdentifier, user.user_id)
    .input('farm', sql.UniqueIdentifier, op.farm_id)
    .query("INSERT INTO dbo.officer_farm (officer_user_id, farm_id, source) VALUES (@officer, @farm, 'registered')");
  await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, op.farm_id)
    .input('email', sql.NVarChar(320), email)
    .input('invitee', sql.UniqueIdentifier, manager.user_id)
    .input('officer', sql.UniqueIdentifier, user.user_id)
    .input('claimed', sql.DateTime2(3), manager.invited ? null : new Date())
    .query(`INSERT INTO dbo.farm_invite (farm_id, email, invited_user_id, invited_by, claimed_at)
            VALUES (@farm, @email, @invitee, @officer, @claimed)`);
  await new sql.Request(tx)
    .input('email', sql.NVarChar(320), email)
    .input('farm', sql.UniqueIdentifier, op.farm_id)
    .input('language', sql.Char(2), user.language)
    .query("INSERT INTO dbo.email_outbox (to_email, template, farm_id, language) VALUES (@email, 'farm_invite', @farm, @language)");
  return applied({ farm_code: await farmCode(tx, op.farm_id), join_code: joinCode });
}

export async function farmUpdate(tx: sql.Transaction, user: UserRow, op: Op<'farm.update'>): Promise<Outcome> {
  const manager = await managerOf(tx, op.farm_id);
  if (!manager) return reject('INVALID_PAYLOAD', 'This farm does not exist.');
  const officer = !same(manager, user.user_id) && (await registeredByAndUnclaimed(tx, user, op.farm_id));
  if (!same(manager, user.user_id) && !officer) return NOT_MANAGER();
  const b = op.body;
  if (officer && b.kebele_id !== undefined) {
    // The officer's farm stays in his woredas.
    const k = await new sql.Request(tx).input('kebele', sql.Int, b.kebele_id)
      .query<{ woreda_id: number }>('SELECT woreda_id FROM dbo.kebele WHERE kebele_id = @kebele');
    const woreda = k.recordset[0]?.woreda_id;
    if (woreda === undefined) return reject('INVALID_PAYLOAD', 'This kebele does not exist.');
    if (!(await woredasOf(tx, user)).includes(woreda)) return reject('OUTSIDE_WOREDA', 'This farm is outside your woredas.');
  }
  const sets: string[] = [];
  const request = new sql.Request(tx).input('farm', sql.UniqueIdentifier, op.farm_id);
  if (b.name !== undefined) { sets.push('name = @name'); request.input('name', sql.NVarChar(200), b.name); }
  if (b.phone !== undefined) { sets.push('phone = @phone'); request.input('phone', sql.VarChar(20), b.phone); }
  if (b.kebele_id !== undefined) { sets.push('kebele_id = @kebele'); request.input('kebele', sql.Int, b.kebele_id); }
  if (sets.length) await request.query(`UPDATE dbo.farm SET ${sets.join(', ')}, updated_at = SYSUTCDATETIME() WHERE farm_id = @farm`);
  return applied();
}

export async function houseCreate(tx: sql.Transaction, user: UserRow, op: Op<'house.create'>): Promise<Outcome> {
  const manager = await managerOf(tx, op.body.farm_id);
  if (!manager) return reject('INVALID_PAYLOAD', 'This farm does not exist.');
  if (!same(manager, user.user_id)) return NOT_MANAGER();
  await new sql.Request(tx)
    .input('house', sql.UniqueIdentifier, op.house_id)
    .input('farm', sql.UniqueIdentifier, op.body.farm_id)
    .input('name', sql.NVarChar(100), op.body.name)
    .input('animal', sql.VarChar(20), op.body.animal_code)
    .input('produce', sql.VarChar(20), op.body.produce_code)
    .query(`INSERT INTO dbo.farm_house (house_id, farm_id, name, animal_code, produce_code)
            VALUES (@house, @farm, @name, @animal, @produce)`);
  return applied();
}

export async function houseUpdate(tx: sql.Transaction, user: UserRow, op: Op<'house.update'>): Promise<Outcome> {
  const r = await new sql.Request(tx).input('house', sql.UniqueIdentifier, op.house_id)
    .query<{ farm_id: string }>('SELECT farm_id FROM dbo.farm_house WHERE house_id = @house');
  const farmId = r.recordset[0]?.farm_id;
  if (!farmId) return reject('INVALID_PAYLOAD', 'This house does not exist.');
  if (!same(await managerOf(tx, farmId), user.user_id) && !(await registeredByAndUnclaimed(tx, user, farmId))) return NOT_MANAGER();
  const b = op.body;
  const sets: string[] = [];
  const request = new sql.Request(tx).input('house', sql.UniqueIdentifier, op.house_id);
  if (b.name !== undefined) { sets.push('name = @name'); request.input('name', sql.NVarChar(100), b.name); }
  if (b.produce_code !== undefined) { sets.push('produce_code = @produce'); request.input('produce', sql.VarChar(20), b.produce_code); }
  if (b.active !== undefined) { sets.push('active = @active'); request.input('active', sql.Bit, b.active); }
  // Two phones editing one house: the operation received later wins (§9.7).
  if (sets.length) await request.query(`UPDATE dbo.farm_house SET ${sets.join(', ')} WHERE house_id = @house`);
  return applied();
}
