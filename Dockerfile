FROM node:26.9.0@sha256:e26b4e7d163a29e0d05806e167db8cc0c76f02f633006c1f5c0aeea5a8415147

LABEL org.opencontainers.image.source="https://github.com/midnightntwrk/midnight-faucet-api"

ENV FAUCET_HOST 0.0.0.0
ENV PATH ${PATH}:/source/node_modules/.bin

# Node unbundled corepack in v25, so it must be installed before `corepack enable`.
# It stays in use rather than a plain `npm i -g yarn` because the `packageManager`
# hash in package.json is only verified when corepack provisions Yarn. Pinned exact
# so builds are reproducible; it sits before COPY so the layer caches across builds.
RUN npm i -g corepack@0.36.0 && corepack enable

COPY . /source/
WORKDIR /source
# Node unbundled corepack in v25, so it must be installed before `corepack enable`.
# It stays in use rather than a plain `npm i -g yarn` because the `packageManager`
# hash in package.json is only verified when corepack provisions Yarn.
RUN npm i -g corepack@latest \
  && corepack enable \
  && mkdir -p apps/server/certs \
  && curl -fsSL -o apps/server/certs/rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && yarn && chown -R node:node /source

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:5300/api/health || exit 1

ENTRYPOINT [ "/bin/bash", "-c" ]
CMD [ "midnight-faucet start" ]
