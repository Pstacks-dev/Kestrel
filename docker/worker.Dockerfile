# Kestrel worker runtime. The Docker socket is supplied by Compose at runtime.
FROM node:22-bookworm-slim

ENV KESTREL_WORKER_EXECUTOR=docker \
    KESTREL_WORKER_WORKDIR=/var/lib/kestrel/work

ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io curl git ca-certificates \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL "https://github.com/docker/buildx/releases/download/v0.20.1/buildx-v0.20.1.linux-$TARGETARCH" -o /usr/local/lib/docker/cli-plugins/docker-buildx \
 && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-buildx \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/kestrel

COPY package*.json ./
RUN npm ci --omit=dev

COPY server/lib ./server/lib
COPY worker ./worker

RUN mkdir -p /var/lib/kestrel/work \
 && chown -R node:node /var/lib/kestrel

# Runs as root because access to the mounted Docker socket requires daemon privileges.
# CI job containers themselves run with reduced capabilities and a non-root UID.

CMD ["node", "worker/agent.mjs"]
