FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    STATE_DIR=/app/var

# No runtime dependencies today; this keeps the layer right if some are added.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY model ./model
COPY data ./data
COPY src ./src

# Conversations, proposals, applications and the audit log live here. Mount a volume on it.
RUN mkdir -p /app/var && chown node:node /app/var
USER node
VOLUME ["/app/var"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node directly (not npm) so SIGTERM reaches the server and it shuts down cleanly.
CMD ["node", "src/server.js"]
