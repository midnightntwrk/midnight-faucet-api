FROM node:24.11.1

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
