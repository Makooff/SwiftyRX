# Node 22 on Debian slim rather than Alpine: the project needs no native
# modules, and glibc avoids the musl surprises that only show up in production.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a code change does not reinstall the tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Persist the decision journal and agent state across container restarts. This
# is the whole point of running continuously: a portfolio that resets on every
# deploy can never accumulate a track record.
VOLUME ["/app/data"]

# Non-root. The process reads a .env and writes one directory; nothing it does
# needs privilege.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production \
    LOG_PRETTY=false \
    DASHBOARD_PORT=3000

EXPOSE 3000

# No CMD shell form: signals must reach the process so SIGTERM shuts the agent
# down cleanly and checkpoints its state.
CMD ["npx", "tsx", "scripts/paper.ts"]
