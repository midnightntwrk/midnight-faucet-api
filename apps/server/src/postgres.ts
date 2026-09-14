/* eslint-disable @typescript-eslint/no-unsafe-return */
import { pipe, Resource, Task } from "@midnightntwrk/faucet-utils";
import knexLib, { Knex } from "knex";
import { ConnectionOptions } from "node:tls";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { defer, delay, firstValueFrom, map, Observable, of, retry, throwError } from "rxjs";

export type PostgresqlConfig = Readonly<{
  user: string;
  password: string;
  database: string;
  host: string;
  port: number;
  ssl?: ConnectionOptions | boolean;
}>;

const migrationsDirectory = fileURLToPath(new URL("../dist/migrations/", import.meta.url));

export type MigrationResult = { status: "success" } | { status: "failure"; message: string };

export const runMigrations = async (knex: Knex, logger: pino.Logger): Promise<MigrationResult> => {
  try {
    logger.info("Running migrations");

    await knex.migrate.latest({
      directory: migrationsDirectory,
      extension: ".js",
      loadExtensions: [".js"],
    });

    return {
      status: "success",
    };
  } catch (error) {
    return {
      status: "failure",
      message: error instanceof Error ? error.message : JSON.stringify(error),
    };
  }
};

export const checkDb = (knexInstance: Knex, logger: pino.Logger): Promise<void> => {
  logger.debug("Checking db connection");
  return knexInstance.raw("SELECT version()");
};
export const knexResource = (config: PostgresqlConfig, logger: pino.Logger): Resource<Knex> =>
  Resource.make(
    pipe(
      Task.delay(() => {
        logger.debug({ host: config.host, db: config.database }, "Initializing DB connection");
        return knexLib({
          client: "pg",
          connection: config,
          pool: {
            min: 0,
            max: 100,
            acquireTimeoutMillis: 60_000,
            createRetryIntervalMillis: 10,
            createTimeoutMillis: 60_000,
            idleTimeoutMillis: 60_000,
            // Server-side statement timeout. Any single query taking longer
            // than this is killed by Postgres, freeing the pool connection.
            // Without this, a blocked lock or slow query can hold a connection
            // indefinitely and exhaust the pool (`max: 100`), which is also
            // the typical server-wide `max_connections` cap.
            afterCreate: (
              conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
              done: (err: Error | null, conn: unknown) => void,
            ) => {
              conn.query("SET statement_timeout = '30s'", (err) => {
                done(err, conn);
              });
            },
          },
        });
      }),
      Task.flatMapPromise((knexInstance) =>
        pipe(
          defer(() => checkDb(knexInstance, logger)),
          retry({
            delay: (err, count): Observable<void> => {
              logger.error({ err }, "DB connection check failed");
              const nextDelay = 2 ** count * 100;
              return nextDelay > 60_000
                ? throwError(() => err)
                : of(undefined).pipe(delay(nextDelay));
            },
          }),
          map(() => knexInstance),
          (x) => firstValueFrom(x),
        ),
      ),
    ),
    (knexInstance) =>
      Task.lift(() => {
        logger.debug("Closing DB connection");
        return knexInstance.destroy();
      }),
  );
