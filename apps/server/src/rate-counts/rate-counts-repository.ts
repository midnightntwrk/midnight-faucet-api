/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Knex } from "knex";
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
      return await this.knex.transaction(async (trx) => {
        const { rateCount } = await this.getOrCreateRateCount(trx, keys);
        return rateCount;
      });
    } catch (error) {
      this.logger.error({ error, address }, "Error retrieving rate count data from DB");
      throw error;
    }
  }

  async reset(address: string): Promise<RateCountType> {
    const keys: RateCountKeys = { address };
    try {
      return await this.knex.transaction(async (trx) => {
        const { rateCount, created } = await this.getOrCreateRateCount(trx, keys);
        // If a new rate count was created, then return it...
        if (created) {
          return rateCount;
        }
        // ...otherwise reset it before returning it.
        const data = {
          count: 0, // Reset `count` to zero.
          updated_at: this.knex.fn.now(), // Update the date/time of last updated.
        };
        const updatedRateCount = await this.RateCounts()
          .transacting(trx)
          .update(data)
          .where(keys)
          .returning("*")
          .then((rateCounts) => rateCounts[0]);
        if (!updatedRateCount) {
          throw new Error("Failed to update row.");
        }
        return updatedRateCount;
      });
    } catch (error) {
      this.logger.error({ error, address }, "Error while saving rate count data to DB");
      throw error;
    }
  }

  async increment(address: string): Promise<void> {
    const keys: RateCountKeys = { address };
    try {
      await this.knex.transaction(async (trx) => {
        const { rateCount } = await this.getOrCreateRateCount(trx, keys);
        const data = {
          count: rateCount.count + 1, // Increment the current `count`.
          updated_at: this.knex.fn.now(), // Update the date/time of last updated.
        };
        await this.RateCounts().transacting(trx).update(data).where(keys);
      });
    } catch (error) {
      this.logger.error({ error, address }, "Error while saving rate count data to DB");
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
