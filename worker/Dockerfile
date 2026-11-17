# SONU read-only Marafiq connection worker.
# Build context = the repo root `app` (as compose does it):  docker build -f worker/Dockerfile .
# Base image tag MUST match the installed `playwright` version in worker/package.json (1.65.1).

FROM mcr.microsoft.com/playwright:v1.65.1-noble AS build
WORKDIR /opt/sonu/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --ignore-scripts
COPY worker/tsconfig.json worker/tsconfig.build.json ./
COPY worker/src ./src
RUN npm run build:src && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.65.1-noble
ENV NODE_ENV=production \
    HEADLESS=1 \
    POLL_SECONDS=15 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/sonu/worker
COPY --from=build --chown=root:root /opt/sonu/worker/node_modules ./node_modules
COPY --from=build --chown=root:root /opt/sonu/worker/dist ./dist
COPY --chown=root:root worker/package.json ./
# Non-root user shipped with the Playwright image. Code is owned by root and read-only to it.
USER pwuser
# No EXPOSE: the worker listens on nothing. It only polls the SONU server and talks to the portal.
CMD ["node", "dist/main.js"]
