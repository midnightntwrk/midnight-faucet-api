import { UserId } from "@midnight-ntwrk/faucet-auth";
import * as fc from "fast-check";
import { wait } from "@midnight-ntwrk/faucet-utils";
import pino from "pino";
import { InMemoryUserActionTimesRepository } from "../in-memory-user-action-times-repository.js";
import {
  ActionPermit,
  InvalidRateLimitConfigError,
  RateLimitConfig,
  RateLimiter,
  RateLimitError,
} from "../rate-limiting.js";
import { FakeClock } from "./fake-clock.js";

const dateBoundaryMillis = 8_640_000_000_000_000;
const maxSecondsToUse = dateBoundaryMillis / 1000 / 4; // We're limiting the space, so that various additions fit within Date range

const millisecondsArbitrary = fc.integer({
  min: 1,
  max: maxSecondsToUse * 1000,
});

const dateArbitrary = fc.date({
  min: new Date(0),
  max: new Date(maxSecondsToUse * 1000),
  noInvalidDate: true,
});

const rateLimiterConfigArbitrary: fc.Arbitrary<RateLimitConfig> = fc.record({
  waitDuration: millisecondsArbitrary,
  failureTimeout: millisecondsArbitrary,
  maxDailyRequests: fc.constant(25),
});

const invalidDurationValueArbitrary = fc.oneof(
  fc.float({
    max: 0,
    maxExcluded: false,
    noNaN: false,
    noDefaultInfinity: false,
  }),
  fc.integer({
    max: 0,
  }),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
);
const invalidRateLimiterConfigArbitrary: fc.Arbitrary<RateLimitConfig> =
  rateLimiterConfigArbitrary.chain((initialConfig) =>
    fc
      .array(fc.constantFrom("waitDuration", "failureTimeout"), { minLength: 1, maxLength: 2 })
      .chain((propertiesToZero) =>
        invalidDurationValueArbitrary.map((invalidValue) =>
          propertiesToZero.reduce(
            (config, propertyName) => ({
              ...config,
              [propertyName]: invalidValue,
            }),
            initialConfig,
          ),
        ),
      ),
  );

describe("Rate limiting", () => {
  const logger = pino({ level: "silent" });
  it("requires configuration to impose non-zero durations", () => {
    return fc.assert(
      fc.property(invalidRateLimiterConfigArbitrary, (invalidConfiguration) => {
        const clock = new FakeClock(new Date());
        const actionsRepository = new InMemoryUserActionTimesRepository();

        expect(
          () => new RateLimiter(invalidConfiguration, actionsRepository, clock, logger),
        ).toThrow(InvalidRateLimitConfigError);
      }),
    );
  });

  it("permits users, if there is no history", () => {
    return fc.assert(
      fc.asyncProperty(dateArbitrary, rateLimiterConfigArbitrary, async (startDate, config) => {
        const clock = new FakeClock(startDate);
        const userId = UserId.generate();
        const actionsRepository = new InMemoryUserActionTimesRepository();
        const limiter = new RateLimiter(config, actionsRepository, clock, logger);
        const permit = await limiter.permitAction(userId);

        expect(permit).toBeInstanceOf(ActionPermit);
      }),
    );
  });

  it("permits users, if specified period has passed since last successful request", () => {
    return fc.assert(
      fc.asyncProperty(dateArbitrary, rateLimiterConfigArbitrary, async (startDate, config) => {
        const clock = new FakeClock(startDate);
        const userId = UserId.generate();
        const actionsRepository = new InMemoryUserActionTimesRepository();
        const limiter = new RateLimiter(config, actionsRepository, clock, logger);
        const originalPermit = await limiter.permitAction(userId);
        await originalPermit.succeeded();

        clock.moveByMs(config.waitDuration);

        const newPermit = await limiter.permitAction(userId);
        expect(newPermit).toBeInstanceOf(ActionPermit);
      }),
    );
  });

  it("permits users if specified period has passed since last successful request, but there are unsuccessful requests within specified duration", () => {
    return fc.assert(
      fc.asyncProperty(
        dateArbitrary,
        rateLimiterConfigArbitrary.chain((config) =>
          fc.record({
            config: fc.constant(config),
            waitAfterFailure: fc.nat({ max: config.waitDuration }),
          }),
        ),
        async (startDate, { config, waitAfterFailure }) => {
          const clock = new FakeClock(startDate);
          const userId = UserId.generate();
          const actionsRepository = new InMemoryUserActionTimesRepository();
          const limiter = new RateLimiter(config, actionsRepository, clock, logger);
          const successfulPermit = await limiter.permitAction(userId);
          await successfulPermit.succeeded();

          clock.moveByMs(config.waitDuration);
          const failingPermit = await limiter.permitAction(userId);
          await failingPermit.failed();

          clock.moveByMs(waitAfterFailure);
          const finalPermit = await limiter.permitAction(userId);
          expect(finalPermit).toBeInstanceOf(ActionPermit);
        },
      ),
    );
  });

  it("treats ongoing tasks running for longer than specified duration as failed, and immediately permits user to perform action", () => {
    return fc.assert(
      fc.asyncProperty(dateArbitrary, rateLimiterConfigArbitrary, async (startDate, config) => {
        const clock = new FakeClock(startDate);
        const userId = UserId.generate();
        const actionsRepository = new InMemoryUserActionTimesRepository();
        const limiter = new RateLimiter(config, actionsRepository, clock, logger);
        await limiter.permitAction(userId);

        clock.moveByMs(config.failureTimeout);
        const newPermit = await limiter.permitAction(userId);

        expect(newPermit).toBeInstanceOf(ActionPermit);
      }),
    );
  });

  it("treats ongoing tasks running for longer than specified duration as failed, and immediately permits user to perform action if last successful action happened before specified period", () => {
    return fc.assert(
      fc.asyncProperty(dateArbitrary, rateLimiterConfigArbitrary, async (startDate, config) => {
        const clock = new FakeClock(startDate);
        const userId = UserId.generate();
        const actionsRepository = new InMemoryUserActionTimesRepository();
        const limiter = new RateLimiter(config, actionsRepository, clock, logger);
        // We perform a successful action
        const lastSuccessful = await limiter.permitAction(userId);
        await lastSuccessful.succeeded();

        // Then we need to wait `waitDuration`, and start another action that won't finish
        clock.moveByMs(config.waitDuration);
        await limiter.permitAction(userId);

        // Then we wait a `failureTimeout`, and we should be able to start
        // another action, as the previous one should be treated as failed at this point
        clock.moveByMs(config.failureTimeout);
        const newPermit = await limiter.permitAction(userId);

        expect(newPermit).toBeInstanceOf(ActionPermit);
      }),
    );
  });

  it("does not permit users who have ongoing requests", () => {
    return fc.assert(
      fc.asyncProperty(
        dateArbitrary,
        rateLimiterConfigArbitrary
          .filter((config) => config.failureTimeout > 1)
          .chain((config) =>
            fc.record({
              config: fc.constant(config),
              timeToWait: fc.integer({ min: 1, max: config.failureTimeout - 1 }),
            }),
          ),
        async (startDate, { config, timeToWait }) => {
          const clock = new FakeClock(startDate);
          const userId = UserId.generate();
          const actionsRepository = new InMemoryUserActionTimesRepository();
          const limiter = new RateLimiter(config, actionsRepository, clock, logger);
          await limiter.permitAction(userId);

          clock.moveByMs(timeToWait);

          await expect(limiter.permitAction(userId)).rejects.toThrow(RateLimitError);
        },
      ),
    );
  });

  it("does not permit users when specified period since last successful request has not passed yet", () => {
    return fc.assert(
      fc.asyncProperty(
        dateArbitrary,
        rateLimiterConfigArbitrary.chain((config) =>
          fc.record({
            config: fc.constant(config),
            timeToWait: fc.nat({ max: config.waitDuration - 1 }),
          }),
        ),
        async (startDate, { config, timeToWait }) => {
          const clock = new FakeClock(startDate);
          const userId = UserId.generate();
          const actionsRepository = new InMemoryUserActionTimesRepository();
          const limiter = new RateLimiter(config, actionsRepository, clock, logger);
          const originalPermit = await limiter.permitAction(userId);
          await originalPermit.succeeded();

          clock.moveByMs(timeToWait);
          await expect(limiter.permitAction(userId)).rejects.toThrow(RateLimitError);
        },
      ),
    );
  });

  it("allows to successfully finish permit by passing a promise", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.anything(),
        rateLimiterConfigArbitrary,
        fc.integer({ min: 0, max: 10 }),
        async (data, config, timeout) => {
          const clock = new FakeClock(new Date());
          const userId = UserId.generate();
          const actionsRepository = new InMemoryUserActionTimesRepository();
          const limiter = new RateLimiter(config, actionsRepository, clock, logger);
          const permit = await limiter.permitAction(userId);
          const action = () =>
            wait(timeout).then(() => {
              clock.moveByMs(timeout);
              return data;
            });
          const result = await permit.finishWithAction(action());
          const actionTimes = await actionsRepository.getActionsOfUser(userId);

          expect(actionTimes.lastSucceeded?.getTime()).toEqual(clock.currentTime.getTime());
          expect(result).toEqual(data);
        },
      ),
    );
  });

  it("allows to fail permit by passing a promise", () => {
    return fc.assert(
      fc.asyncProperty(
        rateLimiterConfigArbitrary,
        fc.integer({ min: 0, max: 10 }),
        async (config, timeout) => {
          const clock = new FakeClock(new Date());
          const userId = UserId.generate();
          const actionsRepository = new InMemoryUserActionTimesRepository();
          const limiter = new RateLimiter(config, actionsRepository, clock, logger);
          const permit = await limiter.permitAction(userId);
          const action = () =>
            wait(timeout).then(() => {
              clock.moveByMs(timeout);
              throw new Error("Bu!");
            });
          await expect(permit.finishWithAction(action())).rejects.toThrow();
          const actionTimes = await actionsRepository.getActionsOfUser(userId);
          expect(actionTimes.lastFailed?.getTime()).toEqual(clock.currentTime.getTime());
        },
      ),
    );
  });
});
