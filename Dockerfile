# Build from repo root: docker build -f apps/mcp/Dockerfile .
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp/package.json apps/mcp/
# Skip lifecycle scripts, shared `prepare` needs tsc before sources are copied
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @rill/shared... --filter @rill/mcp...
COPY packages/shared packages/shared
COPY apps/mcp apps/mcp
RUN pnpm --filter @rill/shared build && pnpm --filter @rill/mcp build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV RILL_MCP_TRANSPORT=http
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp/package.json apps/mcp/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @rill/shared... --filter @rill/mcp...
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/mcp/dist apps/mcp/dist
WORKDIR /app/apps/mcp
EXPOSE 3101
CMD ["node", "dist/http-entry.js"]
