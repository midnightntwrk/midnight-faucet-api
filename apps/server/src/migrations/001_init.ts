import { Knex } from "knex";

export const up = (knex: Knex) =>
  knex.schema.createTable("users", (table) => {
    table.uuid("id").unique().primary().notNullable();
    table.string("name").unique().notNullable();
    table.binary("salt").unique().notNullable();
    table.binary("hashedPassword").notNullable();
  });

export const down = (knex: Knex) => knex.schema.dropTable("users");
