import type { Operation } from '@aderratech/contracts/sync';
import { sql } from '../db/pool.js';
import { findMedia, isReporter } from '../media/access.js';
import { mediaStore, sha256 } from '../media/store.js';
import type { UserRow } from '../users.js';
import { applied, reject, type Outcome } from './outcome.js';

/**
 * media.confirm (docs/sync-service.md): the file the phone uploaded is in the store with the size and
 * SHA-256 it says, so media.uploaded_at is set and others can read it. A missing or different file is
 * rejected MEDIA_MISSING, which the phone retries after uploading again.
 */
export async function mediaConfirm(tx: sql.Transaction, user: UserRow, op: Extract<Operation, { op: 'media.confirm' }>): Promise<Outcome> {
  const media = await findMedia(tx, user, op.body.media_id);
  if (!media || !isReporter(media, user)) return reject('FORBIDDEN', 'This photo is not yours to send.');
  if (media.uploaded_at) return applied();
  const data = await mediaStore().get(media.onelake_path);
  if (!data || data.length !== op.body.size_bytes || sha256(data) !== op.body.sha256.toLowerCase()) {
    return reject('MEDIA_MISSING', 'The photo did not arrive whole. It will be sent again.', false);
  }
  await new sql.Request(tx)
    .input('media', sql.Char(26), op.body.media_id)
    .input('size', sql.Int, data.length)
    .input('sha', sql.Char(64), op.body.sha256.toLowerCase())
    .query('UPDATE dbo.media SET uploaded_at = SYSUTCDATETIME(), size_bytes = @size, sha256 = @sha WHERE media_id = @media');
  return applied();
}
