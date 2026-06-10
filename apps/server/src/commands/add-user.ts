import { Task } from "@midnight-ntwrk/faucet-utils";
import { User, UserId } from "@midnight-ntwrk/faucet-auth";
import { AuthContext } from "../auth/authContext.js";

type UserData = {
  username: string;
  password: string;
  passIfExists: boolean;
};

export function addUser(authContext: AuthContext, userData: UserData): Task<void> {
  return Task.lift(async () => {
    const newCredentials = authContext.userAuth.generateStoredCredentials(userData.password);
    const newUser = new User(
      UserId.generate(),
      userData.username,
      newCredentials.salt,
      newCredentials.hashedPassword,
    );
    return authContext.userRepository
      .findUserByUsername(userData.username)
      .then((maybeExistingUser) => {
        if (maybeExistingUser instanceof User) {
          if (userData.passIfExists) {
            return;
          } else {
            throw new Error(`User ${userData.username} already exists`);
          }
        }

        return authContext.userRepository.saveUser(newUser);
      });
  });
}
