import { Resource } from "@midnight-ntwrk/faucet-utils";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";
import { PostgresqlUserActionTimesRepository } from "../postgresql-user-action-times-repository.js";
import { runUserActionTimesRepositorySuite } from "./user-action-times-repository-suite.js";

runUserActionTimesRepositorySuite({
  implementationName: "postgresql",
  infrastructure: postgresInfrastructure,
  instance: ({ knex }: PostgreInfrastructure) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    Resource.of(new PostgresqlUserActionTimesRepository(knex)),
});
