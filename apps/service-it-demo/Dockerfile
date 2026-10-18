ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV CI=1

RUN npm install --global --allow-scripts=pnpm pnpm@12.11.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY fixtures ./fixtures
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hasi/service-it-demo... build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV SERVICE_IT_DEMO_HOST=0.0.0.0
ENV SERVICE_IT_DEMO_PORT=4110
WORKDIR /app

COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/service-it-demo ./apps/service-it-demo
COPY --from=build --chown=node:node /workspace/fixtures ./fixtures

USER node:node
EXPOSE 4110
CMD ["node", "apps/service-it-demo/dist/server.js"]
