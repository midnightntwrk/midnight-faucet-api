FROM node:26.8.1@sha256:f5d1cc40abc10c2843339a2134d07817cf33c405cb16bfd052b0ed790254c3a3

LABEL org.opencontainers.image.source="https://github.com/midnight-ntwrk/artifacts"

ENV FAUCET_HOST 0.0.0.0
ENV PATH ${PATH}:/source/node_modules/.bin

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
