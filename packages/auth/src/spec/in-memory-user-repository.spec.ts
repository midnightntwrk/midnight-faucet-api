import { Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { testUserRepository } from "../testing/user-repository-spec.js";
import { InMemoryUserRepository } from "../user-repository.js";

testUserRepository({
  implementationName: "In-memory",
  infrastructure: () => Resource.of(undefined),
  createRepository: () => Resource.fromTask(Task.delay(() => new InMemoryUserRepository())),
});
