# Single-stage: tiny image. No native compilation needed for Baileys + pino + express.
# Used for local parity. On GCE, the VM runs `node server.js` directly under
# systemd so the Persistent Disk mount at /data stays simple.
FROM node:22-alpine

# tini = clean PID 1 signal forwarding. Cloud Run sends SIGTERM; the bridge
# needs to flush the Baileys auth state before exit.
RUN apk add --no-cache tini

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=10000 \
    AUTH_STORE_PATH=/data/auth_store

# Auth store directory is intentionally a mount point. Create as 'node' user
# so a bind-mounted host dir or attached PD with matching ownership Just Works.
RUN mkdir -p /data/auth_store && chown -R node:node /app /data
USER node

EXPOSE 10000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
