import { app } from '@azure/functions';
import { endpoint, fail, json } from '../http.js';
import { lc } from '../ops/outcome.js';
import { sql } from '../db/pool.js';
import { officerFarms } from '../officer.js';
import { mayChooseVet, vetsForFarm } from '../vets.js';
import { ensureUser } from '../users.js';

/**
 * GET /api/v1/farms/lookup?join_code=: a farm to join (§15 C1). Name and
 * woreda only, so a guessed code reveals little.
 */
app.http('farmLookup', {
  methods: ['GET'],
  route: 'v1/farms/lookup',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, pool }) => {
    const code = request.query.get('join_code')?.trim().toUpperCase();
    if (!code) return fail(400, 'INVALID_PAYLOAD', 'Enter the farm code.');
    const r = await new sql.Request(pool).input('code', sql.VarChar(12), code).query<{ farm_id: string; name: string; woreda_id: number }>(`
      SELECT f.farm_id, f.name, k.woreda_id FROM dbo.farm f JOIN dbo.kebele k ON k.kebele_id = f.kebele_id WHERE f.join_code = @code`);
    const farm = r.recordset[0];
    if (!farm) return fail(404, 'JOIN_CODE_UNKNOWN', 'No farm has this code.');
    return json(200, { farm_id: lc(farm.farm_id), name: farm.name, woreda_id: farm.woreda_id });
  }),
});

/**
 * GET /api/v1/officer/farms (§16 D2): the farms this officer reports for.
 * GET /api/v1/officer/farms?q=: farms in the officer's woreda whose name contains q.
 */
app.http('officerFarms', {
  methods: ['GET'],
  route: 'v1/officer/farms',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, identity, pool }) => {
    const user = await ensureUser(pool, identity, 'en');
    if (user.role !== 'extension_officer') return fail(403, 'FORBIDDEN', 'For extension officers.');
    return json(200, await officerFarms(pool, user, request.query.get('q') ?? ''));
  }),
});

/** GET /api/v1/farms/vets?farm_id=: the vets a farm can ask (those serving its woreda), for whoever chooses its vet. */
app.http('farmVets', {
  methods: ['GET'],
  route: 'v1/farms/vets',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, identity, pool }) => {
    const farmId = request.query.get('farm_id') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(farmId)) return fail(400, 'INVALID_PAYLOAD', 'Which farm?');
    const user = await ensureUser(pool, identity, 'en');
    if (!(await mayChooseVet(pool, user, farmId))) return fail(403, 'FORBIDDEN', "Only the farm's manager can choose its vet.");
    return json(200, { vets: await vetsForFarm(pool, user, farmId) });
  }),
});
