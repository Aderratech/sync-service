import { randomInt } from 'node:crypto';
import type { Operation } from '@aderratech/contracts/sync';
import { sql } from '../db/pool.js';
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

/** 6 characters with no lookalikes (no 0/O, 1/I), shared by the manager for farmers to join (§7). */
const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newJoinCode = () => Array.from({ length: 6 }, () => JOIN_ALPHABET[randomInt(JOIN_ALPHABET.length)]).join('');

export async function farmCreate(tx: sql.Transaction, user: UserRow, op: Op<'farm.create'>): Promise<Outcome> {
  if (user.role !== 'farm_manager') return reject('FORBIDDEN', 'Only a farm manager can create a farm.');
  const existing = await new sql.Request(tx).input('user', sql.UniqueIdentifier, user.user_id)
    .query('SELECT 1 AS x FROM dbo.farm WHERE manager_user_id = @user');
  if (existing.recordset.length) return reject('ALREADY_HAS_FARM', 'You already manage a farm.');

  const b = op.body;
  let joinCode = '';
  for (let attempt = 0; ; attempt++) {
    joinCode = newJoinCode();
    try {
      await new sql.Request(tx)
        .input('farm', sql.UniqueIdentifier, op.farm_id)
        .input('name', sql.NVarChar(200), b.name)
        .input('code', sql.VarChar(12), joinCode)
        .input('kebele', sql.Int, b.kebele_id)
        .input('lat', sql.Decimal(9, 6), b.lat)
        .input('lon', sql.Decimal(9, 6), b.lon)
        .input('phone', sql.VarChar(20), b.phone)
        .input('manager', sql.UniqueIdentifier, user.user_id)
        .query(`INSERT INTO dbo.farm (farm_id, name, join_code, kebele_id, lat, lon, phone, manager_user_id)
                VALUES (@farm, @name, @code, @kebele, @lat, @lon, @phone, @manager)`);
      break;
    } catch (error) {
      // A join code already in use: draw another (32^6 codes, so this is rare).
      const clash = error instanceof sql.RequestError && error.number === 2627 && /join_code/.test(error.message);
      if (!clash || attempt === 5) throw error;
    }
  }
  // The manager is the farm's first active member.
  await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, op.farm_id)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .query(`INSERT INTO dbo.farm_member (farm_id, user_id, state, decided_by, decided_at)
            VALUES (@farm, @user, 'active', @user, SYSUTCDATETIME())`);
  const code = await new sql.Request(tx).input('farm', sql.UniqueIdentifier, op.farm_id)
    .query<{ farm_code: string }>('SELECT farm_code FROM dbo.farm WHERE farm_id = @farm');
  return applied({ farm_code: code.recordset[0]!.farm_code, join_code: joinCode });
}

export async function farmUpdate(tx: sql.Transaction, user: UserRow, op: Op<'farm.update'>): Promise<Outcome> {
  const manager = await managerOf(tx, op.farm_id);
  if (!manager) return reject('INVALID_PAYLOAD', 'This farm does not exist.');
  if (!same(manager, user.user_id)) return NOT_MANAGER();
  const b = op.body;
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
  if (!same(await managerOf(tx, farmId), user.user_id)) return NOT_MANAGER();
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
