FROM --platform=$BUILDPLATFORM golang:alpine AS builder

RUN apk add --no-cache ca-certificates curl jq tar python3

WORKDIR /src/CLIProxyAPI

ARG CLIPROXY_REPO=router-for-me/CLIProxyAPI
ARG CLIPROXY_VERSION=""
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

RUN python3 /tmp/apply_upstream_patches.py

RUN set -eux; \
    go mod tidy; \
    CLIPROXY_VERSION="$(cat /tmp/cliproxy-version)"; \
    BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
    CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build \
      -ldflags="-s -w -X 'main.Version=${CLIPROXY_VERSION}' -X 'main.Commit=release-${CLIPROXY_VERSION}' -X 'main.BuildDate=${BUILD_DATE}'" \
      -o /out/CLIProxyAPI ./cmd/server/

FROM alpine:3.22.0

RUN mkdir -p /CLIProxyAPI/usage

COPY --from=ghcr.io/komari-monitor/komari-agent:latest /app/komari-agent /CLIProxyAPI/komari-agent

RUN apk add --no-cache ca-certificates curl tzdata

WORKDIR /CLIProxyAPI

COPY --from=builder /out/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
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
