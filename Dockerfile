# ---------- Stage 1: builder ----------
# Installs all deps (incl. dev), builds Tailwind CSS, downloads Puppeteer's
# Chrome, then prunes devDependencies. Same base as runtime so prebuilt
# native binaries (sharp, etc.) are ABI-compatible.
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Tooling for occasional npm postinstall fallbacks (node-gyp, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# Pin Puppeteer's Chrome cache to a known path that survives the prune.
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package.json package-lock.json ./

RUN npm ci --include=dev

# Bring in the full source. .dockerignore filters secrets, logs, the bridge
# subdir, and other build-context noise.
COPY . .

# Compile Tailwind to public/styles/output.css.
RUN npm run build:css

# Drop devDependencies. Keeps /app/.cache/puppeteer (Chrome) intact since
# it lives outside node_modules.
RUN npm prune --omit=dev


# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime

# Runtime system packages:
#   - ffmpeg: V4 video pipeline shells out via execFile (BrandStoryService,
#     beat-generators/TextOverlayCardGenerator, VideoGenerationService)
#   - Chrome runtime libs + fonts: Puppeteer headless rendering
#     (services/ViewportCaptureService.js)
#   - tini: PID 1 that forwards SIGTERM (Cloud Run sends SIGTERM with 10s
#     grace before SIGKILL; node must receive it to drain cleanly)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      tini \
      ffmpeg \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
      libatspi2.0-0 \
      libx11-6 \
      libxcb1 \
      libxext6 \
      libxss1 \
      libnspr4 \
      libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    NPM_CONFIG_LOGLEVEL=warn

# One copy of the entire pruned app tree from builder. node_modules is
# already production-only thanks to `npm prune --omit=dev` above.
# --chown avoids a separate chown layer.
COPY --from=builder --chown=node:node /app /app

USER node

EXPOSE 8080

# tini -> node => SIGTERM forwarded for graceful shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
