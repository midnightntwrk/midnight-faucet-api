import { Knex } from "knex";

export const up = (knex: Knex) =>
  knex.schema.createTable("user_action_times", (table) => {
    table.uuid("user_id").primary().notNullable().unique();
    table.timestamp("last_started", { useTz: false });
    table.timestamp("last_succeeded", { useTz: false });
    table.timestamp("last_failed", { useTz: false });
  });

export const down = (knex: Knex) => knex.schema.dropTable("user_action_times");
