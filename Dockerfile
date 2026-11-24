FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 FLOWDAY_STANDALONE=1
COPY package.json package-lock.json ./
RUN npm ci
COPY next.config.ts next-env.d.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ARG FLOWDAY_RELEASE=dev
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3100 FLOWDAY_RELEASE=${FLOWDAY_RELEASE}
LABEL org.opencontainers.image.revision=${FLOWDAY_RELEASE}
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --chown=node:node supabase/migrations ./migrations
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD ["node","-e","fetch('http://127.0.0.1:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
