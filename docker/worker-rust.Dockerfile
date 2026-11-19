FROM rust:1-bookworm AS build
WORKDIR /src
COPY runtime/rust/Cargo.toml runtime/rust/Cargo.toml
COPY runtime/rust/src runtime/rust/src
RUN cargo build --release --manifest-path runtime/rust/Cargo.toml

FROM debian:bookworm-slim
ENV KESTREL_WORKER_WORKDIR=/var/lib/kestrel/work \
    KESTREL_DOCKER_BIN=docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates docker.io git \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/kestrel/work
COPY --from=build /src/runtime/rust/target/release/kestrel-runtime /usr/local/bin/kestrel-runtime
WORKDIR /var/lib/kestrel
ENTRYPOINT ["/usr/local/bin/kestrel-runtime"]
