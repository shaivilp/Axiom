# Bun-based frontend build → static files served by nginx.

FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY frontend/package.json ./
RUN bun install
COPY frontend/ ./
# `bun run build` runs `tsc -b && vite build` (see package.json). Bun
# resolves the binaries from node_modules cleanly.
RUN bun run build

# ---------- runtime ----------
FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
