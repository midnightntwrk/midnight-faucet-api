import { Knex } from "knex";

export const up = async (knex: Knex) => {
  return knex.schema.alterTable("tasks", (table) => {
    table.bigint("amount").nullable();
  });
};

export const down = (knex: Knex) =>
  knex.schema.alterTable("tasks", (table) => {
    table.dropColumn("amount");
  });
