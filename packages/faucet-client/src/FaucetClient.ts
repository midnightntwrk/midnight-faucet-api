import {
  dripRequestCodec,
  dripResponseCodec,
  DripResponse,
  ErrorResponse,
  errorResponseCodec,
  FaucetClientRequests,
  WalletAddress,
} from "@midnight-ntwrk/faucet-internal-api";
import { either } from "fp-ts";
import * as t from "io-ts";
import { PathReporter } from "io-ts/lib/PathReporter.js";
import { catchError, distinctUntilChanged, from, of, shareReplay, switchMap, timer } from "rxjs";

/**
 * FaucetClient-specific subclass of `Error`
 */
export class ClientError extends Error {
  /**
   * Error type. Following values are expected:
   *
   * - "decoding_error" -- to indicate decoding of request or response payload failed (is generally not expected when using the client)
   * - "error" -- to indicate general/unexpected error that occurred when processing a request
   * - "auth_error" -- to indicate authentication error
   * - "rate_limit_error" -- to indicate exceeding rate limit set in place
   */
  public readonly type: ErrorResponse["status"];

  constructor(type: ErrorResponse["status"], message: string) {
    super(message);
    this.type = type;
  }
}

const parseResponse =
  <T>(codec: t.Type<T, unknown, unknown>) =>
  (response: unknown): Promise<T> => {
    const decodeResult = codec.decode(response);

    return either.fold(
      (errors: t.Errors) =>
        Promise.resolve(errors)
          .then(t.failures)
          .then(PathReporter.report)
          .then((array) => array.join("\n"))
          .then((message) => Promise.reject(new Error(message))),
      (value: T) => Promise.resolve(value),
    )(decodeResult);
  };

const parseDripResponse = parseResponse(dripResponseCodec);

const parseJSON = async (response: {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<unknown> => {
  if (response.ok) {
    return response.json();
  } else if (!response.ok && response.status === 401) {
    return response.text().then((text) => Promise.reject(new ClientError("auth_error", text)));
  } else if (!response.ok && response.status === 429) {
    return response
      .text()
      .then((text) => Promise.reject(new ClientError("rate_limit_error", text)));
  } else {
    return response.json().then((parsed) => {
      const maybeKnownError = errorResponseCodec.decode(parsed);
      const error = either.fold(
        () => {
          // Try to extract error message from drip API error format
          const dripError = parsed as { error?: string };
          if (dripError.error) {
            return new ClientError("error", dripError.error);
          }
          return new ClientError("decoding_error", JSON.stringify(parsed));
        },
        (err: ErrorResponse) => new ClientError(err.status, err.message),
      )(maybeKnownError);

      return Promise.reject(error);
    });
  }
};

/**
 * Client's entrypoint. It takes  and (optionally) fetch function to use.
 * @param url - API url, like `http://localhost:5300/api` in local development
 * @param pollInterval - how often check request status
 * @param fetchFn - fetch function to use. By default it is `global.fetch`, but in case of additional
 *   configurations needed it is possible to override it with any compatible function
 */

interface FaucetClientI {
  url: string;
  pollInterval: number;
}
export const FaucetClient = ({
  url,
  pollInterval = 10_000,
}: FaucetClientI): FaucetClientRequests => {
  const pollForResponse = (dripId: string, errorRetriesLeft = 100): Promise<DripResponse> => {
    const makeCall = (): Promise<DripResponse> => {
      return fetch(`${url}/drips/${dripId}`, {
        headers: {
          "Content-Type": "application/json",
        },
      })
        .then(parseJSON)
        .then(parseDripResponse);
    };

    const delay = () =>
      new Promise((resolve) => {
        setTimeout(
          resolve,
          pollInterval + Math.round((Math.random() * 2 * pollInterval) / 5 - pollInterval / 5),
        ); // By default every 10s +/- 2s
      });

    return delay()
      .then(() => makeCall())
      .then(
        (drip) => {
          switch (drip.status) {
            case "PENDING":
              return pollForResponse(dripId, errorRetriesLeft);
            case "CONFIRMED":
              return Promise.resolve(drip);
            case "FAILED":
              return Promise.reject(new ClientError("error", drip.error ?? "Drip failed"));
          }
        },
        (error) => {
          // eslint-disable-next-line no-console
          console.error("Got error from faucet", error);
          if (errorRetriesLeft >= 1) {
            return pollForResponse(dripId, errorRetriesLeft - 1);
          } else {
            throw new ClientError("error", String(error));
          }
        },
      );
  };

  const healthStatus$ = timer(0, 30_000).pipe(
    switchMap(() =>
      from(
        fetch(`${url}/health`)
          .then((response) => response.json())
          .then((data) => {
            const status =
              (data as { status?: string }).status === "SERVING"
                ? ("ok" as const)
                : ("not_ok" as const);
            return { status };
          }),
      ).pipe(catchError(() => of({ status: "not_ok" as const }))),
    ),
    distinctUntilChanged((prev, curr) => prev.status === curr.status),
    shareReplay(1),
  );

  return {
    requestTokens(
      address: WalletAddress,
      captchaToken: string,
      amount: string,
    ): Promise<DripResponse> {
      const request = {
        recipientAddress: address,
        amount: BigInt(amount),
      };
      return fetch(`${url}/drips`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Captcha-Token": captchaToken,
        },
        body: JSON.stringify(dripRequestCodec.encode(request)),
      })
        .then(parseJSON)
        .then(parseDripResponse)
        .then((drip: DripResponse) => pollForResponse(drip?.dripId));
    },
    healthStatus$,
  };
};
