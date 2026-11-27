import type { Knex } from "knex";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence-repository.js";

const state = {
  shielded: "shielded-state",
  unshielded: "unshielded-state",
  dust: "dust-state",
};

// Type cast required because: `saveState` only reaches `knex.transaction`, and
// the success path is covered against a real database in
// `serialize-and-save-state.spec.ts`. Building a full `Knex` just to reject is
// not worth it, and these assertions must run without Docker.
const knexThatFails = (failure: Error): Knex<object> =>
  ({ transaction: () => Promise.reject(failure) }) as unknown as Knex<object>;

describe("PostgresqlStateSnapshotsRepository.saveState", () => {
  const failure = new Error("canceling statement due to statement timeout");

  it("rejects with the original error so the caller can record the failure", async () => {
    const repository = new PostgresqlStateSnapshotsRepository(knexThatFails(failure), "faucet-1");
    const logger = pino({ level: "silent" });

    await expect(repository.saveState({ logger, ...state })).rejects.toBe(failure);
  });

  it("logs the failure under `err` so pino serializes the Postgres message", async () => {
    const repository = new PostgresqlStateSnapshotsRepository(knexThatFails(failure), "faucet-1");
    const errorLog = vi.fn();
    // Type cast required because: the repository only calls `logger.error`.
    const logger = { error: errorLog } as unknown as pino.Logger;

    await expect(repository.saveState({ logger, ...state })).rejects.toBe(failure);

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [fields] = errorLog.mock.calls[0] as [{ err?: unknown; error?: unknown }];
    expect(fields.err).toBe(failure);
    // Under `error` pino drops the non-enumerable `message`, which is what hid
    // the real Postgres error in the incident behind #77.
    expect(fields.error).toBeUndefined();
  });
});
