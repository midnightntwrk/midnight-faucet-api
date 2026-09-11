import { ValuesOf } from "@midnightntwrk/faucet-utils";
import pino from "pino";
import pinoPretty from "pino-pretty";

export const availableLevels = ["error", "warn", "info", "debug", "trace"] as const;
export const availableFormats = { pretty: "pretty", json: "json" } as const;

export type LoggingConfig = {
  format: ValuesOf<typeof availableFormats>;
  level: Exclude<pino.Level, "fatal">;
};

const buildOpenTelemetryLoggingOptions: () => Partial<pino.LoggerOptions> = () => ({
  // Create levels that map to the Open Telemetry severity levels:
  // https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/pkg/stanza/docs/types/severity.md
  customLevels: {
    fatal: 21,
    error: 17,
    warn: 13,
    info: 9,
    debug: 5,
    trace: 1,
  },
  useOnlyCustomLevels: true, // Override `pino`s defaults
});

export const createLogger = (config: LoggingConfig): pino.Logger => {
  const cfg: pino.LoggerOptions = {
    level: config.level,
    ...buildOpenTelemetryLoggingOptions(),
  };
  switch (config.format) {
    case "json":
      return pino(cfg);
    case "pretty":
      return pino(
        {
          ...cfg,
          // Write out the level label when using the `'pretty'` format.
          formatters: {
            level: (level: string) => ({ level }),
          },
        },
        pinoPretty({ colorize: true }),
      );
  }
};
