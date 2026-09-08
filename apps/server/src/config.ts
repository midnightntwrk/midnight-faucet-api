/* eslint-disable @typescript-eslint/restrict-template-expressions */
/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import convict from "convict";
import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { availableFormats, availableLevels, LoggingConfig } from "./logging.js";
import { PostgresqlConfig } from "./postgres.js";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { TaskManagerConfig } from "./TaskManager.js";

convict.addFormat({
  name: "faucet-hex-string",
  validate(val) {
    if (
      typeof val === "string" &&
      val.length > 0 &&
      Buffer.from(val, "hex").toString("hex") === val
    ) {
      return true;
    } else {
      throw new Error("Expected a non-empty hex string");
    }
  },
  coerce(val) {
    if (typeof val === "string") {
      return val;
    }
    throw new Error("Expected a hex string");
  },
});

convict.addFormat({
  name: "faucet-url",
  validate(val) {
    if (typeof val === "string") {
      return new URL(val);
    } else if (val instanceof URL) {
      return val;
    }

    throw new Error("Expected an URL");
  },
  coerce(val) {
    return new URL(val).toString();
  },
});

convict.addFormat({
  name: "faucet-path",
  validate(val) {
    if (typeof val === "string" && path.isAbsolute(val) && fs.statSync(val).isDirectory()) {
      return true;
    } else {
      throw new Error("Expected an absolute path to an existing directory");
    }
  },
});

export type RateLimitConfig = Readonly<{
  /**
   * The maximum daily number of requests per address.
   */
  maxDailyRequests: number;
}>;

export interface ThirdPartyApiConfig {
  allowedOrigins: string[];
  /**
   * Whether the `Origin` allow-list is enforced. Off by default — a
   * server-to-server caller sends no `Origin` header at all.
   */
  requireOrigin: boolean;
  /** The single `network` literal this deployment answers for. */
  network: string;
  /** The single `token` literal this deployment answers for. */
  token: string;
  /**
   * Largest amount a single third-party request may ask for, in the token's
   * smallest denomination — the unit the third-party API speaks throughout.
   */
  maxAmount: string;
  /** Dispensed when a third-party request omits `amount`, same denomination. */
  defaultAmount: string;
  apiKey: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  metricsPort: number;
  dropAmount: string;
  jwtIssuer: string;
  jwtSignSecret: Buffer;
  walletSeed: Buffer;
  targetCoinNumber: number;
  targetCoinSizeFactor: bigint;
  numberOfOutputs: number;
  networkId: NetworkId.NetworkId;
  printConfig: boolean;
  uiPath: string;
  db: PostgresqlConfig;
  urls: {
    node: URL;
    indexer: URL;
    provingServer: URL;
  };
  rateLimiting: RateLimitConfig;
  logging: LoggingConfig;
  tasks: TaskManagerConfig;
  encryptionKey: Buffer;
  identifier: string;
  turnstileKey: string;
  turnstileHeader: string;
  thirdPartyApi: ThirdPartyApiConfig;
}

/**
 * Amounts crossing the third-party API are integer strings in the token's
 * smallest denomination, kept as strings so a value beyond `Number.MAX_SAFE_INTEGER`
 * survives the trip into `bigint` intact.
 */
const amountInSmallestDenomination = (value: string, name: string): string => {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Expected '${name}' to be a non-negative integer string, got '${value}'`);
  }
  return value;
};

export const schema = {
  host: {
    doc: "Host to expose the server on",
    default: "127.0.0.1",
    env: "FAUCET_HOST",
    arg: "host",
  },
  port: {
    doc: "Port, on which the server will be listening",
    default: 5300,
    format: "port",
    env: "FAUCET_PORT",
    arg: "port",
  },
  metricsPort: {
    doc: "Port, on which the metrics server will be listening",
    default: 9696,
    format: "port",
    env: "FAUCET_METRICS_PORT",
    arg: "metrics-port",
  },
  dropAmount: {
    doc: "Amount of tokens provided in a single request",
    format: String,
    default: "5000000000", // 1000_000_000n tNight
    env: "DROP_AMOUNT",
    arg: "drop-amount",
  },
  encryptionKey: {
    doc: "Key for state encryption",
    format: "faucet-hex-string",
    default: "",
    env: "ENCRYPTION_KEY",
    arg: "encryption-key",
  },
  walletSeed: {
    doc: "Secret seed of wallet used for faucet",
    format: "faucet-hex-string",
    default: "0000000000000000000000000000000000000000000000000000000000000001",
    env: "WALLET_SEED",
    arg: "wallet-seed",
  },
  targetCoinNumber: {
    doc: "Target number of coins managed by faucet. Effectively - the bigger the number, the more parallelism for building transactions is allowed",
    format: "nat",
    default: 6,
    env: "TARGET_COIN_NUMBER",
    arg: "target-coin-number",
  },
  targetCoinSizeFactor: {
    doc: "How many 'dropAmount' should fit into new coins created to meet 'targetCoinNumber'",
    format: BigInt,
    default: 100,
    env: "TARGET_COIN_SIZE_FACTOR",
    arg: "target-coin-size-factor",
  },
  numberOfOutputs: {
    doc: "Number of outputs faucet creates in each transaction (can lead into balancing issues if too high)",
    format: "nat",
    default: 1,
    env: "OUTPUTS",
    arg: "outputs",
  },
  networkId: {
    doc: "Network to be used",
    format: String,
    default: NetworkId.NetworkId.Undeployed,
    env: "NETWORK_ID",
    arg: "network-id",
  },
  jwtIssuer: {
    doc: "Value of 'iss' field in created JWTs",
    format: String,
    default: "Midnight Faucet",
    env: "JWT_ISSUER",
    arg: "jwt-issuer",
  },
  jwtSignSecret: {
    doc: "Secret to use for signing JWTs",
    format: "faucet-hex-string",
    default: "",
    env: "JWT_SIGN_SECRET",
    arg: "jwt-sign-secret",
  },
  printConfig: {
    doc: "Whether to print a complete config on startup",
    format: Boolean,
    default: false,
    env: "PRINT_CONFIG",
    arg: "print-config",
  },
  uiPath: {
    doc: "An absolute path, where UI bundle is located",
    format: "faucet-path",
    default: path.resolve(new URL(import.meta.url).pathname, "..", "..", "..", "ui", "dist"),
    env: "UI_PATH",
    arg: "ui-path",
  },
  maxBackgroundTasks: {
    doc: "Number indicating how many token requests might be tracked at once. Note: it is only about tracking, as actual execution is a separate topic",
    format: "int",
    default: 1000,
    env: "MAX_BACKGROUND_TASKS",
    arg: "max-background-tasks",
  },
  db: {
    host: {
      doc: "Host, which runs database",
      format: String,
      default: "localhost",
      env: "DB_HOST",
      arg: "db-host",
    },
    port: {
      doc: "Port, on which database can be found",
      format: "port",
      default: 5432,
      env: "DB_PORT",
      arg: "db-port",
    },
    database: {
      doc: "Database name",
      format: String,
      default: "faucet",
      env: "DB_NAME",
      arg: "db-name",
    },
    password: {
      doc: "Password to authenticate database user",
      format: String,
      default: "mysecretpassword",
      env: "DB_PASSWORD",
      arg: "db-password",
    },
    user: {
      doc: "Database user",
      format: String,
      default: "faucet",
      env: "DB_USER",
      arg: "db-user",
    },
    ssl: {
      doc: "Whether to use SSL for encrypted connection",
      format: Boolean,
      default: false,
      env: "DB_SSL",
      arg: "db-ssl",
    },
    sslRejectUnauthorized: {
      doc: "Whether to reject unauthorized SSL certificates. Set to false only for self-signed certificates.",
      format: Boolean,
      default: true,
      env: "DB_SSL_REJECT_UNAUTHORIZED",
      arg: "db-ssl-reject-unauthorized",
    },
  },
  urls: {
    node: {
      doc: "URL to node RPC",
      format: "faucet-url",
      default: "http://localhost:9944",
      env: "NODE_URL",
      arg: "node-url",
    },
    indexer: {
      doc: "URL to indexer query API",
      format: "faucet-url",
      default: "http://localhost:8088/api/v3/graphql",
      env: "INDEXER_URL",
      arg: "indexer-url",
    },
    provingServer: {
      doc: "URL to proving server API",
      format: "faucet-url",
      default: "http://localhost:6300",
      env: "PROVING_SERVER_URL",
      arg: "proving-server-url",
    },
  },
  rateLimiting: {
    maxDailyRequests: {
      doc: "Maximum daily number of requests per address",
      format: Number,
      default: 25,
      env: "RATE_LIMITING_MAX_DAILY",
      arg: "rate-limiting-max-daily",
    },
  },
  logging: {
    level: {
      doc: "Level of logs",
      format: availableLevels,
      default: "trace",
      env: "LOG_LEVEL",
      arg: "log-level",
    },
    format: {
      doc: "Format of logs",
      format: Object.values(availableFormats),
      default: "json",
      env: "LOG_FORMAT",
      arg: "log-format",
    },
  },
  tasks: {
    maxStoredResults: {
      doc: "Number of task results kept in memory. (Note: Applies only if using in-memory-only task repository)",
      format: "nat",
      default: 10_000,
      env: "MAX_STORED_TASK_RESULTS",
      arg: "max-stored-task-results",
    },
    maxConcurrentTasks: {
      doc: "Maximum number of allowed concurrent tasks",
      format: "nat",
      default: 1,
      env: "MAX_CONCURRENT_TASKS",
      arg: "max-concurrent-tasks",
    },
    pollTime: {
      doc: "Time in milliseconds between polling for new tasks",
      format: "nat",
      default: 5000,
      env: "POLL_TIME",
      arg: "poll-time",
    },
  },
  identifier: {
    doc: "Identifier of the faucet",
    format: String,
    default: "faucet-1",
    env: "IDENTIFIER",
    arg: "identifier",
  },
  turnstileKey: {
    doc: "Cloudflare's Turnstile secret key",
    default: "1x0000000000000000000000000000000AA",
    format: String,
    env: "TURNSTILE_SECRET_KEY",
    arg: "turnstile-secret-key",
  },
  turnstileHeader: {
    doc: "Secret used to sign a turnstile header",
    format: String,
    default: "",
    env: "TURNSTILE_HEADER",
    arg: "turnstile-header",
  },
  thirdPartyApi: {
    allowedOrigins: {
      doc: "Comma-separated list of allowed origins for third-party API",
      format: String,
      default: "",
      env: "THIRD_PARTY_ALLOWED_ORIGINS",
      arg: "third-party-allowed-origins",
    },
    requireOrigin: {
      doc: "Enforce the origin allow-list on the third-party API (browser callers only)",
      format: Boolean,
      default: false,
      env: "THIRD_PARTY_REQUIRE_ORIGIN",
      arg: "third-party-require-origin",
    },
    network: {
      doc: "Network literal the third-party API accepts. Defaults to 'midnight_<networkId>'",
      format: String,
      default: "",
      env: "THIRD_PARTY_NETWORK",
      arg: "third-party-network",
    },
    token: {
      doc: "Token literal the third-party API accepts",
      format: String,
      default: "tNIGHT",
      env: "THIRD_PARTY_TOKEN",
      arg: "third-party-token",
    },
    maxAmount: {
      doc: "Maximum allowed drip amount, in the smallest denomination. Defaults to 'dropAmount'",
      format: String,
      default: "",
      env: "THIRD_PARTY_MAX_AMOUNT",
      arg: "third-party-max-amount",
    },
    defaultAmount: {
      doc: "Amount dispensed when a third-party request omits one, in the smallest denomination. Defaults to 'dropAmount'",
      format: String,
      default: "",
      env: "THIRD_PARTY_DEFAULT_AMOUNT",
      arg: "third-party-default-amount",
    },
    apiKey: {
      doc: "API key for third-party API authentication",
      format: String,
      default: "",
      env: "THIRD_PARTY_API_KEY",
      arg: "third-party-api-key",
      sensitive: true,
    },
  },
} as const;

const configSources = [
  { type: "path", path: path.resolve(process.cwd(), "config.json5") },
  { type: "env", variableName: "FAUCET_CONFIG_FILE" },
] as const;

/* eslint-disable no-console -- let this function log */
export const loadConfig = (): ServerConfig => {
  const initialConfig = convict(schema);

  const config = configSources
    .reduce((prev, source) => {
      switch (source.type) {
        case "path":
          console.log(`Loading path ${source.path}`);
          if (fs.existsSync(source.path)) {
            return prev.loadFile(source.path);
          }
          return prev;

        case "env":
          console.log(`Loading file from ${source.variableName} environment variable`);
          // eslint-disable-next-line no-case-declarations
          const value = process.env[source.variableName];
          if (value !== undefined) {
            return prev.loadFile(value);
          }
          return prev;
      }
    }, initialConfig)
    .validate();

  const finalConfig: ServerConfig = {
    host: config.get("host"),
    port: config.get("port"),
    metricsPort: config.get("metricsPort"),
    dropAmount: config.get("dropAmount"),
    encryptionKey: Buffer.from(config.get("encryptionKey"), "hex"),
    walletSeed: Buffer.from(config.get("walletSeed") as string, "hex"),
    targetCoinNumber: config.get("targetCoinNumber"),
    targetCoinSizeFactor: BigInt(config.get("targetCoinSizeFactor")),
    numberOfOutputs: config.get("numberOfOutputs"),
    networkId: config.get("networkId"),
    jwtSignSecret: Buffer.from(config.get("jwtSignSecret"), "hex"),
    jwtIssuer: config.get("jwtIssuer"),
    printConfig: config.get("printConfig"),
    uiPath: config.get("uiPath"),
    identifier: config.get("identifier"),
    db: {
      host: config.get("db.host"),
      database: config.get("db.database"),
      port: config.get("db.port"),
      password: config.get("db.password"),
      user: config.get("db.user"),
      ssl: config.get("db.ssl")
        ? {
            rejectUnauthorized: config.get("db.sslRejectUnauthorized"),
            ca: fs
              .readFileSync(path.resolve(import.meta.dirname, "..", "certs", "rds-ca-bundle.pem"))
              .toString(),
          }
        : false,
    },
    urls: {
      node: new URL(config.get("urls.node")),
      indexer: new URL(config.get("urls.indexer")),
      provingServer: new URL(config.get("urls.provingServer")),
    },
    rateLimiting: {
      maxDailyRequests: config.get("rateLimiting.maxDailyRequests"),
    },
    logging: {
      format: config.get("logging.format"),
      level: config.get("logging.level"),
    },
    tasks: {
      maxStoredResults: config.get("tasks.maxStoredResults"),
      maxConcurrentTasks: config.get("tasks.maxConcurrentTasks"),
      pollTime: config.get("tasks.pollTime"),
    },
    turnstileKey: config.get("turnstileKey"),
    turnstileHeader: config.get("turnstileHeader"),
    thirdPartyApi: {
      allowedOrigins: config
        .get("thirdPartyApi.allowedOrigins")
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0),
      requireOrigin: config.get("thirdPartyApi.requireOrigin"),
      network:
        config.get("thirdPartyApi.network") ||
        `midnight_${String(config.get("networkId")).toLowerCase()}`,
      token: config.get("thirdPartyApi.token"),
      maxAmount: amountInSmallestDenomination(
        config.get("thirdPartyApi.maxAmount") || config.get("dropAmount"),
        "thirdPartyApi.maxAmount",
      ),
      defaultAmount: amountInSmallestDenomination(
        config.get("thirdPartyApi.defaultAmount") || config.get("dropAmount"),
        "thirdPartyApi.defaultAmount",
      ),
      apiKey: config.get("thirdPartyApi.apiKey"),
    },
  };

  if (finalConfig.printConfig) {
    console.log("Config loaded:");
    console.log({
      ...finalConfig,
      urls: {
        node: `URL<${finalConfig.urls.node.toString()}>`,
        indexer: `URL<${finalConfig.urls.indexer.toString()}>`,
        provingServer: `URL<${finalConfig.urls.provingServer.toString()}>`,
      },
    });
  }

  return finalConfig;
};
/* eslint-enable no-console */

export const configHelp = () => {
  const isSchemaObj = <T>(arg: unknown): arg is convict.SchemaObj<T> & { arg: string } => {
    return typeof arg === "object" && arg != null && "default" in arg;
  };

  const getArgs = <S, T extends convict.Schema<S>>(aSchema: T): string[] =>
    Object.entries(aSchema).flatMap(([key, value]) => {
      if (isSchemaObj(value)) {
        return [
          `--${value.arg.padEnd(34, " ")}${value.doc}
      ${value.default != null ? `default:\t\t\t${value.default}` : "required"}
      env variable:\t\t\t${value.env}
      json key:\t\t\t${key}\n`,
        ];
      } else {
        return getArgs(value as convict.Schema<unknown>);
      }
    });
  const args = getArgs(schema);

  const sources = configSources.map((src) => {
    switch (src.type) {
      case "env":
        return `- File path set by environment variable ${src.variableName}`;
      case "path":
        return `- File ${src.path}`;
    }
  });

  return [...args, "Additionally, configuration is loaded from:", ...sources].join("\n");
};
