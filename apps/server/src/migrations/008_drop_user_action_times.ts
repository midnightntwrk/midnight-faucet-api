import { Knex } from "knex";

/**
 * `user_action_times` backed the timestamp-based `RateLimiter`, which no route ever
 * reached — the daily counters in `rate_counts` are what enforce the limit. The
 * table has never been written to by a running server, so there is nothing to
 * migrate out of it.
 *
 * `down` restores the schema from `002_user-ids-and-last-requests` and the index
 * from `003_add-indexes`, not the rows: dropping it is what loses those, and a
 * rollback that recreates an empty table is exactly as useful as the table was.
 */
export const up = (knex: Knex) => knex.schema.dropTable("user_action_times");

export const down = (knex: Knex) =>
  knex.schema
    .createTable("user_action_times", (table) => {
      table.uuid("user_id").primary().notNullable().unique();
      table.timestamp("last_started", { useTz: false });
      table.timestamp("last_succeeded", { useTz: false });
      table.timestamp("last_failed", { useTz: false });
    })
    .table("user_action_times", (table) => table.index("user_id"));
