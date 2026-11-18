import { z } from "zod";

/**
 * Response shapes of the Veeam Service Provider Console REST API, from
 * Veeam's published OpenAPI specification (REST API 3.6.1, VSPC 9.1, and
 * 3.5.1, VSPC 8.1, which every endpoint and field here also exists in).
 *
 * Only the fields the connector reads are declared. Unknown fields are kept
 * (loose objects), so the record stored as a result's raw payload is exactly
 * what the console sent. Enumerations are read as plain strings: Veeam marks
 * them extensible, and a value added in a later release must reach the
 * normalizer as "unknown", not fail the sync.
 */

const optionalString = z.string().nullish();

/** `{ meta: { pagingInfo: { total, count, offset } }, data: [...] }` */
export const vspcPageSchema = z.object({
  data: z.array(z.unknown()),
  meta: z
    .object({
      pagingInfo: z
        .object({ total: z.number().int().nonnegative(), count: z.number().int().nullish() })
        .nullish(),
    })
    .nullish(),
});

/** GET organizations/companies */
export const vspcCompanySchema = z.looseObject({
  instanceUid: z.string().min(1),
  name: z.string(),
  status: optionalString,
});
export type VspcCompany = z.infer<typeof vspcCompanySchema>;

/** GET infrastructure/backupServers/jobs */
export const vspcServerJobSchema = z.looseObject({
  instanceUid: z.string().min(1),
  uniqueUid: optionalString,
  name: optionalString,
  type: optionalString,
  /** The organization that owns the backup server. */
  organizationUid: optionalString,
  /** The organization the job is assigned to, when the provider has assigned it to a client. */
  mappedOrganizationUid: optionalString,
  isEnabled: z.boolean().nullish(),
  scheduleType: optionalString,
  status: optionalString,
});
export type VspcServerJob = z.infer<typeof vspcServerJobSchema>;

/** GET infrastructure/backupServers/jobs/backupVmJobs/objects: one VM in one job. */
export const vspcVmObjectSchema = z.looseObject({
  jobUid: z.string().min(1),
  uniqueJobUid: optionalString,
  /** The protected VM. */
  instanceUid: z.string().min(1),
  name: z.string(),
  platform: optionalString,
  isExcluded: z.boolean().nullish(),
  lastSession: z
    .looseObject({
      backupStatus: optionalString,
      startTime: optionalString,
      endTime: optionalString,
      messages: z.array(z.string()).nullish(),
    })
    .nullish(),
});
export type VspcVmObject = z.infer<typeof vspcVmObjectSchema>;

/** GET infrastructure/backupAgents */
export const vspcAgentSchema = z.looseObject({
  instanceUid: z.string().min(1),
  name: optionalString,
  organizationUid: optionalString,
  agentPlatform: optionalString,
  platform: optionalString,
});
export type VspcAgent = z.infer<typeof vspcAgentSchema>;

/** GET infrastructure/backupAgents/jobs */
export const vspcAgentJobSchema = z.looseObject({
  instanceUid: z.string().min(1),
  backupAgentUid: z.string().min(1),
  organizationUid: optionalString,
  name: optionalString,
  status: optionalString,
  lastRun: optionalString,
  lastEndTime: optionalString,
  failureMessage: optionalString,
  isEnabled: z.boolean().nullish(),
  scheduleType: optionalString,
});
export type VspcAgentJob = z.infer<typeof vspcAgentJobSchema>;

/**
 * A timestamp from the console, or null when it is absent, unreadable, or
 * a placeholder for "never" (.NET's minimum date, year 1). Timestamps carry
 * their offset in the specification's examples; one without is read as UTC.
 */
export function parseVspcTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return null;
  return date;
}
