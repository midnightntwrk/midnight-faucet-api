import * as nodeCrypto from "node:crypto";
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
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
