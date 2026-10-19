# One small container for Railway / Fly.io / any Docker host.
# Mount a persistent volume at /app/data (the SQLite file and backups live there).
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
ENV NODE_ENV=production PORT=3000 DB_PATH=data/app.sqlite
EXPOSE 3000
CMD ["node", "server/index.js"]
