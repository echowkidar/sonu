# syntax=docker/dockerfile:1
# SONU app image: API server + built web app + run-time assets. Build context = repo root.
#   docker build -t sonu-app .
# Steps that depend on folders still being written (packages/core, web) are skipped when absent.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN mkdir -p packages web/dist

# 1) @sonu/core (pure library, used by the server once it is wired in)
RUN if [ -f packages/core/package.json ]; then \
      cd packages/core && \
      if [ -f package-lock.json ]; then npm ci; else npm install; fi && \
      npm run build && npm prune --omit=dev; \
    fi

# 2) server
RUN cd server && npm ci && npm run build && npm prune --omit=dev

# 3) web app (Vite build to web/dist) — tolerant: skipped when web/ has no package.json yet
RUN if [ -f web/package.json ]; then \
      cd web && \
      if [ -f package-lock.json ]; then npm ci; else npm install; fi && \
      npm run build; \
    fi

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=build /app/server/package.json /app/server/package.json
COPY --from=build /app/server/node_modules /app/server/node_modules
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/server/migrations /app/server/migrations
COPY --from=build /app/packages /app/packages
COPY --from=build /app/web/dist /app/web/dist
COPY assets /app/assets
# The named volume mounted at /data/uploads inherits this ownership on first use.
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
