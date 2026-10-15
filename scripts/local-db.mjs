/**
 * Local database for development and tests: starts SQL Server in Docker,
 * publishes the schema from the contracts repo (../contracts, or
 * ADERRA_CONTRACTS), and creates the `sync_local` login in the aderra_sync
 * role, so the service runs with the same grants as in Azure. Then loads the
 * development data in dev-seed.mjs.
 *
 *   npm run db:local            create or update
 *   npm run db:local -- --reset drop the database first
 *
 * Needs Docker Desktop, the .NET 8 SDK and SqlPackage
 * (`dotnet tool install -g microsoft.sqlpackage`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';
import { devSeedSql } from './dev-seed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = resolve(process.env.ADERRA_CONTRACTS ?? join(root, '..', 'contracts'));
const project = join(contracts, 'db', 'Aderra.Db.sqlproj');
const dacpac = join(contracts, 'db', 'bin', 'Debug', 'Aderra.Db.dacpac');
const sqlpackage = join(homedir(), '.dotnet', 'tools', process.platform === 'win32' ? 'sqlpackage.exe' : 'sqlpackage');

const SA_PASSWORD = process.env.LOCAL_SA_PASSWORD ?? 'Local-only-Sa-2026!';
const SYNC_PASSWORD = process.env.SQL_PASSWORD ?? 'Local-only-Sync-2026!';
const DATABASE = 'aderra_ops';
const PORT = 14330;
const reset = process.argv.includes('--reset');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const server = (database = 'master') => ({
  server: 'localhost', port: PORT, user: 'sa', password: SA_PASSWORD, database,
  options: { encrypt: true, trustServerCertificate: true },
});

if (!existsSync(project)) throw new Error(`${project} not found: clone Aderratech/contracts beside this repo, or set ADERRA_CONTRACTS.`);

console.log('Starting SQL Server in Docker…');
run('docker', ['compose', 'up', '-d'], { cwd: root });

let master;
for (let attempt = 1; ; attempt++) {
  try {
    master = await new sql.ConnectionPool(server()).connect();
    break;
  } catch (error) {
    if (attempt === 30) throw new Error(`SQL Server did not start: ${error.message}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (reset) {
  console.log(`Dropping ${DATABASE}…`);
  await master.query(`IF DB_ID('${DATABASE}') IS NOT NULL BEGIN ALTER DATABASE [${DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DATABASE}]; END`);
}
await master.query(`IF DB_ID('${DATABASE}') IS NULL CREATE DATABASE [${DATABASE}]`);
await master.query(`IF SUSER_ID('sync_local') IS NULL CREATE LOGIN sync_local WITH PASSWORD = '${SYNC_PASSWORD}', CHECK_POLICY = OFF`);
await master.close();

console.log('Building the database project…');
run('dotnet', ['build', project, '-nologo', '-v', 'q']);

console.log('Publishing the schema…');
run(sqlpackage, [
  '/Action:Publish', `/SourceFile:${dacpac}`,
  `/TargetConnectionString:Server=localhost,${PORT};Database=${DATABASE};User ID=sa;Password=${SA_PASSWORD};TrustServerCertificate=True`,
  // The project targets SQL database in Fabric; the local copy is SQL Server 2022.
  '/p:AllowIncompatiblePlatform=true',
  '/p:BlockOnPossibleDataLoss=false',
  '/p:IgnoreColumnOrder=true',
  '/p:VerifyDeployment=false',
]);

const db = await new sql.ConnectionPool(server(DATABASE)).connect();
await db.query(`
  IF USER_ID('sync_local') IS NULL CREATE USER sync_local FOR LOGIN sync_local;
  IF IS_ROLEMEMBER('aderra_sync', 'sync_local') = 0 ALTER ROLE aderra_sync ADD MEMBER sync_local;`);
console.log('Loading development data (test places, a test vet, reference versions)…');
await db.query(devSeedSql());
await db.close();
console.log(`Ready: localhost,${PORT} database ${DATABASE}, login sync_local (role aderra_sync).`);
