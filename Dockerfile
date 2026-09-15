FROM node:26.8.2@sha256:fb192b8ad31841aadc4bb79c44ae0f59d193a798ffbc9fdce37ba6ecb20c2236

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
