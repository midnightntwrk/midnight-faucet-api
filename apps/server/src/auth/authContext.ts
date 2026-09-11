import { UserAuthenticator, UserRepository } from "@midnightntwrk/faucet-auth";
import pino from "pino";
import { ServerConfig } from "../config.js";

export type AuthContext = {
  userAuth: UserAuthenticator;
  userRepository: UserRepository;
  logger: pino.Logger;
};

export const prepareAuthContext = (
  config: ServerConfig,
  userRepository: UserRepository,
  logger: pino.Logger,
): Omit<AuthContext, "logger"> => ({
  userAuth: new UserAuthenticator(logger, config.jwtIssuer, config.jwtSignSecret),
  userRepository,
});
