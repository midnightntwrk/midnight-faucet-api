import { Knex } from "knex";

export const up = (knex: Knex) =>
  knex.schema.createTable("state_snapshots", (table) => {
    table.increments("id").primary();
    table.string("identifier").notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.binary("shielded").notNullable();
    table.binary("unshielded").notNullable();
    table.binary("dust").notNullable();
  });

export const down = (knex: Knex) => knex.schema.dropTable("state_snapshots");
