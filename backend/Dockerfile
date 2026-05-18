# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ openssl
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

WORKDIR /repo

# Workspace lockfile + manifests first for cache friendliness.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY backend/package.json backend/
RUN pnpm install --filter backend --frozen-lockfile

# Now the source; prisma generate runs from postinstall and needs the schema.
COPY backend/prisma backend/prisma
COPY backend/tsconfig.json backend/tsconfig.build.json backend/
COPY backend/src backend/src

WORKDIR /repo/backend
RUN pnpm prisma:generate
RUN pnpm build

# ---------- deploy: pnpm deploy produces a self-contained backend dir
# with a flat node_modules under /deploy. This avoids the brittle
# `../node_modules` escape in the runtime image.
WORKDIR /repo
RUN pnpm --filter backend --prod deploy /deploy
# Re-run prisma generate inside /deploy because pnpm deploy strips the
# generated client (it lives in the .pnpm store, not in dependencies).
WORKDIR /deploy
COPY backend/prisma /deploy/prisma
RUN cd /deploy && node node_modules/prisma/build/index.js generate

# ---------- runtime ----------
FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl tini wget
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Self-contained deploy bundle.
COPY --from=builder /deploy/package.json ./package.json
COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/prisma ./prisma
COPY --from=builder /repo/backend/dist ./dist

# Persistent dirs (mounted as volumes in compose).
RUN mkdir -p /data/.msauth-cache && chown -R app:app /data /app
ENV MSAUTH_CACHE_DIR=/data/.msauth-cache
ENV NODE_ENV=production

USER app
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# `prisma migrate deploy` is the production migration path. It applies any
# pending migration files in prisma/migrations and fails fast if the DB
# state is incompatible (no destructive auto-fixes). Then start the server.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/index.js"]
