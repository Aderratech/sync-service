import type { Operation } from '@aderratech/contracts/sync';
import { sql } from '../db/pool.js';
import { notify } from '../notify.js';
import { woredasOf } from '../me.js';
import type { UserRow } from '../users.js';
import { applied, reject, type Outcome } from './outcome.js';

type ReportCreate = Extract<Operation, { op: 'report.create' }>;

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** Media files land at this path in the lakehouse Files area (docs/sync-service.md). */
export const mediaPath = (reportId: string, mediaId: string) => `Files/global_ingress_uploads/${reportId}/${mediaId}`;

type Place = { farm_name: string | null; house_name: string | null; animal_code: string; produce_code: string | null; kebele_id: number; woreda_id: number };

/**
 * Who may report for this house (§2, §9.5), and the facts the report takes
 * from the house and farm rather than from the phone: animal, produce, kebele.
 */
async function checkPlace(tx: sql.Transaction, user: UserRow, op: ReportCreate): Promise<Place | Outcome> {
  const b = op.body;
  if (!b.farm_id || !b.house_id) {
    // Unregistered smallholders are reported by extension officers (step 4).
    return reject('FORBIDDEN', 'Smallholder cases come with the officer flow.');
  }
  const r = await new sql.Request(tx)
    .input('house', sql.UniqueIdentifier, b.house_id)
    .input('farm', sql.UniqueIdentifier, b.farm_id)
    .query<{ farm_name: string; manager_user_id: string; house_name: string; animal_code: string; produce_code: string | null; active: boolean; kebele_id: number; woreda_id: number }>(`
      SELECT f.name AS farm_name, f.manager_user_id, h.name AS house_name, h.animal_code, h.produce_code, h.active,
             f.kebele_id, k.woreda_id
      FROM dbo.farm_house h JOIN dbo.farm f ON f.farm_id = h.farm_id JOIN dbo.kebele k ON k.kebele_id = f.kebele_id
      WHERE h.house_id = @house AND h.farm_id = @farm`);
  const place = r.recordset[0];
  if (!place) return reject('INVALID_PAYLOAD', 'This house is not on this farm.');

  if (user.role === 'farm_manager') {
    if (!same(place.manager_user_id, user.user_id)) return reject('NOT_MEMBER', 'You are no longer a member of this farm.');
  } else if (user.role === 'farmer') {
    const m = await new sql.Request(tx)
      .input('farm', sql.UniqueIdentifier, b.farm_id)
      .input('house', sql.UniqueIdentifier, b.house_id)
      .input('user', sql.UniqueIdentifier, user.user_id)
      .query<{ state: string; assigned: number }>(`
        SELECT m.state,
               CASE WHEN EXISTS (SELECT 1 FROM dbo.farm_member_house x WHERE x.farm_id = m.farm_id AND x.user_id = m.user_id
                                   AND x.house_id = @house AND x.removed_at IS NULL) THEN 1 ELSE 0 END AS assigned
        FROM dbo.farm_member m WHERE m.farm_id = @farm AND m.user_id = @user`);
    const member = m.recordset[0];
    if (member?.state !== 'active') return reject('NOT_MEMBER', 'You are no longer a member of this farm.');
    if (!member.assigned) return reject('NOT_ASSIGNED', 'You are not assigned to this house.');
  } else if (user.role === 'extension_officer') {
    if (!(await woredasOf(tx, user)).includes(place.woreda_id)) return reject('OUTSIDE_WOREDA', 'This farm is outside your woredas.');
  } else {
    return reject('FORBIDDEN', "You can't do this.");
  }
  if (!place.active) return reject('HOUSE_INACTIVE', 'This house is no longer in use.');
  return place;
}

/** The farm's current vet, else the woreda's (vet_farm), as of today. */
async function findVet(tx: sql.Transaction, farmId: string | null, woredaId: number) {
  const r = await new sql.Request(tx)
    .input('farm', sql.UniqueIdentifier, farmId)
    .input('woreda', sql.Int, woredaId)
    .query<{ vet_user_id: string; vet_email: string; vet_name: string }>(`
      SELECT TOP 1 v.vet_user_id, v.vet_email, u.name AS vet_name
      FROM dbo.vet_farm v JOIN dbo.app_user u ON u.user_id = v.vet_user_id
      WHERE ((@farm IS NOT NULL AND v.farm_id = @farm) OR v.woreda_id = @woreda)
        AND v.valid_from <= CAST(SYSUTCDATETIME() AS DATE)
        AND (v.valid_to IS NULL OR v.valid_to >= CAST(SYSUTCDATETIME() AS DATE))
      ORDER BY CASE WHEN v.farm_id IS NOT NULL THEN 0 ELSE 1 END, v.valid_from DESC`);
  return r.recordset[0] ?? null;
}

/**
 * report.create (§9.5): the report, its labels, signs and media rows, the
 * `received` event and the vet's notification, in one transaction. The phone
 * minted report_id and media ids, so a resend is a duplicate.
 */
export async function reportCreate(tx: sql.Transaction, user: UserRow, op: ReportCreate): Promise<Outcome> {
  const place = await checkPlace(tx, user, op);
  if ('result' in place) return place;
  const vet = await findVet(tx, op.body.farm_id, place.woreda_id);
  // Retryable: the data team assigns a vet, and the phone keeps the case queued until then.
  if (!vet) return reject('NO_VET_ASSIGNED', 'Waiting for a vet to be assigned to this farm.', false);

  const b = op.body;
  const rank1 = b.labels.find((l) => l.rank === 1);
  const inserted = await new sql.Request(tx)
    .input('id', sql.Char(26), op.report_id)
    .input('farm', sql.UniqueIdentifier, b.farm_id)
    .input('house', sql.UniqueIdentifier, b.house_id)
    .input('kebele', sql.Int, place.kebele_id)
    .input('lat', sql.Decimal(9, 6), b.owner_ok ? b.lat : null)
    .input('lon', sql.Decimal(9, 6), b.owner_ok ? b.lon : null)
    .input('reporter', sql.UniqueIdentifier, user.user_id)
    .input('role', sql.VarChar(20), user.role)
    .input('vet', sql.UniqueIdentifier, vet.vet_user_id)
    .input('vet_email', sql.NVarChar(320), vet.vet_email)
    .input('animal', sql.VarChar(20), place.animal_code)
    .input('produce', sql.VarChar(20), place.produce_code)
    .input('onset', sql.VarChar(12), b.onset)
    .input('medicine', sql.VarChar(8), b.medicine_given)
    .input('owner_ok', sql.Bit, b.owner_ok)
    .input('made', sql.DateTime2(3), new Date(b.created_on_device_at))
    .input('suspected', sql.VarChar(40), rank1?.disease_code ?? null)
    .query<{ case_number: number; case_code: string; received_at: Date }>(`
      INSERT INTO dbo.report (report_id, farm_id, house_id, kebele_id, lat, lon, reporter_user_id, reporter_role,
                              vet_user_id, vet_email, animal_code, produce_code, onset, medicine_given, owner_ok,
                              created_on_device_at, suspected_code)
      OUTPUT inserted.case_number, inserted.case_code, inserted.received_at
      VALUES (@id, @farm, @house, @kebele, @lat, @lon, @reporter, @role, @vet, @vet_email, @animal, @produce,
              @onset, @medicine, @owner_ok, @made, @suspected)`);
  const report = inserted.recordset[0]!;

  for (const l of b.labels) {
    await new sql.Request(tx)
      .input('id', sql.Char(26), op.report_id).input('rank', sql.TinyInt, l.rank).input('code', sql.VarChar(40), l.disease_code)
      .input('score', sql.Decimal(5, 4), l.score).input('model', sql.VarChar(40), b.model_version)
      .query('INSERT INTO dbo.report_label (report_id, rank, disease_code, score, model_version) VALUES (@id, @rank, @code, @score, @model)');
  }
  for (const s of b.signs) {
    await new sql.Request(tx)
      .input('id', sql.Char(26), op.report_id).input('code', sql.VarChar(40), s.sign_code).input('source', sql.VarChar(6), s.source)
      .query('INSERT INTO dbo.report_sign (report_id, sign_code, source) VALUES (@id, @code, @source)');
  }
  for (const m of b.media) {
    await new sql.Request(tx)
      .input('media', sql.Char(26), m.media_id).input('id', sql.Char(26), op.report_id).input('kind', sql.VarChar(16), m.kind)
      .input('seq', sql.TinyInt, m.seq).input('path', sql.NVarChar(400), mediaPath(op.report_id, m.media_id))
      .input('type', sql.VarChar(100), m.content_type).input('size', sql.Int, m.size_bytes).input('sha', sql.Char(64), m.sha256)
      .input('duration', sql.SmallInt, m.duration_seconds ?? null).input('lang', sql.Char(2), m.lang ?? null)
      .input('captured', sql.DateTime2(3), new Date(m.captured_at))
      .input('fresh', sql.Bit, m.fresh_ok ?? null).input('fill', sql.Bit, m.fill_ok ?? null).input('shadow', sql.Bit, m.shadow_ok ?? null)
      .input('sharp', sql.Bit, m.sharp_ok ?? null).input('light', sql.Bit, m.light_ok ?? null)
      .query(`INSERT INTO dbo.media (media_id, report_id, kind, seq, onelake_path, content_type, size_bytes, sha256, duration_seconds,
                                     lang, captured_at, fresh_ok, fill_ok, shadow_ok, sharp_ok, light_ok)
              VALUES (@media, @id, @kind, @seq, @path, @type, @size, @sha, @duration, @lang, @captured, @fresh, @fill, @shadow, @sharp, @light)`);
  }
  await new sql.Request(tx)
    .input('id', sql.Char(26), op.report_id).input('actor', sql.UniqueIdentifier, user.user_id)
    .query("INSERT INTO dbo.case_event (report_id, actor_user_id, type) VALUES (@id, @actor, 'received')");
  if (user.role === 'extension_officer' && b.farm_id) {
    // The farm joins the officer's list, for the next visit (§16 D2).
    await new sql.Request(tx).input('officer', sql.UniqueIdentifier, user.user_id).input('farm', sql.UniqueIdentifier, b.farm_id)
      .query(`IF NOT EXISTS (SELECT 1 FROM dbo.officer_farm WHERE officer_user_id = @officer AND farm_id = @farm)
                INSERT INTO dbo.officer_farm (officer_user_id, farm_id, source) VALUES (@officer, @farm, 'reported')
              ELSE UPDATE dbo.officer_farm SET removed_at = NULL WHERE officer_user_id = @officer AND farm_id = @farm`);
  }
  await notify(tx, {
    userId: vet.vet_user_id,
    reportId: op.report_id,
    type: 'new_report',
    title: `New case from ${place.farm_name ?? 'a smallholder'}`,
    text: [report.case_code, place.house_name].filter(Boolean).join(' · '),
  });

  return applied({
    report_id: op.report_id,
    case_number: report.case_number,
    case_code: report.case_code,
    status: 'new',
    received_at: report.received_at.toISOString(),
    vet_name: vet.vet_name,
  });
}
