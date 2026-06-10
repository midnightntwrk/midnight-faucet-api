import { Knex } from "knex";

export const up = async (knex: Knex) => {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  return knex.schema.createTable("tasks", (table) => {
    table.uuid("id").primary().notNullable().unique();
    table.string("address").notNullable();
    table.string("status").notNullable();
    table.binary("state").nullable();
    table.string("picked_by").nullable();
    table.timestamp("start_time").defaultTo(knex.fn.now());
    table.timestamp("end_time").defaultTo(knex.fn.now());
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());
  });
};

export const down = (knex: Knex) => knex.schema.dropTable("tasks");
