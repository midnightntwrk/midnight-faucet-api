import { intlFormat } from "date-fns";

/**
 * A request refused because the address has no daily slot left.
 *
 * Thrown at the API boundary only — the daily limit itself is decided inside
 * {@link "../rate-counts/rate-counts-repository".PostgresqlRateCountRepository.tryReserve},
 * which reports a refusal rather than throwing so the task layer can treat it as
 * the expected outcome it is.
 */
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
