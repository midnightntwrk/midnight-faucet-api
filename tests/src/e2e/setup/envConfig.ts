import { NetworkId, NoOpTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { testWalletHalo2, WalletConfig } from "./walletConfig";
import { type DefaultConfiguration } from "@midnight-ntwrk/wallet-sdk-facade";

export interface Config {
  readonly faucetUi: string;
  readonly nodeAddress: string;
  readonly indexerAddress: string;
  readonly indexerWsAddress: string;
  readonly proofServerAddress: string;
  readonly wallet: WalletConfig;
  readonly networkId: NetworkId.NetworkId;
}

export class DevnetConfig implements Config {
  networkId = NetworkId.NetworkId.DevNet;

  faucetUi = "https://faucet.devnet.midnight.network?isTesting=true";

  nodeAddress = "wss://rpc.devnet.midnight.network";

  indexerAddress = "https://indexer.devnet.midnight.network/api/v3/graphql";

  indexerWsAddress = "wss://indexer.devnet.midnight.network/api/v3/graphql/ws";

  proofServerAddress = "http://localhost:6300";

  wallet = testWalletHalo2;
}

export class QanetConfig implements Config {
  networkId = NetworkId.NetworkId.QaNet;

  faucetUi = "https://faucet.qanet.midnight.network?isTesting=true";

  nodeAddress = "wss://rpc.qanet.midnight.network";

  indexerAddress = "https://indexer.qanet.midnight.network/api/v3/graphql";

  indexerWsAddress = "wss://indexer.qanet.midnight.network/api/v3/graphql/ws";

  proofServerAddress = "http://localhost:6300";

  wallet = testWalletHalo2;
}

export class PreviewConfig implements Config {
  networkId = NetworkId.NetworkId.Preview;

  faucetUi = "https://faucet.preview.midnight.network?isTesting=true";

  nodeAddress = "wss://rpc.preview.midnight.network";

  indexerAddress = "https://indexer.preview.midnight.network/api/v3/graphql";

  indexerWsAddress = "wss://indexer.preview.midnight.network/api/v3/graphql/ws";

  proofServerAddress = "http://localhost:6300";

  wallet = testWalletHalo2;
}

export class PreProdConfig implements Config {
  networkId = NetworkId.NetworkId.PreProd;

  faucetUi = "https://faucet.preprod.midnight.network?isTesting=true";

  nodeAddress = "wss://rpc.preprod.midnight.network";

  indexerAddress = "https://indexer.preprod.midnight.network/api/v3/graphql";

  indexerWsAddress = "wss://indexer.preprod.midnight.network/api/v3/graphql/ws";

  proofServerAddress = "http://localhost:6300";

  wallet = testWalletHalo2;
}

export function getConfig(): Config {
  let config: Config;
  const env = process.env.NETWORK;
  if (env === undefined) {
    throw new Error("NETWORK environment variable is not defined.");
  }
  switch (env) {
    case "devnet":
      config = new DevnetConfig();
      break;
    case "qanet":
      config = new QanetConfig();
      break;
    case "preview":
      config = new PreviewConfig();
      break;
    case "preprod":
      config = new PreProdConfig();
      break;
    default:
      throw new Error(`Unknown env value=${env}`);
  }
  return config;
}

export function getWalletConfig(config: Config): DefaultConfiguration {
  return {
    indexerClientConnection: {
      indexerHttpUrl: config.indexerAddress,
      indexerWsUrl: config.indexerWsAddress,
    },
    provingServerUrl: new URL(config.proofServerAddress),
    relayURL: new URL(config.nodeAddress),
    networkId: config.networkId,
    costParameters: {
      feeBlocksMargin: 5,
    },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  };
}
