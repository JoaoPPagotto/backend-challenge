# syntax=docker/dockerfile:1
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
# exec form: the bun process is PID 1 and receives SIGTERM directly (graceful shutdown).
CMD ["bun", "src/main.ts"]
