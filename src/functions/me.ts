import { app } from '@azure/functions';
import { endpoint, json } from '../http.js';
import { buildMe } from '../me.js';
import { ensureUser, startLanguage } from '../users.js';

/** GET /api/v1/me: first sign-in creates the user (sign-up and sign-in are one step). */
app.http('me', {
  methods: ['GET'],
  route: 'v1/me',
  authLevel: 'anonymous', // App Service authentication guards the app; identity comes from its headers
  handler: endpoint(async ({ request, identity, pool }) => {
    const user = await ensureUser(pool, identity, startLanguage(request.headers.get('accept-language')));
    return json(200, await buildMe(pool, user));
  }),
});
