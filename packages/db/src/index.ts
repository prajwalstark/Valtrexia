// The Prisma client itself is intentionally not exported. Tenant data is
// reachable only through `withTenant`, and the three pre-tenant operations
// only through the named methods on `Db`.
export {
  createDb,
  getDb,
  type CreateDbOptions,
  type Db,
  type DueIntegration,
  type TenantContext,
  type TenantTx,
  type TransactionOptions,
} from "./db";
export { InvalidTenantIdError, UnsafeDatabaseRoleError } from "./errors";
export { recordAudit, type AuditEntry } from "./repositories/audit";
export {
  deactivateUser,
  upsertUser,
  type UserChange,
  type UserIdentity,
} from "./repositories/users";
export {
  createIntegration,
  decryptIntegrationCredentials,
  deleteIntegration,
  getIntegrationSummary,
  integrationNameExists,
  IntegrationNameTakenError,
  integrationSummarySelect,
  listIntegrations,
  loadIntegrationCredentials,
  replaceIntegrationCredentials,
  type CreateIntegrationInput,
  type IntegrationSummary,
  type ReplaceCredentialsInput,
} from "./repositories/integrations";
export {
  ActorType,
  BackupStatus,
  IncidentType,
  SyncStatus,
  UserRole,
  Vendor,
} from "./generated/prisma/enums";
export type {
  Asset,
  AuditLog,
  BackupResult,
  Client,
  Incident,
  Integration,
  Tenant,
  User,
  VendorClientMapping,
} from "./generated/prisma/client";
export { Prisma } from "./generated/prisma/client";
