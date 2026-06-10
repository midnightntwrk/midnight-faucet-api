import { Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knexLib, { Knex } from "knex";
import * as crypto from "node:crypto";
import pino from "pino";
import { PostgresqlConfig, runMigrations } from "../postgres.js";

export const getPostgresqlConfig = (container: StartedPostgreSqlContainer): PostgresqlConfig => ({
  host: container.getHost(),
  port: container.getPort(),
  database: container.getDatabase(),
  password: container.getPassword(),
  user: container.getUsername(),
});

export const initKnex = (config: PostgresqlConfig) =>
  knexLib({
    client: "pg",
    connection: config,
  });

export type PostgreInfrastructure = {
  config: PostgresqlConfig;
  knex: Knex;
  container: StartedPostgreSqlContainer;
};
export const postgresInfrastructure = (logger: pino.Logger) =>
  Resource.make(
    Task.lift(async () => {
      const dbId = crypto.randomUUID();
      const container = await new PostgreSqlContainer("postgres:15.0").withDatabase(dbId).start();
      const config = getPostgresqlConfig(container);
      const knex = initKnex(config);
      await runMigrations(knex, logger);

      return { config, knex, container };
    }),
    ({ knex, container }) =>
      Task.lift(async () => {
        await knex.destroy();
        await container.stop({ remove: true, removeVolumes: true });
      }),
  );
