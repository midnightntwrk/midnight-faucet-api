import { FaucetImpl, StandardWalletConfig, WalletFactory } from "@midnight-ntwrk/faucet";
import { Faucet } from "@midnight-ntwrk/faucet-internal-api";
import { Resource } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import { Subject } from "rxjs";
import { ServerConfig } from "./config.js";

export const transformURLs = (
  serverConfigURLs: ServerConfig["urls"],
): StandardWalletConfig["urls"] => ({
  nodeURL: serverConfigURLs.node,
  provingServerURL: serverConfigURLs.provingServer,
  indexerURL: serverConfigURLs.indexer,
  indexerSubscriptionURL: (() => {
    const out = new URL(serverConfigURLs.indexer);
    out.protocol = out.protocol === "https:" ? "wss:" : "ws:";
    out.pathname = out.pathname.endsWith("/") ? `${out.pathname}ws` : `${out.pathname}/ws`;
    return out;
  })(),
});
export const prepareFaucet = (
  config: ServerConfig,
  logger: pino.Logger,
  cachedState?: {
    shielded: string | undefined;
    unshielded: string | undefined;
    dust: string | undefined;
  },
): Resource<Faucet> => {
  const faucetConfig = {
    dropAmount: config.dropAmount,
    walletSeed: config.walletSeed,
    numberOfOutputs: config.numberOfOutputs,
    targetCoinNumber: config.targetCoinNumber,
    targetCoinSizeFactor: config.targetCoinSizeFactor,
    networkId: config.networkId,
    walletConfig: {
      urls: transformURLs(config.urls),
      logLevel: config.logging.level,
      networkId: config.networkId,
    },
  };

  const syncErrorSubject = new Subject<unknown>();
  const faucetWalletFactory = WalletFactory(faucetConfig.walletConfig, logger, (error) =>
    syncErrorSubject.next(error),
  );

  return FaucetImpl(faucetConfig, {
    walletFactory: faucetWalletFactory,
    cachedState,
    logger,
    syncErrorSubject,
  });
};
