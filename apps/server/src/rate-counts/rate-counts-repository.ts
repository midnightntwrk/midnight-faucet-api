import { option } from "fp-ts";
import { Knex } from "knex";
import { DateTime } from "luxon";
import pino from "pino";
import * as t from "io-ts";
import * as td from "io-ts-types";

export const TABLE_NAME = "rate_counts";

export const RateCount = t.type({
  address: t.string,
  count: t.number,
  updated_at: td.date,
});

export type RateCountType = t.TypeOf<typeof RateCount>;
export type RateCountKeys = Pick<RateCountType, "address">;

/** The mutations this repository performs, used as log context. */
type RateCountOp = "reset" | "increment" | "decrement";

/**
 * Column update for a rate-count row. Both callers move the window anchor, so
 * `updated_at` is required — {@link PostgresqlRateCountRepository.decrement} must
 * leave the anchor alone and therefore does not go through this shape.
 */
type RateCountUpdate = { count: number; updated_at: Knex.Raw };

export class PostgresqlRateCountRepository {
  private readonly RateCounts: () => Knex.QueryBuilder<RateCountType, RateCountType>;

  constructor(
    private readonly knex: Knex,
    private readonly logger: pino.Logger,
  ) {
    this.RateCounts = () => knex<RateCountType, RateCountType>(TABLE_NAME);
  }

  async get(address: string): Promise<RateCountType> {
    const keys: RateCountKeys = { address };
    try {
      return await this.knex.transaction(async (trx: Knex.Transaction<RateCountType>) => {
        const { rateCount } = await this.getOrCreateRateCount(trx, keys);
        return rateCount;
      });
    } catch (error) {
      this.logger.error({ error, address }, "Error retrieving rate count data from DB");
      throw error;
    }
  }

  /**
   * Read a rate count without creating one, unlike {@link get}. `none` means the
   * address has never reserved a slot.
   */
  async find(address: string): Promise<option.Option<RateCountType>> {
    const keys: RateCountKeys = { address };
    try {
      return option.fromNullable(await this.RateCounts().where(keys).first());
    } catch (error) {
      this.logger.error({ error, address }, "Error retrieving rate count data from DB");
      throw error;
    }
  }

  async reset(address: string): Promise<RateCountType> {
    return this.adjustCount(address, "reset", (_current, created) =>
      // A freshly-created row is already at zero — nothing to reset.
      created ? option.none : option.some({ count: 0, updated_at: this.knex.fn.now() }),
    );
  }

  async increment(address: string): Promise<void> {
    await this.adjustCount(address, "increment", (current) =>
      option.some({
        count: current.count + 1,
        updated_at: this.knex.fn.now(),
      }),
    );
  }

  /**
   * Refund a slot reserved by {@link increment} when the drip ultimately fails.
   *
   * `updated_at` is the window anchor {@link "../api/drip-routes".validateRateLimit}
   * resets on, so the refund must (a) leave it untouched and (b) no-op unless the
   * row is still in the window the slot was reserved in (`registeredAt`'s day).
   * Otherwise the day has already rolled over and we would either drag the window
   * forward or decrement a fresh day's counter.
   *
   * Unlike {@link increment} this never creates a row: with nothing reserved there
   * is no slot to hand back, and inserting one here would anchor a brand-new
   * window at `now()` off the back of a refund (#595).
   */
  async decrement(address: string, registeredAt: Date): Promise<void> {
    const windowDay = DateTime.fromJSDate(registeredAt).startOf("day");
    const keys: RateCountKeys = { address };
    await this.inTransaction(address, "decrement", async (trx) => {
      const current = await this.RateCounts().transacting(trx).where(keys).forUpdate().first();
      if (current === undefined) {
        return;
      }
      const rowDay = DateTime.fromJSDate(current.updated_at).startOf("day");
      if (!rowDay.equals(windowDay)) {
        return; // Slot already rolled over — nothing of ours to refund.
      }
      await this.RateCounts()
        .transacting(trx)
        .update({ count: Math.max(0, current.count - 1) }) // Never below zero, keep updated_at.
        .where(keys);
    });
  }

  /**
   * Shared transaction body for {@link reset} and {@link increment}: get-or-create
   * the row, then apply `compute`. `none` from `compute` leaves the row untouched.
   */
  private async adjustCount(
    address: string,
    op: RateCountOp,
    compute: (current: RateCountType, created: boolean) => option.Option<RateCountUpdate>,
  ): Promise<RateCountType> {
    const keys: RateCountKeys = { address };
    return this.inTransaction(address, op, async (trx) => {
      const { rateCount, created } = await this.getOrCreateRateCount(trx, keys);
      const data = compute(rateCount, created);
      if (option.isNone(data)) {
        return rateCount;
      }
      const updated = await this.RateCounts()
        .transacting(trx)
        .update(data.value)
        .where(keys)
        .returning("*")
        .then((rows) => rows[0]);
      if (!updated) {
        throw new Error("Failed to update row.");
      }
      return updated;
    });
  }

  /** Run `body` in one transaction, logging with `op` context before rethrowing. */
  private async inTransaction<A>(
    address: string,
    op: RateCountOp,
    body: (trx: Knex.Transaction<RateCountType>) => Promise<A>,
  ): Promise<A> {
    try {
      return await this.knex.transaction(body);
    } catch (error) {
      this.logger.error({ error, address, op }, "Error while saving rate count data to DB");
      throw error;
    }
  }

  private async getOrCreateRateCount(
    trx: Knex.Transaction<RateCountType>,
    keys: RateCountKeys,
  ): Promise<{ rateCount: RateCountType; created: boolean }> {
    const inserted = await this.RateCounts()
      .transacting(trx)
      .insert(keys)
      .onConflict("address")
      .ignore()
      .returning("*")
      .then((rows) => rows[0] ?? null);
    if (inserted) {
      return { rateCount: inserted, created: true };
    }

    // Conflict occurred due to concurrency caused by spamming
    const rateCount = await this.RateCounts().transacting(trx).where(keys).first();
    if (!rateCount) {
      throw new Error(`Error creating row in ${TABLE_NAME} table.`);
    }
    return { rateCount, created: false };
  }
}
