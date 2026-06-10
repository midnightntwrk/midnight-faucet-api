import { InvalidTokenError, JwtPayload, UserNotFoundError } from "@midnight-ntwrk/faucet-auth";
import * as passportJwt from "passport-jwt";
import { VerifiedCallback } from "passport-jwt";
import { AuthContext } from "./authContext.js";

export const jwtPassportStrategy = (authContext: AuthContext) =>
  new passportJwt.Strategy(
    {
      jwtFromRequest: passportJwt.ExtractJwt.fromAuthHeaderAsBearerToken(),
      issuer: authContext.userAuth.jwtIssuer,
      secretOrKey: authContext.userAuth.jwtSignSecret,
      algorithms: ["HS256"],
    },
    (payload: JwtPayload, done: VerifiedCallback) => {
      authContext.logger.trace({ sub: payload.sub }, "Verifying JWT");
      const now = new Date();
      authContext.userAuth
        .authenticateVerifiedJWT(payload, now, (username) =>
          authContext.userRepository.findUserByUsername(username),
        )
        .then(
          (user) => {
            authContext.logger.trace({ sub: payload.sub }, "JWT ok");
            done(null, user);
          },
          (error: unknown) => {
            if (error instanceof InvalidTokenError || error instanceof UserNotFoundError) {
              authContext.logger.debug({ sub: payload.sub, error }, "JWT invalid");
              done(null, false);
            } else {
              authContext.logger.error(
                { payload, err: error instanceof Error ? error : String(error) },
                "Error while verifying JWT",
              );
              done(error);
            }
          },
        );
    },
  );
