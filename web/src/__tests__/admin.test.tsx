import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { BulkPreview } from '@/components/admin/BulkPreview';
import { RequireRole } from '@/components/shell/RequireRole';
import { MailForm } from '@/pages/admin/AdminEmailPage';
import { UserForm } from '@/pages/admin/AdminUsersPage';
import { serverErrors } from '@/lib/forms';
import { ApiError } from '@/lib/api';
import type { BulkJob, MailSettings } from '@/lib/types';

type FetchCall = { url: string; method: string; body: Record<string, unknown> | null };
let calls: FetchCall[] = [];

function mockFetch(handler: (c: FetchCall) => unknown) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const c: FetchCall = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    const out = handler(c);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

const wrap = (ui: React.ReactElement, route = '/') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter></QueryClientProvider>);
};

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

const baseJob: BulkJob = {
  id: 'job-1', kind: 'users', fileName: 'users.xlsx', status: 'preview', createdAt: '2026-11-17T10:00:00Z', confirmedAt: null, result: null,
  counts: { add: 2, update: 1, problem: 1, skippedExamples: 3 },
  rows: [
    { sheet: 'Users', rowNumber: 4, action: 'add', key: 'a@x.com', values: { contractorCode: 'ACME', fullName: 'Amal', email: 'a@x.com', role: 'Technician' }, problems: [], notes: [] },
    { sheet: 'Users', rowNumber: 5, action: 'update', key: 'b@x.com', values: { contractorCode: 'ACME', fullName: 'Bilal', email: 'b@x.com', role: 'Foreman' }, problems: [], notes: [] },
    { sheet: 'Users', rowNumber: 6, action: 'problem', key: 'bad', values: { contractorCode: 'ACME', fullName: 'Cara', email: 'not-an-email', role: 'Manager' }, problems: [{ column: 'Email', reason: 'This is not an e-mail address.' }], notes: [] },
  ],
};

describe('BulkPreview', () => {
  it('shows the counters, the "nothing saved" statement and marks the problem cell with its reason', () => {
    render(<BulkPreview job={baseJob} onConfirm={() => {}} onCancel={() => {}} />);
    expect(within(screen.getByTestId('counter-To add')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('counter-To update')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('counter-With problems')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('counter-EXAMPLE rows skipped')).getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is saved until you confirm/)).toBeInTheDocument();

    const cell = document.querySelector('[data-problem="true"]') as HTMLElement;
    expect(cell).not.toBeNull();
    expect(cell).toHaveTextContent('not-an-email');
    expect(cell.getAttribute('title')).toBe('This is not an e-mail address.');
    expect(document.querySelectorAll('[data-problem="true"]')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Download rows with problems/ })).toHaveAttribute('href', '/api/admin/bulk-import/job-1/rejected.xlsx');
    expect(screen.getByRole('button', { name: /Confirm and save 3 rows/ })).toBeEnabled();
  });

  it('reveals the reason when the cell is tapped', async () => {
    render(<BulkPreview job={baseJob} onConfirm={() => {}} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /Problem in Email, row 6/ }));
    expect(screen.getAllByText('This is not an e-mail address.').length).toBeGreaterThan(0);
  });

  it('disables Confirm when no row is valid', () => {
    const none: BulkJob = { ...baseJob, counts: { add: 0, update: 0, problem: 1, skippedExamples: 0 }, rows: [baseJob.rows[2]!] };
    render(<BulkPreview job={none} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: /Confirm and save 0 rows/ })).toBeDisabled();
  });
});

const smtp: MailSettings = {
  scope: 'contractor', contractorId: 'c1', driver: 'smtp', fromAddress: 'noreply@acme.test', fromName: 'ACME', replyTo: null, signature: null, footer: null,
  purchasingFromAddress: null, smtpHost: 'smtp.acme.test', smtpPort: 587, smtpSecure: false, smtpUser: 'mailer', hasPassword: true,
  oauthProvider: null, oauthUser: null, oauthClientId: null, oauthTenant: null, hasClientSecret: false, hasRefreshToken: false, notificationMailbox: null, updatedAt: null,
};

describe('write-only secret field', () => {
  it('never renders a value, and sends the password only when replaced', async () => {
    mockFetch(() => ({ ...smtp }));
    wrap(<MailForm settings={smtp} />);

    expect(screen.getByText(/password is saved/i)).toBeInTheDocument();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: /Save settings/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const first = calls.find((c) => c.method === 'PUT')!;
    expect(first.url).toContain('/api/admin/mail');
    expect(first.body).not.toHaveProperty('password');
    expect(first.body).not.toHaveProperty('clearPassword');

    calls = [];
    await userEvent.click(screen.getByRole('button', { name: /Replace app password/i }));
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.value).toBe('');
    await userEvent.type(input, 'new-secret-123');
    await userEvent.click(screen.getByRole('button', { name: /Save settings/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ password: 'new-secret-123' });
  });
});

describe('UserForm', () => {
  it('requires an e-mail and a role before anything is sent', async () => {
    mockFetch(() => ({}));
    wrap(<UserForm editing={null} teams={[]} people={[]} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText('Full name'), 'Sami Ali');
    await userEvent.click(screen.getByRole('button', { name: /Send invitation/ }));
    expect(await screen.findByText('Enter the e-mail address.')).toBeInTheDocument();
    expect(screen.getByText('Choose a role.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('posts the invitation once e-mail and role are given', async () => {
    mockFetch((c) => (c.method === 'POST' ? { user: { id: 'u1' }, invitation: { driver: 'log' } } : {}));
    const onDone = vi.fn();
    wrap(<UserForm editing={null} teams={[]} people={[]} onDone={onDone} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'E-mail' }), 'Sami@Acme.test');
    await userEvent.type(screen.getByLabelText('Full name'), 'Sami Ali');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'technician');
    await userEvent.click(screen.getByRole('button', { name: /Send invitation/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/admin/users');
    expect(post.body).toMatchObject({ email: 'sami@acme.test', role: 'technician', sendInvite: true });
  });
});

describe('server error mapping', () => {
  it('maps validation details to form fields', () => {
    const err = new ApiError(400, 'validation_error', 'Some fields are not valid.', [{ path: 'admin.email', message: 'Invalid e-mail' }]);
    expect(serverErrors(err, { 'admin.email': 'adminEmail' })).toEqual({ fields: { adminEmail: 'Invalid e-mail' }, message: null });
  });
});

describe('RequireRole', () => {
  it('hides admin pages from a technician', async () => {
    mockFetch((c) => (c.url.includes('/api/auth/me')
      ? { user: { id: 't1', email: 't@acme.test', fullName: 'Tech', role: 'technician', contractorId: 'c1', contractorName: 'ACME' } }
      : {}));
    wrap(
      <Routes>
        <Route element={<RequireRole />}>
          <Route path="/admin/users" element={<div>SECRET ADMIN PAGE</div>} />
          <Route path="/my-jobs" element={<div>My jobs</div>} />
        </Route>
      </Routes>,
      '/admin/users',
    );
    expect(await screen.findByText('You do not have access to this page')).toBeInTheDocument();
    expect(screen.queryByText('SECRET ADMIN PAGE')).toBeNull();
  });
});
