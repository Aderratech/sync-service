import { REFERENCE_ROWS, type ChangesResponse, type ReferenceTable } from '@aderratech/contracts/sync';
import { clientConfig } from './config.js';
import { sql } from './db/pool.js';
import { farmFor, membershipsFor } from './me.js';
import { lc } from './ops/outcome.js';
import type { UserRow } from './users.js';

/**
 * GET /api/v1/changes (PLAN.md §9.6). The cursor is opaque to the phone: the
 * time of the last pull and the reference-table versions it holds.
 *
 * Time-based lists restart a little before the last pull, because a row
 * written in a transaction that commits after the pull can carry an earlier
 * time. The phone stores every row by its id, so a repeat is harmless.
 */
const OVERLAP_MS = 30_000;

type Cursor = { t: string | null; v: Partial<Record<ReferenceTable, number>> };

export function readCursor(since: string | null): Cursor {
  if (!since) return { t: null, v: {} };
  try {
    const parsed = JSON.parse(Buffer.from(since, 'base64url').toString('utf8')) as Cursor;
    return { t: typeof parsed.t === 'string' ? parsed.t : null, v: parsed.v ?? {} };
  } catch {
    return { t: null, v: {} }; // an unreadable cursor: start again from everything
  }
}

const writeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const REFERENCE_SQL: Record<ReferenceTable, string> = {
  region: 'SELECT region_id, name_en, name_am, name_om FROM dbo.region',
  zone: 'SELECT zone_id, region_id, name_en, name_am, name_om FROM dbo.zone',
  woreda: 'SELECT woreda_id, zone_id, name_en, name_am, name_om FROM dbo.woreda',
  kebele: 'SELECT kebele_id, woreda_id, CAST(lat AS FLOAT) AS lat, CAST(lon AS FLOAT) AS lon, name_en, name_am, name_om FROM dbo.kebele',
  animal_type: 'SELECT code, sort_order, name_en, name_am, name_om FROM dbo.animal_type',
  produce_type: 'SELECT code, animal_code, sort_order, name_en, name_am, name_om FROM dbo.produce_type',
  sign: 'SELECT code, animal_code, sort_order, name_en, name_am, name_om FROM dbo.sign',
  disease: 'SELECT code, animal_code, notifiable, classifier_label, name_en, name_am, name_om FROM dbo.disease',
  quick_response: 'SELECT code, kind, text_en, text_am, text_om, sort_order, active FROM dbo.quick_response',
};

/** Reference tables the phone does not hold at their current version, each sent whole. */
async function referenceChanges(pool: sql.ConnectionPool, known: Cursor['v']) {
  const versions = await new sql.Request(pool).query<{ table_name: string; version: number }>(
    'SELECT table_name, version FROM dbo.reference_version');
  const current = new Map(versions.recordset.map((r) => [r.table_name, r.version]));
  const out: Partial<Record<ReferenceTable, { version: number; rows: unknown[] }>> = {};
  const now: Cursor['v'] = {};
  for (const table of Object.keys(REFERENCE_SQL) as ReferenceTable[]) {
    const version = current.get(table) ?? 0; // no row yet: version 0, sent once
    now[table] = version;
    if (known[table] === version) continue;
    const rows = (await new sql.Request(pool).query(REFERENCE_SQL[table])).recordset;
    out[table] = { version, rows: rows.map((row) => REFERENCE_ROWS[table].parse(row)) };
  }
  return { reference: Object.keys(out).length ? out : null, versions: now };
}

export async function buildChanges(pool: sql.ConnectionPool, user: UserRow, since: string | null): Promise<ChangesResponse> {
  const started = new Date();
  const cursor = readCursor(since);
  const after = cursor.t ? new Date(Date.parse(cursor.t) - OVERLAP_MS) : new Date(0);

  const { farm, manages } = await farmFor(pool, user);
  const { reference, versions } = await referenceChanges(pool, cursor.v);

  // Reports the user may see: their own, or every report of the farm they manage (§2).
  const visible = new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('farm', sql.UniqueIdentifier, manages ? farm!.farm_id : null)
    .input('after', sql.DateTime2(3), after);
  const reports = await visible.query<{
    report_id: string; case_number: number; case_code: string; status: string; reporter_user_id: string;
    farm_id: string | null; house_id: string | null; vet_user_id: string | null; vet_name: string | null;
    suspected_code: string | null; confirmed_code: string | null; received_at: Date; confirmed_at: Date | null;
    completed_at: Date | null; withdrawn_at: Date | null; reporter_name: string; animal_code: string;
    produce_code: string | null; onset: string; medicine_given: string; owner_ok: boolean; created_on_device_at: Date;
  }>(`
    SELECT r.report_id, r.case_number, r.case_code, r.status, r.reporter_user_id, r.farm_id, r.house_id,
           r.vet_user_id, v.name AS vet_name, r.suspected_code, r.confirmed_code, r.received_at,
           r.confirmed_at, r.completed_at, r.withdrawn_at, rp.name AS reporter_name, r.animal_code, r.produce_code,
           r.onset, r.medicine_given, r.owner_ok, r.created_on_device_at
    FROM dbo.report r LEFT JOIN dbo.app_user v ON v.user_id = r.vet_user_id
    JOIN dbo.app_user rp ON rp.user_id = r.reporter_user_id
    WHERE (r.reporter_user_id = @user OR (@farm IS NOT NULL AND r.farm_id = @farm))
      AND (r.updated_at > @after OR EXISTS (SELECT 1 FROM dbo.case_event e WHERE e.report_id = r.report_id AND e.at > @after))`);

  const events = await new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('farm', sql.UniqueIdentifier, manages ? farm!.farm_id : null)
    .input('after', sql.DateTime2(3), after)
    .query<{ event_id: string; report_id: string; type: string; at: Date; actor_name: string | null }>(`
      SELECT e.event_id, e.report_id, e.type, e.at, a.name AS actor_name
      FROM dbo.case_event e JOIN dbo.report r ON r.report_id = e.report_id
      LEFT JOIN dbo.app_user a ON a.user_id = e.actor_user_id
      WHERE (r.reporter_user_id = @user OR (@farm IS NOT NULL AND r.farm_id = @farm)) AND e.at > @after`);

  // What was reported, as the vet sees it: tapped signs, and heard ones once the voice note is processed.
  const signs = await new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('farm', sql.UniqueIdentifier, manages ? farm!.farm_id : null)
    .input('after', sql.DateTime2(3), after)
    .query<{ report_id: string; sign_code: string; source: string; removed_at: Date | null }>(`
      SELECT s.report_id, s.sign_code, s.source, s.removed_at
      FROM dbo.report_sign s JOIN dbo.report r ON r.report_id = s.report_id
      WHERE (r.reporter_user_id = @user OR (@farm IS NOT NULL AND r.farm_id = @farm))
        AND (s.added_at > @after OR s.removed_at > @after)`);

  // The conversation (§14 G2): new messages, and messages whose action points were marked done since.
  const messages = await new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('farm', sql.UniqueIdentifier, manages ? farm!.farm_id : null)
    .input('after', sql.DateTime2(3), after)
    .query<{
      message_id: string; report_id: string; side: string; author_name: string; text: string | null; lang: string;
      translated_text: string | null; translated_lang: string | null; sent_at: Date; reply_to_message_id: string | null;
      items: string | null; media_ids: string | null;
    }>(`
      SELECT m.message_id, m.report_id, m.side, a.name AS author_name, m.text, m.lang, m.translated_text,
             m.translated_lang, m.sent_at, m.reply_to_message_id,
             (SELECT i.seq, i.quick_response_code, i.done_at FROM dbo.message_item i
              WHERE i.message_id = m.message_id ORDER BY i.seq FOR JSON PATH) AS items,
             (SELECT x.media_id FROM dbo.media x WHERE x.message_id = m.message_id FOR JSON PATH) AS media_ids
      FROM dbo.message m JOIN dbo.report r ON r.report_id = m.report_id JOIN dbo.app_user a ON a.user_id = m.author_user_id
      WHERE (r.reporter_user_id = @user OR (@farm IS NOT NULL AND r.farm_id = @farm))
        AND (m.received_at > @after OR EXISTS (SELECT 1 FROM dbo.message_item i WHERE i.message_id = m.message_id AND i.done_at > @after))`);

  const notifications = await new sql.Request(pool)
    .input('user', sql.UniqueIdentifier, user.user_id)
    .input('after', sql.DateTime2(3), after)
    .query<{ notification_id: string; type: string; report_id: string | null; subject_user_id: string | null; title: string | null; text: string; created_at: Date; read_at: Date | null }>(`
      SELECT notification_id, type, report_id, subject_user_id, title, text, created_at, read_at FROM dbo.notification
      WHERE user_id = @user AND (created_at > @after OR read_at > @after)`);

  return {
    cursor: writeCursor({ t: started.toISOString(), v: versions }),
    has_more: false,
    server_time: started.toISOString(),
    reports: reports.recordset.map((r) => ({
      report_id: r.report_id.trim(),
      case_number: r.case_number,
      case_code: r.case_code,
      status: r.status as ChangesResponse['reports'][number]['status'],
      reporter_user_id: lc(r.reporter_user_id),
      farm_id: r.farm_id && lc(r.farm_id),
      house_id: r.house_id && lc(r.house_id),
      vet_user_id: r.vet_user_id && lc(r.vet_user_id),
      vet_name: r.vet_name,
      suspected_code: r.suspected_code,
      confirmed_code: r.confirmed_code,
      received_at: r.received_at.toISOString(),
      confirmed_at: iso(r.confirmed_at),
      completed_at: iso(r.completed_at),
      withdrawn_at: iso(r.withdrawn_at),
      reporter_name: r.reporter_name,
      animal_code: r.animal_code,
      produce_code: r.produce_code,
      onset: r.onset as ChangesResponse['reports'][number]['onset'] & string,
      medicine_given: r.medicine_given as ChangesResponse['reports'][number]['medicine_given'] & string,
      owner_ok: r.owner_ok,
      created_on_device_at: r.created_on_device_at.toISOString(),
    })),
    events: events.recordset.map((e) => ({
      event_id: lc(e.event_id),
      report_id: e.report_id.trim(),
      type: e.type as ChangesResponse['events'][number]['type'],
      at: e.at.toISOString(),
      actor_name: e.actor_name,
    })),
    messages: messages.recordset.map((m) => ({
      message_id: m.message_id.trim(),
      report_id: m.report_id.trim(),
      side: m.side as ChangesResponse['messages'][number]['side'],
      author_name: m.author_name,
      text: m.text,
      lang: m.lang.trim() as ChangesResponse['messages'][number]['lang'],
      translated_text: m.translated_text,
      translated_lang: (m.translated_lang?.trim() ?? null) as ChangesResponse['messages'][number]['translated_lang'],
      sent_at: m.sent_at.toISOString(),
      reply_to_message_id: m.reply_to_message_id?.trim() ?? null,
      // FOR JSON writes datetime2 without a zone; the database stores UTC.
      items: (JSON.parse(m.items ?? '[]') as { seq: number; quick_response_code: string; done_at?: string }[]).map((i) => ({
        seq: i.seq,
        quick_response_code: i.quick_response_code,
        done_at: i.done_at ? new Date(i.done_at.endsWith('Z') ? i.done_at : `${i.done_at}Z`).toISOString() : null,
      })),
      media_ids: (JSON.parse(m.media_ids ?? '[]') as { media_id: string }[]).map((x) => x.media_id.trim()),
    })),
    signs: signs.recordset.map((s) => ({
      report_id: s.report_id.trim(),
      sign_code: s.sign_code,
      source: s.source as ChangesResponse['signs'][number]['source'],
      removed_at: iso(s.removed_at),
    })),
    // Transcripts and media state arrive with uploads and voice notes.
    transcripts: [],
    media: [],
    notifications: notifications.recordset.map((n) => ({
      notification_id: lc(n.notification_id),
      type: n.type as ChangesResponse['notifications'][number]['type'],
      report_id: n.report_id?.trim() ?? null,
      subject_user_id: n.subject_user_id && lc(n.subject_user_id),
      title: n.title,
      text: n.text,
      created_at: n.created_at.toISOString(),
      read_at: iso(n.read_at),
    })),
    // The farm and memberships are small: sent whole on every pull.
    memberships: await membershipsFor(pool, user, manages ? farm!.farm_id : null),
    farm,
    reference: reference as ChangesResponse['reference'],
    config: clientConfig(),
  };
}
