import type { Operation } from '@aderratech/contracts/sync';
import { sql } from '../db/pool.js';
import { notify } from '../notify.js';
import type { UserRow } from '../users.js';
import { applied, reject, type Outcome } from './outcome.js';

type ReportDone = Extract<Operation, { op: 'report.done' }>;

/**
 * report.done (§14 G2): the farm's Completed. On a confirmed case it completes the case ('completed' event,
 * status completed); before confirmation it only records 'done'. Either way the vet is told. The reporter
 * or the farm's manager may tap it; a case already completed is left as it is.
 */
export async function reportDone(tx: sql.Transaction, user: UserRow, op: ReportDone): Promise<Outcome> {
  const r = await new sql.Request(tx)
    .input('id', sql.Char(26), op.report_id)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .query<{ case_code: string; status: string; vet_user_id: string | null; withdrawn_at: Date | null; farm_name: string | null }>(`
      SELECT r.case_code, r.status, r.vet_user_id, r.withdrawn_at, f.name AS farm_name
      FROM dbo.report r LEFT JOIN dbo.farm f ON f.farm_id = r.farm_id
      WHERE r.report_id = @id
        AND (r.reporter_user_id = @user OR r.farm_id IN (SELECT farm_id FROM dbo.farm WHERE manager_user_id = @user))`);
  const report = r.recordset[0];
  if (!report) return reject('FORBIDDEN', 'Only the reporter or the farm manager can mark this case.');
  if (report.withdrawn_at) return reject('INVALID_PAYLOAD', 'This case was withdrawn.');
  if (report.status === 'completed') return applied();

  const tapped = new Date(op.body.tapped_at);
  const completes = report.status === 'confirmed';
  if (completes) {
    await new sql.Request(tx)
      .input('id', sql.Char(26), op.report_id)
      .input('at', sql.DateTime2(3), tapped)
      .query("UPDATE dbo.report SET status = 'completed', completed_at = @at, updated_at = SYSUTCDATETIME() WHERE report_id = @id");
  }
  await new sql.Request(tx)
    .input('id', sql.Char(26), op.report_id)
    .input('actor', sql.UniqueIdentifier, user.user_id)
    .input('type', sql.VarChar(12), completes ? 'completed' : 'done')
    .query('INSERT INTO dbo.case_event (report_id, actor_user_id, type) VALUES (@id, @actor, @type)');
  if (report.vet_user_id) {
    await notify(tx, {
      userId: report.vet_user_id,
      type: 'done',
      reportId: op.report_id,
      title: completes ? 'Case completed' : 'Done tapped',
      text: completes
        ? `${report.case_code}: ${user.name}${report.farm_name ? ` (${report.farm_name})` : ''} marked the case completed.`
        : `${report.case_code}: ${user.name} tapped Done. The case is still waiting for your confirmation.`,
      subjectUserId: user.user_id,
    });
  }
  return applied({ status: completes ? 'completed' : report.status });
}
