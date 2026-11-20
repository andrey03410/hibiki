# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --silent --show-error --location --retry 3 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp -o /usr/local/bin/yt-dlp \
    && echo "e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3  /usr/local/bin/yt-dlp" | sha256sum -c
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 VITE_PROVISIONED_ACCOUNTS_ONLY=1
RUN npm ci && npm run build

FROM base AS runtime
COPY --from=build --chmod=755 /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=build --chown=node:node /app /app
RUN install -d -o node -g node storage
ENV NODE_ENV=production PROVISIONED_ACCOUNTS_ONLY=1
ENV HOST=0.0.0.0 STORAGE_DIR=/app/storage
USER node
EXPOSE 8790
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 CMD ["node", "-e", "fetch('http://127.0.0.1:8790/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["sh", "-ec", "npm run db:deploy && exec node --import tsx apps/server/src/main.ts"]
