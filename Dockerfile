# checkov:skip=CKV_DOCKER_2: healthchecks are defined at the orchestrator level (compose files / deployment probes)
FROM node:24.18.0@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059

LABEL org.opencontainers.image.source="https://github.com/midnight-ntwrk/artifacts"

ENV FAUCET_HOST 0.0.0.0
ENV PATH ${PATH}:/source/node_modules/.bin

COPY . /source/
WORKDIR /source
RUN corepack enable \
  && mkdir -p apps/server/certs \
  && curl -fsSL -o apps/server/certs/rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && yarn && chown -R node:node /source

USER node

ENTRYPOINT [ "/bin/bash", "-c" ]
CMD [ "midnight-faucet start" ]
