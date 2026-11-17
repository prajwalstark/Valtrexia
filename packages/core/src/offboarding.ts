/**
 * How long a workspace waits between being marked for deletion and its data
 * being deleted (decision 7). Long enough to notice a mistake and cancel, or
 * for an organization deleted by accident to be recovered by an operator.
 * The database refuses anything shorter than a week.
 */
export const DELETION_HOLD_DAYS = 30;

export type DeletionReason = "organization_deleted" | "owner_request";

/** When a workspace marked now is deleted. */
export function deleteAfterFor(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_HOLD_DAYS * 86_400_000);
}
