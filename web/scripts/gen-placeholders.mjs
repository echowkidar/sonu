// One-off generator for the placeholder pages (kept so the list is easy to extend). Run: node scripts/gen-placeholders.mjs
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const pages = [
  ['DashboardPage', 'Dashboard', 'Stage counts, ageing, escalations and the money trail will appear here.'],
  ['MyWorkPage', 'My work', 'Work requests you own, grouped by what is due next.'],
  ['WorkRequestsPage', 'Work requests', 'The full work request list with saved views and a side panel.'],
  ['MyJobsPage', 'My jobs', "Today's jobs in order, each with a big Start / Update / Done button."],
  ['TeamJobsPage', 'Team jobs', 'Jobs of your technicians and evidence waiting to be submitted.'],
  ['ImportsPage', 'Imports', 'Upload Marafiq exports and see rows read, new, changed and problems.'],
  ['NotificationsPage', 'Notifications', 'Everything the system told you, newest first.'],
  ['admin/AdminContractorsPage', 'Contractors', 'Create and manage contractor companies.'],
  ['admin/AdminUsersPage', 'Users', 'Invite people, change roles and deactivate accounts.'],
  ['admin/AdminTeamsPage', 'Work teams', 'Zones and the people assigned to them.'],
  ['admin/AdminBulkImportPage', 'Bulk import', 'Create users, teams and lookups from the Excel templates.'],
  ['admin/AdminEmailPage', 'E-mail', 'Outgoing mail settings and templates.'],
  ['admin/AdminMessagingPage', 'Messaging', 'Push and message channel settings.'],
  ['admin/AdminMarafiqPage', 'Marafiq connection', 'Connect, test, pause and resume the background connection.'],
  ['admin/AdminRulesPage', 'Rules', 'Deadline and escalation rules.'],
  ['admin/AdminLookupsPage', 'Lookups', 'Contractor lookup lists.'],
  ['admin/AdminAuditPage', 'Audit log', 'Who did what and when.'],
];

mkdirSync('src/pages/admin', { recursive: true });
for (const [file, title, desc] of pages) {
  const path = `src/pages/${file}.tsx`;
  if (existsSync(path)) continue; // never overwrite a real screen
  const name = file.split('/').pop();
  writeFileSync(path, `import { PlaceholderPage } from '@/components/PlaceholderPage';

export default function ${name}() {
  return <PlaceholderPage title=${JSON.stringify(title)} description=${JSON.stringify(desc)} />;
}
`);
}
console.log('done');
