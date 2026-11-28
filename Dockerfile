# agentes.chat image: API, WebSocket, workers and the web app in one Bun process.
# Multi-stage (slimmed for the tea-gift fork's self-host deployment):
#   build     full install + web build + runner bundle (discarded afterwards)
#   prod-deps production-only install (isolated linker tree, no dev tooling)
#   runtime   bun slim base + server/packages sources + web dist + prod deps

FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile \
 && bun run --filter '@agenteschat/web' build \
 && bun build apps/server/runner/main.ts --target=node --banner '#!/usr/bin/env node' --outfile apps/web/dist/runner/agentes-runner.mjs
# The runtime stage overlays its own production node_modules; drop the full
# ones from the sources it copies so they don't ride along.
RUN find apps/server packages -type d -name node_modules -prune -exec rm -rf {} +

FROM oven/bun:1.4.4 AS prod-deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/live/package.json packages/live/package.json
COPY packages/modules/package.json packages/modules/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/setup/package.json packages/setup/package.json
COPY packages/tokens/package.json packages/tokens/package.json
COPY packages/ui/package.json packages/ui/package.json
# Production deps for the server and the shared packages only: the desktop,
# mobile and web apps' dependencies (React Native, React, Tauri, …) never run
# in this image — the web app ships as the static dist built above.
RUN bun install --production --frozen-lockfile \
      --filter '@agenteschat/server' \
      --filter '@agenteschat/adapters' \
      --filter '@agenteschat/client' \
      --filter '@agenteschat/config' \
      --filter '@agenteschat/db' \
      --filter '@agenteschat/engine' \
      --filter '@agenteschat/i18n' \
      --filter '@agenteschat/live' \
      --filter '@agenteschat/modules' \
      --filter '@agenteschat/providers' \
      --filter '@agenteschat/setup' \
      --filter '@agenteschat/tokens' \
      --filter '@agenteschat/ui'

FROM oven/bun:1.4.4-slim AS runtime
WORKDIR /app
# A named volume mounted on an empty image directory takes its owner: FILES_DIR in docker-compose.yml.
RUN install -d -o bun -g bun /data/files
# Production dependency tree (isolated linker: root + per-workspace node_modules),
# plus every workspace's package.json, the lockfile and patches.
COPY --from=prod-deps --chown=bun:bun /app ./
# Server and shared-package sources, and the built web app.
COPY --from=build --chown=bun:bun /app/apps/server ./apps/server
COPY --from=build --chown=bun:bun /app/packages ./packages
COPY --from=build --chown=bun:bun /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=bun:bun /app/tsconfig.base.json ./tsconfig.base.json
# The root filesystem can be read-only: the server writes only to /tmp and FILES_DIR, and the
# base image already turns off Bun's transpiler cache (BUN_RUNTIME_TRANSPILER_CACHE_PATH=0).
ENV NODE_ENV=production \
    WEB_DIR=/app/apps/web/dist \
    PORT=3000
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# ENTRYPOINT, not CMD, so `docker compose run --rm agentes migrate` reaches main.ts as argv. An
# absolute path: `docker run -w /work … setup` runs it from the directory being set up.
ENTRYPOINT ["bun", "/app/apps/server/src/main.ts"]
