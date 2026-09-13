# Dockerfile for the sample Monitored_App (target-app).
#
# Personal AI-Powered APM System — self-hosted, $0/month (AGENTS.md hard
# constraint; Requirement 14.1). Uses the official Node.js image (free, OSS)
# and produces a compiled JS bundle so the running container needs no dev
# toolchain at runtime.
#
# The app serves BOTH its HTTP routes and the Prometheus /metrics endpoint on
# the same http.Server, bound to the `PORT` env var (see src/index.ts).
# prometheus/prometheus.yml scrapes this app at `target-app:9464`, so the
# Compose service sets PORT=9464 to make /metrics reachable on that port.

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

# Only the runtime dependencies (prom-client); omit dev tooling to keep the
# image small and free of the build toolchain.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled JavaScript produced in the build stage.
COPY --from=build /app/dist ./dist

# Default to the port Prometheus scrapes (target-app:9464). Overridable via
# the Compose `environment` block.
ENV PORT=9464
EXPOSE 9464

CMD ["node", "dist/index.js"]
