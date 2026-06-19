import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";

export class DevnetConfig {
  faucetUrl = "https://faucet.devnet.midnight.network";

  nodeUrl = "wss://rpc.devnet.midnight.network";

  indexerURL = "https://indexer.devnet.midnight.network/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.devnet.midnight.network/api/v4/graphql";

  networkId = NetworkId.NetworkId.DevNet;
}

export class QanetConfig {
  faucetUrl = "https://faucet.qanet.midnight.network";

  nodeUrl = "wss://rpc.qanet.midnight.network";

  indexerURL = "https://indexer.qanet.midnight.network/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.qanet.midnight.network/api/v4/graphql";

  networkId = NetworkId.NetworkId.QaNet;
}

export class PreviewConfig {
  faucetUrl = "https://faucet.preview.midnight.network";

  nodeUrl = "wss://rpc.preview.midnight.network";

  indexerURL = "https://indexer.preview.midnight.network/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.preview.midnight.network/api/v4/graphql";

  networkId = NetworkId.NetworkId.Preview;
}

export class PreprodConfig {
  faucetUrl = "https://faucet.preprod.midnight.network";

  nodeUrl = "wss://rpc.preprod.midnight.network";

  indexerURL = "https://indexer.preprod.midnight.network/api/4/graphql";

  indexerSubscriptionURL = "wss://indexer.preprod.midnight.network/api/v4/graphql";

  networkId = NetworkId.NetworkId.PreProd;
}

export class StagenetConfig {
  faucetUrl = "https://faucet.stagenet.midnight.network";

  nodeUrl = "wss://rpc.stagenet.midnight.network";

  indexerURL = "https://indexer.stagenet.midnight.network/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.stagenet.midnight.network/api/v4/graphql";

  networkId = "stagenet";
}

export function getConfig() {
  let config;
  let env = "";
  if (process.env.NETWORK !== undefined) {
    env = process.env.NETWORK;
  } else {
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
      config = new PreprodConfig();
      break;
    case "stagenet":
      config = new StagenetConfig();
      break;
    default:
      throw new Error(`Unknown env value=${env}`);
  }
  return config;
}
