FROM golang:1.26-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq python3 build-essential git && rm -rf /var/lib/apt/lists/*

WORKDIR /src/CLIProxyAPI

ARG CLIPROXY_REPO=Ironboxplus/CLIProxyAPI
ARG CLIPROXY_VERSION="v7.2.80-ironbox.1"
ARG CLIPROXY_BUILD_VERSION=""
ARG GITHUB_TOKEN=""
ARG TARGETOS
ARG TARGETARCH

RUN set -eux; \
    auth_header=""; \
    if [ -n "$GITHUB_TOKEN" ]; then auth_header="Authorization: Bearer $GITHUB_TOKEN"; fi; \
    if [ -z "$CLIPROXY_VERSION" ]; then \
      if [ -n "$auth_header" ]; then \
        CLIPROXY_VERSION="$(curl -fsSL -H "$auth_header" "https://api.github.com/repos/${CLIPROXY_REPO}/releases/latest" | jq -r '.tag_name')"; \
      else \
        CLIPROXY_VERSION="$(curl -fsSL "https://api.github.com/repos/${CLIPROXY_REPO}/releases/latest" | jq -r '.tag_name')"; \
      fi; \
    fi; \
    test -n "$CLIPROXY_VERSION"; \
    test "$CLIPROXY_VERSION" != "null"; \
    curl -fsSL "https://github.com/${CLIPROXY_REPO}/archive/refs/tags/${CLIPROXY_VERSION}.tar.gz" -o /tmp/cliproxy.tar.gz; \
    tar -xzf /tmp/cliproxy.tar.gz --strip-components=1 -C /src/CLIProxyAPI; \
    rm /tmp/cliproxy.tar.gz; \
    echo "$CLIPROXY_VERSION" > /tmp/cliproxy-version

COPY embeddedusage ./internal/embeddedusage
COPY patches/apply_upstream_patches.py /tmp/apply_upstream_patches.py
COPY patches/account_inspection_scheduler.go /tmp/account_inspection_scheduler.go
COPY patches/routing_protection_config.go /tmp/routing_protection_config.go
COPY patches/routing_policy.go /tmp/routing_policy.go
COPY patches/routing_policy_test.go /tmp/routing_policy_test.go
COPY patches/redisqueue_plugin.go /tmp/redisqueue_plugin.go
COPY patches/redisqueue_usage_toggle.go /tmp/redisqueue_usage_toggle.go
COPY plugins/cpa-sensitive /src/cpa-sensitive

RUN python3 /tmp/apply_upstream_patches.py

RUN set -eux; \
    go mod tidy; \
    CLIPROXY_SOURCE_VERSION="$(cat /tmp/cliproxy-version)"; \
    if [ -z "$CLIPROXY_BUILD_VERSION" ]; then CLIPROXY_BUILD_VERSION="$CLIPROXY_SOURCE_VERSION"; fi; \
    BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
    CGO_ENABLED=1 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -buildvcs=false \
      -ldflags="-s -w -X 'main.Version=${CLIPROXY_BUILD_VERSION}' -X 'main.Commit=release-${CLIPROXY_SOURCE_VERSION}' -X 'main.BuildDate=${BUILD_DATE}'" \
      -o /out/CLIProxyAPI ./cmd/server/; \
    mkdir -p "/out/plugins/${TARGETOS:-linux}/${TARGETARCH:-amd64}"; \
    cd /src/cpa-sensitive; \
    go mod download; \
    CGO_ENABLED=1 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -buildvcs=false -buildmode=c-shared \
      -o "/out/plugins/${TARGETOS:-linux}/${TARGETARCH:-amd64}/cpa-sensitive.so" .; \
    rm -f "/out/plugins/${TARGETOS:-linux}/${TARGETARCH:-amd64}/cpa-sensitive.h"

FROM debian:bookworm

RUN mkdir -p /CLIProxyAPI/usage

COPY --from=ghcr.io/komari-monitor/komari-agent:latest /app/komari-agent /CLIProxyAPI/komari-agent

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tzdata && rm -rf /var/lib/apt/lists/*

WORKDIR /CLIProxyAPI

COPY --from=builder /out/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
COPY --from=builder /out/plugins /CLIProxyAPI/plugins
COPY --from=builder /src/CLIProxyAPI/config.example.yaml /CLIProxyAPI/config.example.yaml
COPY entrypoint.sh /CLIProxyAPI/entrypoint.sh

ENV TZ=Asia/Shanghai
ENV USAGE_DATA_DIR=/CLIProxyAPI/usage
ENV USAGE_DB_PATH=/CLIProxyAPI/usage/usage.sqlite
ENV USAGE_BATCH_SIZE=100
ENV USAGE_POLL_INTERVAL_MS=500
ENV USAGE_QUERY_LIMIT=50000

VOLUME ["/CLIProxyAPI/usage"]

EXPOSE 8317

RUN chmod -R 777 /CLIProxyAPI && chmod +x /CLIProxyAPI/entrypoint.sh

CMD ["/CLIProxyAPI/entrypoint.sh"]
