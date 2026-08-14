import * as nodeCrypto from "node:crypto";
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { option } from "fp-ts";
import pino from "pino";
import { PostgresqlRateCountRepository, type RateCountType } from "../rate-counts-repository.js";

export type RateCountsRepositorySpecContext<T = unknown> = {
  infrastructure: (logger: pino.Logger) => Resource<T>;
  instance: (infrastructure: T) => Resource<PostgresqlRateCountRepository>;
};
export function runRateCountsRepositorySuite<T>(context: RateCountsRepositorySpecContext<T>) {
  describe("Rate Counts Repository", () => {
    const createAddress = () => nodeCrypto.randomBytes(64).toString("hex");
    let infrastructure: T;
    let infrastructureTeardown: Task<void>;

    beforeAll(async () => {
      const allocated = await Task.unsafeRun(
        Resource.allocate(context.infrastructure(pino({ level: "silent" }))),
      );
      infrastructure = allocated.value;
      infrastructureTeardown = allocated.teardown;
    });

    afterAll(async () => {
      await Task.unsafeRun(infrastructureTeardown);
    });

    describe("get", () => {
      it("should create a RateCount if not already present for an address", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({
                  address,
                  count: 0,
                }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });
    });

    describe("increment", () => {
      it("should create and initialize a RateCount if not already present for an address", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.increment(address);
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({
                  address,
                  count: 1,
                }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should increment the count by one", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({
                  address,
                  count: 0,
                }),
              );
              await repo.increment(address);
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({
                  address,
                  count: 1,
                }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should return the window anchor it wrote", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              // The anchor a caller has to keep in order to refund later must be
              // the row's own `updated_at`, not an app-clock guess: `decrement`
              // compares it against the stored value and refuses anything else.
              const anchor = await repo.increment(address);
              expect(anchor).toEqual((await repo.get(address)).updated_at);
            }),
          ),
          Task.unsafeRun,
        );
      });
    });

    describe("reset", () => {
      it("should reset a count to zero", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.increment(address);
              expect(await repo.reset(address)).toEqual(
                expect.objectContaining({
                  address,
                  count: 0,
                }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should return a zeroed row for an address it has never seen", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              // The day-rollover path resets before the first reservation of the
              // new day, so it routinely resets a row it just created — which is
              // already at zero and must not be written again.
              expect(await repo.reset(address)).toEqual(
                expect.objectContaining({ address, count: 0 }),
              );
              expect(await repo.find(address)).toEqual(
                option.some(expect.objectContaining({ address, count: 0 })),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });
    });

    describe("decrement", () => {
      it("should refund a slot reserved in the current window", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.increment(address);
              await repo.increment(address);
              await repo.decrement(address, new Date());
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({ address, count: 1 }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should no-op when the slot belongs to an earlier window (#595)", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.increment(address); // count=1, window = today
              const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
              await repo.decrement(address, twoDaysAgo);
              // Today's counter must be untouched — the slot was reserved earlier.
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({ address, count: 1 }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should not create a row for an address that never reserved a slot (#595)", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              // Nothing was reserved, so there is no slot to hand back. Creating a
              // row here would anchor a fresh window at `now()` off a refund.
              await repo.decrement(address, new Date());
              expect(await repo.find(address)).toEqual(option.none);
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should not move the window anchor (updated_at)", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.increment(address);
              const before = await repo.get(address);
              await repo.decrement(address, new Date());
              const after = await repo.get(address);
              expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should refund against the anchor the reservation returned", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              // The production shape: keep what `increment` handed back and refund
              // with it, rather than with a date the application made up.
              const anchor = await repo.increment(address);
              await repo.increment(address);
              await repo.decrement(address, anchor);
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({ address, count: 1 }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should no-op when the slot belongs to a later window", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.increment(address);
              const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
              // A clock that runs ahead of the database must not be able to refund
              // a slot the row does not hold yet.
              await repo.decrement(address, tomorrow);
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({ address, count: 1 }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should never take the count below zero", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              const anchor = await repo.increment(address);
              // A negative count would hand the address free requests the next day,
              // since the rollover reset is what clears it back to zero.
              await repo.decrement(address, anchor);
              await repo.decrement(address, anchor);
              expect(await repo.get(address)).toEqual(
                expect.objectContaining({ address, count: 0 }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });
    });

    /**
     * Reservations and refunds are read-modify-write, and both the drip route and
     * the task manager can be running one for the same address at the same moment.
     * Without a row lock on every read, one of the two updates is lost — either
     * reverting a refund or handing out a slot that was never spent.
     */
    describe("concurrent access", () => {
      const RACERS = 3;

      it("should keep every reservation that races another", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();

              await Promise.all(Array.from({ length: RACERS }, () => repo.increment(address)));

              expect(await repo.get(address)).toEqual(
                expect.objectContaining({ address, count: RACERS }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should apply refunds and reservations that race each other exactly once", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              // Reserve enough up front that no interleaving reaches zero, so the
              // count floor cannot absorb a lost update and hide it.
              const anchors = await Promise.all(
                Array.from({ length: RACERS }, () => repo.increment(address)),
              );

              await Promise.all([
                ...Array.from({ length: RACERS }, () => repo.increment(address)),
                ...anchors.map((anchor) => repo.decrement(address, anchor)),
              ]);

              expect(await repo.get(address)).toEqual(
                expect.objectContaining({ address, count: RACERS }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should create a single row when concurrent callers race the insert", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();

              // `get` and `increment` both get-or-create, which is the path a first
              // request and its rate-limit check take together.
              await Promise.all([repo.get(address), repo.increment(address), repo.get(address)]);

              expect(await repo.find(address)).toEqual(
                option.some(expect.objectContaining({ address, count: 1 })),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });
    });

    it("all updates should set date/time updated", async () => {
      return pipe(
        context.instance(infrastructure),
        Resource.use((repo) =>
          Task.lift(async () => {
            const address = createAddress();
            const exec = async (fn: () => Promise<unknown>) => {
              await fn();
              return repo.get(address);
            };
            const ops: RateCountType[] = [
              await exec(() => repo.get(address)),
              await exec(() => repo.increment(address)),
              await exec(() => repo.increment(address)),
              await exec(() => repo.increment(address)),
              await exec(() => repo.reset(address)),
            ];
            for (let idx = 1; idx < ops.length; idx += 1) {
              expect(ops[idx - 1].updated_at.getMilliseconds()).toBeLessThan(
                ops[idx].updated_at.getMilliseconds(),
              );
            }
          }),
        ),
        Task.unsafeRun,
      );
    });
  });
}
