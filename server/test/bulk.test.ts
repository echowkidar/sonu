import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSETS_DIR, Client, createContractorWithAdmin, makeTestApp, setupPlatformAdmin, type TestContext } from './helpers.js';

/** Loads the real template from assets/, writes rows from row 3 (row 2 = EXAMPLE stays). */
async function fillTemplate(file: string, sheets: Record<string, (string | number | null)[][]>, extraHeader?: { sheet: string; caption: string }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ASSETS_DIR, file));
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name)!;
    rows.forEach((r, i) => {
      const row = ws.getRow(3 + i);
      r.forEach((v, j) => {
        row.getCell(j + 1).value = v;
      });
      row.commit();
    });
  }
  if (extraHeader) {
    const ws = wb.getWorksheet(extraHeader.sheet)!;
    ws.getRow(1).getCell(ws.columnCount + 1).value = extraHeader.caption;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function multipart(kind: string, fileName: string, buf: Buffer) {
  const boundary = '----sonutest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, buf, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(ctx: TestContext, client: Client, kind: string, fileName: string, buf: Buffer) {
  const { payload, contentType } = multipart(kind, fileName, buf);
  return ctx.app.inject({
    method: 'POST',
    url: '/api/admin/bulk-import/preview',
    payload,
    headers: { 'content-type': contentType, 'x-requested-with': 'sonu', cookie: client.cookie },
  });
}

const count = async (ctx: TestContext, table: string) => (await ctx.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

describe('bulk import', () => {
  let ctx: TestContext;
  let platform: Client;
  let admin: Client;

  beforeAll(async () => {
    ctx = await makeTestApp();
    platform = await setupPlatformAdmin(ctx);
    ({ admin } = await createContractorWithAdmin(platform, ctx, 'BULK', 'admin.bulk@example.com'));
    await createContractorWithAdmin(platform, ctx, 'OTHER', 'admin.other@example.com');
    await admin.post('/api/admin/users', { email: 'manager.bulk@example.com', fullName: 'Manager Bulk', role: 'manager', sendInvite: false });
  });
  afterAll(async () => ctx?.close());

  it('contractors: preview shows add / update / problem, skips EXAMPLE, saves nothing before confirm', async () => {
    const buf = await fillTemplate('SONU-import-contractors.xlsx', {
      Contractors: [
        ['NEWCO', 'New Company W.L.L.', null, 'TRADE-1', 'WT-N1; WT-N2', 'Civil; HVAC', 'New Admin', 'new.admin@example.com', '97455550111', null, 'Asia/Qatar', 'Active', null],
        ['BULK', 'Bulk Renamed W.L.L.', null, null, 'WT-BULK-Z1', null, 'Ignored Admin', 'ignored@example.com', null, null, null, 'Active', null],
        ['BADCO', 'Bad Company', null, null, null, null, 'Bad Admin', 'not-an-email', null, null, 'Mars/Base', 'Maybe', null],
        ['NEWCO', 'Duplicate', null, null, null, null, 'Dup Admin', 'dup@example.com', null, null, null, 'Active', null],
        ['TAKEN', 'Taken Admin Co', null, null, null, null, 'Taken', 'admin.bulk@example.com', null, null, null, 'Active', null],
      ],
    });
    const before = { c: await count(ctx, 'contractor'), u: await count(ctx, 'app_user'), r: await count(ctx, 'deadline_rule') };

    expect((await upload(ctx, admin, 'contractors', 'c.xlsx', buf)).statusCode).toBe(403);
    const res = await upload(ctx, platform, 'contractors', 'contractors-batch.xlsx', buf);
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.counts).toEqual({ add: 1, update: 1, problem: 3, skippedExamples: 1 });
    const byRow = Object.fromEntries(p.rows.map((r: { rowNumber: number }) => [r.rowNumber, r]));
    expect(byRow[3].action).toBe('add');
    expect(byRow[3].values.adminMobile).toBe('+97455550111');
    expect(byRow[4].action).toBe('update');
    const bad = byRow[5].problems.map((x: { column: string }) => x.column).sort();
    expect(bad).toEqual(['Admin Email', 'Status', 'Time Zone']);
    expect(byRow[6].problems[0].reason).toMatch(/more than once/);
    expect(byRow[7].problems[0]).toMatchObject({ column: 'Admin Email', reason: expect.stringMatching(/already belongs/) });

    expect(await count(ctx, 'contractor')).toBe(before.c);
    expect(await count(ctx, 'app_user')).toBe(before.u);
    expect(await count(ctx, 'deadline_rule')).toBe(before.r);

    const conf = await platform.post(`/api/admin/bulk-import/confirm/${p.id}`);
    expect(conf.statusCode).toBe(200);
    expect(conf.json().result).toEqual({ added: 1, updated: 1, rejected: 3 });
    expect(conf.json().invitationsSent).toBe(1);
    expect(await count(ctx, 'contractor')).toBe(before.c + 1);
    const newco = (await platform.get('/api/admin/contractors')).json().items.find((c: { code: string }) => c.code === 'NEWCO');
    expect(newco.marafiqWorkTeams).toEqual(['WT-N1', 'WT-N2']);
    const rules = await ctx.db.query('SELECT count(*)::int AS n FROM deadline_rule WHERE contractor_id = $1', [newco.id]);
    expect(rules.rows[0].n).toBe(16);
    const renamed = (await platform.get('/api/admin/contractors')).json().items.find((c: { code: string }) => c.code === 'BULK');
    expect(renamed.name).toBe('Bulk Renamed W.L.L.');
    const outbox = await ctx.db.query(`SELECT 1 FROM mail_outbox WHERE to_address = 'new.admin@example.com'`);
    expect(outbox.rowCount).toBe(1);
    expect((await ctx.db.query(`SELECT 1 FROM app_user WHERE email = 'ignored@example.com'`)).rowCount).toBe(0);

    const audit = await ctx.db.query(`SELECT summary, details, user_email FROM audit_log WHERE action = 'bulk_import.confirm'`);
    expect(audit.rows[0].details).toMatchObject({ fileName: 'contractors-batch.xlsx', added: 1, updated: 1, rejected: 3 });
    expect(audit.rows[0].user_email).toBe('platform@example.com');

    expect((await platform.post(`/api/admin/bulk-import/confirm/${p.id}`)).statusCode).toBe(409);

    // Rejected rows file
    const rej = await ctx.app.inject({ method: 'GET', url: `/api/admin/bulk-import/${p.id}/rejected.xlsx`, headers: { cookie: platform.cookie } });
    expect(rej.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rej.rawPayload as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Contractors')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Contractor Code*');
    expect(ws.actualRowCount).toBe(4);
    expect(String(ws.getRow(2).getCell(14).value)).toMatch(/Admin Email|Status|Time Zone/);
    // A contractor admin cannot see the platform admin's import
    expect((await admin.get(`/api/admin/bulk-import/${p.id}`)).statusCode).toBe(404);
  });

  it('password-looking column rejects the whole file and stores nothing', async () => {
    const buf = await fillTemplate(
      'SONU-import-users.xlsx',
      { Users: [['BULK', 'Pw User', 'pw.user@example.com', null, 'Technician', null, null, null, null, null, null, null, null, null, 'Active']] },
      { sheet: 'Users', caption: 'Password' },
    );
    const jobs = await count(ctx, 'import_job');
    const users = await count(ctx, 'app_user');
    const res = await upload(ctx, admin, 'users', 'users.xlsx', buf);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('password_column');
    expect(res.json().error.message).toMatch(/Column "Password".*never imported/);
    expect(await count(ctx, 'import_job')).toBe(jobs);
    expect(await count(ctx, 'app_user')).toBe(users);
  });

  it('users: matched on e-mail, scoped to own contractor, invitations after confirm', async () => {
    const buf = await fillTemplate('SONU-import-users.xlsx', {
      Users: [
        ['BULK', 'Sara Supervisor', 'sara.sup@example.com', '+97455550120', 'Supervisor', 'WT-BULK-Z1', 'Civil', 'E-1001', null, 'English', 'Yes', 'No', 'No', 'manager.bulk@example.com', 'Active'],
        ['BULK', 'Manager Bulk Renamed', 'manager.bulk@example.com', null, 'Manager', null, null, null, null, null, 'Yes', 'Yes', 'No', null, 'Active'],
        ['BULK', 'Tom Tech', 'tom.tech@example.com', null, 'Technician', 'WT-NOPE', null, null, null, null, null, null, null, 'sara.sup@example.com', 'Active'],
        ['OTHER', 'Foreign Row', 'foreign@example.com', null, 'Technician', null, null, null, null, null, null, null, null, null, 'Active'],
        ['BULK', 'Odd Role', 'odd.role@example.com', null, 'Wizard', null, null, null, null, null, 'Perhaps', null, null, null, 'Active'],
        ['BULK', 'Other Tenant Email', 'admin.other@example.com', null, 'Technician', null, null, null, null, null, null, null, null, null, 'Active'],
        ['BULK', 'Fred Foreman', 'fred.foreman@example.com', null, 'Foreman', null, null, null, null, null, null, null, null, 'sara.sup@example.com', 'Active'],
      ],
    });
    const res = await upload(ctx, admin, 'users', 'staff.xlsx', buf);
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.counts).toEqual({ add: 2, update: 1, problem: 4, skippedExamples: 1 });
    const byEmail = Object.fromEntries(p.rows.map((r: { key: string }) => [r.key, r]));
    expect(byEmail['tom.tech@example.com'].problems[0]).toMatchObject({ column: 'Work Teams' });
    expect(byEmail['foreign@example.com'].problems[0].reason).toMatch(/own contractor/);
    expect(byEmail['odd.role@example.com'].problems.map((x: { column: string }) => x.column).sort()).toEqual(['Notify by Email', 'Role']);
    expect(byEmail['admin.other@example.com'].problems[0].reason).toMatch(/another contractor/);
    expect((await ctx.db.query(`SELECT 1 FROM app_user WHERE email = 'sara.sup@example.com'`)).rowCount).toBe(0);

    const conf = await admin.post(`/api/admin/bulk-import/confirm/${p.id}`);
    expect(conf.statusCode).toBe(200);
    expect(conf.json().result).toEqual({ added: 2, updated: 1, rejected: 4 });
    expect(conf.json().invitationsSent).toBe(2);
    const sara = (await admin.get('/api/admin/users?q=sara')).json().items[0];
    expect(sara).toMatchObject({ role: 'supervisor', status: 'invited', mobile: '+97455550120', notifyPush: false, employeeNo: 'E-1001' });
    expect(sara.workTeams.map((t: { code: string }) => t.code)).toEqual(['WT-BULK-Z1']);
    const fred = (await admin.get('/api/admin/users?q=fred')).json().items[0];
    expect(fred.reportsTo).toBe(sara.id); // reports-to resolved to a user created in the same import
    const mgr = (await admin.get('/api/admin/users?q=manager.bulk')).json().items[0];
    expect(mgr.fullName).toBe('Manager Bulk Renamed');
    expect(await ctx.db.query(`SELECT 1 FROM mail_outbox WHERE to_address IN ('sara.sup@example.com', 'fred.foreman@example.com')`).then((r) => r.rowCount)).toBe(2);
    const audit = (await admin.get('/api/admin/audit?action=bulk_import.confirm')).json().items[0];
    expect(audit.summary).toMatch(/staff\.xlsx: 2 added, 1 updated, 4 rejected/);
  });

  it('sub-contractors: two sheets, contacts linked by code', async () => {
    const buf = await fillTemplate('SONU-import-subcontractors.xlsx', {
      SubContractors: [
        ['BULK', 'SUB-001', 'Blinds Fictional Co', null, '555', 'Blinds and curtains; Painting', null, 'Doha', 'www.example.com', '30 days', 'Yes', 'Verified', null],
        ['BULK', 'SUB-002', 'Unknown Cat Co', null, null, 'Rocket repair', null, null, null, null, null, 'Verified', null],
      ],
      Contacts: [
        ['SUB-001', 'Nina Estimator', 'Estimator', '+97455550130', null, 'nina@example.com', 'WhatsApp', 'English', 'Yes', 'No', 1, 'Yes'],
        ['SUB-002', 'Omar Sales', 'Sales', '+97455550131', null, null, null, null, null, null, null, null],
        ['SUB-404', 'Ghost Contact', null, '+97455550132', null, null, null, null, null, null, null, null],
      ],
    });
    const res = await upload(ctx, admin, 'subcontractors', 'subs.xlsx', buf);
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p.counts).toEqual({ add: 2, update: 0, problem: 3, skippedExamples: 2 });
    const conf = await admin.post(`/api/admin/bulk-import/confirm/${p.id}`);
    expect(conf.json().result).toEqual({ added: 2, updated: 0, rejected: 3 });
    const sub = await ctx.db.query(`SELECT categories, website, emergency_callout FROM subcontractor WHERE code = 'SUB-001'`);
    expect(sub.rows[0]).toEqual({ categories: ['Blinds and curtains', 'Painting'], website: 'https://www.example.com/', emergency_callout: true });
    const contact = await ctx.db.query(`SELECT name, consent, escalation_order FROM sub_contact WHERE mobile = '+97455550130'`);
    expect(contact.rows[0]).toEqual({ name: 'Nina Estimator', consent: true, escalation_order: 1 });
  });

  it('rejects non-xlsx uploads', async () => {
    const res = await upload(ctx, admin, 'users', 'users.csv', Buffer.from('a,b,c'));
    expect(res.statusCode).toBe(415);
  });
});
