import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Every client, ranked by backup health with the worst first."
      />

      <section className="mt-10 max-w-xl border-l-2 border-iris-dim pl-6">
        <h2 className="text-lg font-semibold">No clients in sight yet</h2>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          Connect a backup vendor and your clients appear here after the first check. Failed and
          missed backups rise to the top.
        </p>
        <Button asChild className="mt-6">
          <Link href="/integrations">Connect a vendor</Link>
        </Button>
      </section>
    </>
  );
}
