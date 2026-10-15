import { app } from '@azure/functions';
import { endpoint, fail, json } from '../http.js';
import { lc } from '../ops/outcome.js';
import { sql } from '../db/pool.js';

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
