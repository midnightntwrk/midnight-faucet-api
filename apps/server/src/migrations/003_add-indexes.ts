import { Knex } from "knex";

export const up = (knex: Knex) =>
  knex.schema
    .table("users", (table) => table.index("id").index("name"))
    .table("user_action_times", (table) => table.index("user_id"));

export const down = (knex: Knex) =>
  knex.schema
    .table("users", (table) => table.dropIndex("id").dropIndex("name"))
    .table("user_action_times", (table) => table.dropIndex("user_id"));
