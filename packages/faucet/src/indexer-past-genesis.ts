import { pipe } from "@midnightntwrk/faucet-utils";
import { either } from "fp-ts";
import * as t from "io-ts";
import pino from "pino";
import { exhaustMap, Observable, shareReplay, takeWhile, tap, timer } from "rxjs";

const LatestBlockResponse = t.type({
  data: t.type({ block: t.type({ height: t.number }) }),
});

/**
 * The wallet SDK values DUST at the timestamp of the indexer's latest block. At genesis
 * that is the genesis DUST coins' own creation time, so they are worth nothing and every
 * drip fails with "could not balance dust". One block later they can pay a fee.
 *
 * Any failure reads as `false`, so the faucet waits rather than dispensing drips that fail.
 */
export const isIndexerPastGenesis = async (indexerURL: URL): Promise<boolean> => {
  try {
    const response = await fetch(indexerURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ block { height } }" }),
      signal: AbortSignal.timeout(5_000),
    });
    const body: unknown = await response.json();
    return pipe(
      LatestBlockResponse.decode(body),
      either.map(({ data }) => data.block.height >= 1),
      either.getOrElse(() => false),
    );
  } catch {
    return false;
  }
};

/** Height never goes back down, so polling stops at the first `true`. */
export const getIndexerPastGenesis = (logger: pino.Logger, indexerURL: URL): Observable<boolean> =>
  timer(0, 2_000).pipe(
    exhaustMap(() => isIndexerPastGenesis(indexerURL)),
    takeWhile((pastGenesis) => !pastGenesis, true),
    tap((pastGenesis) => {
      if (pastGenesis) {
        logger.info("Indexer is past genesis; drips can pay their fees");
      }
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
