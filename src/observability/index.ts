/**
 * Phase 5 — Observability barrel.
 *
 * Re-exports the dashboard data layer. The audit reader lives in
 * `../audit/log.js` and is also re-exported via `../audit/index.js` so
 * dashboard front-ends can import either surface.
 */

export {
  dashboardSummary,
  jobStatusHistogram,
  recentForUid,
  recentSystemActivity,
  type DashboardSummary,
  type JobStatusHistogram,
  type KindCount,
  type SourceCount,
  type SummaryQuery,
} from './dashboard.js';
