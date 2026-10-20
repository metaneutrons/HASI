ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV CI=1
ENV NEXT_TELEMETRY_DISABLED=1

# Install the exact workspace package manager directly; Corepack is not used.
RUN npm install --global --allow-scripts=pnpm pnpm@12.11.2

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY docs/assets/hasi-hero-light.svg docs/assets/hasi-hero-dark.svg ./docs/assets/

RUN pnpm install --frozen-lockfile

# This image is intentionally a public prototype build. These flags only affect
# the client bundle and Next configuration; no server credential is supplied.
ENV HASI_STANDALONE_BUILD=1
ENV NEXT_PUBLIC_HASI_PUBLIC_DEMO=1
RUN mkdir -p apps/web/public
RUN pnpm --filter @hasi/web build

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
ARG SOURCE_COMMIT=${REVISION}
LABEL org.opencontainers.image.source="https://github.com/metaneutrons/HASI"
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.revision="${SOURCE_COMMIT}"
ENV HASI_BUILD_REVISION=${SOURCE_COMMIT}
ENV NODE_ENV=production
ENV PORT=3000
ENV HASI_DEMO_LOOPBACK_TRANSPORT=1
ENV HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /workspace/apps/web/public ./apps/web/public
COPY --chown=node:node LICENSE NOTICE ./
COPY --chown=node:node scripts/deploy/healthcheck.mjs ./healthcheck.mjs

USER node:node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
