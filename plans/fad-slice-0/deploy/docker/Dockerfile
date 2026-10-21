# REFERENCE Dockerfile — becomes runnable only when the API source, package
# workspaces, lockfile, and build scripts are implemented by the /goal.
# Pin a digest-approved Node.js LTS image before production deployment.
ARG NODE_IMAGE=node:lts-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /srv/fad
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --no-audit --no-fund
RUN npm run build --workspace apps/api
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /srv/fad
COPY --from=build --chown=node:node /srv/fad/package.json ./
COPY --from=build --chown=node:node /srv/fad/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/fad/apps ./apps
COPY --from=build --chown=node:node /srv/fad/packages ./packages
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
 CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
