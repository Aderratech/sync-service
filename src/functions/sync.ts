import { app } from '@azure/functions';
import { MAX_BATCH_BYTES } from '@aderratech/contracts/sync';
import { endpoint, fail, json } from '../http.js';
import { applyBatch, SyncEnvelope } from '../ops/apply.js';
import { ensureUser, startLanguage } from '../users.js';

/** POST /api/v1/sync: a batch from the phone's outbox (PLAN.md §9.4). */
app.http('sync', {
  methods: ['POST'],
  route: 'v1/sync',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, identity, pool }) => {
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BATCH_BYTES) return fail(413, 'INVALID_PAYLOAD', 'Batch too large.');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, 'INVALID_PAYLOAD', 'Something in this report could not be read.');
    }
    const envelope = SyncEnvelope.safeParse(body);
    if (!envelope.success) return fail(400, 'INVALID_PAYLOAD', 'Something in this report could not be read.');
    const user = await ensureUser(pool, identity, startLanguage(request.headers.get('accept-language')));
    return json(200, await applyBatch(pool, user, envelope.data.ops));
  }),
});
