/**
 * The interim test database in Fabric: publishes the schema from the contracts repo (../contracts, or
 * ADERRA_CONTRACTS) to a separate SQL database in Aderra's workspace, then loads the development data
 * (test places, a test vet, reference versions). Never the portal's database.
 *
 *   FABRIC_SQL_SERVER=…database.fabric.microsoft.com FABRIC_SQL_DATABASE=Aderra_Mobile_Interim-… \
 *     npm run db:interim -- --interim
 *
 * Signs in as you: run `az login` first with the Aderra Entra account that can open the database.
 * Needs the .NET 8 SDK and SqlPackage (`dotnet tool install -g microsoft.sqlpackage`).
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

const server = process.env.FABRIC_SQL_SERVER?.trim();
const database = process.env.FABRIC_SQL_DATABASE?.trim();

// Guards: the portal's Rayfin app depends on Aderra_Ops; this script must never publish there.
if (!server || !database) throw new Error('Set FABRIC_SQL_SERVER and FABRIC_SQL_DATABASE (Fabric: the SQL database → Settings → Connection strings).');
if (/aderra_ops/i.test(database)) throw new Error(`Refusing ${database}: that is the portal's database. This script is for the interim test database only.`);
if (!process.argv.includes('--interim')) throw new Error('Pass --interim to confirm this is the interim test database.');
if (!existsSync(project)) throw new Error(`${project} not found: clone Aderratech/contracts beside this repo, or set ADERRA_CONTRACTS.`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const shell = process.platform === 'win32';

console.log('Getting a database token from the Azure CLI (az login)…');
const token = execFileSync('az', ['account', 'get-access-token', '--resource', 'https://database.windows.net/', '--query', 'accessToken', '-o', 'tsv'], { encoding: 'utf8', shell }).trim();
if (!token) throw new Error('No token: run `az login` with your Aderra account first.');

console.log('Building the database project…');
run('dotnet', ['build', project, '-nologo', '-v', 'q']);

console.log(`Publishing the schema to ${database}…`);
run(sqlpackage, [
  '/Action:Publish', `/SourceFile:${dacpac}`,
  `/TargetConnectionString:Server=${server},1433;Database=${database};Encrypt=True`,
  `/AccessToken:${token}`,
  // Never drop data in the test database without being told.
  '/p:BlockOnPossibleDataLoss=true',
  '/p:IgnoreColumnOrder=true',
]);

console.log('Loading development data (test places, a test vet, reference versions)…');
const db = await new sql.ConnectionPool({
  server, port: 1433, database,
  authentication: { type: 'azure-active-directory-access-token', options: { token } },
  options: { encrypt: true },
}).connect();
await db.query(devSeedSql());
const counts = await db.query(`
  SELECT (SELECT COUNT(*) FROM dbo.woreda) AS woredas, (SELECT COUNT(*) FROM dbo.kebele) AS kebeles,
         (SELECT COUNT(*) FROM dbo.vet_farm) AS vet_areas, (SELECT COUNT(*) FROM dbo.app_user) AS users`);
await db.close();
console.log('Ready:', counts.recordset[0]);
