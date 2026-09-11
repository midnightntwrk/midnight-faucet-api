import { Task } from "@midnightntwrk/faucet-utils";
import { User } from "@midnightntwrk/faucet-auth";
import { AuthContext } from "../auth/authContext.js";

type UserData = {
  username: string;
  password: string;
};

export function changePassword(authContext: AuthContext, userData: UserData): Task<void> {
  return Task.lift(async () => {
    return authContext.userRepository
      .findUserByUsername(userData.username)
      .then((maybeExistingUser) => {
        if (maybeExistingUser == null) {
          throw new Error(`User ${userData.username} does not exist`);
        }

        const newCredentials = authContext.userAuth.generateStoredCredentials(userData.password);
        const newUser = new User(
          maybeExistingUser.id,
          maybeExistingUser.name,
          newCredentials.salt,
          newCredentials.hashedPassword,
        );

        return authContext.userRepository.saveUser(newUser);
      });
  });
}
