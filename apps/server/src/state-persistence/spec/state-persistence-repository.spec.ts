import type { Knex } from "knex";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { PostgresqlStateSnapshotsRepository } from "../state-persistence-repository.js";

const state = {
  shielded: "shielded-state",
  unshielded: "unshielded-state",
  dust: "dust-state",
};

const failure = new Error("canceling statement due to statement timeout");

// Type cast required because: only the one query each method builds is
// reached, and the success paths are covered against a real database in
// `serialize-and-save-state.spec.ts` / `get-and-deserialize-state.spec.ts`.
// Building a full `Knex` just to reject is not worth it, and these assertions
// must run without Docker.
const saveFails = (): Knex<object> =>
  ({ transaction: () => Promise.reject(failure) }) as unknown as Knex<object>;

const readFails = (): Knex<object> =>
  (() => ({
    where: () => ({
      orderBy: () => ({ first: () => Promise.reject(failure) }),
    }),
  })) as unknown as Knex<object>;

describe("PostgresqlStateSnapshotsRepository", () => {
  describe("saveState", () => {
    it("rejects with the original error so the caller can record the failure", async () => {
      const repository = new PostgresqlStateSnapshotsRepository(saveFails(), "faucet-1");

      await expect(repository.saveState(state)).rejects.toBe(failure);
    });
  });

  describe("getState", () => {
    // Unlike `saveState`, a read failure is swallowed — `undefined` means "no
    // snapshot to restore from", and the faucet starts fresh. That makes this
    // the one place the error is reported, so the key it is logged under is
    // the difference between a usable log line and `{"code":"57014"}`.
    it("logs the failure under `err` so pino serializes the Postgres message", async () => {
      const repository = new PostgresqlStateSnapshotsRepository(readFails(), "faucet-1");
      const errorLog = vi.fn();
      // Type cast required because: the repository only calls `logger.error`.
      const logger = { error: errorLog } as unknown as pino.Logger;

      await expect(repository.getState(logger)).resolves.toBeUndefined();

      expect(errorLog).toHaveBeenCalledTimes(1);
      const [fields] = errorLog.mock.calls[0] as [{ err?: unknown; error?: unknown }];
      expect(fields.err).toBe(failure);
      expect(fields.error).toBeUndefined();
    });
  });
});
