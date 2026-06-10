import { addDays, fromUnixTime, getUnixTime, isBefore } from "date-fns";
import * as crypto from "node:crypto";
import jwt from "jsonwebtoken";
import pino from "pino";

export class UserId {
  static generate(): UserId {
    return new UserId(crypto.randomUUID());
  }

  constructor(public readonly value: string) {}
}
/**
 * A raw user data as received from storage. It is not authenticated yet in any way
 * Should not be used as reference in further action
 */
export class User {
  constructor(
    public readonly id: UserId,
    public readonly name: string,
    public readonly salt: Buffer,
    public readonly hashedPassword: Buffer,
  ) {}

  withCredentials(credentials: { salt: Buffer; hashedPassword: Buffer }): User {
    return new User(this.id, this.name, credentials.salt, credentials.hashedPassword);
  }
}

/**
 * Token that should only be accessible in this file.
 * That way it can be used as a marker/proof when creating an instance of {@link AuthenticatedUser }
 */
const authenticatedUserToken: unique symbol = Symbol("VerifiedAuthUser");

/**
 * A user, who passed authentication
 * can be used as a reference in further actions
 */
export class AuthenticatedUser {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- It's needed for TS to check this class nominally, see https://michalzalecki.com/nominal-typing-in-typescript/
  // @ts-ignore
  // eslint-disable-next-line no-unused-private-class-members
  #token: typeof authenticatedUserToken;

  constructor(
    public readonly user: User,
    token: typeof authenticatedUserToken,
  ) {
    if (token !== authenticatedUserToken) {
      throw new Error('Trying to create "VerifiedAuthUser" without needed token');
    }

    this.#token = authenticatedUserToken;
  }
}

/**
 * Expected shape of payload
 * Reference: https://datatracker.ietf.org/doc/html/rfc7519#section-4.1
 *
 * TODO: use branded types/io-ts for greater type safety
 */
export type JwtPayload = {
  readonly iss: string;
  readonly sub: string;
  readonly exp: number;
};
export class InvalidPasswordError extends Error {
  constructor(public readonly user: User) {
    super(`Invalid password`);
  }
}

export class InvalidTokenError extends Error {
  constructor(public readonly token?: JwtPayload) {
    super(`Invalid token`);
  }
}

export class UserNotFoundError extends Error {
  constructor(public readonly username: string) {
    super(`User ${username} could not be found`);
  }
}

export class ExceedingTokenValidity extends Error {
  constructor(
    public readonly tried: number,
    public readonly max: number,
  ) {
    super(
      `Tried to create a JWT token valid for ${tried} days, while the longest allowed is ${max} days`,
    );
  }
}

/**
 * The building blocks of user authentication upon which further functionalities and integrations can be built
 * It is meant to be primarily a set of pure/almost pure functions, so that thorough testing is possible
 */
export class UserAuthenticator {
  private static generateSalt(): Buffer {
    return crypto.randomBytes(32);
  }

  constructor(
    private readonly logger: pino.Logger,
    public readonly jwtIssuer: string,
    public readonly jwtSignSecret: string | Buffer,
    public readonly hashIterations: number = 310000,
    public readonly maxTokenValidityInDays: number = 180,
  ) {
    if (hashIterations < 1 || !Number.isSafeInteger(hashIterations)) {
      throw new Error("Number of hash iterations should be a positive integer");
    }

    if (
      maxTokenValidityInDays < 1 ||
      maxTokenValidityInDays > 3650 ||
      !Number.isSafeInteger(maxTokenValidityInDays)
    ) {
      throw new Error(
        "Tokens should be valid at least one day and no more than 3650 days (10 years). Only integers are accepted.",
      );
    }
  }

  /**
   * Given user data and password, verify if user password matches
   * @param user - user to authenticate
   * @param password - password to try
   */
  verifyPassword(user: User, password: string): AuthenticatedUser {
    this.logger.debug({ id: user.id, name: user.name }, "Verifying user password");
    const hashed = this.hashPassword(password, user.salt);

    if (!crypto.timingSafeEqual(user.hashedPassword, hashed)) {
      throw new InvalidPasswordError(user);
    }

    return new AuthenticatedUser(user, authenticatedUserToken);
  }

  /**
   * Verify a raw JWT token: checks the signature, issuer, expiration, then
   * resolves the user via `findUser`. This is the safe entry point — callers
   * pass the unverified token string and the method performs cryptographic
   * verification internally before doing anything else.
   *
   * @param token Raw JWT token string (e.g. from an Authorization header)
   * @param now reference Date to check expiry against
   * @param findUser Function to find a user given the verified `sub` claim
   */
  async verifyJWT(
    token: string,
    now: Date,
    findUser: (name: string) => Promise<User | null>,
  ): Promise<AuthenticatedUser> {
    this.logger.debug({ tokenLength: token.length }, "Verifying JWT");

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, this.jwtSignSecret, {
        issuer: this.jwtIssuer,
        algorithms: ["HS256"],
        clockTimestamp: Math.floor(now.getTime() / 1000),
      }) as JwtPayload;
    } catch {
      throw new InvalidTokenError();
    }

    return this.authenticateVerifiedJWT(payload, now, findUser);
  }

  /**
   * Resolve a user from a JWT payload that the CALLER has already
   * cryptographically verified (signature + algorithm).
   *
   * IMPORTANT: this method does NOT verify the JWT signature. It is intended
   * for integration with libraries (e.g. passport-jwt) that perform their own
   * signature verification before invoking application code. For any other
   * caller, use {@link verifyJWT} which takes the raw token and performs
   * verification internally.
   *
   * As defense-in-depth this method re-checks `iss` and `exp` even though a
   * properly-verified payload should already satisfy them.
   *
   * @param payload JWT Payload whose signature has ALREADY been verified
   * @param now reference Date to check expiry against
   * @param findUser Function to find a user
   */
  async authenticateVerifiedJWT(
    payload: JwtPayload,
    now: Date,
    findUser: (name: string) => Promise<User | null>,
  ): Promise<AuthenticatedUser> {
    this.logger.debug({ sub: payload.sub }, "Authenticating pre-verified JWT payload");
    if (payload.iss !== this.jwtIssuer) {
      throw new InvalidTokenError(payload);
    }
    if (isBefore(fromUnixTime(payload.exp), now)) {
      throw new InvalidTokenError(payload);
    }

    const maybeUser = await findUser(payload.sub);
    if (!maybeUser) {
      throw new UserNotFoundError(payload.sub);
    }

    return new AuthenticatedUser(maybeUser, authenticatedUserToken);
  }

  /**
   * Create & sign a JWT
   * @param user User, for who the token is being created
   * @param validityInDays Number of days the token is valid
   * @param now Date used as a reference in expiry date calculation
   */
  createJWT(user: AuthenticatedUser, validityInDays: number, now: Date): string {
    this.logger.debug(
      { id: user.user.id, name: user.user.name, validityInDays },
      "Issuing new JWT",
    );
    if (validityInDays > this.maxTokenValidityInDays) {
      throw new ExceedingTokenValidity(validityInDays, this.maxTokenValidityInDays);
    }

    const payload: JwtPayload = {
      iss: this.jwtIssuer,
      sub: user.user.name,
      exp: getUnixTime(addDays(now, validityInDays)),
    };

    return jwt.sign(payload, this.jwtSignSecret);
  }

  /**
   * Generate password-related credentials to be stored as part of user datatype
   * @param password Password used to calculate the credentials
   */
  generateStoredCredentials(password: string): { hashedPassword: Buffer; salt: Buffer } {
    const salt = UserAuthenticator.generateSalt();
    return {
      salt,
      hashedPassword: this.hashPassword(password, salt),
    };
  }

  private hashPassword(password: string, salt: Buffer): Buffer {
    const generatedKeyLength = 32;
    return crypto.pbkdf2Sync(password, salt, this.hashIterations, generatedKeyLength, "sha256");
  }
}
