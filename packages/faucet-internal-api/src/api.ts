import * as t from "io-ts";
import { Observable } from "rxjs";
import { Duration } from "luxon";
import { ShieldedAddress, UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

const ShieldedAddressCodec = new t.Type<ShieldedAddress, ShieldedAddress, unknown>(
  "ShieldedAddress",
  (u): u is ShieldedAddress => u instanceof ShieldedAddress,
  (u, c) => (u instanceof ShieldedAddress ? t.success(u) : t.failure(u, c)),
  (a) => a,
);

const UnshieldedAddressCodec = new t.Type<UnshieldedAddress, UnshieldedAddress, unknown>(
  "UnshieldedAddress",
  (u): u is UnshieldedAddress => u instanceof UnshieldedAddress,
  (u, c) => (u instanceof UnshieldedAddress ? t.success(u) : t.failure(u, c)),
  (a) => a,
);

export const walletAddressCodec = t.string;
export const captchaTokenCodec = t.string;
export type CaptchaToken = t.TypeOf<typeof captchaTokenCodec>;
export type WalletAddress = t.TypeOf<typeof walletAddressCodec>;

export const tokenRequestCodec = t.type({
  address: walletAddressCodec,
  captchaToken: captchaTokenCodec,
});
export type TokenRequest = t.TypeOf<typeof tokenRequestCodec>;

export const backgroundTaskResponseCodec = t.string;
export type BackgroundTaskId = t.TypeOf<typeof backgroundTaskResponseCodec>;

export const durationCodec = t.string.pipe(
  new t.Type<Duration, string, string>(
    "duration",
    (x): x is Duration => x instanceof Duration && x.isValid,
    (input: string, context) => {
      try {
        const res = Duration.fromISO(input);
        if (res.isValid) {
          return t.success(res);
        } else {
          return t.failure(
            input,
            context,
            `Reason:
  ${res.invalidReason},
Explanation:
  ${res.invalidExplanation}`,
          );
        }
      } catch (e) {
        return t.failure(input, context, e instanceof Error ? e.message : JSON.stringify(e));
      }
    },
    (duration: Duration): string => {
      return duration.toISO()!;
    },
  ),
);

export const tokenResponseCodec = t.type({
  transactionIdentifier: t.string,
  // It's a bit unfortunate this has to be here, probably it makes sense to decouple faucet and faucet client types
  // and let this API to be only definition for the JSON API
  timeToNextRequest: durationCodec,
});
export type TokenResponse = t.TypeOf<typeof tokenResponseCodec>;
export type TokenResponseOutput = t.OutputOf<typeof tokenResponseCodec>;

export const statusResponseCodec = t.union([
  t.type({
    status: t.literal("scheduled"),
  }),
  t.type({
    status: t.literal("in_progress"),
  }),
  t.type({
    status: t.literal("success"),
    value: tokenResponseCodec,
  }),
  t.type({
    status: t.literal("failure"),
    error: t.string,
  }),
]);
export type StatusResponse = t.TypeOf<typeof statusResponseCodec>;

export const jwtResponseCodec = t.string;
export type JWTResponse = t.TypeOf<typeof jwtResponseCodec>;

export const errorResponseCodec = t.type({
  status: t.union([
    t.literal("decoding_error"),
    t.literal("error"),
    t.literal("auth_error"),
    t.literal("rate_limit_error"),
  ]),
  message: t.string,
});
export type ErrorResponse = t.TypeOf<typeof errorResponseCodec>;

// Third-party Drip API types
const bigintFromString = new t.Type<bigint, string, unknown>(
  "bigintFromString",
  (u): u is bigint => typeof u === "bigint",
  (u, c) => {
    if (typeof u === "string") {
      try {
        return t.success(BigInt(u));
      } catch {
        return t.failure(u, c, "Expected an integer number");
      }
    }
    return t.failure(u, c, "Expected a non-negative integer string");
  },
  (a) => a.toString(),
);

export const dripRequestCodec = t.type({
  recipientAddress: walletAddressCodec,
  amount: bigintFromString,
});
export type DripRequest = t.TypeOf<typeof dripRequestCodec>;

export const dripStatusCodec = t.union([
  t.literal("PENDING"),
  t.literal("CONFIRMED"),
  t.literal("FAILED"),
]);
export type DripStatus = t.TypeOf<typeof dripStatusCodec>;

export const dripResponseCodec = t.type({
  dripId: t.string,
  status: dripStatusCodec,
  taskStatus: t.union([t.string, t.null]),
  transactionHash: t.union([t.string, t.null]),
  error: t.union([t.string, t.null]),
});
export type DripResponse = t.TypeOf<typeof dripResponseCodec>;

export const dripHealthStatusCodec = t.union([t.literal("SERVING"), t.literal("NOT_SERVING")]);
export type DripHealthStatus = t.TypeOf<typeof dripHealthStatusCodec>;

export const dripHealthResponseCodec = t.type({
  status: dripHealthStatusCodec,
  reason: t.union([t.string, t.null]),
  needsRestart: t.boolean,
});
export type DripHealthResponse = t.TypeOf<typeof dripHealthResponseCodec>;

// Third-party Drip API (the `/v1` surface, per the Google Drip API spec).
// The `drip*` codecs above stay the public `/api` contract the UI client speaks.

/**
 * Error codes the third-party API reports. All but the last are the canonical
 * literals the spec defines; `INVALID_REQUEST` covers a malformed body or an
 * out-of-range amount, which the spec has no literal for. Unrecognised literals
 * are defaulted to `INTERNAL_ERROR` by the caller, so it degrades safely while
 * staying legible in our own logs.
 */
export const dripErrorCodeCodec = t.union([
  t.literal("INVALID_ADDRESS"),
  t.literal("UNSUPPORTED_NETWORK"),
  t.literal("UNSUPPORTED_TOKEN"),
  t.literal("INVALID_API_KEY"),
  t.literal("VERIFICATION_REJECTED"),
  t.literal("DUPLICATE_CLAIM"),
  t.literal("RATE_LIMIT_EXCEEDED"),
  t.literal("INSUFFICIENT_FUNDS"),
  t.literal("SERVICE_UNAVAILABLE"),
  t.literal("INTERNAL_ERROR"),
  t.literal("INVALID_REQUEST"),
]);
export type DripErrorCode = t.TypeOf<typeof dripErrorCodeCodec>;

export const dripErrorCodec = t.type({
  code: dripErrorCodeCodec,
  message: t.union([t.string, t.null]),
});
export type DripError = t.TypeOf<typeof dripErrorCodec>;

export const thirdPartyErrorResponseCodec = t.type({
  error: dripErrorCodec,
});
export type ThirdPartyErrorResponse = t.TypeOf<typeof thirdPartyErrorResponseCodec>;

/**
 * `amount` stays a raw string here rather than decoding straight to `bigint`:
 * parsing it separately is what lets a bad amount answer with its own error code
 * instead of a generic decode failure. It is denominated in the token's smallest
 * unit, and is optional — an omitted amount falls back to the configured default.
 */
export const thirdPartyDripRequestCodec = t.intersection([
  t.type({
    recipientAddress: walletAddressCodec,
    network: t.string,
    token: t.string,
  }),
  t.partial({
    amount: t.union([t.string, t.null]),
    fulfillmentContext: t.union([t.UnknownRecord, t.null]),
  }),
]);
export type ThirdPartyDripRequest = t.TypeOf<typeof thirdPartyDripRequestCodec>;

export const thirdPartyCreateDripResponseCodec = t.type({
  dripId: t.string,
});
export type ThirdPartyCreateDripResponse = t.TypeOf<typeof thirdPartyCreateDripResponseCodec>;

export const thirdPartyDripStatusResponseCodec = t.type({
  dripId: t.string,
  status: dripStatusCodec,
  transactionHash: t.union([t.string, t.null]),
  error: t.union([dripErrorCodec, t.null]),
});
export type ThirdPartyDripStatusResponse = t.TypeOf<typeof thirdPartyDripStatusResponseCodec>;

export const thirdPartyDripInfoResponseCodec = t.type({
  dripAmount: t.string,
});
export type ThirdPartyDripInfoResponse = t.TypeOf<typeof thirdPartyDripInfoResponseCodec>;

export const thirdPartyHealthResponseCodec = t.type({
  status: dripHealthStatusCodec,
  reason: t.union([t.string, t.null]),
});
export type ThirdPartyHealthResponse = t.TypeOf<typeof thirdPartyHealthResponseCodec>;

export const loginCodec = t.type({
  username: t.string,
  password: t.string,
});

export const newTokenPayloadCodec = t.type({
  validDays: t.refinement(
    t.number,
    (number) => Number.isInteger(number) && number > 0,
    "positive integer",
  ),
});

export interface FaucetAuth {
  /**
   * Allows to log in with provided username and password. Its response is a short-lived JWT token
   */
  login(username: string, password: string): Promise<JWTResponse>;

  /**
   * Allows to obtain a new, long-lived JWT token
   */
  getNewToken(currentToken: string, validDays: number): Promise<JWTResponse>;
}

// This is the mapped state we use when we get state changes from the wallets
export const faucetStateCodec = t.readonly(
  t.type({
    shielded: t.type({
      address: ShieldedAddressCodec,
      availableCoins: t.array(t.bigint),
      totalCoins: t.array(t.bigint),
      pendingCoins: t.array(t.bigint),
      availableBalance: t.bigint,
      syncProgress: t.type({
        appliedIndex: t.bigint,
        highestRelevantWalletIndex: t.bigint,
        highestIndex: t.bigint,
        highestRelevantIndex: t.bigint,
        isConnected: t.boolean,
      }),
      isSynced: t.boolean,
    }),
    unshielded: t.type({
      address: UnshieldedAddressCodec,
      availableCoins: t.array(t.bigint),
      totalCoins: t.array(t.bigint),
      pendingCoins: t.array(t.bigint),
      availableBalance: t.bigint,
      syncProgress: t.type({
        appliedId: t.bigint,
        highestTransactionId: t.bigint,
        isConnected: t.boolean,
      }),
      isSynced: t.boolean,
    }),
    dust: t.type({
      availableCoins: t.array(t.bigint),
      totalCoins: t.array(t.bigint),
      pendingCoins: t.array(t.bigint),
      availableBalance: t.bigint,
      syncProgress: t.type({
        appliedIndex: t.bigint,
        highestRelevantWalletIndex: t.bigint,
        highestIndex: t.bigint,
        highestRelevantIndex: t.bigint,
        isConnected: t.boolean,
      }),
      isSynced: t.boolean,
    }),
  }),
);
export type FaucetState = t.TypeOf<typeof faucetStateCodec> & {
  shielded: { address: ShieldedAddress };
};

export interface FaucetRequests {
  requestTokens: <T extends object = object>(
    address: WalletAddress,
    loggingContext?: T,
    amount?: bigint,
  ) => Promise<TokenResponse>;
}

export interface HealthStatus {
  status: "ok" | "not_ok";
}

export interface FaucetClientRequests {
  requestTokens: (
    address: WalletAddress,
    captchaToken: CaptchaToken,
    amount: string,
  ) => Promise<DripResponse>;
  healthStatus$: Observable<HealthStatus>;
}

type SerializedCompositeWalletState = {
  shielded: Promise<string>;
  unshielded: Promise<string>;
  dust: Promise<string>;
};
export interface Faucet extends FaucetRequests {
  dropAmount: string;
  address: WalletAddress;
  state$: Observable<FaucetState>;
  syncErrors$: Observable<unknown>;

  serializeWalletState: () => SerializedCompositeWalletState;
}
