# syntax=docker/dockerfile:1
#
# ai.secrets bridge + real OpenCode CLI.
#
#   docker build -t secrets-ai .
#   docker run -d --name secrets-ai -p 127.0.0.1:8790:8790 \
#     -v secrets-ai-config:/home/node/.config/secrets-ai -v "$PWD:/workspace" secrets-ai
#   docker exec -it secrets-ai secrets-ai auth set openrouter
#   docker exec -it secrets-ai secrets-ai auth token
#
# The server listens on 0.0.0.0 INSIDE the container so the published port works. Publish it to
# 127.0.0.1 only (as above) or put it behind a TLS reverse proxy. The bearer token is still
# required on every /v1 route. See docs/RUN-MODES.md.

ARG NODE_VERSION=20
ARG PNPM_VERSION=9.15.9
ARG OPENCODE_VERSION=1.19.6

# ---------- build ----------
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
WORKDIR /app
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---------- runtime ----------
FROM node:${NODE_VERSION}-slim AS runtime
ARG OPENCODE_VERSION
# git + ripgrep are used by OpenCode's tools; ca-certificates for HTTPS to the model providers.
# Debian package versions follow the pinned node:20-slim base, so they are not pinned here.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep tini \
 && rm -rf /var/lib/apt/lists/*
# Real OpenCode CLI, pinned. Fails the build if the platform binary did not install.
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force \
 && opencode --version

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN ln -s /app/dist/cli/index.js /usr/local/bin/secrets-ai \
 && chmod 755 /app/dist/cli/index.js \
 && mkdir -p /home/node/.config/secrets-ai /workspace \
 && chown -R node:node /home/node /workspace \
 && chmod 700 /home/node/.config/secrets-ai

# No secrets here: SECRETS_AI_* are paths/flags (hadolint DL3064 false positive).
# hadolint ignore=DL3064
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    SECRETS_AI_WORKSPACE=/workspace \
    SECRETS_AI_CONTAINER=1 \
    OPENCODE_BIN=opencode

# uid 1000 = the image's "node" user (HOME=/home/node).
USER 1000:1000
VOLUME ["/home/node/.config/secrets-ai", "/workspace"]
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli/index.js"]
CMD ["serve"]
