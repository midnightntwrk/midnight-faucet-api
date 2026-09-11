import * as nodeCrypto from "node:crypto";
import { pipe, Resource, Task } from "@midnightntwrk/faucet-utils";
import { option } from "fp-ts";
import { DateTime, Settings } from "luxon";
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

    /** The stored row, failing the test rather than the assertion when there is none. */
    const rowOf = async (
      repo: PostgresqlRateCountRepository,
      address: string,
    ): Promise<RateCountType> => {
      const found = await repo.find(address);
      if (option.isNone(found)) {
        throw new Error(`Expected a rate_counts row for ${address}`);
      }
      return found.value;
    };

    const countOf = async (repo: PostgresqlRateCountRepository, address: string): Promise<number> =>
      (await rowOf(repo, address)).count;

    /** A limit high enough that a reservation only fails for the reason under test. */
    const NO_PRACTICAL_LIMIT = 1_000;

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

    describe("tryReserve", () => {
      it("should create and initialize a RateCount if not already present for an address", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              expect(await repo.tryReserve(address, NO_PRACTICAL_LIMIT)).toMatchObject({
                _tag: "reserved",
              });
              expect(await rowOf(repo, address)).toEqual(
                expect.objectContaining({ address, count: 1 }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should increment the count by one on each reservation", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              expect(await countOf(repo, address)).toBe(2);
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should return the window anchor the row now carries", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              const reservation = await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              if (reservation._tag === "denied") {
                throw new Error("Expected the first reservation to be granted");
              }
              // The anchor a refund is matched against must be the row's own, not an
              // app-clock guess — the two straddle midnight independently (#595).
              const row = await rowOf(repo, address);
              expect(reservation.registeredAt.getTime()).toBe(row.updated_at.getTime());
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should deny a reservation once the daily limit is spent", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              expect(await repo.tryReserve(address, 2)).toMatchObject({ _tag: "reserved" });
              expect(await repo.tryReserve(address, 2)).toMatchObject({ _tag: "reserved" });
              expect(await repo.tryReserve(address, 2)).toEqual({ _tag: "denied" });
              // A denied reservation must not charge for the slot it refused.
              expect(await countOf(repo, address)).toBe(2);
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should deny every reservation when the limit is zero", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              // The plain-insert branch of the upsert has no limit to check, so a
              // never-seen address is the case a zero limit could slip through.
              expect(await repo.tryReserve(address, 0)).toEqual({ _tag: "denied" });
              expect(await repo.find(address)).toEqual(option.none);
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should roll the window over rather than increment when the day has changed", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.tryReserve(address, 1);
              expect(await repo.tryReserve(address, 1)).toEqual({ _tag: "denied" });

              // Luxon drives the window boundary, so moving its clock forward is what
              // a new day looks like to the repository.
              const realNow = Settings.now;
              const tomorrow = DateTime.now().plus({ days: 1 });
              try {
                Settings.now = () => tomorrow.valueOf();
                expect(await repo.tryReserve(address, 1)).toMatchObject({ _tag: "reserved" });
              } finally {
                Settings.now = realNow;
              }

              // Yesterday's slot is gone, not carried forward.
              expect(await countOf(repo, address)).toBe(1);
            }),
          ),
          Task.unsafeRun,
        );
      });

      // The regression test for the check-then-charge window: reading the count,
      // comparing it in the application and incrementing afterwards let N concurrent
      // requests for one address all observe the same pre-charge count and all pass.
      it("should grant no more than the daily limit under concurrent reservations", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              const limit = 3;
              const attempts = 20;

              const reservations = await Promise.all(
                Array.from({ length: attempts }, () => repo.tryReserve(address, limit)),
              );

              const granted = reservations.filter(
                (reservation) => reservation._tag === "reserved",
              ).length;
              expect(granted).toBe(limit);
              expect(await countOf(repo, address)).toBe(limit);
            }),
          ),
          Task.unsafeRun,
        );
      });
    });

    describe("increment", () => {
      it("should spend a slot regardless of how many the address has already used", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.tryReserve(address, 1);
              expect(await repo.tryReserve(address, 1)).toEqual({ _tag: "denied" });
              // Tokens that already left the wallet must be charged for even past the
              // limit, or the requester keeps both the tokens and the allowance (#595).
              await repo.increment(address);
              expect(await countOf(repo, address)).toBe(2);
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should create and initialize a RateCount if not already present for an address", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              await repo.increment(address);
              expect(await countOf(repo, address)).toBe(1);
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
              // The anchor a caller has to keep in order to refund later must be the
              // row's own `updated_at`, not an app-clock guess: `decrement` compares
              // it against the stored value and refuses anything else (#595).
              const anchor = await repo.increment(address);
              const row = await rowOf(repo, address);
              expect(anchor.getTime()).toBe(row.updated_at.getTime());
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
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              await repo.decrement(address, new Date());
              expect(await rowOf(repo, address)).toEqual(
                expect.objectContaining({ address, count: 1 }),
              );
            }),
          ),
          Task.unsafeRun,
        );
      });

      it("should free the slot for a new reservation", async () => {
        return pipe(
          context.instance(infrastructure),
          Resource.use((repo) =>
            Task.lift(async () => {
              const address = createAddress();
              const reservation = await repo.tryReserve(address, 1);
              if (reservation._tag === "denied") {
                throw new Error("Expected the first reservation to be granted");
              }
              expect(await repo.tryReserve(address, 1)).toEqual({ _tag: "denied" });

              // A drip that failed delivered nothing, so the retry must be allowed.
              await repo.decrement(address, reservation.registeredAt);
              expect(await repo.tryReserve(address, 1)).toMatchObject({ _tag: "reserved" });
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
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT); // count=1, window = today
              const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
              await repo.decrement(address, twoDaysAgo);
              // Today's counter must be untouched — the slot was reserved earlier.
              expect(await rowOf(repo, address)).toEqual(
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
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              const before = await rowOf(repo, address);
              await repo.decrement(address, new Date());
              const after = await rowOf(repo, address);
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
              // The production shape: keep what the reservation handed back and
              // refund with it, rather than with a date the application made up.
              const reservation = await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              if (reservation._tag === "denied") {
                throw new Error("Expected the first reservation to be granted");
              }
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT);

              await repo.decrement(address, reservation.registeredAt);

              expect(await countOf(repo, address)).toBe(1);
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
              await repo.tryReserve(address, NO_PRACTICAL_LIMIT);
              const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

              // A clock running ahead of the database must not be able to refund a
              // slot the row does not hold yet.
              await repo.decrement(address, tomorrow);

              expect(await countOf(repo, address)).toBe(1);
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
              // since the rollover is what clears it back to zero.
              await repo.decrement(address, anchor);
              await repo.decrement(address, anchor);

              expect(await countOf(repo, address)).toBe(0);
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

              expect(await countOf(repo, address)).toBe(RACERS);
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

              expect(await countOf(repo, address)).toBe(RACERS);
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

              // Both entry points get-or-create, which is the path a first request
              // and the slot it spends take together on a never-seen address.
              await Promise.all([
                repo.increment(address),
                repo.tryReserve(address, NO_PRACTICAL_LIMIT),
              ]);

              expect(await repo.find(address)).toEqual(
                option.some(expect.objectContaining({ address, count: 2 })),
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
              return rowOf(repo, address);
            };
            const ops: RateCountType[] = [
              await exec(() => repo.tryReserve(address, NO_PRACTICAL_LIMIT)),
              await exec(() => repo.tryReserve(address, NO_PRACTICAL_LIMIT)),
              await exec(() => repo.increment(address)),
            ];
            // Compare epoch time, not getMilliseconds(): that returns only the sub-second field,
            // which collides between close writes and runs backwards across a second boundary
            // (.900 -> .100). The bound is non-strict because consecutive writes can share a
            // millisecond — Date truncates Postgres' microsecond precision.
            const updateTimes = ops.map((op) => op.updated_at.getTime());
            updateTimes.slice(1).forEach((current, idx) => {
              expect(updateTimes[idx]).toBeLessThanOrEqual(current);
            });
          }),
        ),
        Task.unsafeRun,
      );
    });
  });
}
