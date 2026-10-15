import type { NotificationType } from '@aderratech/contracts';
import { sql } from './db/pool.js';

/**
 * Writes one notification row (PLAN.md §17). The push itself comes later; it
 * carries only ids, and the phone reads the text through /changes.
 *
 * The text is English for now: Amharic and Afaan Oromoo notification text comes
 * from the reviewed string catalogue, never machine translation (§19.3).
 */
export async function notify(
  tx: sql.Transaction,
  n: { userId: string; type: NotificationType; title: string; text: string; reportId?: string | null },
): Promise<void> {
  await new sql.Request(tx)
    .input('user', sql.UniqueIdentifier, n.userId)
    .input('report', sql.Char(26), n.reportId ?? null)
    .input('type', sql.VarChar(20), n.type)
    .input('title', sql.NVarChar(200), n.title)
    .input('text', sql.NVarChar(500), n.text)
    .query('INSERT INTO dbo.notification (user_id, report_id, type, title, text) VALUES (@user, @report, @type, @title, @text)');
}
