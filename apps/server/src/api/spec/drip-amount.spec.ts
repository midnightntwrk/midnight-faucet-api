import { describe, it, expect, vi, afterEach } from "vitest";
import * as express from "express";
import * as http from "node:http";
import pino from "pino";
import { NetworkId } from "@midnightntwrk/wallet-sdk-abstractions";
import { createDripRoutes, resolveDripAmount, type DripRouteDeps } from "../drip-routes.js";
import { STARS_PER_NIGHT } from "../../units.js";

/** The default `dropAmount` from config.ts: 5,000 tNIGHT in STAR. */
const DROP_AMOUNT = 5_000_000_000n;
const ADDRESS = "mn_addr_undeployed1qpfkp8dd8xpv57t3sf0p5cex8a37qz40kjlz7hke3aq6mfk2pkyshz6pq0";

/**
 * The public route's `amount` is whole tNIGHT: a request for 1000 dispenses
 * 1000 tNIGHT. It once multiplied by a `TNIGHT_UNIT` of 5_000_000 STAR — an
 * undocumented unit of 5 tNIGHT — so 1000 registered a drip of 5,000
 * (shieldedtech/mnf-stl-support#370).
 */
describe("resolveDripAmount", () => {
  it("dispenses the tNIGHT asked for, not five times it", () => {
    expect(resolveDripAmount(1000n, DROP_AMOUNT)).toBe(1_000_000_000n);
  });

  it("scales by STARS_PER_NIGHT and nothing else", () => {
    expect(resolveDripAmount(2000n, DROP_AMOUNT)).toBe(2000n * STARS_PER_NIGHT);
  });

  it("allows the ceiling exactly", () => {
    expect(resolveDripAmount(5000n, DROP_AMOUNT)).toBe(DROP_AMOUNT);
  });

  it("refuses more than the deployment's own drip", () => {
    expect(() => resolveDripAmount(5001n, DROP_AMOUNT)).toThrow(
      "Must be between 1 and 5000 tNIGHT",
    );
  });

  it("refuses zero and negatives rather than dispensing nothing", () => {
    expect(() => resolveDripAmount(0n, DROP_AMOUNT)).toThrow("Invalid amount");
    expect(() => resolveDripAmount(-1n, DROP_AMOUNT)).toThrow("Invalid amount");
  });

  it("tracks the configured dropAmount rather than a hardcoded ceiling", () => {
    const smallDrop = 250n * STARS_PER_NIGHT;
    expect(resolveDripAmount(250n, smallDrop)).toBe(smallDrop);
    expect(() => resolveDripAmount(251n, smallDrop)).toThrow("Must be between 1 and 250 tNIGHT");
  });
});

describe("POST /drips amount", () => {
  let server: http.Server;

  const listen = async (registerTask: unknown, dropAmount = DROP_AMOUNT): Promise<string> => {
    const deps = {
      taskManager: { registerTask },
      taskRepository: {},
      // The drip path checks the daily limit before registering. A count of 0
      // updated now keeps every request under the limit, so these tests see
      // only the amount logic.
      rateCountRepository: {
        get: vi.fn().mockResolvedValue({ address: ADDRESS, count: 0, updated_at: new Date() }),
        increment: vi.fn().mockResolvedValue(undefined),
        reset: vi.fn().mockResolvedValue(undefined),
      },
      maxDailyRequests: 25,
      healthService: {},
      syncStuckDetector: { needsRestart: false, start: vi.fn(), stop: vi.fn(), check: vi.fn() },
      logger: pino({ level: "silent" }),
      networkId: NetworkId.NetworkId.Undeployed,
      dropAmount,
      // Type cast required because: the drip path touches only `taskManager`
      // and `rateCountRepository`, and the real repositories would each need a
      // live knex connection.
    } as unknown as DripRouteDeps;

    const app = express.default();
    app.use(express.json());
    app.use(createDripRoutes(deps));
    return new Promise<string>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  };

  const registered = () =>
    vi
      .fn()
      .mockResolvedValue({ _tag: "registered", taskId: "00000000-0000-4000-8000-000000000000" });

  const post = (baseUrl: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/drips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("registers 1000 tNIGHT for a request that asks for 1000", async () => {
    const registerTask = registered();
    const baseUrl = await listen(registerTask);

    const response = await post(baseUrl, { recipientAddress: ADDRESS, amount: "1000" });

    expect(response.status).toBe(200);
    expect(registerTask).toHaveBeenCalledWith(ADDRESS, 1_000_000_000n);
  });

  it("registers the whole dropAmount for the 5000 the page sends", async () => {
    const registerTask = registered();
    const baseUrl = await listen(registerTask);

    const response = await post(baseUrl, { recipientAddress: ADDRESS, amount: "5000" });

    expect(response.status).toBe(200);
    expect(registerTask).toHaveBeenCalledWith(ADDRESS, DROP_AMOUNT);
  });

  it("answers 400 when no amount is named, rather than guessing one", async () => {
    const registerTask = registered();
    const baseUrl = await listen(registerTask);

    const response = await post(baseUrl, { recipientAddress: ADDRESS });

    expect(response.status).toBe(400);
    expect(registerTask).not.toHaveBeenCalled();
  });

  it("answers 400 and registers nothing for an amount above the drop", async () => {
    const registerTask = registered();
    const baseUrl = await listen(registerTask);

    const response = await post(baseUrl, { recipientAddress: ADDRESS, amount: "5001" });

    expect(response.status).toBe(400);
    expect(registerTask).not.toHaveBeenCalled();
  });

  it("answers 400 for an amount that is not an integer string", async () => {
    const registerTask = registered();
    const baseUrl = await listen(registerTask);

    const response = await post(baseUrl, { recipientAddress: ADDRESS, amount: "1.5" });

    expect(response.status).toBe(400);
    expect(registerTask).not.toHaveBeenCalled();
  });
});
