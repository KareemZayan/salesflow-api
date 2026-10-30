# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
ARG PNPM_VERSION=11

# ---- base: node + pnpm ----
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
# Manifests first: this layer (and the install below) is reused until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# ---- deps: all dependencies (build + dev) ----
FROM base AS deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- dev: hot-reload target used by docker-compose.override.yml ----
FROM deps AS dev
COPY . .
CMD ["pnpm", "start:dev"]

# ---- build: compile TypeScript ----
FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: production dependencies only ----
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ---- runtime: slim, non-root ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "dist/main.js"]
