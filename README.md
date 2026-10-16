# Aderra sync service

The mobile app's only server: Azure Functions (TypeScript, Node.js 22) that write the Aderra SQL database in Fabric, using the database role `aderra_sync`. The phone never talks to the portal or the database directly.

What it accepts and returns is defined in [`@aderratech/contracts`](https://github.com/Aderratech/contracts) (`src/sync/`, `docs/sync-service.md`). The app's full specification is `PLAN.md` in [Aderratech/mobile](https://github.com/Aderratech/mobile).

## Endpoints so far

| Endpoint | Does |
| --- | --- |
| `GET /api/v1/me` | First sign-in creates the user, with no role until first run; returns the user, farm, memberships and config |
| `POST /api/v1/sync` | Applies a batch of operations in order. Each is recorded in `sync_op` in the same transaction, so a resend gets the first answer. Handles `user.update` and `device.register`; others are refused as `SERVER_BUSY` (retryable) so the phone keeps them queued |

Every request needs `X-Aderra-Contract` (this contract's major or the one before) and `X-Aderra-App-Build` (at least `MIN_APP_BUILD`), else `426`.

## Layout

| Path | Holds |
| --- | --- |
| `src/functions/` | Thin HTTP bindings, one file per endpoint |
| `src/http.ts` | Compatibility check, sign-in, database connection, error mapping (every failure is an explicit status, never a hang) |
| `src/auth/identity.ts` | The caller, from App Service authentication's `X-MS-CLIENT-PRINCIPAL*` headers; locally, from `dev:` tokens |
| `src/me.ts`, `src/users.ts`, `src/ops/` | The logic, as plain functions the tests call directly |
| `src/db/pool.ts` | `mssql` pool: managed identity in Azure, a SQL login locally |

## Running locally

Needs Docker Desktop, the .NET 8 SDK, SqlPackage (`dotnet tool install -g microsoft.sqlpackage`), Aderratech/contracts cloned beside this repo, and a GitHub token with `read:packages` in `NODE_AUTH_TOKEN` for the contracts package (see the contracts README).

```bash
npm install
npm run db:local                      # SQL Server in Docker, schema from ../contracts, login sync_local in aderra_sync
cp local.settings.example.json local.settings.json
npm start                             # http://localhost:7071/api/v1/…
npm test                              # unit and integration tests against the local database
```

### Signing in locally

App Service authentication only exists in Azure. Locally, with `ADERRA_DEV_AUTH=1`, the service accepts `X-ZUMO-AUTH: dev:<base64url JSON {"sub","name"}>` and treats it as a Google user with subject `dev-<sub>`. The setting is ignored in Azure (`WEBSITE_INSTANCE_ID` is set), so dev tokens can never sign anyone in there.

From the Android emulator the service is at `http://10.0.2.2:7071`.

## Interim test service (deployed)

A separate test setup, so phones can be tested over any network before the portal's database is shared. Nothing here touches `Aderra_Ops`.

| Piece | Where |
| --- | --- |
| Database | `Aderra_Mobile_Interim` (SQL database in Fabric, Unipod workspace), schema and test data from `npm run db:interim -- --interim` |
| Service | Function App `aderra-sync-interim` (Flex Consumption, Node 22, Central US, resource group `rg-animalhealth`), `https://aderra-sync-interim.azurewebsites.net` |
| Photos | `Aderra_Lakehouse`, `Files/interim/uploads/{report_id}/{media_id}` (`MEDIA_STORE=onelake`, `MEDIA_FOLDER=interim`) |
| Access | The app's managed identity: Contributor on the Unipod workspace; `aderra_sync` in `Aderra_Mobile_Interim` |
| Sign-in | Test users only: `ADERRA_DEV_AUTH=1` with `ADERRA_DEV_AUTH_KEY` (kept out of the repo); every request needs `X-Aderra-Test-Key` |

Deploy: the private contracts package can't be installed in Azure, so build here and upload a package with production dependencies (`npm run build`; copy `dist`, `host.json`, `package*.json`, `.npmrc` to a folder; `npm ci --omit=dev`; zip without `.npmrc`; `az functionapp deployment source config-zip -g rg-animalhealth -n aderra-sync-interim --src <zip>`).

## Azure (not deployed yet)

- A Function App on the Flex Consumption plan, Node.js 22, with a system-assigned managed identity.
- App Service authentication with the Google provider (the Web OAuth client ID), "Require authentication", returning 401 for unauthenticated requests.
- The managed identity added to the database role `aderra_sync` (contracts `db/security/members.template.sql`).
- App settings: `SQL_SERVER`, `SQL_DATABASE`, `SQL_AUTH=default`, `MIN_APP_BUILD`.
