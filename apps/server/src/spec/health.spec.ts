import { pipe } from "@midnightntwrk/faucet-utils";
import mapValues from "lodash/mapValues";
import pino from "pino";
import * as fc from "fast-check";
import * as rx from "rxjs";
import { Check, CheckStatus, HealthService } from "../health.js";

describe("HealthService", () => {
  const logger = pino();

  const passingCheckA = HealthService.checkFromObservable(rx.of("ok"));
  const passingCheckB = HealthService.checkFromObservable(rx.of("ok"));
  const failingCheckAsync = HealthService.checkFromObservable(
    rx.throwError(() => new Error("fail")),
  );
  const failingCheckSync = HealthService.checkFromObservable(
    rx.throwError(() => new Error("fail")),
  );

  it("returns ok status when all checks pass", async () => {
    const healthService = new HealthService(
      {
        health: {
          a: passingCheckA,
          b: passingCheckB,
        },
      },
      logger,
    );
    const result = await healthService.doChecks("health");

    expect(result).toEqual({
      status: "ok",
      details: {
        a: "ok",
        b: "ok",
      },
    });
  });

  it("returns not_ok status when some checks pass and some not", async () => {
    const healthService = new HealthService(
      {
        health: {
          a: passingCheckA,
          b: passingCheckB,
          c: failingCheckAsync,
        },
      },
      logger,
    );
    const result = await healthService.doChecks("health");

    expect(result).toEqual({
      status: "not_ok",
      details: {
        a: "ok",
        b: "ok",
        c: "not_ok",
      },
    });
  });

  it("returns not_ok status when all checks fail", async () => {
    const healthService = new HealthService(
      {
        health: {
          c: failingCheckAsync,
          d: failingCheckSync,
        },
      },
      logger,
    );
    const result = await healthService.doChecks("health");

    expect(result).toEqual({
      status: "not_ok",
      details: {
        c: "not_ok",
        d: "not_ok",
      },
    });
  });

  it("treats timed-out checks as failing", async () => {
    const neverCheck = HealthService.checkFromObservable(new rx.Observable(() => {}));
    const healthService = new HealthService(
      {
        health: {
          a: neverCheck,
        },
      },
      logger,
    );
    const result = await healthService.doChecks("health");

    expect(result).toEqual({
      status: "not_ok",
      details: {
        a: "not_ok",
      },
    });
  });

  it("has groups of checks", async () => {
    const healthService = new HealthService(
      {
        liveness: {
          a: passingCheckA,
        },
        readiness: {
          b: passingCheckB,
        },
      },
      logger,
    );
    const livenessResult = await healthService.doChecks("liveness");
    const readinessResult = await healthService.doChecks("readiness");

    expect(livenessResult).toEqual({
      status: "ok",
      details: {
        a: "ok",
      },
    });

    expect(readinessResult).toEqual({
      status: "ok",
      details: {
        b: "ok",
      },
    });
  });

  it("makes group of checks fail independently of each other", async () => {
    const healthService = new HealthService(
      {
        liveness: {
          a: failingCheckSync,
        },
        readiness: {
          b: passingCheckB,
        },
      },
      logger,
    );
    const livenessResult = await healthService.doChecks("liveness");
    const readinessResult = await healthService.doChecks("readiness");

    expect(livenessResult).toEqual({
      status: "not_ok",
      details: {
        a: "not_ok",
      },
    });

    expect(readinessResult).toEqual({
      status: "ok",
      details: {
        b: "ok",
      },
    });
  });

  it("runs them independently", async () => {
    const checkArbitrary = fc.constantFrom(
      { check: passingCheckA, expectedStatus: "ok" },
      { check: passingCheckB, expectedStatus: "ok" },
      { check: failingCheckSync, expectedStatus: "not_ok" },
      { check: failingCheckAsync, expectedStatus: "not_ok" },
    );
    const checkGroupArbitrary = fc.dictionary(fc.string(), checkArbitrary).map((raw) => {
      const group = mapValues(raw, ({ check }) => check);
      const results = mapValues(raw, ({ expectedStatus }) => expectedStatus);
      const aggregateStatus = Object.values(results).includes("not_ok") ? "not_ok" : "ok";

      return {
        group,
        expectedResult: { status: aggregateStatus, details: results },
      };
    });
    const checksArbitrary = fc.dictionary(fc.string(), checkGroupArbitrary).map((raw) => {
      const groups = mapValues(raw, (x) => x.group);
      const expectedResults = mapValues(raw, (x) => x.expectedResult);

      return { groups, expectedResults };
    });

    return fc.assert(
      fc.asyncProperty(checksArbitrary, async ({ groups, expectedResults }): Promise<boolean> => {
        const healthService = new HealthService(groups, logger);

        return pipe(
          rx.from(Object.entries(expectedResults)),
          rx.concatMap(async ([key, expectedResult]) => {
            const result = await healthService.doChecks(key);

            expect(result).toEqual(expectedResult);
            return true;
          }),
          rx.every((res) => res),
          (x) => rx.firstValueFrom(x),
        );
      }),
    );
  });

  describe("building check from observable", () => {
    it("returns first observed value", async () => {
      return fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom<CheckStatus>("ok", "not_ok"), { minLength: 1 }),
          async (values: CheckStatus[]) => {
            const check: Check = HealthService.checkFromObservable(rx.from(values));
            const result = await check();
            expect(result).toEqual(values[0]);
          },
        ),
      );
    });

    it("returns not_ok if error occurs", async () => {
      return fc.assert(
        fc.asyncProperty(fc.anything(), async (value) => {
          const check: Check = HealthService.checkFromObservable(rx.throwError(() => value));
          const result = await check();
          expect(result).toEqual("not_ok");
        }),
      );
    });
  });
});
