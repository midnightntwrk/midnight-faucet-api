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
  describe("third-party amounts", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("defaults both the cap and the default drip to DROP_AMOUNT", () => {
      vi.stubEnv("DROP_AMOUNT", "5000000000");

      const config = loadConfig();

      expect(config.thirdPartyApi.maxAmount).toBe("5000000000");
      expect(config.thirdPartyApi.defaultAmount).toBe("5000000000");
    });

    it("rejects a cap below the advertised default drip", () => {
      vi.stubEnv("DROP_AMOUNT", "5000000000");
      // The value every faucet overlay carried from before the unit change:
      // 1000 whole tNIGHT read as 1000 base units.
      vi.stubEnv("THIRD_PARTY_MAX_AMOUNT", "1000");

      expect(() => loadConfig()).toThrow(/maxAmount.*at least.*defaultAmount/s);
    });

    it("accepts a cap above the default drip", () => {
      vi.stubEnv("DROP_AMOUNT", "5000000000");
      vi.stubEnv("THIRD_PARTY_MAX_AMOUNT", "10000000000");

      const config = loadConfig();

      expect(config.thirdPartyApi.maxAmount).toBe("10000000000");
      expect(config.thirdPartyApi.defaultAmount).toBe("5000000000");
    });

    it("accepts a cap equal to the default drip", () => {
      vi.stubEnv("DROP_AMOUNT", "5000000000");
      vi.stubEnv("THIRD_PARTY_MAX_AMOUNT", "5000000000");

      expect(loadConfig().thirdPartyApi.maxAmount).toBe("5000000000");
    });

    it("rejects a default drip above an explicit cap", () => {
      vi.stubEnv("THIRD_PARTY_MAX_AMOUNT", "1000");
      vi.stubEnv("THIRD_PARTY_DEFAULT_AMOUNT", "2000");

      expect(() => loadConfig()).toThrow(/maxAmount.*at least.*defaultAmount/s);
    });

    it("compares amounts beyond Number.MAX_SAFE_INTEGER exactly", () => {
      vi.stubEnv("THIRD_PARTY_MAX_AMOUNT", "9007199254740993");
      vi.stubEnv("THIRD_PARTY_DEFAULT_AMOUNT", "9007199254740992");

      expect(loadConfig().thirdPartyApi.maxAmount).toBe("9007199254740993");
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
