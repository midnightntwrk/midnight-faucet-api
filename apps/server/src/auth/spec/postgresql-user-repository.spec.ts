import { Resource, Task } from "@midnightntwrk/faucet-utils";
import { testUserRepository } from "@midnightntwrk/faucet-auth/dist/testing";
import pino from "pino";
import { PostgresqlUserRepository } from "../postgresql-user-repository.js";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";

testUserRepository<PostgreInfrastructure>({
  implementationName: "postgres",
  infrastructure: (logger: pino.Logger) => postgresInfrastructure(logger),
  createRepository: ({ knex }: PostgreInfrastructure) =>
    Resource.fromTask(
      Task.lift(() =>
        knex("users")
          .delete()
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          .then(() => new PostgresqlUserRepository(knex)),
      ),
    ),
});
