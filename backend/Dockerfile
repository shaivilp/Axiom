# Bun-based backend image. Bun runs the TypeScript source directly — no
# tsc compile step — and installs deps flat (no pnpm .bin symlink store),
# which avoids the execute-bit issues we hit on some host filesystems.

FROM oven/bun:1-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
# Prisma schema must be present before install so `prisma generate`
# (postinstall) can find it.
COPY backend/package.json ./
COPY backend/prisma ./prisma
RUN bun install
# Generate the Prisma client explicitly (independent of any postinstall).
RUN bunx prisma generate

# ---------- runtime ----------
FROM oven/bun:1-alpine AS runtime
RUN apk add --no-cache openssl tini wget
WORKDIR /app

# Installed deps + generated prisma client.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY backend/package.json ./
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src

# Persistent dir for the encrypted MS auth cache (mounted as a volume).
# Bun's home + cache go to /tmp so the container can run read-only.
RUN mkdir -p /data/.msauth-cache && chown -R bun:bun /data /app
ENV MSAUTH_CACHE_DIR=/data/.msauth-cache \
    NODE_ENV=production \
    PORT=3005 \
    HOME=/tmp \
    BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache

USER bun
EXPOSE 3005

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3005/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Apply pending migrations, then run the TypeScript entry point directly
# under Bun. `bun run` resolves the prisma CLI from node_modules.
CMD ["sh", "-c", "bun ./node_modules/prisma/build/index.js migrate deploy && bun run src/index.ts"]
