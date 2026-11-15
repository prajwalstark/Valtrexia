-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "vendor" AS ENUM ('datto_bcdr', 'kaseya_uniview', 'veeam_vspc', 'mock');

-- CreateEnum
CREATE TYPE "backup_status" AS ENUM ('success', 'warning', 'failed', 'missed', 'running', 'unknown');

-- CreateEnum
CREATE TYPE "sync_status" AS ENUM ('never', 'running', 'ok', 'error');

-- CreateEnum
CREATE TYPE "incident_type" AS ENUM ('failed', 'missed', 'stale');

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('owner', 'technician');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('user', 'system');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clerk_org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grace_hours" INTEGER NOT NULL DEFAULT 2,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'technician',
    "deactivated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "vendor" "vendor" NOT NULL,
    "name" TEXT NOT NULL,
    "credentials_enc" JSONB NOT NULL,
    "credential_hint" TEXT,
    "last_sync_at" TIMESTAMPTZ(3),
    "last_sync_started_at" TIMESTAMPTZ(3),
    "sync_status" "sync_status" NOT NULL DEFAULT 'never',
    "last_sync_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_client_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "vendor_client_id" TEXT NOT NULL,
    "vendor_client_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_client_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "vendor_asset_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "device_name" TEXT,
    "expected_frequency_hours" INTEGER NOT NULL DEFAULT 24,
    "sla_hours" INTEGER NOT NULL DEFAULT 72,
    "muted_until" TIMESTAMPTZ(3),
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_result_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "current_status" "backup_status" NOT NULL DEFAULT 'unknown',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "vendor_result_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "status" "backup_status" NOT NULL,
    "vendor_status_raw" TEXT NOT NULL,
    "message" TEXT,
    "screenshot_verified" BOOLEAN,
    "raw_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "type" "incident_type" NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "acknowledged_by_user_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_clerk_org_id_key" ON "tenants"("clerk_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_clerk_user_id_key" ON "users"("tenant_id", "clerk_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_id_key" ON "users"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_tenant_id_name_key" ON "integrations"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_tenant_id_id_key" ON "integrations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenant_id_name_key" ON "clients"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenant_id_id_key" ON "clients"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "vendor_client_mappings_tenant_id_client_id_idx" ON "vendor_client_mappings"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_client_mappings_integration_id_vendor_client_id_key" ON "vendor_client_mappings"("integration_id", "vendor_client_id");

-- CreateIndex
CREATE INDEX "assets_tenant_id_client_id_idx" ON "assets"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "assets_tenant_id_current_status_idx" ON "assets"("tenant_id", "current_status");

-- CreateIndex
CREATE UNIQUE INDEX "assets_integration_id_vendor_asset_id_key" ON "assets"("integration_id", "vendor_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenant_id_id_key" ON "assets"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "backup_results_tenant_id_asset_id_started_at_idx" ON "backup_results"("tenant_id", "asset_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "backup_results_asset_id_vendor_result_id_key" ON "backup_results"("asset_id", "vendor_result_id");

-- CreateIndex
CREATE INDEX "incidents_tenant_id_closed_at_idx" ON "incidents"("tenant_id", "closed_at");

-- CreateIndex
CREATE INDEX "incidents_tenant_id_asset_id_idx" ON "incidents"("tenant_id", "asset_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_client_mappings" ADD CONSTRAINT "vendor_client_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_client_mappings" ADD CONSTRAINT "vendor_client_mappings_tenant_id_integration_id_fkey" FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "integrations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_client_mappings" ADD CONSTRAINT "vendor_client_mappings_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_integration_id_fkey" FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "integrations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_results" ADD CONSTRAINT "backup_results_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_results" ADD CONSTRAINT "backup_results_tenant_id_asset_id_fkey" FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_results" ADD CONSTRAINT "backup_results_tenant_id_integration_id_fkey" FOREIGN KEY ("tenant_id", "integration_id") REFERENCES "integrations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_asset_id_fkey" FOREIGN KEY ("tenant_id", "asset_id") REFERENCES "assets"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_acknowledged_by_user_id_fkey" FOREIGN KEY ("tenant_id", "acknowledged_by_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_actor_user_id_fkey" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

