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
export {
  createIntegration,
  decryptIntegrationCredentials,
  integrationSummarySelect,
  type CreateIntegrationInput,
  type IntegrationSummary,
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
