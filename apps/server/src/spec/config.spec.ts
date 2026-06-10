import convict from "convict";
import { configHelp, loadConfig, schema, ServerConfig } from "../config.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((path: unknown, ...args: unknown[]) => {
      if (String(path).endsWith("rds-ca-bundle.pem")) {
        return "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----";
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
    }),
  };
});

describe("config", () => {
  describe("DB_SSL ca cert", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("includes ca cert in ssl options when DB_SSL=true", () => {
      vi.stubEnv("DB_SSL", "true");

      const config = loadConfig();

      expect((config.db.ssl as Record<string, unknown>).ca).toBe(
        "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----",
      );
    });

    it("does not include ca cert when DB_SSL=false", () => {
      vi.stubEnv("DB_SSL", "false");

      const config = loadConfig();

      expect(config.db.ssl).toBe(false);
    });
  });
  describe("help", () => {
    it("mentions every bit of configuration schema", () => {
      const loadedConfig = loadConfig();
      const nestedFields: Set<string> = new Set([
        "db",
        "rateLimiting",
        "urls",
        "logging",
        "tasks",
        "thirdPartyApi",
      ]);
      const help = configHelp();

      const checkConfigEntry = (key: string, entry: convict.SchemaObj<unknown>) => {
        expect(help).toContain(entry.doc);
        expect(help).toContain(entry.env);
        expect(help).toContain(entry.arg);
        expect(help).toContain(key);
      };

      (Object.keys(loadedConfig) as Array<keyof ServerConfig>)
        .filter((key) => !nestedFields.has(key))
        .forEach((key) => {
          checkConfigEntry(key, schema[key] as convict.SchemaObj<unknown>);
        });

      (nestedFields as Set<keyof ServerConfig>).forEach((topKey) => {
        Object.keys(loadedConfig[topKey]).forEach((key) => {
          checkConfigEntry(
            key,
            (schema[topKey] as Record<string, convict.SchemaObj<unknown>>)[key],
          );
        });
      });
    });
  });
});
