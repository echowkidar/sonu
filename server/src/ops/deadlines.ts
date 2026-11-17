/**
 * Deadline sweep: evaluates each open WR's active rule (see deadlineFor), stores due_at / breach_level on wr_internal,
 * and raises notifications once per WR per threshold (dedupe = a wr_event row with payload.key):
 *  - unowned WR past the take-ownership limit -> coordinators ("wr.not_owned")
 *  - warning day reached -> owner ("deadline.warning")
 *  - breached -> owner + managers ("deadline.breach", also e-mail)
 */
import type { FastifyInstance } from 'fastify';
import { notify } from '../notifications/index.js';
import { deadlineFor, loadComputeContext, WR_SELECT, type WrRow } from './context.js';

export interface SweepResult {
  contractors: number;
  evaluated: number;
  warnings: number;
  breaches: number;
  notOwned: number;
}

export async function runDeadlineSweep(app: FastifyInstance, contractorId?: string): Promise<SweepResult> {
  const out: SweepResult = { contractors: 0, evaluated: 0, warnings: 0, breaches: 0, notOwned: 0 };
  const ids = contractorId
    ? [contractorId]
    : (await app.db.query<{ id: string }>(`SELECT id FROM contractor WHERE status = 'active'`)).rows.map((r) => r.id);
  for (const cid of ids) {
    out.contractors++;
    const ctx = await loadComputeContext(app, app.db, cid);
    const rows = (await app.db.query<WrRow>(`${WR_SELECT} WHERE w.contractor_id = $1 AND w.gone_at IS NULL`, [cid])).rows;
    const roleUsers = async (role: string) =>
      (await app.db.query<{ id: string }>(`SELECT id FROM app_user WHERE contractor_id = $1 AND role = $2 AND status = 'active'`, [cid, role])).rows.map((r) => r.id);
    let coordinators: string[] | null = null;
    let managers: string[] | null = null;

    for (const w of rows) {
      out.evaluated++;
      const d = deadlineFor(w, ctx);
      const level = d ? (d.breached ? 2 : d.state === 'amber' ? 1 : 0) : 0;
      const dueAt = d?.dueDate ?? null;
      await app.db.query(
        `INSERT INTO wr_internal (contractor_id, work_request_id, due_at, breach_level, deadline_rule_id)
         VALUES ($1,$2, ($3::date::timestamp AT TIME ZONE 'UTC'), $4, $5)
         ON CONFLICT (work_request_id) DO UPDATE SET due_at = EXCLUDED.due_at, breach_level = EXCLUDED.breach_level,
           deadline_rule_id = EXCLUDED.deadline_rule_id`,
        [cid, w.id, dueAt, level, d ? (ctx.ruleKeys.get(d.ruleKey) ?? null) : null],
      );
      if (!d || level === 0) continue;

      let type: string;
      let key: string;
      let recipients: string[];
      let title: string;
      let channels: ('in_app' | 'push' | 'email')[];
      if (!w.owner_id) {
        if (!d.breached) continue;
        type = 'wr.not_owned';
        key = `${d.ruleKey}:breach`;
        recipients = coordinators ??= await roleUsers('coordinator');
        title = `WR ${w.wr_code} is not owned in time`;
        channels = ['in_app', 'push'];
      } else if (d.breached) {
        type = 'deadline.breach';
        key = `${d.ruleKey}:breach`;
        recipients = [...new Set([w.owner_id, ...(managers ??= await roleUsers('manager'))])];
        title = `Deadline breached: WR ${w.wr_code} - ${d.ruleName} (day ${d.dayNumber} of ${d.limit})`;
        channels = ['in_app', 'push', 'email'];
      } else {
        const warnDay = d.warningsDue.length ? Math.max(...d.warningsDue) : d.limit;
        type = 'deadline.warning';
        key = `${d.ruleKey}:w${warnDay}`;
        recipients = [w.owner_id];
        title = `Deadline warning: WR ${w.wr_code} - ${d.ruleName} due ${d.dueDate} (day ${d.dayNumber} of ${d.limit})`;
        channels = ['in_app', 'push'];
      }
      // Once per WR per threshold: the timeline row is the marker.
      const ins = await app.db.query(
        `INSERT INTO wr_event (contractor_id, work_request_id, type, source, payload)
         SELECT $1, $2, $3, 'sonu', $4::jsonb
          WHERE NOT EXISTS (SELECT 1 FROM wr_event WHERE work_request_id = $2 AND type = $3 AND payload->>'key' = $5)`,
        [cid, w.id, type, JSON.stringify({ key, rule: d.ruleKey, day: d.dayNumber, limit: d.limit, dueDate: d.dueDate }), key],
      );
      if (!ins.rowCount) continue;
      if (type === 'wr.not_owned') out.notOwned++;
      else if (type === 'deadline.breach') out.breaches++;
      else out.warnings++;
      if (recipients.length) {
        await notify(app, {
          contractorId: cid, event: type, recipients, title, link: `/wr/${w.wr_code}`, entityType: 'work_request', entityId: w.wr_code,
          workRequestId: w.id, channels,
        });
      }
    }
  }
  return out;
}
