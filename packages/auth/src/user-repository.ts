import { User } from "./auth.js";

export class UserRepositoryError extends Error {}
export interface UserRepository {
  findUserByUsername(username: string): Promise<User | null>;
  saveUser(user: User): Promise<void>;
}

export class InMemoryUserRepository implements UserRepository {
  #storage: Map<string, User>;

  constructor(initialStorage: Map<string, User> = new Map()) {
    this.#storage = initialStorage;
  }

  findUserByUsername(username: string): Promise<User | null> {
    const maybeUser = this.#storage.get(username) ?? null;
    return Promise.resolve(maybeUser);
  }

  async saveUser(user: User): Promise<void> {
    const maybeUser = this.#storage.get(user.name);

    if (maybeUser && maybeUser.id.value !== user.id.value) {
      throw new UserRepositoryError("User id and name mismatch");
    }

    this.#storage.set(user.name, user);
    return Promise.resolve();
  }
}
