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
  inProgress: number; priorityRequests: number;
  filterOptions: { facilities: string[]; zones: string[]; disciplines: string[]; buildings: { facility: string; building: string }[] };
  byDiscipline: Matrix; byZone: Matrix; byFacility: Matrix; byYear: Record<string, number>;
  ageBuckets: Record<string, number>; kpiSplit: Record<string, number>; tdSplit: Record<string, number>; rfeTimeFrameSplit: Record<string, number>;
  descriptiveStages: { stage: number; label: string; count: number }[] | null;
  needsActionToday: {
    deadlinesToday: DeadlineCard[]; deadlinesTodayCount: number; breachedDeadlines: number;
    unowned: DeadlineCard[]; unownedCount: number; returns: DeadlineCard[]; returnsCount: number; unansweredComments: number;
    breachedTd?: DeadlineCard[]; breachedTdCount?: number;
  };
  dataAsOf: { at: string | null; by: string | null; listKey: string | null } | null;
  /** 0 RFE this month (older servers do not send it). */
  zeroRfe?: { monthJobs: number; monthSpent: number | null; withoutReceipt: number };
}

export interface ZeroRfeInfo { at: string; byName: string | null; amount: number | null; note: string | null }
export interface LocalPurchase {
  id: string; item: string; amount: number | null; purchasedOn: string; pettyCashRef: string | null; createdByName: string | null; createdById?: string | null; createdAt: string;
  attachments: { id: string; fileName: string; mime: string }[];
  /** The active petty cash claim this purchase is on (null = not claimed yet). Older servers do not send it. */
  claim?: { id: string; refNo: number; code: string; status: PettyCashStatus } | null;
}
export interface ZeroRfeItem {
  wrCode: string; buildingName: string | null; description: string | null; zone: string | null; discipline: string | null; convertedAt: string; convertedByName: string | null;
  expected: number | null; spent: number | null; purchases: number; receipts: number; wrStatus: string | null; qfStageLabel: string;
  claimed?: number; claims?: { id: string; code: string; status: PettyCashStatus }[];
}
export interface ZeroRfeReport {
  month: string;
  totals: { jobs: number; expected: number | null; spent: number | null; withoutReceipt: number };
  items: ZeroRfeItem[];
}

export interface WrView {
  id: string; wrCode: string; wrStatus: string | null; descriptiveStatus: string | null; qfStage: number | null; marafiqStage?: number | null; ptwCode: string | null; ptwStatus: string | null;
  requestor?: string | null; siteCode: string | null; siteName: string | null; buildingCode: string | null; buildingName: string | null; floorCode: string | null; roomCode: string | null;
  problemType: string | null; workTeamCode: string | null; priority: string | null; description: string | null; dateRequested: string | null; targetDate: string | null;
  dateTradeAssigned: string | null; estimatedTotalCost?: number | null; withRfe: boolean | null; progressPct: number | null; goneAt: string | null;
  internal: { ownerId: string | null; ownerName: string | null; criterion: number | null; contractorStatus: string | null; fcRemarks: string | null; statusSource: string | null; dueAt: string | null; breachLevel: number | null; zeroRfe?: ZeroRfeInfo | null };
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
  localPurchases?: LocalPurchase[];
  materialRequests?: WrMaterialRequest[];
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

// ───────────────────────────── material requests / procurement ─────────────────────────────

export type MrStatus = 'submitted' | 'accepted' | 'enquiry' | 'quoted' | 'ordered' | 'delivered' | 'closed' | 'rejected' | 'cancelled';
export type MrDocKind = 'quote' | 'warranty' | 'client_approval' | 'calibration_certificate' | 'other';
export interface WrMaterialRequest { id: string; mrNo: number; mrCode: string; status: MrStatus; dateRequested: string; lines: number; requestedByName: string | null }
export interface MrFile { id: string; fileName: string; mime: string; uploadedBy?: string | null }
export interface MrLine {
  id: string; lineNo: number; wrCode: string | null; storeSlNo: string | null; clientMatRef: string | null; description: string; quantity: number; uom: string | null;
  brand: string | null; kind: 'material' | 'service'; vendorOrigin: 'local' | 'foreign' | null; claimable: boolean | null; targetDate: string | null; remarks: string | null; photos: MrFile[];
}
export interface MrHistory { id: string; fromStatus: MrStatus | null; toStatus: MrStatus; note: string | null; at: string; userName: string | null }
export interface MrDocument extends MrFile { docKind: MrDocKind | null; createdAt: string; uploadedByName: string | null }
export interface MrDetail {
  id: string; mrNo: number; mrCode: string; status: MrStatus; statusLabel: string; wrCode: string | null; dateRequested: string;
  projectName: string | null; contractNo: string | null; itemDiscipline: string | null; facility: string | null; zone: string | null; buildingName: string | null;
  purchaseType: 'materials' | 'services'; purpose: 'stock' | 'new'; additionalRequirements: string | null; docsRequired: MrDocKind[];
  requestedBy: string | null; requestedByName: string | null; assignedTo: string | null; assignedToName: string | null;
  vendorName: string | null; vendorContact: string | null; quotationRef: string | null; quotedAmount: number | null; expectedDelivery: string | null; procurementRemarks: string | null;
  createdAt: string; updatedAt: string; closedAt: string | null;
  lines: MrLine[]; history: MrHistory[]; documents: MrDocument[];
  can: { edit: boolean; cancel: boolean; procure: boolean; upload: boolean; nextStatuses: MrStatus[] };
}
export interface MrListItem {
  id: string; mrNo: number; mrCode: string; status: MrStatus; statusLabel: string; wrCode: string | null; dateRequested: string; purchaseType: 'materials' | 'services';
  purpose: 'stock' | 'new'; lines: number; firstDescription: string | null; facility: string | null; buildingName: string | null; requestedByName: string | null;
  assignedToName: string | null; vendorName: string | null; quotedAmount: number | null; expectedDelivery: string | null; overdue: boolean; updatedAt: string;
}
export interface PettyCashSummary { draft: number; pendingReview: number; pendingApproval: number; approved: number; rejected: number; approvedAmountThisMonth: number }
export interface ProcurementSummary {
  new: number; pending: number; enquiry: number; quoted: number; ordered: number; delivered: number; closedThisMonth: number; rejected: number; overdue: number;
  /** null / missing: the role has no access to claims (or an older server). */
  pettyCash?: PettyCashSummary | null;
}

export type PettyCashStatus = 'draft' | 'submitted' | 'returned' | 'reviewed' | 'approved' | 'rejected';
export interface PettyCashReceipt { id: string; fileName: string; mime: string; source: 'line' | 'local_purchase' }
export interface PettyCashLine {
  id: string; lineNo: number; workRequestId: string | null; wrCode: string | null; wrStatus: string | null; localPurchaseId: string | null; grnCode: string | null; glCode: string | null; wbs: string | null;
  workDescription: string | null; location: string | null; rfeApprovedAmount: number; claimable: boolean; supplier: string | null; materialUsed: string | null; billDate: string | null;
  billNo: string | null; qty: number; unit: string | null; unitCost: number; discount: number; totalAmount: number; approvedTotal: number | null; receipts: PettyCashReceipt[];
}
export interface PettyCashHeader {
  id: string; refNo: number; code: string; status: PettyCashStatus; statusLabel: string; projectName: string | null; month: string; purchaseType: 'materials' | 'services';
  preparedBy: string | null; preparedByName: string | null; reviewedByName: string | null; reviewedAt: string | null; approvedByName: string | null; approvedAt: string | null;
  totalAmount: number; approvedAmount: number | null; pending: { role: string | null; label: string | null }; createdAt: string; updatedAt: string;
}
export interface PettyCashListItem extends PettyCashHeader { lines: number }
export interface PettyCashHistory { id: string; fromStatus: PettyCashStatus | null; toStatus: PettyCashStatus; note: string | null; at: string; userName: string | null }
export interface PettyCashDetail extends PettyCashHeader {
  preparedAt: string | null; lines: PettyCashLine[]; history: PettyCashHistory[]; unclaimedCount: number;
  can: { edit: boolean; submit: boolean; review: boolean; return: boolean; approve: boolean; reject: boolean; importPurchases: boolean; export: boolean; role: string };
}
export type PettyCashLineInput = Partial<{
  wrCode: string | null; grnCode: string | null; glCode: string | null; wbs: string | null; workDescription: string | null; location: string | null; rfeApprovedAmount: number;
  claimable: boolean; supplier: string | null; materialUsed: string | null; billDate: string | null; billNo: string | null; qty: number; unit: string | null; unitCost: number; discount: number;
}>;
