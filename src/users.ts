import { LANGUAGES, type Language } from '@aderratech/contracts';
import type { Identity } from './auth/identity.js';
import { sql } from './db/pool.js';
import { inviteSubject } from './ops/farm.js';

export type UserRow = {
  user_id: string;
  name: string;
  phone: string | null;
  language: Language;
  role: string | null;
  woreda_id: number | null;
  consent_version: string | null;
};

const SELECT_USER = `
  SELECT user_id, name, phone, language, role, woreda_id, consent_version
  FROM dbo.app_user WHERE identity_provider = @provider AND identity_subject = @subject`;

/** The language a new user starts in: what the phone asked for, else English. */
export function startLanguage(acceptLanguage: string | null): Language {
  const code = acceptLanguage?.trim().slice(0, 2).toLowerCase();
  return (LANGUAGES as readonly string[]).includes(code ?? '') ? (code as Language) : 'en';
}

async function find(pool: sql.ConnectionPool, identity: Identity): Promise<UserRow | null> {
  const result = await new sql.Request(pool)
    .input('provider', sql.VarChar(10), identity.provider)
    .input('subject', sql.NVarChar(256), identity.subject)
    .query<UserRow>(SELECT_USER);
  return result.recordset[0] ?? null;
}

export async function getUser(pool: sql.ConnectionPool, userId: string): Promise<UserRow> {
  const result = await new sql.Request(pool).input('user', sql.UniqueIdentifier, userId).query<UserRow>(`
    SELECT user_id, name, phone, language, role, woreda_id, consent_version FROM dbo.app_user WHERE user_id = @user`);
  const row = result.recordset[0];
  if (!row) throw new Error(`app_user ${userId} not found`);
  return row;
}

/**
 * A farm an extension officer registered names its manager by email (ops/farm.ts farmRegister). The first
 * Google sign-in with that email takes over the placeholder user, so the farm, its houses and its cases are
 * theirs at once. Returns whether a placeholder was taken over.
 */
async function claimInvite(pool: sql.ConnectionPool, identity: Identity): Promise<boolean> {
  if (identity.provider !== 'google' || !identity.email) return false;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const r = await new sql.Request(tx)
      .input('invite', sql.NVarChar(256), inviteSubject(identity.email))
      .input('subject', sql.NVarChar(256), identity.subject)
      .input('name', sql.NVarChar(200), identity.name?.trim() || null)
      .query<{ user_id: string }>(`
        UPDATE dbo.app_user SET identity_subject = @subject, name = COALESCE(@name, name), updated_at = SYSUTCDATETIME()
        OUTPUT inserted.user_id
        WHERE identity_provider = 'google' AND identity_subject = @invite`);
    const userId = r.recordset[0]?.user_id;
    if (userId) {
      await new sql.Request(tx).input('user', sql.UniqueIdentifier, userId)
        .query('UPDATE dbo.farm_invite SET claimed_at = SYSUTCDATETIME() WHERE invited_user_id = @user AND claimed_at IS NULL');
    }
    await tx.commit();
    return Boolean(userId);
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/**
 * The caller's app_user row, created at first sign-in (sign-up and sign-in are
 * one step). The role stays NULL until first run sends user.update.
 */
export async function ensureUser(pool: sql.ConnectionPool, identity: Identity, language: Language): Promise<UserRow> {
  const existing = await find(pool, identity);
  if (existing) return existing;
  if (await claimInvite(pool, identity)) {
    const claimed = await find(pool, identity);
    if (claimed) return claimed;
  }
  try {
    await new sql.Request(pool)
      .input('provider', sql.VarChar(10), identity.provider)
      .input('subject', sql.NVarChar(256), identity.subject)
      .input('name', sql.NVarChar(200), identity.name?.trim() || 'Aderra user')
      .input('language', sql.Char(2), language)
      .query(`INSERT INTO dbo.app_user (identity_provider, identity_subject, name, language, role)
              VALUES (@provider, @subject, @name, @language, NULL)`);
  } catch (error) {
    // Two first requests at once: the other one created the row (uq_app_user_identity).
    if (!(error instanceof sql.RequestError && error.number === 2627)) throw error;
  }
  const created = await find(pool, identity);
  if (!created) throw new Error('app_user row missing after insert');
  return created;
}
