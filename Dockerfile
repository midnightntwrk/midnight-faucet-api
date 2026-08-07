FROM node:26.5.1@sha256:a9875b5ccb02aa527cf7f2297b16ae425a0ff3da2f7d87fce3df41f04ffa0524

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:5300/api/health || exit 1

ENTRYPOINT [ "/bin/bash", "-c" ]
CMD [ "midnight-faucet start" ]
