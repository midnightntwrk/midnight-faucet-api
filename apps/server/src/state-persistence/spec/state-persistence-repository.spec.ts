import type { Knex } from "knex";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence-repository.js";

const state = {
  shielded: "shielded-state",
  unshielded: "unshielded-state",
  dust: "dust-state",
};

// Minimal knex stand-in: `saveState` only uses `knex.transaction`, whose
// callback receives a `trx` that is itself called as `trx(table)`.
type RunTransaction = (callback: (trx: unknown) => Promise<unknown>) => Promise<unknown>;

const makeKnex = (runTransaction: RunTransaction): Knex<object> =>
  ({ transaction: runTransaction }) as unknown as Knex<object>;

const succeedingKnex = (): Knex<object> => {
  const trx = () => ({
    insert: () => ({
      returning: () => Promise.resolve([{ id: 42 }]),
    }),
    where: () => ({
      whereNot: () => ({
        delete: () => Promise.resolve(1),
      }),
    }),
  });
  return makeKnex((callback) => callback(trx));
};

const failingKnex = (failure: Error): Knex<object> => makeKnex(() => Promise.reject(failure));

describe("PostgresqlStateSnapshotsRepository.saveState", () => {
  it("resolves with the inserted row id when the write succeeds", async () => {
    const repository = new PostgresqlStateSnapshotsRepository(succeedingKnex(), "faucet-1");
    const logger = pino({ level: "silent" });

    await expect(repository.saveState({ logger, ...state })).resolves.toEqual({ id: 42 });
  });

  it("rejects when the database write fails, so callers can record the failure", async () => {
    const failure = new Error("canceling statement due to statement timeout");
    const repository = new PostgresqlStateSnapshotsRepository(failingKnex(failure), "faucet-1");
    const logger = pino({ level: "silent" });

    await expect(repository.saveState({ logger, ...state })).rejects.toBe(failure);
  });

  it("logs the failure under `err` so pino serializes the error message", async () => {
    const failure = new Error("canceling statement due to statement timeout");
    const repository = new PostgresqlStateSnapshotsRepository(failingKnex(failure), "faucet-1");
    const errorLog = vi.fn();
    const logger = { error: errorLog } as unknown as pino.Logger;

    await expect(repository.saveState({ logger, ...state })).rejects.toBe(failure);

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [fields] = errorLog.mock.calls[0] as [{ err?: unknown; error?: unknown }];
    expect(fields.err).toBe(failure);
    expect(fields.error).toBeUndefined();
  });
});
