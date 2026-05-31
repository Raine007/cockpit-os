# Cockpit OS — production image for Cloud Run.
#
# Multi-stage:
#   1. builder:  installs all deps (incl. dev), runs the TS build, copies UI assets
#   2. runtime:  installs only prod deps, copies dist + UI, runs as non-root
#
# The image listens on $PORT (Cloud Run sets this to 8080 by default).
# Compatible with Cloud Build's classic builder (no BuildKit features).

# ---------- builder ----------
FROM node:20.20.1-slim AS builder
WORKDIR /app

# Install with full deps (need typescript, tsx, etc. for build).
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Copy source and build.
COPY tsconfig.json ./
# cache-bust: cd66cd4
COPY src ./src
RUN npm run build

# Drop dev deps so we can copy a small node_modules to runtime.
RUN npm prune --omit=dev


# ---------- runtime ----------
FROM node:20.20.1-slim AS runtime
WORKDIR /app

# Run as a non-root user. The node image ships with a `node` user (uid 1000).
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Copy only what we need.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080

# Cloud Run sends SIGTERM for graceful shutdown; cockpit-serve already
# handles SIGTERM/SIGINT and closes the listener before exit.
CMD ["node", "dist/bin/serve.js"]
