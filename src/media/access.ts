import { sql } from '../db/pool.js';
import type { UserRow } from '../users.js';

export type MediaRow = {
  media_id: string;
  report_id: string;
  kind: string;
  content_type: string;
  onelake_path: string;
  size_bytes: number | null;
  sha256: string | null;
  uploaded_at: Date | null;
  reporter_user_id: string;
  can_read: boolean;
};

/**
 * A media row and what this user may do with it: the reporter uploads it; the reporter, the farm's manager
 * or the author of the message it belongs to may read it (docs/sync-service.md, media/read-link).
 */
export async function findMedia(db: sql.ConnectionPool | sql.Transaction, user: UserRow, mediaId: string): Promise<MediaRow | null> {
  const r = await new sql.Request(db as sql.ConnectionPool)
    .input('media', sql.Char(26), mediaId)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .query<MediaRow>(`
      SELECT m.media_id, m.report_id, m.kind, m.content_type, m.onelake_path, m.size_bytes, m.sha256, m.uploaded_at,
             r.reporter_user_id,
             CAST(CASE WHEN r.reporter_user_id = @user
                         OR r.farm_id IN (SELECT farm_id FROM dbo.farm WHERE manager_user_id = @user)
                         OR EXISTS (SELECT 1 FROM dbo.message x WHERE x.message_id = m.message_id AND x.author_user_id = @user)
                       THEN 1 ELSE 0 END AS BIT) AS can_read
      FROM dbo.media m JOIN dbo.report r ON r.report_id = m.report_id
      WHERE m.media_id = @media`);
  return r.recordset[0] ?? null;
}

export const isReporter = (row: MediaRow, user: UserRow) => row.reporter_user_id.toLowerCase() === user.user_id.toLowerCase();
