# syntax=docker/dockerfile:1.7
ARG RAIDNOW_CLI_REF=c79c49f5e0a24a2f17ae450ba8a5da5a795f5142

FROM golang:1.27.4-alpine AS raidnow-cli-builder

ARG RAIDNOW_CLI_REF
ARG TARGETOS
ARG TARGETARCH

RUN apk add --no-cache ca-certificates git
WORKDIR /src/raidnow-cli
RUN git init \
    && git remote add origin https://github.com/albinmedoc/raidnow-cli.git \
    && git fetch --depth=1 origin "${RAIDNOW_CLI_REF}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${RAIDNOW_CLI_REF}" \
    && go mod download \
    && go mod verify \
    && CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build \
      -trimpath \
      -ldflags "-X github.com/albinmedoc/raidnow-cli/internal/cli.Version=${RAIDNOW_CLI_REF}" \
      -o /usr/local/bin/raidnow ./cmd/raidnow

FROM node:22-alpine

ARG RAIDNOW_CLI_REF
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    RAIDNOW_CLI_PATH=/usr/local/bin/raidnow

WORKDIR /app

COPY --from=raidnow-cli-builder /usr/local/bin/raidnow /usr/local/bin/raidnow
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

RUN mkdir -p /app/data/sessions \
    && chown -R node:node /app/data \
    && chmod 700 /app/data /app/data/sessions

USER node

RUN output="$(/usr/local/bin/raidnow --json version)" \
    && expected="{\"schemaVersion\":1,\"ok\":true,\"command\":\"version\",\"status\":\"shown\",\"data\":{\"version\":\"${RAIDNOW_CLI_REF}\"},\"warnings\":[]}" \
    && test "${output}" = "${expected}"

EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
