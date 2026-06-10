import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import * as crypto from "crypto";
import fc from "fast-check";
import pino from "pino";
import { User, UserAuthenticator } from "../auth.js";
import { UserRepository, UserRepositoryError } from "../user-repository.js";
import { uniqueUserGen, userGen } from "./user-gen.js";

export type UserRepositoryTestContext<TInfrastructure = unknown> = {
  implementationName: string;
  infrastructure: (logger: pino.Logger) => Resource<TInfrastructure>;
  createRepository: (inf: TInfrastructure) => Resource<UserRepository>;
};
export const testUserRepository = <TInfrastructure>(
  context: UserRepositoryTestContext<TInfrastructure>,
) => {
  describe(`${context.implementationName} user repository`, () => {
    const logger = pino({ level: "silent" });
    const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);

    let repository: UserRepository;
    let infrastructure: TInfrastructure;
    let teardown: () => Promise<void>;
    let teardownInfrastructure: () => Promise<void>;

    beforeAll(async () => {
      const allocated = await Task.unsafeRun(Resource.allocate(context.infrastructure(logger)));
      infrastructure = allocated.value;
      teardownInfrastructure = () => Task.unsafeRun(allocated.teardown);
    });

    afterAll(() => teardownInfrastructure());

    beforeEach(async () => {
      const allocated = await Task.unsafeRun(
        Resource.allocate(context.createRepository(infrastructure)),
      );
      repository = allocated.value;
      teardown = () => Task.unsafeRun(allocated.teardown);
    });

    afterEach(() => teardown());

    it("returns a user after saving it", () =>
      fc.assert(
        fc.asyncProperty(uniqueUserGen(auth), async ({ user }) => {
          await repository.saveUser(user);
          const result = await repository.findUserByUsername(user.name);

          expect(result).toEqual(user);
          expect(result).toBeInstanceOf(User);
        }),
      ));

    it("returns null if user was not saved", () =>
      fc.assert(
        fc.asyncProperty(userGen(auth), async ({ user }) => {
          const result = await repository.findUserByUsername(user.name);

          expect(result).toBeNull();
        }),
      ));

    it("overrides previous value on save", () => {
      return fc.assert(
        fc.asyncProperty(uniqueUserGen(auth), async ({ user }) => {
          await repository.saveUser(user);
          const newCredentials = auth.generateStoredCredentials("foo");
          const newUser = user.withCredentials(newCredentials);
          await repository.saveUser(newUser);
          const result = await repository.findUserByUsername(user.name);

          expect(result).toEqual(newUser);

          expect(() => auth.verifyPassword(result!, "foo")).not.toThrow();
        }),
      );
    });

    it("returns an error if user name and id don't match on save", () => {
      return fc.assert(
        fc.asyncProperty(
          fc.array(uniqueUserGen(auth), { minLength: 2, maxLength: 2 }),
          async ([{ user: user1 }, { user: user2 }]) => {
            return pipe(
              context.createRepository(infrastructure),
              Resource.use((freshRepository) => {
                return Task.lift(async () => {
                  await freshRepository.saveUser(user1);
                  await freshRepository.saveUser(user2);
                  const mismatch1 = new User(
                    user1.id,
                    user2.name,
                    user2.salt,
                    user2.hashedPassword,
                  );
                  const mismatch2 = new User(
                    user2.id,
                    user1.name,
                    user1.salt,
                    user1.hashedPassword,
                  );

                  await expect(freshRepository.saveUser(mismatch1)).rejects.toBeInstanceOf(
                    UserRepositoryError,
                  );
                  await expect(freshRepository.saveUser(mismatch2)).rejects.toBeInstanceOf(
                    UserRepositoryError,
                  );
                });
              }),
              Task.unsafeRun,
            );
          },
        ),
      );
    });
  });
};
