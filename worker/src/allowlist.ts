/**
 * THE ONLY PLACE THAT KNOWS PORTAL ADDRESSES.
 *
 * Everything the worker may open, press or call on the portal is listed here as a frozen constant.
 * Anything not listed is refused by `guard.ts` (default deny). Changing this file changes what the
 * worker can do on QF's production system — every change needs review by the head of development.
 *
 * Sources (read-only analysis of the portal, 2026-11-16):
 *   - analysis/screens/INDEX.md            menu task -> view file (.axvw)
 *   - analysis/screens/<view>.md           panels, buttons (Show / Clear / XLS / Refresh), server rules
 *   - analysis/03b-export-columns.md       which grid (sub-view) carries the XLS button
 *   - analysis/01-system-overview.md       views live at /archibus/<name>.axvw; the browser talks to the
 *                                          server only via POST /archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr
 *   - design/14 section 4                  login asks for Project, Username, Password; only Show, XLS and paging
 */

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/** Web application root of Archibus Web Central (analysis/01 section 1, "Pages"). */
export const APP_ROOT = '/archibus/';

/**
 * Login page. design/14 4.1 / summary: "The login page asks for Project, Username and Password".
 * The exact file name is NOT recorded in the analysis documents; `login.axvw` is the Archibus
 * Web Central default. If the real portal uses another address the first supervised
 * "Test connection" fails safely with "blocked navigation" and this constant must be reviewed.
 */
export const LOGIN_PATH = '/archibus/login.axvw';

/** Labels of the three login fields (design/14). These are the only fields the worker ever fills. */
export const LOGIN_FIELD_LABELS = deepFreeze({
  project: 'Project',
  username: 'Username',
  password: 'Password',
} as const);

/**
 * Read-only landing pages a successful sign-in may redirect to (GET only). Assumed Archibus defaults,
 * not observed. If the real landing page differs it is simply blocked, which is harmless: the worker
 * opens the list views by address afterwards.
 */
export const LANDING_PATHS: readonly string[] = deepFreeze(['/archibus/', '/archibus/index.html']);

export interface ListDef {
  /** Menu-task view opened by top-level navigation (analysis/screens/INDEX.md "Opens"). */
  readonly viewPath: string;
  /** Screen title from INDEX.md (used in logs and reports only). */
  readonly title: string;
  /** View file of the grid that carries the XLS button (03b) — may be a tab sub-view loaded in a frame. */
  readonly gridView: string;
  /** Whether the list has a Show button that must be pressed before the grid has rows. */
  readonly hasShow: boolean;
  /** Which XLS button to press (0 = first visible) when a view has several. */
  readonly xlsIndex: number;
  /** Known uncertainty, shown in reports. */
  readonly note?: string;
}

/** listKey -> view. Order matters: the first entry is the one "Test connection" opens. */
export const LISTS = deepFreeze({
  pending_work_requests: {
    viewPath: 'qf-ab-wr-contr-report-pending-tabs-temp.axvw',
    title: 'Details of Pending On Demand Work Requests',
    gridView: 'qf-ab-wr-report-contr-pending-requests-temp.axvw',
    hasShow: true,
    xlsIndex: 1,
    note: 'The grid view has a cross-table XLS before the 26-column grid XLS; the worker presses the grid XLS (index 1).',
  },
  review_approved_estimations: {
    viewPath: 'gc-qf-ab-helpdesk-workrequest-rfe-completed-edit.axvw',
    title: 'Review Completed RFEs',
    gridView: 'gc-qf-ab-helpdesk-workrequest-rfe-completed-edit.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
  wr_dashboard: {
    viewPath: 'qf-wr-custom-status-dashboard.axvw',
    title: 'Work Request Status Report - DashBoard',
    gridView: 'qf-wr-custom-status-dashboard.axvw',
    hasShow: false,
    xlsIndex: 1,
    note: 'On the real portal the 22-column grid is "shown only after an action" (a click on a cross-table count), which the worker may not do. Expect this list to fail with a caption error until reviewed.',
  },
  estimate_and_schedule: {
    viewPath: 'qf-eptw-contr-helpdesk-workrequest-tabs.axvw',
    title: 'Estimate and Schedule Work Requests',
    gridView: 'qf-eptw-contr-helpdesk-workrequest-select.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
  edit_update_wrs: {
    viewPath: 'gc-qf-ab-od-contr-tr-workrequest-costs-report.axvw',
    title: 'Assigned Work Requests',
    gridView: 'gc-qf-ab-od-contr-tr-workrequest-costs-report.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
  issue_wr: {
    viewPath: 'qf-ab-ctr-helpdesk-workrequest-issue-tabs-temp.axvw',
    title: 'Issue Work Requests',
    gridView: 'qf-ab-ctr-helpdesk-workrequest-select-temp.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
  rfe_post_box: {
    viewPath: 'qf-ab-helpdesk-workrequest-rfe-edit-action.axvw',
    title: 'Review Pending RFEs for Action',
    gridView: 'qf-ab-helpdesk-workrequest-rfe-edit-action.axvw',
    hasShow: false,
    xlsIndex: 0,
    note: 'No Show button is recorded for this view; the grid is "shown only after an action". Unverified whether XLS works without it.',
  },
  pending_rfe_status: {
    viewPath: 'qf-helpdesk-workrequest-pending-rfe-report.axvw',
    title: 'RFE Pending for Approval',
    gridView: 'qf-helpdesk-workrequest-pending-rfe-report.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
  manage_permit_to_work: {
    viewPath: 'qf-view-ptw-tabs.axvw?type=requestor',
    title: 'View PTW Request',
    gridView: 'qf-view-ptw-list.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
  end_to_end_wr_to_invoice: {
    viewPath: 'qf-erp-view-wr-to-invice-ctr-report.axvw',
    title: 'End to End Details from OD WR to Invoice',
    gridView: 'qf-erp-view-wr-to-invice-ctr-report.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
  boq_details: {
    viewPath: 'qf-wr-cost-report.axvw',
    title: 'BOQ Details for BPA Release',
    gridView: 'qf-wr-cost-report.axvw',
    hasShow: true,
    xlsIndex: 0,
  },
} as const satisfies Record<string, ListDef>);

export type ListKey = keyof typeof LISTS;
export const LIST_KEYS: readonly ListKey[] = deepFreeze(Object.keys(LISTS) as ListKey[]);

export function isListKey(k: string): k is ListKey {
  return Object.prototype.hasOwnProperty.call(LISTS, k);
}

export function getList(k: ListKey): ListDef {
  return LISTS[k];
}

/**
 * The ONLY button labels the worker can press (design/14 4.3: "only the buttons Show, XLS and paging";
 * paging controls are "Previous / Next" per analysis/01 section 4).
 */
export const PERMITTED_BUTTON_LABELS = deepFreeze(['Show', 'XLS', 'Previous', 'Next'] as const);
export type PermittedLabel = (typeof PERMITTED_BUTTON_LABELS)[number];

/* ------------------------------------------------------------------------------------------------
 * Rule channel (DWR) policy
 * ------------------------------------------------------------------------------------------------
 * Source: analysis/01 section 1 — the browser talks to the server only via
 *   POST /archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr
 * with a workflow rule id as first parameter (264 different rules on the contractor screens), and
 * analysis/01 section 8 point 2 — many pages send SQL to the generic rule
 * `AbCommonResources-executeCustomSQL`, "including updates". A companion product must never use it.
 *
 * Policy: DEFAULT DENY. Only the channel below is reachable, only while a list is open, only with a
 * rule id from PERMITTED_READ_RULES, and only naming the currently open allow-listed view(s).
 */
export const DWR_CHANNEL_PATHS: readonly string[] = deepFreeze([
  '/archibus/dwr/call/plaincall/workflow.runWorkflowRule.dwr',
]);

/**
 * Rule ids a list read may call.
 * - `AbCommonResources-getDataRecords`: OBSERVED on the portal as the generic grid/list read.
 * - `AbSystemAdministration-generateGridXLSReport`: UNVERIFIED. The XLS export rule was never captured;
 *   this is the standard Archibus name. If the real name differs the guard blocks it (safe failure)
 *   and the job result names the blocked rule id. Do not widen this list by guessing: confirm the
 *   name from the result of the first supervised "Test connection" and then change it here.
 * Some list pages call `AbCommonResources-executeCustomSQL` on load (e.g. to read the user's trade
 * code). That call stays blocked; a list that fails because of it is REPORTED, never worked around.
 */
export const PERMITTED_READ_RULES: readonly string[] = deepFreeze([
  'AbCommonResources-getDataRecords',
  'AbSystemAdministration-generateGridXLSReport',
]);

/** Rule ids that are refused even if someone adds them above (belt and braces). Source: analysis/01 §8.2 and screen files. */
export const FORBIDDEN_RULES: readonly string[] = deepFreeze([
  'AbCommonResources-executeCustomSQL',
  'AbCommonResources-saveRecord',
]);

/** Any rule id matching this is refused regardless of the lists above. */
export const FORBIDDEN_RULE_PATTERN = /sql|save|delete|remove|update|insert|approve|reject|issue|complete|submit|send|close|create|check.?in|upload|execute/i;

/**
 * Export files a successful XLS export may download (GET only). ASSUMPTION: Archibus writes per-user
 * export files under /archibus/projects/users/<user>/; not recorded in the analysis documents.
 */
export const EXPORT_FILE_PATTERN = /^\/archibus\/projects\/users\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.(xls|xlsx)$/i;

/** Absolute path of a view file. */
export function viewFilePath(viewPathOrFile: string): string {
  return APP_ROOT + viewPathOrFile.split('?')[0];
}
