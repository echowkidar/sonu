/** Response shapes of the admin API (see server/src/**). Dates arrive as ISO strings. */
import type { Role } from './roles';

export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

export interface Contractor {
  id: string; code: string; name: string; nameAr: string | null; marafiqTradeCode: string | null;
  marafiqWorkTeams: string[]; disciplines: string[]; senderEmail: string | null; timeZone: string;
  status: 'active' | 'inactive'; notes: string | null; userCount?: number; createdAt: string; updatedAt: string;
}
export interface ContractorCreated { contractor: Contractor; adminUserId: string; invitation: { driver: string } | { error: string } }

export interface WorkTeamRef { id: string; code: string; name: string | null }
export type UserStatus = 'invited' | 'active' | 'inactive';
export interface UserView {
  id: string; contractorId: string | null; email: string; fullName: string; role: Role; status: UserStatus;
  emailVerified: boolean; mobile: string | null; mobileVerified: boolean; language: string;
  notifyEmail: boolean; notifyPush: boolean; notifyWhatsapp: boolean; quietHoursStart: string | null; quietHoursEnd: string | null;
  reportsTo: string | null; employeeNo: string | null; craftspersonCode: string | null; discipline: string | null;
  workTeams: WorkTeamRef[]; lastLoginAt: string | null; createdAt: string; updatedAt: string;
}
export interface UserCreated { user: UserView; invitation: unknown }

export interface WorkTeam { id: string; contractorId: string; code: string; name: string | null; zone: string | null; active: boolean; memberCount: number }

export interface DeadlineRule {
  id: string; key: string; name: string; appliesTo: string; criteria: number[] | null; stage: string | null; clockStart: string;
  limitValue: number | null; limitUnit: 'hours' | 'days' | 'working_days' | 'same_day' | 'date_field'; limitField: string | null;
  warnings: Record<string, unknown>[]; onBreach: string; escalationRoles: string[]; params: Record<string, unknown>; active: boolean;
  sortOrder: number; updatedAt: string;
}
export interface SiteLookup { siteCode: string; siteName: string | null; zone: string | null; facility: string | null; groupName: string | null }
export interface ProblemLookup { problemType: string; discipline: string }

export interface AuditEntry {
  id: string; contractorId: string | null; userId: string | null; userEmail: string | null; action: string;
  entityType: string | null; entityId: string | null; summary: string | null; details: Record<string, unknown> | null; ip: string | null; at: string;
}

export interface MailSettings {
  scope: 'platform' | 'contractor'; contractorId: string | null; driver: 'log' | 'smtp' | 'oauth2';
  fromAddress: string | null; fromName: string | null; replyTo: string | null; signature: string | null; footer: string | null;
  purchasingFromAddress: string | null; smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean; smtpUser: string | null; hasPassword: boolean;
  oauthProvider: 'microsoft' | 'google' | null; oauthUser: string | null; oauthClientId: string | null; oauthTenant: string | null;
  hasClientSecret: boolean; hasRefreshToken: boolean; notificationMailbox: string | null; updatedAt: string | null;
}
export interface MailTestResult { ok: boolean; driver: string; to: string; messageId: string | null }

export interface MessagingSettings {
  whatsappMode: 'click_to_chat' | 'linked_session'; whatsappNumber: string | null; linkedSessionState: string | null; pushEnabled: boolean;
  smsProvider: string | null; rateLimitPerMinute: number; quietHoursStart: string | null; quietHoursEnd: string | null; updatedAt: string; linkedSessionWarning: string;
}

export interface MarafiqConnection {
  id: string; name: string; baseUrl: string | null; project: string | null; username: string | null; hasPassword: boolean;
  mode: 'off' | 'read_only'; writeLevel: string | null; paused: boolean; state: string; schedule: Record<string, unknown> | null;
  enabledLists: string[] | null; lastSuccess: string | null; lastSignInAt: string | null; lastError: string | null; updatedAt: string;
}

export type BulkKind = 'contractors' | 'users' | 'subcontractors';
export type BulkAction = 'add' | 'update' | 'problem';
export interface BulkRowPreview {
  sheet: string; rowNumber: number; action: BulkAction; key: string;
  values: Record<string, string | number | boolean | string[] | null>;
  problems: { column: string; reason: string }[]; notes: string[];
}
export interface BulkJob {
  id: string; kind: BulkKind; fileName: string; status: 'preview' | 'confirmed' | 'cancelled'; createdAt: string; confirmedAt: string | null;
  counts: { add: number; update: number; problem: number; skippedExamples: number };
  result: { added: number; updated: number; rejected: number } | null;
  rows: BulkRowPreview[];
  invitationsSent?: number; invitationErrors?: string[];
}
export interface BulkHistoryItem {
  id: string; kind: BulkKind; fileName: string; status: string; added: number; updated: number; rejected: number; skippedExamples: number;
  createdAt: string; confirmedAt: string | null;
}
