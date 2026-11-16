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
