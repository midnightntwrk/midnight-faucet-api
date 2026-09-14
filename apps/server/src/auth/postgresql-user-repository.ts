import { User, UserId, UserRepository, UserRepositoryError } from "@midnightntwrk/faucet-auth";
import { Knex } from "knex";

type UserData = {
  id: string;
  name: string;
  salt: Buffer;
  hashedPassword: Buffer;
};

export class PostgresqlUserRepository implements UserRepository {
  constructor(private readonly knex: Knex<object>) {}

  findUserByUsername(username: string): Promise<User | null> {
    return this.knex<UserData, UserData>("users")
      .select()
      .where("name", username)
      .first()
      .then((result) =>
        result
          ? new User(new UserId(result.id), result.name, result.salt, result.hashedPassword)
          : null,
      );
  }

  saveUser(user: User): Promise<void> {
    return this.knex<UserData, UserData>("users")
      .insert({
        id: user.id.value,
        name: user.name,
        hashedPassword: user.hashedPassword,
        salt: user.salt,
      })
      .onConflict(["id"])
      .merge(["salt", "hashedPassword", "name"])
      .then(() => undefined)
      .catch((error) => {
        throw new UserRepositoryError(
          "Could not save user. Most probably username is taken or the user data is malformed",
          { cause: error },
        );
      });
  }
}
