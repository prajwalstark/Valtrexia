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
  deriveCurrentStatus,
  evaluateMissedBackup,
  STALE_SYNC_AFTER_INTERVALS,
  type MissedBackupInput,
  type MissedBackupVerdict,
} from "./rules/missed-backup";
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
