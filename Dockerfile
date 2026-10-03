# syntax=docker/dockerfile:1.7
#
# One image: the API, which also serves the built web app from apps/web/dist.
#
#   deps      — full dependency tree for building the web app.
#   web       — `vite build` → apps/web/dist.
#   prod-deps — production-only tree for the runtime.
#   runtime   — node + raw TypeScript (Node 26 strips types natively; no
#               build step for the API), non-root. Build arguments
#               APP_VERSION and GIT_SHA record what was built.
#
# Every workspace's package.json is copied before `npm ci`: the lockfile
# covers all of them, and npm ci refuses a workspace it cannot find.

FROM docker.io/library/node:26-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/election-core/package.json packages/election-core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --ignore-scripts

FROM deps AS web
COPY tsconfig.base.json ./
COPY packages/election-core packages/election-core
COPY apps/web apps/web
RUN npm run build --workspace apps/web

FROM docker.io/library/node:26-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/election-core/package.json packages/election-core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --ignore-scripts

FROM docker.io/library/node:26-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Non-root, with a fixed numeric id so secret files on a rootless-podman host
# can be chowned to it (`podman unshare chown 10001:10001 …`).
RUN groupadd -r -g 10001 election && useradd -r -u 10001 -g election election

COPY --from=prod-deps /app/node_modules ./node_modules
# package.json files are load-bearing: Node walks up looking for
# "type":"module" to decide ESM vs CJS, and the .ts files only run as ESM.
COPY package.json ./
COPY packages/election-core/package.json packages/election-core/
COPY packages/election-core/src packages/election-core/src
COPY apps/api apps/api
COPY --from=web /app/apps/web/dist apps/web/dist
# The license texts and notice of libvips, the shared library sharp loads
# from node_modules (see third-party-notices/README.md).
COPY third-party-notices third-party-notices

# What was built, reported by /api/health. Set by the CI and release
# workflows; a plain local build reports "dev" and "unknown". Declared after
# the COPY steps, so a new commit invalidates no layer that does real work.
ARG APP_VERSION=""
ARG GIT_SHA=""
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_SHA}

USER 10001:10001

EXPOSE 3000
CMD ["node", "apps/api/server.ts"]
