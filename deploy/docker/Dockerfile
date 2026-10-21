# Node.js 24 LTS (Active). Digest recorded 2026-10-20.
ARG NODE_IMAGE=node:lts-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS build
WORKDIR /srv/fad
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY contracts ./contracts
COPY db ./db
COPY tsconfig.base.json ./
RUN npm ci --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

# Debian zlib1g 1.2.13 is mapped to CVE-2023-45853 and has no bookworm fix.
# Upstream 1.3.1 fixed the minizip issue. The runtime image keeps that library
# and does not keep the vulnerable Debian package.
FROM ${NODE_IMAGE} AS zlib
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates wget \
 && wget -O /tmp/zlib.tar.gz https://zlib.net/fossils/zlib-1.3.1.tar.gz \
 && echo "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23  /tmp/zlib.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/zlib.tar.gz -C /tmp \
 && cd /tmp/zlib-1.3.1 \
 && ./configure --prefix=/opt/zlib \
 && make -j"$(nproc)" \
 && make install \
 && rm -rf /var/lib/apt/lists/*

FROM ${NODE_IMAGE} AS runtime
# bookworm-security perl-base clears CVE-2026-13221, CVE-2026-42496, and CVE-2026-8376.
# The base image digest stays pinned; this package pin is the security delta.
RUN apt-get update \
 && apt-get install -y --no-install-recommends perl-base=5.36.0-7+deb12u4 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
COPY --from=zlib /opt/zlib/lib/libz.so.1.3.1 /usr/local/lib/libz.so.1.3.1
RUN ln -s libz.so.1.3.1 /usr/local/lib/libz.so.1 \
 && ldconfig \
 && dpkg --purge --force-depends zlib1g \
 && ldconfig
ENV NODE_ENV=production PORT=8080 HOME=/tmp LD_LIBRARY_PATH=/usr/local/lib FAD_POLICIES_ENABLED=false
WORKDIR /srv/fad
COPY --from=build --chown=node:node /srv/fad/package.json /srv/fad/package-lock.json ./
COPY --from=build --chown=node:node /srv/fad/node_modules ./node_modules
COPY --from=build --chown=node:node /srv/fad/apps ./apps
COPY --from=build --chown=node:node /srv/fad/packages ./packages
COPY --from=build --chown=node:node /srv/fad/contracts ./contracts
COPY --from=build --chown=node:node /srv/fad/db ./db
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
