import type { Operation } from '@aderratech/contracts/sync';
import { sql } from '../db/pool.js';
import type { UserRow } from '../users.js';
import { applied, type Outcome } from './outcome.js';

/** The user opened notifications (§17.2): sets read_at on their own, once. Others' ids are ignored. */
export async function notificationRead(tx: sql.Transaction, user: UserRow, op: Extract<Operation, { op: 'notification.read' }>): Promise<Outcome> {
  const request = new sql.Request(tx).input('user', sql.UniqueIdentifier, user.user_id);
  const ids = op.body.notification_ids.map((id, i) => {
    request.input(`n${i}`, sql.UniqueIdentifier, id);
    return `@n${i}`;
  });
  await request.query(`UPDATE dbo.notification SET read_at = SYSUTCDATETIME()
                       WHERE user_id = @user AND read_at IS NULL AND notification_id IN (${ids.join(', ')})`);
  return applied();
}
