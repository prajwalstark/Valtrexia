import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MappingForm, SettingsForm, TokenForm } from "@/components/notifications/syncro-setup";
import { PageHeader } from "@/components/shell/page-header";
import { Notice } from "@/components/ui/notice";
import {
  replaceSyncroTokenAction,
  saveSyncroMappingsAction,
  saveSyncroSettingsAction,
} from "@/lib/actions/notifications";
import { requireTenant } from "@/lib/auth";
import { getSyncroSetup } from "@/lib/psa-core";
import { notificationDeps } from "@/lib/server-deps";

export const metadata: Metadata = { title: "Syncro tickets" };

/** A Syncro channel's set-up: matching clients, ticket settings, the token. Owners only. */
export default async function SyncroChannelPage({
  params,
}: {
  params: Promise<{ channelId: string }>;
}) {
  const session = await requireTenant();
  const { channelId } = await params;
  const setup = await getSyncroSetup(await notificationDeps(), session, channelId);
  if (setup === null) notFound();

  return (
    <div className="max-w-4xl">
      <Link
        href="/notifications"
        className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Notifications
      </Link>
      {setup === "forbidden" ? (
        <Notice kind="info" className="mt-6 max-w-xl">
          Only workspace owners can set up a Syncro channel.
        </Notice>
      ) : (
        <>
          <div className="mt-4">
            <PageHeader
              title={setup.channel.name}
              description={`Tickets in Syncro at ${setup.channel.subdomain}.syncromsp.com. Only clients matched to a Syncro customer get tickets.`}
            />
          </div>
          {setup.live ? null : (
            <Notice kind="error" className="mt-6 max-w-2xl">
              Syncro could not be read: {setup.liveError} Matches and settings can be changed once
              it can. If the token was refused, replace it below.
            </Notice>
          )}
          <section className="mt-10" aria-labelledby="clients-heading">
            <h2 id="clients-heading" className="text-lg font-semibold">
              Clients
            </h2>
            <div className="mt-4">
              {setup.live ? (
                <MappingForm
                  setup={{ ...setup, live: setup.live }}
                  action={saveSyncroMappingsAction.bind(null, setup.channel.id)}
                />
              ) : (
                <ul className="divide-y divide-line border-y border-line text-sm">
                  {setup.mappings.map((row) => (
                    <li key={row.clientId} className="flex justify-between gap-4 py-2">
                      <span className="font-medium">{row.clientName}</span>
                      <span className="text-muted-foreground">
                        {row.customer?.name ?? "Not matched"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
          {setup.live ? (
            <section className="mt-12" aria-labelledby="settings-heading">
              <h2 id="settings-heading" className="text-lg font-semibold">
                Ticket settings
              </h2>
              <div className="mt-4">
                <SettingsForm
                  setup={{ ...setup, live: setup.live }}
                  action={saveSyncroSettingsAction.bind(null, setup.channel.id)}
                />
              </div>
            </section>
          ) : null}
          <section className="mt-12" aria-labelledby="token-heading">
            <h2 id="token-heading" className="text-lg font-semibold">
              API token
            </h2>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              The saved token is never shown. Replace it if Syncro refuses it or it was revoked;
              tickets waiting to be sent are retried with the new one.
            </p>
            <div className="mt-4">
              <TokenForm action={replaceSyncroTokenAction.bind(null, setup.channel.id)} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
