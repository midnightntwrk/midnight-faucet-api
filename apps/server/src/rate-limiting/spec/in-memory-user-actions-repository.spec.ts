import { Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { InMemoryUserActionTimesRepository } from "../in-memory-user-action-times-repository.js";
import { runUserActionTimesRepositorySuite } from "./user-action-times-repository-suite.js";

runUserActionTimesRepositorySuite({
  implementationName: "in-memory",
  infrastructure: () => Resource.of(undefined),
  instance: () => Resource.fromTask(Task.delay(() => new InMemoryUserActionTimesRepository())),
});
