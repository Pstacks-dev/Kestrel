# Kestrel worker runtime. The Docker socket is supplied by Compose at runtime.
FROM node:22-bookworm-slim

ENV KESTREL_WORKER_EXECUTOR=docker \
    KESTREL_WORKER_WORKDIR=/var/lib/kestrel/work

RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io docker-buildx git ca-certificates \
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
