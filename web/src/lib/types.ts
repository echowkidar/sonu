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
  whatsappMode: 'click_to_chat' | 'linked_session'; pushEnabled: boolean;
  quietHoursStart: string | null; quietHoursEnd: string | null; updatedAt: string;
  rateLimit: {
    minIntervalSeconds: number; dailyLimit: number;
    hardCaps: { minIntervalSecondsMin: number; minIntervalSecondsMax: number; dailyLimitMin: number; dailyLimitMax: number };
  };
  riskWarning: string; riskAcknowledgedAt: string | null;
}

export interface MarafiqConnection {
  id: string; name: string; baseUrl: string | null; project: string | null; username: string | null; hasPassword: boolean;
  mode: 'off' | 'read_only'; writeLevel: string | null; paused: boolean; state: string; schedule: Record<string, unknown> | null;
  enabledLists: string[] | null; lastSuccess: string | null; lastSignInAt: string | null; lastError: string | null; updatedAt: string;
}

// ───── Operational API (docs/API-ops.md) ─────
export interface Matrix {
  rows: string[]; columns: string[]; cells: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>; columnTotals: Record<string, number>; total: number;
}
export interface Deadline {
  ruleKey: string; ruleName: string; stage: string | null; dayNumber: number; limit: number; state: string; dueDate: string | null; warningsDue?: unknown; breached: boolean;
}
export interface DeadlineCard {
  wrCode: string; buildingName: string | null; description: string | null; workTeamCode: string | null; ownerName: string | null; deadline: Deadline | null;
  /** Days past the agreed target date (top-priority list only). */
  overdueDays?: number;
}
export interface DashboardData {
  today: string;
  totalOutstanding: number; breached: number; backlogKpi: number; averageAge: number; averageAgeFromRequested?: number | null;
  byDiscipline: Matrix; byZone: Matrix; byFacility: Matrix; byYear: Record<string, number>;
  ageBuckets: Record<string, number>; kpiSplit: Record<string, number>; tdSplit: Record<string, number>; rfeTimeFrameSplit: Record<string, number>;
  descriptiveStages: { stage: number; label: string; count: number }[] | null;
  needsActionToday: {
    deadlinesToday: DeadlineCard[]; deadlinesTodayCount: number; breachedDeadlines: number;
    unowned: DeadlineCard[]; unownedCount: number; returns: DeadlineCard[]; returnsCount: number; unansweredComments: number;
    breachedTd?: DeadlineCard[]; breachedTdCount?: number;
  };
  dataAsOf: { at: string | null; by: string | null; listKey: string | null } | null;
}

export interface WrView {
  id: string; wrCode: string; wrStatus: string | null; descriptiveStatus: string | null; qfStage: number | null; ptwCode: string | null; ptwStatus: string | null;
  requestor?: string | null; siteCode: string | null; siteName: string | null; buildingCode: string | null; buildingName: string | null; floorCode: string | null; roomCode: string | null;
  problemType: string | null; workTeamCode: string | null; priority: string | null; description: string | null; dateRequested: string | null; targetDate: string | null;
  dateTradeAssigned: string | null; estimatedTotalCost?: number | null; withRfe: boolean | null; progressPct: number | null; goneAt: string | null;
  internal: { ownerId: string | null; ownerName: string | null; criterion: number | null; contractorStatus: string | null; fcRemarks: string | null; statusSource: string | null; dueAt: string | null; breachLevel: number | null };
  computed: {
    month: string; daysToBreach: number | null; tdStatus: string; kpi: string; rfeSubmittedOn: string | null; rfeApprovedOn: string | null; discipline: string; facility: string; zone: string;
    rfeStatus: string; daysSinceRequested: number | null; rfeTimeFrame: string; rfeTimeFrameKind: string;
  };
  deadline: Deadline | null;
  suggestedStatus: { status: string; reason: string } | null;
}
export interface WrList { today: string; rfeLimitDays: number; total: number; page: number; pageSize: number; items: WrView[] }

export interface TimelineEvent { id: string; kind: string; at: string; type: string; source: string; payload: Record<string, unknown> | null; userName: string | null }
export interface WrAttachment { id: string; ownerType: string; ownerId: string; fileName: string; mime: string; sizeBytes: number; createdAt: string }
export interface WrAssignment { id: string; status: string; plannedDate: string | null; note: string | null; createdAt: string; assigneeId: string; assigneeName: string; assignedByName: string | null }
export interface WrDetail extends WrView {
  today: string; marafiqUrl: string; timeline: TimelineEvent[]; assignments: WrAssignment[]; attachments: WrAttachment[];
  rfe: { submittedOn: string | null; approvedOn: string | null; pendingWith: string | null; rfeAmount: number | null; bpaReleaseRef: string | null } | null;
  rfeComments: { id: string; logId: string | null; text: string; createdBy: string | null; createdOn: string | null; sendTo: string | null; isDone: boolean | null; answeredInSonuAt: string | null }[];
  permit: { ptwCode: string; status: string | null; dateStart: string | null; dateUpto: string | null; dateIssued: string | null; applicant: string | null; controller: string | null; authority: string | null } | null;
  moneyTrail?: Record<string, string | number | null> | null;
}

export interface Person { id: string; fullName: string; role: string; workTeams: string[] }
export interface Meta {
  contractorStatuses: { name: string; side: string }[];
  roles: { key: string; label: string }[];
  criteria: { value: number; label: string }[];
  ageBuckets: string[]; kpis: string[]; tdStatuses: string[]; rfeTimeFrameKinds: string[];
  qfStages: { stage: number; label: string }[];
  lookups: { zones: string[]; facilities: string[]; disciplines: string[] };
  workTeams: { id: string; code: string; name: string | null; zone: string | null }[];
  people: Person[];
  lists: { key: string; title: string; menuPath: string; captions: string[]; required: string[] }[];
}

export interface WorkCard {
  wrCode: string; buildingName: string | null; roomCode: string | null; description: string; wrStatus: string | null; qfStage: number | null;
  criterion: number | null; contractorStatus: string | null;
  dayCounter: { day: number; limit: number; state: string; dueDate: string | null; rule: string } | null; rfeTimeFrame: string | null;
}
export type WorkGroupKey = 'take_ownership' | 'returned' | 'answer_qf' | 'classify' | 'estimate_due' | 'assign_technician' | 'other';
export interface MyWorkData { today: string; owned: number; groups: Record<WorkGroupKey, WorkCard[]> }

export interface NotificationItem {
  id: string; event: string; title: string; body: string | null; link: string | null; url: string | null; workRequestId: string | null;
  createdAt: string; readAt: string | null;
}
export interface NotificationList { items: NotificationItem[]; unread: number; total: number }

export interface ImportResult {
  ok: boolean; batchId: string; listKey: string; rowsRead: number; new: number; changed: number; gone: number; events: number; unchanged: number; warnings: string[];
}
export interface ImportBatch {
  id: string; listKey: string; title: string; source: string; fileName: string | null; status: string; result: 'ok' | 'unchanged' | 'failed'; error: string | null;
  rowsRead: number | null; new: number | null; changed: number | null; gone: number | null; events: number | null; warnings: unknown; user: { id: string; fullName: string } | null; createdAt: string;
}
export interface ExpectedList { key: string; title: string; menuPath: string; lastImportAt: string | null; rows: number | null; lastBatchId: string | null }
export interface TrackerPreview {
  id: string; fileName: string; rows: number; matched: number;
  matchedItems: { wrCode: string; status: string | null; rawStatus: string | null; fcRemarks: string | null; current: unknown }[];
  unknownWrCodes: string[];
  unknownStatuses: { value: string; count: number; candidates: string[]; suggested: string | null }[];
  mappedStatuses: unknown[];
}

export type JobStatus = 'assigned' | 'started' | 'done';
export interface Job {
  id: string; status: JobStatus; plannedDate: string | null; note: string | null; createdAt: string; startedAt: string | null; doneAt: string | null;
  assignee: { id: string; fullName: string }; assignedBy: { id: string; fullName: string } | null;
  wr: {
    code: string; siteName: string | null; buildingCode: string | null; buildingName: string | null; floorCode: string | null; roomCode: string | null;
    description: string | null; problemType: string | null; priority: string | null; workTeamCode: string | null; ptwCode: string | null; ptwStatus: string | null; permitDateUpto: string | null;
  };
}
export interface JobUpdate { id: string; note: string | null; statusTo: string | null; at: string; userName: string | null; attachments: { id: string; fileName: string; mime: string; sizeBytes: number }[] }
export interface JobDetail extends Job { canAct: boolean; updates: JobUpdate[] }
export interface MyJobsData { today: string; todayJobs: Job[]; open: Job[]; doneRecently: Job[] }

export interface RfeLineInput {
  lineType: 'Item' | 'Discount' | 'Margin'; vendorItemName: string; uom: string; lineNumber: string; poNumber: string; bpaItem: string; accountCode: string;
  estQty: number; unitPrice: number; markUp: number;
}

export type BulkKind ='contractors' | 'users' | 'subcontractors';
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
