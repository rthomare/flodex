######### Build stage #########
FROM rust:1.74-slim-bookworm AS builder
WORKDIR /app

# Build deps. The crypto crate pulls k256 (pure Rust) so we don't need libssl.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Copy only what the Cargo workspace needs. Skipping apps/dashboard +
# apps/client (pure TypeScript) keeps the build context lean. All Rust
# workspace members must be present even when targeting just `-p coordinator`,
# or Cargo refuses to load the workspace.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/coordinator ./apps/coordinator
COPY apps/node ./apps/node
COPY apps/proxy ./apps/proxy

RUN cargo build --release -p coordinator

######### Runtime stage #########
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/fldx-coordinator /usr/local/bin/fldx-coordinator

# Sensible defaults; Railway overrides PORT at runtime.
ENV RUST_LOG=info,tower_http=info
ENV FLDX_COORDINATOR_ADDR=0.0.0.0:8000
EXPOSE 8000

# Bind to whatever Railway hands us via $PORT. Falls back to 8000 for local
# `docker run`.
CMD ["/bin/sh", "-c", "FLDX_COORDINATOR_ADDR=0.0.0.0:${PORT:-8000} /usr/local/bin/fldx-coordinator"]
