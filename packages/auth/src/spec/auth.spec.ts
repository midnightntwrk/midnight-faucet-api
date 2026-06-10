import * as crypto from "crypto";
import { addDays, addYears, fromUnixTime, isSameDay } from "date-fns";
import fc from "fast-check";
import jwt from "jsonwebtoken";
import pino from "pino";
import {
  ExceedingTokenValidity,
  InvalidPasswordError,
  InvalidTokenError,
  JwtPayload,
  User,
  UserAuthenticator,
  UserNotFoundError,
  AuthenticatedUser,
  UserId,
} from "../auth.js";
import { userGen } from "../testing/user-gen.js";

describe("Auth", () => {
  const logger = pino({ level: "silent" });
  describe("with username and password", () => {
    it("provides a validated user if correct username and password are provided", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      fc.assert(
        fc.property(userGen(auth), ({ user, password }) => {
          const result = auth.verifyPassword(user, password);

          expect(result).toBeInstanceOf(AuthenticatedUser);
          expect(result.user).toBe(user);
        }),
      );
    });

    it("allows to generate password-related credentials for a given password such that pass password verification", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      fc.assert(
        fc.property(
          fc.record({ username: fc.string(), password: fc.string() }),
          ({ username, password }) => {
            const credentials = auth.generateStoredCredentials(password);
            const user = new User(
              UserId.generate(),
              username,
              credentials.salt,
              credentials.hashedPassword,
            );

            const result = auth.verifyPassword(user, password);

            expect(result).toBeInstanceOf(AuthenticatedUser);
          },
        ),
      );
    });

    it("errors if password is incorrect", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      fc.assert(
        fc.property(
          userGen(auth).chain((userData) =>
            fc
              .string()
              .filter((str) => str !== userData.password)
              .map((wrongPassword) => ({
                ...userData,
                wrongPassword,
              })),
          ),
          ({ user, wrongPassword }) => {
            expect(() => auth.verifyPassword(user, wrongPassword)).toThrow(InvalidPasswordError);
          },
        ),
      );
    });

    it("errors if salt is different", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      fc.assert(
        fc.property(
          userGen(auth).chain((userData) =>
            fc
              .base64String()
              .map((str) => Buffer.from(str, "base64"))
              .filter((buffer) => !buffer.equals(userData.user.salt))
              .map((wrongSalt) => ({ ...userData, wrongSalt })),
          ),
          ({ user, password, wrongSalt }) => {
            const newUser = new User(UserId.generate(), user.name, wrongSalt, user.hashedPassword);
            expect(() => auth.verifyPassword(newUser, password)).toThrow(InvalidPasswordError);
          },
        ),
      );
    });
  });

  describe("with JWT", () => {
    it("allows to create token for a validated user", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      fc.assert(
        fc.property(
          userGen(auth),
          fc.integer({ min: 1, max: auth.maxTokenValidityInDays }), // too many days forward and the library complains about wrong expiry value
          ({ user, password }, daysForward) => {
            const verified = auth.verifyPassword(user, password);
            const now = new Date();

            const token = auth.createJWT(verified, daysForward, now);
            const verifiedToken = jwt.verify(token, auth.jwtSignSecret, {
              issuer: auth.jwtIssuer,
              subject: user.name,
              complete: false,
            }) as JwtPayload;

            expect(isSameDay(addDays(now, daysForward), fromUnixTime(verifiedToken.exp))).toBe(
              true,
            );
          },
        ),
      );
    });

    it("does not allow to create tokens that expire after upper bound set in configuration", () => {
      const dataGen = fc
        .integer({ min: 1, max: 3650 })
        .map((maxValidity) => ({
          auth: new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5, maxValidity),
        }))
        .chain((ctx) => userGen(ctx.auth).map((user) => ({ ...ctx, user })))
        .chain((ctx) =>
          fc.integer({ min: 1 }).map((addedValidity) => ({
            ...ctx,
            exceedingValidity: ctx.auth.maxTokenValidityInDays + addedValidity,
          })),
        );

      return fc.assert(
        // eslint-disable-next-line @typescript-eslint/require-await
        fc.asyncProperty(dataGen, async ({ auth, user: { user, password }, exceedingValidity }) => {
          const verified = auth.verifyPassword(user, password);
          const now = new Date();

          expect(() => auth.createJWT(verified, exceedingValidity, now)).toThrow(
            ExceedingTokenValidity,
          );
        }),
      );
    });

    it.concurrent("provides a validated user when verifying token", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      return fc.assert(
        fc.asyncProperty(userGen(auth), async ({ user, password }) => {
          const verified = auth.verifyPassword(user, password);
          const now = new Date();
          const token = auth.createJWT(verified, 42, now);

          const result = await auth.verifyJWT(token, now, () => Promise.resolve(user));

          expect(result).toBeInstanceOf(AuthenticatedUser);
          expect(result.user).toBe(user);
        }),
      );
    });

    it.concurrent("errors if supplied function cannot find user", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      return fc.assert(
        fc.asyncProperty(userGen(auth), async ({ user, password }) => {
          const verified = auth.verifyPassword(user, password);
          const now = new Date();
          const token = auth.createJWT(verified, 1, now);

          await expect(auth.verifyJWT(token, now, () => Promise.resolve(null))).rejects.toThrow(
            UserNotFoundError,
          );
        }),
      );
    });

    it.concurrent("errors if issuer doesn't match configuration", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      return fc.assert(
        fc.asyncProperty(userGen(auth), fc.string(), async ({ user, password }, wrongIssuer) => {
          const verified = auth.verifyPassword(user, password);
          const now = new Date();
          const token = auth.createJWT(verified, 1, now);
          const payload = jwt.decode(token, { complete: false }) as JwtPayload;
          const modifiedPayload = { ...payload, iss: wrongIssuer };
          const tokenWithWrongIssuer = jwt.sign(modifiedPayload, auth.jwtSignSecret);

          await expect(
            auth.verifyJWT(tokenWithWrongIssuer, now, () => Promise.resolve(user)),
          ).rejects.toThrow(InvalidTokenError);
        }),
      );
    });

    it.concurrent("errors if expiry date is before reference one", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      return fc.assert(
        fc.asyncProperty(
          userGen(auth),
          fc.date({ noInvalidDate: true, min: new Date(0), max: addYears(new Date(), 50) }),
          fc.integer({ min: 1, max: 3650 }),
          async ({ user, password }, referenceDate, numberOfDays) => {
            const verified = auth.verifyPassword(user, password);
            const token = auth.createJWT(verified, 0, referenceDate);

            await expect(
              auth.verifyJWT(token, addDays(referenceDate, numberOfDays), () =>
                Promise.resolve(user),
              ),
            ).rejects.toThrow(InvalidTokenError);
          },
        ),
      );
    });

    it.concurrent("errors if signature is forged with wrong secret", () => {
      const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
      return fc.assert(
        fc.asyncProperty(userGen(auth), async ({ user, password }) => {
          const verified = auth.verifyPassword(user, password);
          const now = new Date();
          const legitToken = auth.createJWT(verified, 1, now);
          const payload = jwt.decode(legitToken, { complete: false }) as JwtPayload;
          // Attacker re-signs the same payload with a different secret
          const forgedToken = jwt.sign(payload, crypto.randomBytes(32));

          await expect(
            auth.verifyJWT(forgedToken, now, () => Promise.resolve(user)),
          ).rejects.toThrow(InvalidTokenError);
        }),
      );
    });
  });

  it("doesn't allow to create verified users from outside", () => {
    const auth = new UserAuthenticator(logger, "foo", crypto.randomBytes(32), 5);
    fc.assert(
      fc.property(
        userGen(auth),
        fc.string().map((str) => Symbol(str)),
        ({ user }, someSymbol) => {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          expect(() => new AuthenticatedUser(user, someSymbol)).toThrow();
        },
      ),
    );
  });
});
