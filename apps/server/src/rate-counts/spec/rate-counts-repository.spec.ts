import { Resource } from "@midnightntwrk/faucet-utils";
import pino from "pino";
import { PostgreInfrastructure, postgresInfrastructure } from "../../testing/postgres.js";
import { runRateCountsRepositorySuite } from "./rate-counts-repository-suite.js";
import { PostgresqlRateCountRepository } from "../rate-counts-repository.js";

runRateCountsRepositorySuite({
  infrastructure: postgresInfrastructure,
  instance: ({ knex }: PostgreInfrastructure) =>
    Resource.of(new PostgresqlRateCountRepository(knex, pino({ level: "silent" }))),
});
