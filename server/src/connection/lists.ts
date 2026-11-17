/**
 * List keys the worker may read. MIRRORS worker/src/allowlist.ts (LISTS) — keep in the same order.
 * test/connection.test.ts fails when the two drift.
 */
export const MARAFIQ_LIST_KEYS = [
  'pending_work_requests',
  'review_approved_estimations',
  'wr_dashboard',
  'estimate_and_schedule',
  'edit_update_wrs',
  'issue_wr',
  'rfe_post_box',
  'pending_rfe_status',
  'manage_permit_to_work',
  'end_to_end_wr_to_invoice',
  'boq_details',
] as const;

export type MarafiqListKey = (typeof MARAFIQ_LIST_KEYS)[number];

export function isMarafiqListKey(k: string): k is MarafiqListKey {
  return (MARAFIQ_LIST_KEYS as readonly string[]).includes(k);
}
