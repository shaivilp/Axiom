# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY frontend/package.json frontend/
# backend manifest is referenced by the workspace lockfile resolver
COPY backend/package.json backend/
COPY backend/prisma backend/prisma
RUN pnpm install --filter frontend --frozen-lockfile
# Some host filesystems drop the execute bit on bin files that pnpm
# materializes from its content-addressable store. Recursively chmod
# every `.bin` and `bin` directory under any node_modules so the
# shell shims AND their symlink targets are runnable.
RUN find /repo -type d \( -name ".bin" -o -name "bin" \) -path "*node_modules*" -exec sh -c 'chmod -R a+rx "$@"' _ {} + 2>/dev/null || true

COPY frontend ./frontend
WORKDIR /repo/frontend
RUN pnpm build

# ---------- runtime ----------
FROM nginx:1.27-alpine AS runtime

COPY --from=builder /repo/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
