#!/usr/bin/env bash
# Builds the production images and runs them as production would, against a
# Postgres and a Redis that require TLS, then checks they work and that they
# refuse insecure settings. CI runs this on every push; it also runs locally.
#
#   docker/smoke/run.sh
#
# Everything it creates (containers, certificates, passwords) is throwaway
# and removed at the end. It needs docker, openssl and curl, and ports 3000,
# 3001, 55432 and 56379 free.
#
# Environment:
#   SMOKE_SKIP_BUILD=1      use existing images instead of building
#   SMOKE_IMAGE_PREFIX      image names, default "valtrexia"
#   SMOKE_BUILD_ARGS        extra `docker build` arguments (a proxy, a CA secret)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PREFIX="${SMOKE_IMAGE_PREFIX:-valtrexia}"
# The same versions docker-compose.yml uses, pinned by digest.
POSTGRES_IMAGE="postgres:16-alpine@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e"
REDIS_IMAGE="redis:7-alpine@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe"
PG_PORT=55432
REDIS_PORT=56379
WORK="$(mktemp -d)"
NAMES=(vx-smoke-pg vx-smoke-redis vx-smoke-web vx-smoke-web-insecure vx-smoke-worker)

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf '\nFAILED: %s\n' "$*" >&2
  for name in "${NAMES[@]}"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      printf -- '--- %s logs\n' "$name" >&2
      docker logs --tail 40 "$name" 2>&1 | sed 's/^/  /' >&2 || true
    fi
  done
  exit 1
}
cleanup() {
  docker rm -f "${NAMES[@]}" >/dev/null 2>&1 || true
  rm -rf -- "${WORK:?}"
}
trap cleanup EXIT

# Polls a command until it succeeds or the time runs out.
wait_for() {
  local seconds="$1" what="$2"
  shift 2
  for ((i = 0; i < seconds; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "$what did not happen within ${seconds}s"
}

status_of() { curl -s -o /dev/null -w '%{http_code}' -b '__client_uat=0; __clerk_db_jwt=dvb_smoke' "$1"; }
expect_status() {
  local url="$1" want="$2" got
  got="$(status_of "$url")"
  [[ "$got" == "$want" ]] || fail "$url answered $got, expected $want"
  echo "ok: $url -> $got"
}

step "Throwaway certificate authority and passwords"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Valtrexia smoke CA" \
  -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout "$WORK/server.key" -out "$WORK/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' >"$WORK/ext.cnf"
openssl x509 -req -in "$WORK/server.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" \
  -CAcreateserial -days 1 -extfile "$WORK/ext.cnf" -out "$WORK/server.crt" 2>/dev/null
rm -f "$WORK/ca.key" "$WORK/server.csr"
# Read by the Postgres, Redis and app users inside their containers. Throwaway.
chmod 755 "$WORK"
chmod 644 "$WORK"/*
OWNER_PW="$(openssl rand -hex 16)"
APP_PW="$(openssl rand -hex 16)"
REDIS_PW="$(openssl rand -hex 16)"

step "Postgres and Redis, both requiring TLS"
# Its own pg_hba.conf accepts TLS connections over TCP and refuses the rest,
# so nothing below can pass by connecting without it.
docker run -d --name vx-smoke-pg --network host \
  -e POSTGRES_USER=valtrexia_owner -e POSTGRES_PASSWORD="$OWNER_PW" -e POSTGRES_DB=valtrexia \
  -e APP_DB_PASSWORD="$APP_PW" \
  -v "$ROOT/docker/postgres/init:/docker-entrypoint-initdb.d:ro" -v "$WORK:/pki:ro" \
  --entrypoint sh "$POSTGRES_IMAGE" -c '
    install -o postgres -g postgres -m 600 /pki/server.key /tmp/server.key &&
    install -o postgres -g postgres -m 644 /pki/server.crt /tmp/server.crt &&
    printf "local all all trust\nhostssl all all all scram-sha-256\nhostnossl all all all reject\n" >/tmp/pg_hba.conf &&
    chown postgres /tmp/pg_hba.conf &&
    exec docker-entrypoint.sh postgres -p '"$PG_PORT"' -c ssl=on \
      -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key \
      -c hba_file=/tmp/pg_hba.conf' >/dev/null
docker run -d --name vx-smoke-redis --network host -v "$WORK:/pki:ro" "$REDIS_IMAGE" \
  redis-server --port 0 --tls-port "$REDIS_PORT" --tls-auth-clients no \
  --tls-cert-file /pki/server.crt --tls-key-file /pki/server.key \
  --requirepass "$REDIS_PW" --save "" --appendonly no --maxmemory-policy noeviction >/dev/null
wait_for 60 "Postgres accepting TLS connections" \
  docker exec vx-smoke-pg pg_isready -h 127.0.0.1 -p "$PG_PORT" -U valtrexia_owner
wait_for 30 "Redis answering over TLS" \
  docker exec vx-smoke-redis redis-cli --tls --cacert /pki/ca.crt -p "$REDIS_PORT" \
  -a "$REDIS_PW" --no-auth-warning ping

if [[ "${SMOKE_SKIP_BUILD:-}" != "1" ]]; then
  step "Build the images"
  for target in web worker migrate; do
    # shellcheck disable=SC2086 # SMOKE_BUILD_ARGS is a list of arguments.
    docker build ${SMOKE_BUILD_ARGS:-} --target "$target" -t "$PREFIX-$target:smoke" "$ROOT"
  done
fi
WEB="$PREFIX-web:smoke"
WORKER="$PREFIX-worker:smoke"
MIGRATE="$PREFIX-migrate:smoke"

step "Nothing secret or local inside the images"
for image in "$WEB" "$WORKER" "$MIGRATE"; do
  user="$(docker image inspect --format '{{.Config.User}}' "$image")"
  [[ "$user" == "node" ]] || fail "$image runs as '$user', not the unprivileged node user"
  # Environment files anywhere; keys and certificates in what we added (the
  # base images carry the operating system's public CA list).
  found="$(docker run --rm --entrypoint sh "$image" -c \
    'find / -xdev \( -name ".env" -o -name ".env.*" \) 2>/dev/null;
     find /app \( -name "*.key" -o -name "*.pem" -o -name "*.p12" \) 2>/dev/null' || true)"
  [[ -z "$found" ]] || fail "$image contains: $found"
  echo "ok: $image runs as node and holds no environment or key files"
done

# What production gives every container: a read-only filesystem with /tmp
# writable, the CA to trust, and nothing else from the host.
RUN_AS_PROD=(--network host --read-only --tmpfs /tmp -v "$WORK/ca.crt:/certs/ca.crt:ro")
APP_DB="postgresql://valtrexia_app:$APP_PW@localhost:$PG_PORT/valtrexia?sslmode=verify-full"
OWNER_DB_PRISMA="postgresql://valtrexia_owner:$OWNER_PW@localhost:$PG_PORT/valtrexia?sslmode=require&sslaccept=strict&sslcert=/certs/ca.crt"
REDIS="rediss://default:$REDIS_PW@localhost:$REDIS_PORT"
APP_ENV=(
  -e NODE_EXTRA_CA_CERTS=/certs/ca.crt
  -e DATABASE_URL="$APP_DB"
  -e REDIS_URL="$REDIS"
  -e VALTREXIA_KEY_PROVIDER=aws-kms
  -e VALTREXIA_KMS_KEY_ID=arn:aws:kms:eu-west-1:111122223333:alias/valtrexia-smoke
)

step "Migrations"
if docker run --rm "${RUN_AS_PROD[@]}" \
  -e DATABASE_URL_OWNER="postgresql://valtrexia_owner:$OWNER_PW@localhost:$PG_PORT/valtrexia?sslmode=verify-full" \
  "$MIGRATE" >"$WORK/refused.log" 2>&1; then
  fail "the migrate image accepted sslmode=verify-full, which Prisma does not verify"
fi
grep -q "Refusing to migrate" "$WORK/refused.log" || fail "the migrate image failed for another reason: $(cat "$WORK/refused.log")"
echo "ok: an unverified owner URL is refused"
docker run --rm "${RUN_AS_PROD[@]}" -e DATABASE_URL_OWNER="$OWNER_DB_PRISMA" "$MIGRATE" \
  || fail "migrations did not apply"
echo "ok: migrations applied over verified TLS"

step "Web"
docker run -d --name vx-smoke-web "${RUN_AS_PROD[@]}" "${APP_ENV[@]}" \
  -e CLERK_PUBLISHABLE_KEY="pk_test_$(printf 'placeholder.clerk.accounts.dev$' | base64 | tr -d '\n')" \
  -e CLERK_SECRET_KEY=sk_test_placeholder \
  "$WEB" >/dev/null
wait_for 60 "the web app answering" curl -sf http://localhost:3000/api/health
expect_status http://localhost:3000/api/health 200
expect_status http://localhost:3000/api/ready 200
expect_status http://localhost:3000/sign-in 200
curl -sI -b '__client_uat=0; __clerk_db_jwt=dvb_smoke' http://localhost:3000/sign-in |
  grep -qi "^content-security-policy:.*'nonce-" || fail "no nonce-based CSP on /sign-in"
echo "ok: /sign-in carries a nonce-based Content-Security-Policy"
wait_for 60 "the container reporting healthy" \
  sh -c '[ "$(docker inspect --format "{{.State.Health.Status}}" vx-smoke-web)" = healthy ]'
echo "ok: the image's own health check passes"

step "Web with an unencrypted Redis is not ready"
docker run -d --name vx-smoke-web-insecure "${RUN_AS_PROD[@]}" "${APP_ENV[@]}" \
  -e REDIS_URL="redis://default:$REDIS_PW@localhost:$REDIS_PORT" -e PORT=3001 \
  -e CLERK_PUBLISHABLE_KEY="pk_test_$(printf 'placeholder.clerk.accounts.dev$' | base64 | tr -d '\n')" \
  -e CLERK_SECRET_KEY=sk_test_placeholder \
  "$WEB" >/dev/null
wait_for 60 "the second web app answering" curl -sf http://localhost:3001/api/health
expect_status http://localhost:3001/api/ready 503

step "Worker"
docker run -d --name vx-smoke-worker "${RUN_AS_PROD[@]}" "${APP_ENV[@]}" \
  -e WORKER_INSTANCE_ID=smoke-1 "$WORKER" >/dev/null
wait_for 90 "the worker's heartbeat" \
  docker exec vx-smoke-worker node --import tsx src/scripts/healthcheck.ts
echo "ok: the worker is running and its heartbeat is fresh"
docker logs vx-smoke-worker 2>&1 | grep -q '"msg":"retention applied"' \
  || fail "the worker did not run maintenance at startup"
echo "ok: maintenance ran"

step "Worker with an unencrypted database refuses to start"
if docker run --rm "${RUN_AS_PROD[@]}" "${APP_ENV[@]}" \
  -e DATABASE_URL="postgresql://valtrexia_app:$APP_PW@localhost:$PG_PORT/valtrexia" \
  "$WORKER" >"$WORK/insecure-worker.log" 2>&1; then
  fail "the worker started with an unencrypted database connection"
fi
grep -q "Insecure connection settings" "$WORK/insecure-worker.log" \
  || fail "the worker failed for another reason: $(tail -5 "$WORK/insecure-worker.log")"
grep -q "$APP_PW" "$WORK/insecure-worker.log" && fail "the refusal printed the password"
echo "ok: refused, without printing the URL"

printf '\nAll smoke checks passed.\n'
