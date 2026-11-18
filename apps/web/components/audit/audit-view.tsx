import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import { Pagination, ViewTabs } from "@/components/ui/pagination";
import { AUDIT_CATEGORIES, auditQuery, type AuditCategory, type AuditList } from "@/lib/audit-core";
import { count, formatDateTime } from "@/lib/format";

/**
 * The audit log: who changed what, and when. Read-only by construction: the
 * application's database role can add entries and can never alter or remove
 * them.
 */
export function AuditView({ list }: { list: AuditList }) {
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change made in this workspace: who made it, when, and from where. Entries cannot be edited or removed."
      />

      {list.status === "forbidden" ? (
        <Notice kind="info" className="mt-8 max-w-xl">
          Only workspace owners can read the audit log.
        </Notice>
      ) : (
        <>
          <div className="mt-8">
            <ViewTabs
              label="Kinds of change"
              tabs={(Object.keys(AUDIT_CATEGORIES) as AuditCategory[]).map((category) => ({
                href: auditQuery({ category }),
                label: AUDIT_CATEGORIES[category].label,
                current: list.filter.category === category,
              }))}
            />
          </div>

          {list.rows.length === 0 ? (
            <p className="mt-8 border-l-2 border-iris-dim pl-4 text-muted-foreground">
              Nothing has been recorded here yet.
            </p>
          ) : (
            <>
              <p className="mt-6 text-sm text-subtle-foreground">
                {count(list.total, "entry", "entries")}, newest first
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-sm">
                  <caption className="sr-only">Audit log entries, newest first</caption>
                  <thead className="border-y border-line text-subtle-foreground">
                    <tr>
                      <th scope="col" className="py-2 pr-6 font-normal sm:pl-3">
                        When
                      </th>
                      <th scope="col" className="py-2 pr-6 font-normal">
                        Who
                      </th>
                      <th scope="col" className="py-2 pr-6 font-normal">
                        What
                      </th>
                      <th scope="col" className="py-2 font-normal sm:pr-3">
                        From
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {list.rows.map((entry) => (
                      <tr key={entry.id} className="align-top">
                        <td className="py-2.5 pr-6 whitespace-nowrap tabular-nums text-muted-foreground sm:pl-3">
                          {formatDateTime(entry.at, list.timeZone)}
                        </td>
                        <td className="py-2.5 pr-6 whitespace-nowrap">{entry.actor}</td>
                        <td className="py-2.5 pr-6">
                          {entry.summary}
                          <span className="block text-xs text-subtle-foreground">
                            {entry.action}
                          </span>
                        </td>
                        <td className="py-2.5 whitespace-nowrap tabular-nums text-muted-foreground sm:pr-3">
                          {entry.ip ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={list.filter.page}
                pageCount={list.pageCount}
                href={(page) => auditQuery({ ...list.filter, page })}
                className="mt-5"
              />
            </>
          )}
        </>
      )}
    </>
  );
}
