import type { BulkKind } from './types';

/** Column captions of the three Excel templates (mirrors server/src/bulk/templateParser.ts TEMPLATE_SPECS). */
export interface BulkColumn { field: string; caption: string }
export interface BulkSheet { sheet: string; columns: BulkColumn[] }

export const BULK_LABELS: Record<BulkKind, { title: string; hint: string }> = {
  contractors: { title: 'Contractors', hint: 'Companies and their first admin. Platform admin only.' },
  users: { title: 'Users', hint: 'People of one or more contractors, with role and work teams.' },
  subcontractors: { title: 'Sub-contractors', hint: 'Sub-contractor companies and their contacts.' },
};

const c = (field: string, caption: string): BulkColumn => ({ field, caption });

export const BULK_SHEETS: Record<BulkKind, BulkSheet[]> = {
  contractors: [{
    sheet: 'Contractors',
    columns: [
      c('code', 'Contractor Code'), c('name', 'Company Name'), c('nameAr', 'Company Name (Arabic)'), c('marafiqTradeCode', 'Marafiq Trade Code'),
      c('marafiqWorkTeams', 'Marafiq Work Teams'), c('disciplines', 'Disciplines'), c('adminName', 'Admin Name'), c('adminEmail', 'Admin Email'),
      c('adminMobile', 'Admin Mobile'), c('senderEmail', 'Sender Email'), c('timeZone', 'Time Zone'), c('status', 'Status'), c('notes', 'Notes'),
    ],
  }],
  users: [{
    sheet: 'Users',
    columns: [
      c('contractorCode', 'Contractor Code'), c('fullName', 'Full Name'), c('email', 'Email'), c('mobile', 'Mobile'), c('role', 'Role'),
      c('workTeams', 'Work Teams'), c('discipline', 'Discipline'), c('employeeNo', 'Employee No'), c('craftspersonCode', 'Marafiq Craftsperson Code'),
      c('language', 'Language'), c('notifyEmail', 'Notify by Email'), c('notifyPush', 'Notify by Push'), c('notifyWhatsapp', 'Notify by WhatsApp'),
      c('reportsTo', 'Reports To (Email)'), c('status', 'Status'),
    ],
  }],
  subcontractors: [
    {
      sheet: 'SubContractors',
      columns: [
        c('contractorCode', 'Contractor Code'), c('code', 'Sub-contractor Code'), c('name', 'Company Name'), c('nameAr', 'Company Name (Arabic)'),
        c('crNumber', 'CR Number'), c('categories', 'Categories'), c('zonesServed', 'Zones Served'), c('address', 'Address'), c('website', 'Website'),
        c('paymentTerms', 'Payment Terms'), c('emergencyCallout', 'Emergency Call-out'), c('status', 'Status'), c('notes', 'Notes'),
      ],
    },
    {
      sheet: 'Contacts',
      columns: [
        c('subcontractorCode', 'Sub-contractor Code'), c('name', 'Contact Name'), c('role', 'Role'), c('mobile', 'Mobile'), c('whatsapp', 'WhatsApp Number'),
        c('email', 'Email'), c('preferredChannel', 'Preferred Channel'), c('language', 'Language'), c('receivesEnquiries', 'Receives Enquiries'),
        c('receivesUrgent', 'Receives Urgent Calls'), c('escalationOrder', 'Escalation Order'), c('consent', 'Consent to Messages'),
      ],
    },
  ],
};

export const normCaption = (s: string) => s.replace(/\*/g, '').trim().toLowerCase();

/** Columns for a sheet: the known template columns, or the value keys when the sheet is unknown. */
export function columnsFor(kind: BulkKind, sheet: string, sampleValues: Record<string, unknown>[]): BulkColumn[] {
  const known = BULK_SHEETS[kind]?.find((s) => s.sheet.toLowerCase() === sheet.toLowerCase());
  if (known) return known.columns;
  const keys = new Set<string>();
  for (const v of sampleValues) for (const k of Object.keys(v)) keys.add(k);
  return [...keys].map((k) => ({ field: k, caption: k }));
}
