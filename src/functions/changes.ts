import { app } from '@azure/functions';
import { buildChanges } from '../changes.js';
import { endpoint, json } from '../http.js';
import { ensureUser, startLanguage } from '../users.js';

/** GET /api/v1/changes?since=<cursor>: everything the user may see that changed (PLAN.md §9.6). */
app.http('changes', {
  methods: ['GET'],
  route: 'v1/changes',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, identity, pool }) => {
    const user = await ensureUser(pool, identity, startLanguage(request.headers.get('accept-language')));
    return json(200, await buildChanges(pool, user, request.query.get('since')));
  }),
});
