import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createContractorWithAdmin, makeTestApp, setupPlatformAdmin, type TestContext } from './helpers.js';

describe('tenant isolation', () => {
  let ctx: TestContext;
  let platform: Client;
  let a: Client;
  let b: Client;
  let aId: string;
  let bId: string;
  let bUserId: string;
  let bTeamId: string;
  let bRuleId: string;

  beforeAll(async () => {
    ctx = await makeTestApp();
    platform = await setupPlatformAdmin(ctx);
    ({ admin: a, contractorId: aId } = await createContractorWithAdmin(platform, ctx, 'TENA', 'admin.a@example.com'));
    ({ admin: b, contractorId: bId } = await createContractorWithAdmin(platform, ctx, 'TENB', 'admin.b@example.com'));
    bUserId = (await b.post('/api/admin/users', { email: 'sup.b@example.com', fullName: 'Supervisor B', role: 'supervisor' })).json().user.id;
    bTeamId = (await b.get('/api/admin/work-teams')).json().items[0].id;
    bRuleId = (await b.get('/api/admin/deadline-rules')).json().items[0].id;
  });
  afterAll(async () => ctx?.close());

  it('seeds deadline rules, lookups and work teams per contractor', async () => {
    const rules = (await a.get('/api/admin/deadline-rules')).json().items;
    expect(rules.length).toBe(16);
    const rfe = rules.find((r: { key: string }) => r.key === 'rfe_submit_14d');
    expect(rfe).toMatchObject({ limitValue: 14, limitUnit: 'days', clockStart: 'date_trade_assigned' });
    const sites = (await a.get('/api/admin/lookups/sites')).json().items;
    expect(sites.length).toBeGreaterThan(10);
    const pts = (await a.get('/api/admin/lookups/problem-types')).json().items;
    expect(pts.find((p: { problemType: string }) => p.problemType === 'HVAC').discipline).toBe('HVAC');
    const teams = (await a.get('/api/admin/work-teams')).json().items.map((t: { code: string }) => t.code);
    expect(teams).toEqual(['WT-TENA-Z1', 'WT-TENA-Z2']);
  });

  it("A cannot list, read or change B's users", async () => {
    const list = (await a.get('/api/admin/users')).json().items.map((u: { email: string }) => u.email);
    expect(list).toEqual(['admin.a@example.com']);
    expect((await a.get(`/api/admin/users?contractorId=${bId}`)).statusCode).toBe(403);
    expect((await a.get(`/api/admin/users/${bUserId}`)).statusCode).toBe(404);
    expect((await a.patch(`/api/admin/users/${bUserId}`, { fullName: 'Hacked' })).statusCode).toBe(404);
    expect((await a.post(`/api/admin/users/${bUserId}/deactivate`)).statusCode).toBe(404);
    expect((await a.put(`/api/admin/users/${bUserId}/work-teams`, { workTeamIds: [] })).statusCode).toBe(404);
    expect((await a.post('/api/admin/users', { email: 'x.b@example.com', fullName: 'Planted', role: 'manager', contractorId: bId })).statusCode).toBe(403);
    const still = (await b.get(`/api/admin/users/${bUserId}`)).json();
    expect(still.fullName).toBe('Supervisor B');
    expect(still.status).toBe('invited');
  });

  it("A cannot read or change B's work teams", async () => {
    expect((await a.get(`/api/admin/work-teams?contractorId=${bId}`)).statusCode).toBe(403);
    expect((await a.patch(`/api/admin/work-teams/${bTeamId}`, { name: 'Hacked' })).statusCode).toBe(404);
    expect((await a.del(`/api/admin/work-teams/${bTeamId}`)).statusCode).toBe(404);
    // Assigning B's team to an A user is silently ignored (team not in A).
    const aUser = (await a.post('/api/admin/users', { email: 'tech.a@example.com', fullName: 'Tech A', role: 'technician', workTeamIds: [bTeamId] })).json().user;
    expect(aUser.workTeams).toEqual([]);
    expect((await b.get('/api/admin/work-teams')).json().items.find((t: { id: string }) => t.id === bTeamId).name).toBeNull();
  });

  it("A cannot read or change B's deadline rules, lookups, mail, audit", async () => {
    expect((await a.get(`/api/admin/deadline-rules?contractorId=${bId}`)).statusCode).toBe(403);
    expect((await a.patch(`/api/admin/deadline-rules/${bRuleId}`, { limitValue: 99 })).statusCode).toBe(404);
    expect((await b.get('/api/admin/deadline-rules')).json().items.find((r: { id: string }) => r.id === bRuleId).limitValue).not.toBe(99);
    expect((await a.put('/api/admin/lookups/sites', { contractorId: bId, items: [] })).statusCode).toBe(403);
    expect((await a.get(`/api/admin/mail?contractorId=${bId}`)).statusCode).toBe(403);
    expect((await a.get(`/api/admin/audit?contractorId=${bId}`)).statusCode).toBe(403);
    const audit = (await a.get('/api/admin/audit?pageSize=500')).json().items as { contractorId: string }[];
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((x) => x.contractorId === aId)).toBe(true);
  });

  it('own changes work', async () => {
    const rule = (await a.get('/api/admin/deadline-rules')).json().items[0];
    const upd = await a.patch(`/api/admin/deadline-rules/${rule.id}`, { limitValue: 2, warnings: [{ value: 6, unit: 'hours' }] });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ limitValue: 2, warnings: [{ value: 6, unit: 'hours' }] });
    const team = await a.post('/api/admin/work-teams', { code: 'WT-TENA-Z3', name: 'Zone 3' });
    expect(team.statusCode).toBe(201);
    expect((await a.post('/api/admin/work-teams', { code: 'wt-tena-z3' })).statusCode).toBe(409);
  });

  it('platform admin manages contractors; contractor admin cannot', async () => {
    expect((await a.get('/api/admin/contractors')).statusCode).toBe(403);
    const list = (await platform.get('/api/admin/contractors')).json().items.map((c: { code: string }) => c.code);
    expect(list).toEqual(expect.arrayContaining(['TENA', 'TENB']));
    // Platform admin may administer B's users with explicit scope
    expect((await platform.get(`/api/admin/users?contractorId=${bId}`)).json().items.length).toBe(2);
    expect((await platform.get('/api/admin/users')).statusCode).toBe(400);
  });

  it('deactivating a contractor signs its users out', async () => {
    expect((await platform.del(`/api/admin/contractors/${bId}`)).json().status).toBe('inactive');
    expect((await b.get('/api/auth/me')).statusCode).toBe(401);
  });
});
