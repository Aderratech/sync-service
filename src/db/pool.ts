import sql from 'mssql';

/**
 * One connection pool per instance.
 *
 * In Azure the Function App's managed identity signs in (SQL_AUTH=default:
 * DefaultAzureCredential), and the database grants it the aderra_sync role.
 * Locally, a SQL login in the same role on the Docker database (SQL_AUTH=sql),
 * so grant mistakes show up before deployment.
 */
let pool: Promise<sql.ConnectionPool> | null = null;

function config(): sql.config {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const base = {
    server: env('SQL_SERVER'),
    port: Number(process.env.SQL_PORT ?? 1433),
    database: env('SQL_DATABASE'),
    options: { encrypt: true, trustServerCertificate: process.env.SQL_TRUST_CERT === '1' },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  };
  if ((process.env.SQL_AUTH ?? 'default') === 'sql') {
    return { ...base, user: env('SQL_USER'), password: env('SQL_PASSWORD') };
  }
  return { ...base, authentication: { type: 'azure-active-directory-default', options: {} } };
}

export function getPool(): Promise<sql.ConnectionPool> {
  if (!pool) {
    pool = new sql.ConnectionPool(config()).connect().catch((error: unknown) => {
      pool = null; // let the next request try again
      throw error;
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await (await current).close();
  }
}

export { sql };
