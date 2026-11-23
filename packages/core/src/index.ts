export {
  buildIncidentsPayload,
  buildIntegrationHealthPayload,
  buildMonthlyReportPayload,
  buildTestPayload,
  changesForChannel,
  channelsForIntegrationHealth,
  channelsForMonthlyReport,
  MAX_CHANGES_PER_MESSAGE,
  MAX_DELIVERY_ATTEMPTS,
  MAX_REPORT_CLIENTS,
  nextAttemptAt,
  NOTIFICATION_PAYLOAD_VERSION,
  planIncidentMessages,
  planPsaMessages,
  RETRY_DELAYS_MINUTES,
  type ChannelPreferences,
  type IncidentChange,
  type IncidentPayloadEntry,
  type IncidentsPayload,
  type IntegrationHealthPayload,
  type MonthlyReportClient,
  type MonthlyReportPayload,
  type NotificationPayload,
  type TestPayload,
} from "./notifications/plan";
export {
  clampAssetHours,
  isMutedIndefinitely,
  MAX_ASSET_HOURS,
  MAX_GRACE_HOURS,
  MAX_MUTE_DAYS,
  MIN_ASSET_HOURS,
  MIN_GRACE_HOURS,
  MUTE_DAY_CHOICES,
  MUTE_REASON_MAX_LENGTH,
  MUTE_REASON_MIN_LENGTH,
  MUTED_INDEFINITELY,
  TECHNICIAN_MAX_MUTE_DAYS,
} from "./asset-settings";
// Client-safe entry point: pure logic with no Node APIs. Anything that needs
// crypto or logging lives in "@valtrexia/core/server".
export { brand, brandLine, pageTitle, taglineLines, type Brand } from "./brand";
export {
  compareWorstFirst,
  HEALTH_LEVELS,
  isWatched,
  summarizeClientHealth,
  type ClientHealth,
  type Health,
  type HealthAsset,
} from "./health";
export {
  planIncidents,
  RAISED_INCIDENT_TYPES,
  type IncidentInput,
  type IncidentPlan,
  type RaisedIncidentType,
} from "./rules/incidents";
export {
  assessIntegrationHealth,
  ACTION_REQUIRED_ERROR_KINDS,
  SYNC_ERROR_KINDS,
  UNHEALTHY_AFTER_FAILURES,
  type IntegrationHealth,
  type IntegrationHealthInput,
  type IntegrationHealthState,
  type SyncErrorKind,
} from "./rules/integration-health";
export {
  deriveCurrentStatus,
  evaluateMissedBackup,
  STALE_SYNC_AFTER_INTERVALS,
  statusInView,
  vendorDataProblem,
  watchSuppression,
  type MissedBackupInput,
  type MissedBackupVerdict,
} from "./rules/missed-backup";
export { effectiveSlaHours, evaluateSla, type SlaInput, type SlaVerdict } from "./rules/sla";
export {
  BACKUP_STATUSES,
  isBackupStatus,
  isCompletedBackup,
  lastCompletedBackupAt,
  statusSeverity,
  worstStatus,
  type BackupStatus,
  type ResultTiming,
} from "./status";
export {
  SYNC_INTERVAL_MINUTES,
  VENDOR_IDS,
  getVendor,
  realVendors,
  vendors,
  type VendorId,
  type VendorInfo,
} from "./vendors";
export {
  escapeHtml,
  MAX_EMAIL_REPORT_CLIENTS,
  renderNotificationEmail,
  type RenderedEmail,
} from "./notifications/email";
export { DELETION_HOLD_DAYS, deleteAfterFor, type DeletionReason } from "./offboarding";
export {
  buildClientMonthReport,
  type AssetMonth,
  type ClientMonthInput,
  type ClientMonthReport,
  type ReportAsset,
  type ReportDay,
  type ReportIncident,
  type ReportResult,
} from "./reports/client-month";
