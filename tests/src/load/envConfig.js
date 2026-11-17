import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";

export class DevnetConfig {
  faucetUrl = "https://faucet.devnet.shielded.tools";

  nodeUrl = "wss://rpc.devnet.shielded.tools";

  indexerURL = "https://indexer.devnet.shielded.tools/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.devnet.shielded.tools/api/v4/graphql";

  networkId = NetworkId.NetworkId.DevNet;
}

export class QanetConfig {
  faucetUrl = "https://faucet.qanet.shielded.tools";

  nodeUrl = "wss://rpc.qanet.shielded.tools";

  indexerURL = "https://indexer.qanet.shielded.tools/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.qanet.shielded.tools/api/v4/graphql";

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

  nodeUrl = "wss://rpc.preprod.shielded.tools";

  indexerURL = "https://indexer.preprod.shielded.tools/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.preprod.shielded.tools/api/v4/graphql";

  networkId = NetworkId.NetworkId.PreProd;
}

export class StagenetConfig {
  faucetUrl = "https://faucet.stagenet.shielded.tools";

  nodeUrl = "wss://rpc.stagenet.shielded.tools";

  indexerURL = "https://indexer.stagenet.shielded.tools/api/v4/graphql";

  indexerSubscriptionURL = "wss://indexer.stagenet.shielded.tools/api/v4/graphql";

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
