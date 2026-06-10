import { Knex } from "knex";

export const up = (knex: Knex) =>
  knex.schema.createTable("rate_counts", (table) => {
    table.string("address").primary().notNullable().unique();
    table.integer("count").notNullable().defaultTo(0);
    table.timestamp("updated_at").defaultTo(knex.fn.now());
  });

export const down = (knex: Knex) => knex.schema.dropTable("rate_counts");
