import { UserId } from "@midnight-ntwrk/faucet-auth";
import { addMilliseconds, intlFormat, isAfter, isBefore, isEqual, max } from "date-fns";
import { Duration } from "luxon";
import pino from "pino";
import * as UA from "./user-action-times.js";

export type RateLimitConfig = Readonly<{
  /**
   * Number of milliseconds that need to pass before a permit can be issued
   */
  waitDuration: number;
  /**
   * Number of milliseconds that need to pass to treat ongoing action as a failed one
   */
  failureTimeout: number;
  /**
   * The maximum daily number of requests per address.
   */
  maxDailyRequests: number;
}>;

export class RateLimitError extends Error {
  readonly name = "RateLimitError";

  constructor(nextAllowedTime: Date) {
    super(
      `You can't resubmit right now, next attempt is allowed at ${intlFormat(nextAllowedTime, {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone: "UTC",
      })}, in 24 hours.`,
    );

    Object.setPrototypeOf(this, new.target.prototype);
  }

  static in24Hours(from = new Date()) {
    return new RateLimitError(new Date(from.getTime() + 24 * 60 * 60 * 1000));
  }
}

export class InvalidRateLimitConfigError extends Error {
  constructor(
    public readonly field: keyof RateLimitConfig,
    public readonly value: RateLimitConfig[keyof RateLimitConfig],
    message: string,
  ) {
    super(`Passed configuration field ${field} has invalid value: ${message}`);
  }
}

export interface UserActionTimesRepository {
  getActionsOfUser(user: UserId): Promise<UA.UserActionTimes>;
  actionStarted(user: UserId, time: Date): Promise<void>;
  actionFailed(user: UserId, time: Date): Promise<void>;
  actionSucceeded(user: UserId, time: Date): Promise<void>;
}

export interface Clock {
  now: () => Date;
}
export class RealClock implements Clock {
  now() {
    return new Date();
  }
}

const actionPermitToken: unique symbol = Symbol("ActionPermit");
export class ActionPermit {
  #finished = false;

  constructor(
    private readonly clock: Clock,
    token: typeof actionPermitToken,
    public readonly userId: UserId,
    private readonly repository: UserActionTimesRepository,
    private readonly logger: pino.Logger,
  ) {
    if (token !== actionPermitToken) {
      throw new Error("Tried to create ActionPermit without required token");
    }
  }

  async succeeded(): Promise<void> {
    if (this.#finished) {
      throw new Error("Tried to succeed already finished action");
    }

    this.#finished = true;
    const when = this.clock.now();
    this.logger.debug({ when }, "Permit action finished");
    await this.repository.actionSucceeded(this.userId, when);
  }

  async failed(): Promise<void> {
    if (this.#finished) {
      throw new Error("Tried to fail already finished action");
    }

    this.#finished = true;
    const when = this.clock.now();
    this.logger.debug({ when }, "Permit action failed");
    await this.repository.actionFailed(this.userId, when);
  }

  async finishWithAction<T>(action: Promise<T>): Promise<T> {
    try {
      this.logger.trace("Waiting for action to finish");
      const result = await action;
      await this.succeeded();
      return result;
    } catch (error) {
      await this.failed();
      throw error;
    }
  }
}

/**
 * Simple, per-user rate limiter.
 *
 * It decides whether to permit an action or based on 3 timestamps tracked
 * individually for each user:
 *   - when was the last start of an allowed action
 *   - when was the last success of an allowed action
 *   - when was the last registered failure of an allowed action
 *
 * Then, the logic is more or less this:
 *   - generally - allow next action only after `config.waitPeriod` passes
 *     since the last success
 *   - don't allow starting 2 overlapping actions
 *   - ignore registered errors
 *   - treat ongoing actions as failed if they are not registered
 *     as failed or succeeded after `config.failureTimeout` - this is mostly
 *     useful for handling app restarts in the middle of request processing
 *
 * The justification for this comes mostly from the goal of finding a balance
 * between UX and protecting faucet's funds from drainage:
 *   - we want users to be able to request tokens on a regular basis
 *   - in case of accidental errors we want users to allow to request tokens
 *     again, without having to wait full `config.waitPeriod`
 *
 * Though - the `config.failureTimeout` initially needs to be carefully set
 * to a rather conservative number due to `zswap.LocalState` not having
 * mechanics of releasing spent tokens if the transaction was not
 * accepted or received on chain (due to e.g. networking issues)
 *
 * The API with `ActionPermit` class is meant to be used as a form of a bracket
 * around action protected by the `RateLimiter`:
 * ```
 * const rateLimiter = new RateLimiter(config, userActionTimesRepository);
 *
 * const permit = rateLimiter.permitAction(new Date())
 * try {
 *   doSomeAction();
 *   await permit.actionSucceeded(new Date());
 * } catch (error) {
 *   await permit.actionFailed(new Date());
 * }
 * ```
 */
export class RateLimiter {
  static allowsPermit(config: RateLimitConfig, now: Date, actions: UA.UserActionTimes): boolean {
    const nextAllowedTime = RateLimiter.nextAllowedTime(config, now, actions);
    return isAfter(now, nextAllowedTime) || isEqual(now, nextAllowedTime);
  }

  static nextAllowedTime(config: RateLimitConfig, now: Date, actions: UA.UserActionTimes): Date {
    const nextFromSucceeded = actions.lastSucceeded
      ? addMilliseconds(actions.lastSucceeded, config.waitDuration)
      : null;

    const isThereOngoingAction =
      actions.lastStarted != null &&
      [actions.lastFailed, actions.lastSucceeded].every((finishedTime) => {
        return finishedTime == null ? true : isBefore(finishedTime, actions.lastStarted!);
      });

    const nextFromStarted = isThereOngoingAction
      ? addMilliseconds(actions.lastStarted, config.failureTimeout)
      : null;

    const timesToCheck = [now, nextFromSucceeded, nextFromStarted].filter(
      (date): date is Date => date != null,
    );

    return max(timesToCheck);
  }

  constructor(
    private readonly config: RateLimitConfig,
    private readonly userActionTimesRepository: UserActionTimesRepository,
    private readonly clock: Clock,
    private readonly logger: pino.Logger,
  ) {
    const checkDurationValue = <K extends keyof RateLimitConfig>(key: K) => {
      const value = config[key];
      if (Number.isSafeInteger(value) && value > 0) {
        return undefined;
      } else {
        throw new InvalidRateLimitConfigError(key, value, "Duration needs to be longer than 0");
      }
    };

    checkDurationValue("waitDuration");
    checkDurationValue("failureTimeout");
  }

  timeToWait(): Duration {
    return Duration.fromMillis(this.config.waitDuration);
  }

  async permitAction(userId: UserId): Promise<ActionPermit> {
    const now = this.clock.now();
    const userActions = await this.userActionTimesRepository.getActionsOfUser(userId);
    this.logger.trace({ userId, userActions }, "Issuing permit for user");
    if (RateLimiter.allowsPermit(this.config, now, userActions)) {
      this.logger.trace({ userId }, "Permit for user issued");
      await this.userActionTimesRepository.actionStarted(userId, now);
      return new ActionPermit(
        this.clock,
        actionPermitToken,
        userId,
        this.userActionTimesRepository,
        this.logger.child({ userId }),
      );
    } else {
      throw new RateLimitError(RateLimiter.nextAllowedTime(this.config, now, userActions));
    }
  }
}
