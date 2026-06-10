import fc from "fast-check";
import { User, UserAuthenticator, UserId } from "../auth.js";

export const userGen = (auth: UserAuthenticator): fc.Arbitrary<{ user: User; password: string }> =>
  fc
    .record({
      id: fc.uuid().map((id) => new UserId(id)),
      name: fc.string({ minLength: 1 }),
      password: fc.string(),
    })
    .map((value) => {
      const credentials = auth.generateStoredCredentials(value.password);
      return {
        user: new User(value.id, value.name, credentials.salt, credentials.hashedPassword),
        password: value.password,
      };
    });

export const uniqueUserGen = (
  auth: UserAuthenticator,
): fc.Arbitrary<{ user: User; password: string }> =>
  fc.tuple(fc.uuid(), fc.string({ minLength: 1 }), fc.string()).map(([id, name, password]) => {
    const credentials = auth.generateStoredCredentials(password);
    return {
      user: new User(new UserId(id), `${name}-${id}`, credentials.salt, credentials.hashedPassword),
      password,
    };
  });
