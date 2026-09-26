# Source self-host image. Full node_modules (not standalone) so the Prisma
# CLI is available for migrations at startup — simplicity over image size
# for the self-host path.
FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

ENV NODE_ENV=production \
    AUTH_TRUST_HOST=true \
    PORT=3000
EXPOSE 3000

# .data holds resume uploads on the local storage backend — mount a volume.
VOLUME ["/app/.data"]

# Apply migrations, then serve. For zero-downtime multi-node setups run
# `npm run db:deploy` as a separate release step and change CMD to just
# `npm run start`.
CMD ["sh", "-c", "node scripts/migrate.mjs && npm run start"]
