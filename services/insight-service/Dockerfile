# Dockerfile for the Insight_Service (Node.js + TypeScript).
#
# Personal AI-Powered APM System — self-hosted, $0/month (AGENTS.md hard
# constraint; Requirement 14.1). Uses the official Node.js image (free, OSS).
#
# The service exposes its single-user JSON API on `PORT` (default 3001) and
# reads Prometheus via `PROMETHEUS_URL`. In Compose these resolve to the
# `insight-service` and `prometheus` service names on the shared network.

# --- Build stage: install all deps and compile TypeScript -> dist/ ---
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies against the committed lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Compile the TypeScript sources to dist/ (tsconfig outDir = dist).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage: production deps only + compiled output ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only the runtime dependencies (express); omit dev tooling (vitest, fast-check,
# typescript) to keep the image small.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled JavaScript produced in the build stage.
COPY --from=build /app/dist ./dist

# JSON API port (index.ts defaults to 3001). Overridable via Compose.
ENV PORT=3001
EXPOSE 3001

CMD ["node", "dist/index.js"]
