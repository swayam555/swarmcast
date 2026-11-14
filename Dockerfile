# --- console build
FROM node:22-alpine AS console
WORKDIR /console
COPY console/package*.json ./
RUN npm ci --no-audit --no-fund
COPY console/ ./
RUN npm run build

# --- runtime: control plane and/or worker (SWARMCAST_ROLE=all|api|worker)
FROM node:22-alpine
ENV NODE_ENV=production SWARMCAST_DATA_DIR=/data PORT=3029
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY bin ./bin
COPY --from=console /console/dist ./console/dist
RUN addgroup -S swarmcast && adduser -S swarmcast -G swarmcast && mkdir -p /data && chown swarmcast:swarmcast /data
USER swarmcast
VOLUME ["/data"]
EXPOSE 3029 6881/tcp 6881/udp
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "src/server.js"]
