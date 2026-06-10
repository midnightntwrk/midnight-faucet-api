import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { ServerConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { knexResource, MigrationResult, runMigrations } from "../postgres.js";

export function migrateDb(config: ServerConfig): Task<MigrationResult> {
  const logger = createLogger(config.logging);
  return pipe(
    knexResource(config.db, logger),
    Resource.use((knex) => Task.lift(() => runMigrations(knex, logger))),
  );
}
