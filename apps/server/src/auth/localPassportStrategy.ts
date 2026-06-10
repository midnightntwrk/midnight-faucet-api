import {
  AuthenticatedUser,
  InvalidPasswordError,
  UserNotFoundError,
} from "@midnight-ntwrk/faucet-auth";
import * as passportLocal from "passport-local";
import { AuthContext } from "./authContext.js";

export const localPassportStrategy = (authContext: AuthContext) =>
  new passportLocal.Strategy(
    {
      session: false,
    },
    (username, password, done) => {
      authContext.logger.debug({ username }, "Checking user credentials");
      authContext.userRepository
        .findUserByUsername(username)
        .then((user) => {
          if (!user) {
            throw new UserNotFoundError(username);
          } else {
            return authContext.userAuth.verifyPassword(user, password);
          }
        })
        .then(
          (user: AuthenticatedUser) => {
            authContext.logger.trace({ user }, "User authenticated");
            done(null, user);
          },
          (err: Error) => {
            authContext.logger.trace({ error: err, username }, "Invalid credentials");
            if (err instanceof InvalidPasswordError || err instanceof UserNotFoundError) {
              done(null, false);
            } else {
              done(err);
            }
          },
        );
    },
  );
