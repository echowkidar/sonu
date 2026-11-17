/**
 * The mock portal's own copy of the views it imitates. Deliberately NOT imported from the worker's
 * allow-list, so a mistake in the allow-list is caught by the tests instead of mirrored.
 * Captions: analysis/03b-export-columns.md (exact, including the portal's own spelling);
 * WR Dashboard grid: analysis/screens/qf-wr-custom-status-dashboard.md (22 columns).
 */

export interface MockView {
  key: string;
  /** Main menu-task view, may carry a query string. */
  view: string;
  title: string;
  /** Grid sub-view loaded in a frame (tabbed views) or the same file. */
  gridView: string;
  hasShow: boolean;
  /** XLS buttons in screen order; each yields a file with these captions. */
  exports: string[][];
}

const split = (s: string) => s.split(' | ');

const PENDING = split(
  'Work Request Code | Work Request Status | Service Request Code | Permit to Work Code | Permit to Work Status | Requestor Name | Contractor | Site Code | Site Name | Building Code | Building Name | Floor Code | Room Code | Directorate Code | Department Code | Equipment Code | Equipment Standard | Problem Type | Problem Type Description | Work Team Code | Work Request Priority | WR Description | Date Work Requested | Agreed Target Date | Date Trade Assigned | Estimated Total Cost',
);
const REVIEW_APPROVED = split('Work Request Code | Site Code | Building Code | RFE Submitted On | RFE Approved On | Work Team Code | Work Description');
const WR_DASHBOARD = split(
  'Action Item ID | Assigned to Work Order | Work Request Code | Site Code | Site Name | Building Code | Building Name | Floor Code | Room Code | Equipment Code | Date Work Requested | Agreed Target Date | Date Trade Assigned | Requested by | Problem Type | Work Request Priority | Estimated Total Cost | Work Team Code | Contractor | Work Request Status | WR Descriptive Status | Work Description',
);
const ESTIMATE = split(
  'Work Request Code | PTW Id | PTW status | Requested by | Problem Type | Work Request Priority | Work Team Code | Date Work Requested | Site Code | Building Code | Floor Code | Room Code | Equipment Code | Equipment Standard | Step Type | Date Assigned | Work Description | Action Item ID | Assigned to Work Order | With RFE? | Estimated Total Cost',
);
const EDIT_UPDATE = split(
  'Work Request Code | Assigned to Work Order | Action Item ID | Date Work Requested | Date to Perform | Agreed Target Date | Work Request Priority | PTW Id | PTW Status | % Progress | PM Procedure | Site Code | Building Code | Building Name | Apartment (Suite) Code | Floor Code | Room Code | Trade/Discipline | Equipment Code | Equipment Standard | Equipment Exhoust Count | Estimated Labor Hours | Actual Labor Hours | Problem Type | Work Request Status | Work Description | Work Team Code | Wr Closure Comments',
);
const ISSUE = split(
  'Permit to Work Code | Permit to work status | Service Request ID | Work Request Code | Assigned to Work Order | Primary Trade | Site Code | Building Code | Floor Code | Room Code | Equipment Code | Equipment Name | Equipment Standard | Classification Code | Criticality | Date Work Requested | Problem Type | Problem Description | Work Description | Work Request Priority | Requested by | Date to Perform | Agreed Target Date | Work Team Code',
);
const RFE_POST_BOX = split('Other Res. Log ID | Work Request Code | Date Used | Time Used | Quantity Estimated | Estimated Cost | Comments | Created By | Send To | Date Created | Time Created');
const PENDING_RFE = split(
  'Work Request Code | Date Work Requested | Date RFE Submitted | Site Code | Building Code | Contractor | Work Team Code | Problem Type | Pending With | RFE Amount | Total Amount | Work Description',
);
const PTW = split(
  'Permit to Work Code | Site Name | Building Name | Date Created | Date Issued | Date Start | Date Upto | Description | Permit to Work Status | Created By | Permit Applicant | Permit Authority | Permit Controller | Building Focal Point | Contractor | Project Code | TRAM Reviewer',
);
const E2E = split(
  'Work Request Code | Requestor | Date WR Estimated | Work Request Status | Site Code | Building Code | Problem Type | Work Team Code | Contractor | BPA Agreement | Demand Note | Demand Note Description | Date Created | Demand Note Status | PO Number | PO Date | PO Status | PR Number | PR Date | PR Status | Demand Note Line Number | Reference Code | BPA Line No. | Item | Item Description | Units (BPA) | Quantity Estimated | Actual Quantity | Unit Cost | Cost Estimated | Cost Actual | Account Code | WCC Number | WCC Completion Date | Is Ammedment Required | WCC Status | Invoice Number | invoice status | Po type',
);
const BOQ = split(
  'Work Request Code | Site Code | Building Code | Problem Type | Work Team Code | Directorate Code | Department Code | Date Work Assigned | Date Work Completed | Work Request Status | Account Code | Part Code / Craftsperson Code / Other Resource Code | Part Description / Craftsperson Name / Other Resource Cost | DE Comments | Date Work Performed | Unit of Measure | Unit Cost | Estimated Cost | Actual Cost | Estimated Hours | Quantity / Actual Hours | BPA Agreement No | BPA Release Ref.# | Line No | Item No | Type of Work | Work Description',
);
/** Cross-table panels (summary) that sit before the list grid on two screens. */
const CROSS_TABLE = ['Work Request Status', 'Count'];

export const MOCK_VIEWS: readonly MockView[] = [
  { key: 'pending_work_requests', view: 'qf-ab-wr-contr-report-pending-tabs-temp.axvw', title: 'Details of Pending On Demand Work Requests', gridView: 'qf-ab-wr-report-contr-pending-requests-temp.axvw', hasShow: true, exports: [CROSS_TABLE, PENDING] },
  { key: 'review_approved_estimations', view: 'gc-qf-ab-helpdesk-workrequest-rfe-completed-edit.axvw', title: 'Review Completed RFEs', gridView: 'gc-qf-ab-helpdesk-workrequest-rfe-completed-edit.axvw', hasShow: true, exports: [REVIEW_APPROVED] },
  { key: 'wr_dashboard', view: 'qf-wr-custom-status-dashboard.axvw', title: 'Work Request Status Report - DashBoard', gridView: 'qf-wr-custom-status-dashboard.axvw', hasShow: false, exports: [CROSS_TABLE, WR_DASHBOARD] },
  { key: 'estimate_and_schedule', view: 'qf-eptw-contr-helpdesk-workrequest-tabs.axvw', title: 'Estimate and Schedule Work Requests', gridView: 'qf-eptw-contr-helpdesk-workrequest-select.axvw', hasShow: true, exports: [ESTIMATE] },
  { key: 'edit_update_wrs', view: 'gc-qf-ab-od-contr-tr-workrequest-costs-report.axvw', title: 'Assigned Work Requests', gridView: 'gc-qf-ab-od-contr-tr-workrequest-costs-report.axvw', hasShow: true, exports: [EDIT_UPDATE] },
  { key: 'issue_wr', view: 'qf-ab-ctr-helpdesk-workrequest-issue-tabs-temp.axvw', title: 'Issue Work Requests', gridView: 'qf-ab-ctr-helpdesk-workrequest-select-temp.axvw', hasShow: true, exports: [ISSUE] },
  { key: 'rfe_post_box', view: 'qf-ab-helpdesk-workrequest-rfe-edit-action.axvw', title: 'Review Pending RFEs for Action', gridView: 'qf-ab-helpdesk-workrequest-rfe-edit-action.axvw', hasShow: false, exports: [RFE_POST_BOX] },
  { key: 'pending_rfe_status', view: 'qf-helpdesk-workrequest-pending-rfe-report.axvw', title: 'RFE Pending for Approval', gridView: 'qf-helpdesk-workrequest-pending-rfe-report.axvw', hasShow: true, exports: [PENDING_RFE] },
  { key: 'manage_permit_to_work', view: 'qf-view-ptw-tabs.axvw?type=requestor', title: 'View PTW Request', gridView: 'qf-view-ptw-list.axvw', hasShow: true, exports: [PTW] },
  { key: 'end_to_end_wr_to_invoice', view: 'qf-erp-view-wr-to-invice-ctr-report.axvw', title: 'End to End Details from OD WR to Invoice', gridView: 'qf-erp-view-wr-to-invice-ctr-report.axvw', hasShow: true, exports: [E2E] },
  { key: 'boq_details', view: 'qf-wr-cost-report.axvw', title: 'BOQ Details for BPA Release', gridView: 'qf-wr-cost-report.axvw', hasShow: true, exports: [BOQ] },
];

/** A real portal view that is NOT on the worker's allow-list (approval screen). Any hit is a trap hit. */
export const FORBIDDEN_VIEW = 'qf-ab-helpdesk-workrequest-approve.axvw';

/** Captions of the list export (the last XLS on the screen) per list key. */
export function listCaptions(key: string): string[] | undefined {
  const v = MOCK_VIEWS.find((m) => m.key === key);
  return v ? v.exports[v.exports.length - 1] : undefined;
}
