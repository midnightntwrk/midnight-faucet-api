import { exit } from "node:process";
import { DockerComposeEnvironment, StartedDockerComposeEnvironment, Wait } from "testcontainers";
import { StartedGenericContainer } from "testcontainers/build/generic-container/started-generic-container";
import path from "node:path";
import * as utils from "../e2e/setup/utils";
import { NetworkId, NoOpTransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { type DefaultConfiguration } from "@midnightntwrk/wallet-sdk-facade";
import { beforeAll, afterAll } from "vitest";

export const currentDir = path.resolve(new URL(import.meta.url).pathname, "..");
const logger = await utils.createLogger(
  path.resolve(currentDir, "..", "logs", "test-fixture", `${new Date().toISOString()}.log`),
);

export class TestContainersFixture {
  constructor(
    public readonly composeEnvironment: StartedDockerComposeEnvironment,
    private readonly uid: string,
  ) {}

  public async down() {
    await this.composeEnvironment.down();
  }

  public static readonly PROOF_SERVER_PORT = 6300;

  public static readonly NODE_PORT_RPC = 9944;

  public static readonly INDEXER_PORT = 8088;

  public static readonly FAUCET_PORT = 5300;

  public static readonly DROP_AMOUNT = 1000n; // matches config default dropAmount "1000"

  static readonly network = process.env.NETWORK as utils.MidnightNetwork;

  public getProofServerContainer(): StartedGenericContainer {
    return this.composeEnvironment.getContainer(`proof-server_${this.uid}`);
  }

  public getNodeContainer(): StartedGenericContainer {
    return this.composeEnvironment.getContainer(`node_${this.uid}`);
  }

  public getIndexerContainer(): StartedGenericContainer {
    return this.composeEnvironment.getContainer(`indexer_${this.uid}`);
  }

  public getFaucetContainer(): StartedGenericContainer {
    return this.composeEnvironment.getContainer(`faucet_${this.uid}`);
  }

  public getProverUri(): string {
    const proofServerPort = this.getProofServerContainer().getMappedPort(
      TestContainersFixture.PROOF_SERVER_PORT,
    );
    return `http://localhost:${proofServerPort}`;
  }

  private getIndexerPort(): number {
    return this.getIndexerContainer().getMappedPort(TestContainersFixture.INDEXER_PORT);
  }

  public getIndexerUri(): string {
    switch (TestContainersFixture.network) {
      case "preprod": {
        return "https://indexer.preprod.midnight.network/api/v4/graphql";
      }
      case "preview": {
        return "https://indexer.preview.midnight.network/api/v4/graphql";
      }
      case "qanet": {
        return "https://indexer.qanet.midnight.network/api/v4/graphql";
      }
      case "devnet": {
        return "https://indexer.devnet.midnight.network/api/v4/graphql";
      }
      case "stagenet": {
        return "https://indexer.stagenet.shielded.tools/api/v4/graphql";
      }
      case "undeployed": {
        const indexerPort = this.getIndexerPort();
        return `http://localhost:${indexerPort}/api/v4/graphql`;
      }
      default:
        throw new Error(`Unrecognized network: ${String(TestContainersFixture.network)}`);
    }
  }

  public getIndexerWsUri(): string {
    switch (TestContainersFixture.network) {
      case "preprod": {
        return "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";
      }
      case "preview": {
        return "wss://indexer.preview.midnight.network/api/v4/graphql/ws";
      }
      case "devnet": {
        return "wss://indexer.devnet.midnight.network/api/v4/graphql/ws";
      }
      case "qanet": {
        return "wss://indexer.qanet.midnight.network/api/v4/graphql/ws";
      }
      case "stagenet": {
        return "wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws";
      }
      case "undeployed": {
        const indexerPort = this.getIndexerPort();
        return `ws://localhost:${indexerPort}/api/v4/graphql/ws`;
      }
      default:
        throw new Error(`Unrecognized network: ${String(TestContainersFixture.network)}`);
    }
  }

  public getNodeUri(): string {
    switch (TestContainersFixture.network) {
      case "preprod": {
        return "wss://rpc.preprod.midnight.network";
      }
      case "preview": {
        return "wss://rpc.preview.midnight.network";
      }
      case "devnet": {
        return "wss://rpc.devnet.midnight.network";
      }
      case "qanet": {
        return "wss://rpc.qanet.midnight.network";
      }
      case "stagenet": {
        return "wss://rpc.stagenet.shielded.tools";
      }
      case "undeployed": {
        const nodePortRpc = this.getNodeContainer().getMappedPort(
          TestContainersFixture.NODE_PORT_RPC,
        );
        return `http://localhost:${nodePortRpc}`;
      }
      default:
        throw new Error(`Unrecognized network: ${String(TestContainersFixture.network)}`);
    }
  }

  public getFaucetUrl(): string {
    switch (TestContainersFixture.network) {
      case "preprod": {
        return "https://faucet.preprod.midnight.network";
      }
      case "preview": {
        return "https://faucet.preview.midnight.network";
      }
      case "devnet": {
        return "https://faucet.devnet.midnight.network";
      }
      case "qanet": {
        return "https://faucet.qanet.midnight.network";
      }
      case "stagenet": {
        return "https://faucet.stagenet.shielded.tools";
      }
      case "undeployed": {
        const faucetPort = this.getFaucetContainer().getMappedPort(
          TestContainersFixture.FAUCET_PORT,
        );
        return `http://localhost:${faucetPort}`;
      }
      default:
        throw new Error(`Unrecognized network: ${String(TestContainersFixture.network)}`);
    }
  }

  public getNetworkId(): NetworkId.NetworkId {
    switch (TestContainersFixture.network) {
      case "undeployed":
        return NetworkId.NetworkId.Undeployed;
      case "qanet":
        return NetworkId.NetworkId.QaNet;
      case "devnet":
        return NetworkId.NetworkId.DevNet;
      case "preview":
        return NetworkId.NetworkId.Preview;
      case "preprod":
        return NetworkId.NetworkId.PreProd;
      case "stagenet":
        return "stagenet";
      default:
        throw new Error(`Unrecognized network: ${String(TestContainersFixture.network)}`);
    }
  }

  public getWalletConfig(): DefaultConfiguration {
    return {
      indexerClientConnection: {
        indexerHttpUrl: this.getIndexerUri(),
        indexerWsUrl: this.getIndexerWsUri(),
      },
      provingServerUrl: new URL(this.getProverUri()),
      relayURL: new URL(this.getNodeUri()),
      networkId: this.getNetworkId(),
      costParameters: {
        feeBlocksMargin: 5,
      },
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
    };
  }
}

export function useTestContainersFixture() {
  let fixture: TestContainersFixture | undefined;

  beforeAll(async () => {
    logger.info(`Spinning up ${process.env.NETWORK} test environment...`);
    const uid = Math.floor(Math.random() * 1000).toString();
    let composeEnvironment: StartedDockerComposeEnvironment;
    switch (process.env.NETWORK) {
      case "undeployed": {
        composeEnvironment = await new DockerComposeEnvironment("./", "docker-compose-dynamic.yml")
          .withWaitStrategy(`proof-server_${uid}`, Wait.forListeningPorts())
          .withWaitStrategy(`node_${uid}`, Wait.forListeningPorts())
          .withWaitStrategy(`indexer_${uid}`, Wait.forListeningPorts())
          .withWaitStrategy(`db_${uid}`, Wait.forHealthCheck())
          .withWaitStrategy(`faucet_${uid}`, Wait.forHealthCheck())
          .withEnvironment({ TESTCONTAINERS_UID: uid })
          .withStartupTimeout(300_000)
          .up();
        break;
      }
      case "devnet":
      case "qanet":
      case "preview":
      case "preprod":
      case "stagenet": {
        composeEnvironment = await new DockerComposeEnvironment(
          "./",
          "docker-compose-proof-server-dynamic.yml",
        )
          .withWaitStrategy(
            `proof-server_${uid}`,
            Wait.forLogMessage("Actix runtime found; starting in Actix runtime"),
          )
          .withEnvironment({ TESTCONTAINERS_UID: uid, NETWORK_ID: process.env.NETWORK })
          .withStartupTimeout(120_000)
          .up();
        break;
      }
      default: {
        logger.warn(`Unrecognized network: ${process.env.NETWORK}`);
        exit(1);
      }
    }
    logger.info("Test environment started");
    fixture = new TestContainersFixture(composeEnvironment, uid);
  }, 600_000);

  afterAll(async () => {
    logger.info("Tearing down test environment...");
    await fixture?.down();
    logger.info("Test environment torn down");
  }, 60_000);

  return () => fixture!;
}
