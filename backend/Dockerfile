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

# ---------- runtime ----------
FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl tini
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Bring only the production artifacts.
COPY --from=builder /repo/backend/package.json ./package.json
COPY --from=builder /repo/backend/dist ./dist
COPY --from=builder /repo/backend/prisma ./prisma
# Hoisted pnpm node_modules — the backend's deps are inside the monorepo store.
COPY --from=builder /repo/node_modules ../node_modules
COPY --from=builder /repo/backend/node_modules ./node_modules

# Persistent dirs (mounted as volumes in compose).
RUN mkdir -p /data/.msauth-cache && chown -R app:app /data /app
ENV MSAUTH_CACHE_DIR=/data/.msauth-cache
ENV NODE_ENV=production

USER app
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Run migrations idempotently at boot, then start the server.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss=false && node dist/index.js"]
