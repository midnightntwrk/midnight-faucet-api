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
type RateCountOp = "reserve" | "increment" | "decrement";

/**
 * The outcome of {@link PostgresqlRateCountRepository.tryReserve}: either the slot
 * was taken — carrying the window anchor a later refund has to be matched against —
 * or the address has nothing left in the current window.
 */
export type SlotReservation =
  { readonly _tag: "reserved"; readonly registeredAt: Date } | { readonly _tag: "denied" };

export class PostgresqlRateCountRepository {
  private readonly RateCounts: () => Knex.QueryBuilder<RateCountType, RateCountType>;

  constructor(
    private readonly knex: Knex,
    private readonly logger: pino.Logger,
  ) {
    this.RateCounts = () => knex<RateCountType, RateCountType>(TABLE_NAME);
  }

  /**
   * Read a rate count without creating one. `none` means the address has never
   * reserved a slot.
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

  /**
   * Reserve a slot for `address` unless it has already spent `maxDailyRequests`
   * today, returning the window anchor the row now carries on success. Callers that
   * may have to hand the slot back must pass that anchor to {@link decrement} — it
   * is the database's clock, and comparing it against the app's would silently
   * no-op the refund whenever the two straddle midnight (#595).
   *
   * Checking the limit and charging for it is deliberately one statement. Reading
   * the count, comparing it in the application and incrementing afterwards leaves a
   * window in which N concurrent requests for one address all observe the same
   * pre-charge count, all pass, and all reserve — so the limit bounds nothing but
   * the counter. `ON CONFLICT DO UPDATE` locks the conflicting row before it
   * evaluates its `WHERE`, so reservations for one address serialise and exactly
   * `maxDailyRequests` of them can succeed.
   *
   * The day boundary comes from the application clock rather than
   * `date_trunc('day', now())`, keeping the window the same one the rest of the
   * server reasons about. A row anchored before it belongs to a finished day and is
   * rolled over to a count of one rather than incremented.
   */
  async tryReserve(address: string, maxDailyRequests: number): Promise<SlotReservation> {
    // The plain-insert branch of the upsert has no `WHERE` to guard it, so a
    // never-seen address would be granted a slot however low the limit is.
    if (maxDailyRequests < 1) {
      return { _tag: "denied" };
    }

    const windowStart = DateTime.now().startOf("day").toJSDate();
    try {
      const reserved = await this.knex.raw<{ rows: Array<Pick<RateCountType, "updated_at">> }>(
        `INSERT INTO ${TABLE_NAME} (address, count, updated_at)
              VALUES (?, 1, now())
         ON CONFLICT (address) DO UPDATE
                 SET count = CASE
                               WHEN ${TABLE_NAME}.updated_at < ? THEN 1
                               ELSE ${TABLE_NAME}.count + 1
                             END,
                     updated_at = now()
               WHERE ${TABLE_NAME}.updated_at < ? OR ${TABLE_NAME}.count < ?
           RETURNING updated_at`,
        [address, windowStart, windowStart, maxDailyRequests],
      );

      const row = reserved.rows[0];
      // No row updated means the `WHERE` rejected it: the address is in today's
      // window and already at the limit.
      return row === undefined
        ? { _tag: "denied" }
        : { _tag: "reserved", registeredAt: row.updated_at };
    } catch (error) {
      const op: RateCountOp = "reserve";
      this.logger.error({ error, address, op }, "Error while saving rate count data to DB");
      throw error;
    }
  }

  /**
   * Spend a slot without consulting the limit, for tokens that have already left
   * the wallet — {@link "../TaskManager".TaskManager} re-charges a slot the timeout
   * sweep refunded when the drip turns out to have delivered after all. Denying
   * that would hand back an allowance for tokens the requester kept (#595).
   *
   * Use {@link tryReserve} for anything a requester can trigger.
   */
  async increment(address: string): Promise<Date> {
    const keys: RateCountKeys = { address };
    const reserved = await this.inTransaction(address, "increment", async (trx) => {
      const current = await this.getOrCreateRateCount(trx, keys);
      const updated = await this.RateCounts()
        .transacting(trx)
        .update({ count: current.count + 1, updated_at: this.knex.fn.now() })
        .where(keys)
        .returning("*")
        .then((rows) => rows[0]);
      if (!updated) {
        throw new Error("Failed to update row.");
      }
      return updated;
    });
    return reserved.updated_at;
  }

  /**
   * Refund a slot reserved by {@link tryReserve} when the drip ultimately fails.
   *
   * `updated_at` is the window anchor {@link tryReserve} rolls the count over on, so
   * the refund must (a) leave it untouched and (b) no-op unless the row is still in
   * the window the slot was reserved in (`registeredAt`'s day). Otherwise the day
   * has already rolled over and we would either drag the window forward or decrement
   * a fresh day's counter.
   *
   * Unlike {@link tryReserve} this never creates a row: with nothing reserved there
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
  ): Promise<RateCountType> {
    const inserted = await this.RateCounts()
      .transacting(trx)
      .insert(keys)
      .onConflict("address")
      .ignore()
      .returning("*")
      .then((rows) => rows[0] ?? null);
    if (inserted) {
      return inserted;
    }

    // Conflict occurred due to concurrency caused by spamming. `forUpdate` is
    // required, not just defensive: callers read-modify-write the count, so an
    // unlocked read lets a concurrent refund and reservation lose each other's
    // update — reverting a refund, or handing out an extra slot (#595).
    const rateCount = await this.RateCounts().transacting(trx).where(keys).forUpdate().first();
    if (!rateCount) {
      throw new Error(`Error creating row in ${TABLE_NAME} table.`);
    }
    return rateCount;
  }
}
