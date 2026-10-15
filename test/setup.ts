import { randomUUID } from 'node:crypto';
import sql from 'mssql';
import type { Identity } from '../src/auth/identity.js';

/** The local Docker database from `npm run db:local`. The service connects as sync_local (role aderra_sync). */
export const LOCAL = {
  SQL_SERVER: 'localhost',
  SQL_PORT: '14330',
  SQL_DATABASE: 'aderra_ops',
  SQL_AUTH: 'sql',
  SQL_USER: 'sync_local',
  SQL_PASSWORD: process.env.SQL_PASSWORD ?? 'Local-only-Sync-2026!',
  SQL_TRUST_CERT: '1',
};
Object.assign(process.env, LOCAL);

/** sa, for test fixtures the sync service may not write (places are the data team's). */
export function adminPool(): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool({
    server: 'localhost', port: 14330, database: 'aderra_ops', user: 'sa',
    password: process.env.LOCAL_SA_PASSWORD ?? 'Local-only-Sa-2026!',
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
}

/** A fresh Google identity per test, so tests never share users. */
export const newIdentity = (name = 'Almaz Girma'): Identity => ({
  provider: 'google', subject: `dev-test-${randomUUID()}`, name, email: null,
});

/** Ids of the test places, created once: one region › zone › woreda. */
export const PLACE = { region: 99001, zone: 99002, woreda: 99003 };

export async function ensurePlaces(admin: sql.ConnectionPool): Promise<void> {
  await admin.query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.region WHERE region_id = ${PLACE.region})
      INSERT dbo.region (region_id, name_en) VALUES (${PLACE.region}, N'Test region');
    IF NOT EXISTS (SELECT 1 FROM dbo.zone WHERE zone_id = ${PLACE.zone})
      INSERT dbo.zone (zone_id, region_id, name_en) VALUES (${PLACE.zone}, ${PLACE.region}, N'Test zone');
    IF NOT EXISTS (SELECT 1 FROM dbo.woreda WHERE woreda_id = ${PLACE.woreda})
      INSERT dbo.woreda (woreda_id, zone_id, name_en) VALUES (${PLACE.woreda}, ${PLACE.zone}, N'Test woreda');`);
}

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A random ULID-shaped op id. */
export const opId = (): string => Array.from({ length: 26 }, (_, i) => crockford[i === 0 ? 0 : Math.floor(Math.random() * 32)]).join('');
