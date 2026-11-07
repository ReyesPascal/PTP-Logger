# Adapted from Manifexus Dockerfile: build layers and bundled runtime retained.
ARG NODE_IMAGE=node:22-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3340
ENV DATA_DIR=/app/data
# rclone (Drive archive) + journalctl (systemd); omit recommended daemons and clean package indexes.
RUN apt-get update && apt-get install -y --no-install-recommends rclone ca-certificates systemd && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data && chown node:node /app/data
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3340
VOLUME ["/app/data"]
CMD ["nice", "-n", "10", "node", "dist/server.cjs"]
