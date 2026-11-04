FROM caddy:2.11.7-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5 AS https
# The upstream binary has file capabilities, which conflict with drop: ALL.
# Both listeners use high ports; no capabilities are needed.
RUN setcap -r /usr/bin/caddy
USER 1000:1000

FROM node:22.23.1-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS dependencies
WORKDIR /app
RUN npm install --global pnpm@9.15.9
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22.23.1-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ENV NODE_ENV=production RELAY_DATABASE=/data/relay.db
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/vendor ./vendor
COPY package.json ./
COPY src ./src
RUN mkdir /data && chown node:node /data
USER 1000:1000
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["node", "src/cli.mjs"]
