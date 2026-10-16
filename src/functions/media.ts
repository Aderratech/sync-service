import { app, type HttpRequest } from '@azure/functions';
import { ReadLinkRequest, UploadLinkRequest } from '@aderratech/contracts/sync';
import { endpoint, fail, json } from '../http.js';
import { findMedia, isReporter } from '../media/access.js';
import { mediaStore } from '../media/store.js';
import { ensureUser, startLanguage } from '../users.js';

/** Photos are a few hundred kB; this leaves room for voice notes. */
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

/**
 * The "link" is the service's own content endpoint: the phone sends its usual sign-in headers, and the
 * service writes to or reads from the media store (src/media/store.ts). The contract's shape lets this
 * become a direct OneLake link later without changing the phone.
 */
const contentUrl = (request: HttpRequest, mediaId: string) => `${new URL(request.url).origin}/api/v1/media/${mediaId}/content`;
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function body(request: HttpRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** POST /api/v1/media/upload-link: for the reporter, while the file is not uploaded yet. */
app.http('mediaUploadLink', {
  methods: ['POST'],
  route: 'v1/media/upload-link',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, identity, pool }) => {
    const parsed = UploadLinkRequest.safeParse(await body(request));
    if (!parsed.success) return fail(400, 'INVALID_PAYLOAD', 'Something in this photo could not be read.');
    const user = await ensureUser(pool, identity, startLanguage(request.headers.get('accept-language')));
    const media = await findMedia(pool, user, parsed.data.media_id);
    if (!media || media.report_id.trim() !== parsed.data.report_id || !isReporter(media, user)) {
      return fail(403, 'FORBIDDEN', 'This photo is not yours to send.');
    }
    return json(200, {
      url: contentUrl(request, parsed.data.media_id),
      method: 'PUT',
      headers: { 'Content-Type': media.content_type },
      expires_at: inMinutes(15),
    });
  }),
});

/** POST /api/v1/media/read-link: the reporter, the farm's manager or the message's author. */
app.http('mediaReadLink', {
  methods: ['POST'],
  route: 'v1/media/read-link',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, identity, pool }) => {
    const parsed = ReadLinkRequest.safeParse(await body(request));
    if (!parsed.success) return fail(400, 'INVALID_PAYLOAD', 'Something in this request could not be read.');
    const user = await ensureUser(pool, identity, startLanguage(request.headers.get('accept-language')));
    const media = await findMedia(pool, user, parsed.data.media_id);
    if (!media?.can_read) return fail(403, 'FORBIDDEN', "You can't see this photo.");
    if (!media.uploaded_at) return fail(404, 'MEDIA_MISSING', 'This photo has not arrived yet.');
    return json(200, { url: contentUrl(request, parsed.data.media_id), expires_at: inMinutes(5) });
  }),
});

/** PUT (the reporter) or GET (anyone who may read it) /api/v1/media/{mediaId}/content. */
app.http('mediaContent', {
  methods: ['GET', 'PUT'],
  route: 'v1/media/{mediaId}/content',
  authLevel: 'anonymous',
  handler: endpoint(async ({ request, identity, pool }) => {
    const user = await ensureUser(pool, identity, startLanguage(request.headers.get('accept-language')));
    const media = await findMedia(pool, user, request.params.mediaId ?? '');
    const store = mediaStore();

    if (request.method === 'PUT') {
      if (!media || !isReporter(media, user)) return fail(403, 'FORBIDDEN', 'This photo is not yours to send.');
      if (media.uploaded_at) return { status: 204 }; // already confirmed: nothing to do
      const data = Buffer.from(await request.arrayBuffer());
      if (data.length === 0 || data.length > MAX_MEDIA_BYTES) return fail(413, 'INVALID_PAYLOAD', 'This file is too large.');
      await store.put(media.onelake_path, data, media.content_type);
      return { status: 204 };
    }

    if (!media?.can_read) return fail(403, 'FORBIDDEN', "You can't see this photo.");
    const data = media.uploaded_at ? await store.get(media.onelake_path) : null;
    if (!data) return fail(404, 'MEDIA_MISSING', 'This photo has not arrived yet.');
    return { status: 200, body: data, headers: { 'Content-Type': media.content_type, 'Cache-Control': 'private, max-age=86400' } };
  }),
});
