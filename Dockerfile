# syntax=docker/dockerfile:1
#
# Production images. One file, three targets:
#
#   docker build --target web     -t valtrexia-web .
#   docker build --target worker  -t valtrexia-worker .
#   docker build --target migrate -t valtrexia-migrate .
#
# web      The Next.js server, on port 3000.
# worker   Syncs, notifications and maintenance. The same image runs the
#          seed and key rotation scripts.
# migrate  Applies database migrations as the owner role, then exits. Run it
#          before each deployment; only this task is given the owner URL.
#
# Every image runs as an unprivileged user, works on a read-only filesystem
# (with /tmp writable), and contains no environment file or key: all
# configuration arrives as environment variables at run time. See
# docs/DEPLOYMENT.md.
#
# Behind an intercepting proxy, pass its certificate authority as a build
# secret (`--secret id=ca,src=ca.crt`) with the usual proxy build arguments.
# It is used during installs only and is not kept in any image.

# Pinned by digest: a tag can be moved to different contents. The version
# matches .nvmrc; a test checks the two agree.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# The full image, for the migration task only: Prisma's migration engine is a
# native binary that needs OpenSSL, which the slim image does not have.
ARG NODE_FULL_IMAGE=node:22.23.4-bookworm@sha256:7702d8aa4d5910871692af4480eb3ba86f23047a6417a44d857d06c95d060d3f

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# pnpm, at the version package.json names (a test checks the two agree).
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm install --global --no-fund --no-audit pnpm@10.28.0 \
 && rm -rf /root/.npm
WORKDIR /repo

# The workspace's manifests only, so dependency layers are reused until a
# manifest or the lockfile changes.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/connectors/package.json packages/connectors/

# ---------------------------------------------------------------------------
# Everything, built once: the Prisma client is generated and the web app built.
FROM manifests AS build
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm --filter @valtrexia/db generate
COPY . .
RUN pnpm --filter @valtrexia/web build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone server and the files it was traced to need, owned by root
# and read-only to the user it runs as.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# The worker runs its TypeScript through tsx, with production dependencies only.
FROM manifests AS worker-files
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@valtrexia/worker..."
COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/
COPY packages/connectors/src packages/connectors/src
COPY packages/connectors/tsconfig.json packages/connectors/
COPY packages/db/src packages/db/src
COPY packages/db/tsconfig.json packages/db/
# Only the migrations' names are read, by `db:verify`, to know what a
# correct database has.
COPY packages/db/prisma/migrations packages/db/prisma/migrations
COPY --from=build /repo/packages/db/src/generated packages/db/src/generated
COPY apps/worker/src apps/worker/src
COPY apps/worker/tsconfig.json apps/worker/
# Tests and fixtures do not ship.
RUN find apps/worker/src packages/core/src packages/connectors/src packages/db/src \
      -name "*.test.ts" -delete \
 && rm -rf apps/web

FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=worker-files /repo ./
WORKDIR /app/apps/worker
USER node
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "--import", "tsx", "src/scripts/healthcheck.ts"]
CMD ["node", "--import", "tsx", "src/index.ts"]

# ---------------------------------------------------------------------------
# Prisma's migration engine is a native binary, fetched by its install script
# for the OpenSSL it finds. Installed on the full image, the one it runs on;
# on the slim image it would fetch the build for the wrong OpenSSL.
FROM ${NODE_FULL_IMAGE} AS migrate-files
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm install --global --no-fund --no-audit pnpm@10.28.0 \
 && rm -rf /root/.npm
WORKDIR /repo
COPY --from=manifests /repo ./
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile --filter "@valtrexia/db"
COPY packages/db/scripts/check-migration-url.mjs packages/db/scripts/

FROM ${NODE_FULL_IMAGE} AS migrate
WORKDIR /app
COPY --from=migrate-files /repo ./
WORKDIR /app/packages/db
USER node
ENV NODE_ENV=production
# Reads DATABASE_URL_OWNER, which must verify the server's certificate (the
# check refuses it otherwise). Applies pending migrations and exits; safe to
# run again.
CMD ["sh", "-c", "node scripts/check-migration-url.mjs && exec node_modules/.bin/prisma migrate deploy"]
