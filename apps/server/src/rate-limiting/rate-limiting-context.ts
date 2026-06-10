import pino from "pino";
import { Clock, RateLimitConfig, RateLimiter, UserActionTimesRepository } from "./rate-limiting.js";

export type RateLimiterContext = Readonly<{
  rateLimiter: RateLimiter;
}>;

export const prepareRateLimitingContext = (
  config: RateLimitConfig,
  actionTimesRepository: UserActionTimesRepository,
  clock: Clock,
  logger: pino.Logger,
): RateLimiterContext => {
  return { rateLimiter: new RateLimiter(config, actionTimesRepository, clock, logger) };
};
