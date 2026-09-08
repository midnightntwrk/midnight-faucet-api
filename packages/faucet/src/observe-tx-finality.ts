import { TransactionHistoryStorage } from "@midnightntwrk/wallet-sdk-abstractions";
import { WalletEntry } from "@midnightntwrk/wallet-sdk-facade";
import pino from "pino";
import {
  catchError,
  defaultIfEmpty,
  exhaustMap,
  from,
  interval,
  lastValueFrom,
  map,
  of,
  startWith,
  takeUntil,
  takeWhile,
  timer,
} from "rxjs";

/**
 * How often the wallet's transaction history is asked about a submitted drip.
 *
 * The history store is updated by the SDK's own sync, so polling it on a timer is
 * enough — and it keeps this off `wallet.state()`, which is an unshared
 * `combineLatest` of four sync streams and so emits far more often than there is
 * anything new to see.
 */
export const TX_HISTORY_POLL_INTERVAL_MS = 5_000;

/**
 * How long a submitted drip is watched before it is reported as unconfirmed.
 *
 * This is an observability window, not a correctness bound: nothing waits on the
 * result, and a transaction that has not finalized by now has not necessarily
 * failed — its TTL (30 minutes, see `mkRequestTokens`) is the point after which it
 * genuinely cannot land. Five minutes is chosen to be comfortably longer than
 * block inclusion plus indexing, so a `pending` outcome is worth an operator's
 * attention rather than routine noise.
 */
export const TX_FINALITY_DEADLINE_MS = 5 * 60_000;

/**
 * What watching a submitted transaction established.
 *
 * The three terminal cases are kept apart from the inconclusive ones because they
 * mean opposite things to an operator: `settled`/`rejected` are the network telling
 * us the drip did not work, while the rest only say we stopped looking. Collapsing
 * them is what made the previous implementation unreadable — a rejected transaction
 * and a slow one produced the identical `TimeoutError`.
 *
 * `absent` and `unobservable` are that same distinction one level down. `absent` is
 * an answer — the lookup succeeded and the transaction is not in history — whereas
 * `unobservable` is the absence of one. Reporting an indexer outage as "never
 * appeared" would read as a lost submission when nothing is known either way.
 *
 * `pending` carries the lifecycle it last saw, because "not finalized yet" and
 * "finalized, outcome not yet reported" are different waits: `status` is optional on
 * a `WalletEntry` and populates after `lifecycle` reaches `finalized`.
 */
export type TxFinalityOutcome =
  | { readonly _tag: "success" }
  | {
      readonly _tag: "settled";
      readonly status: TransactionHistoryStorage.TransactionHistoryStatus;
    }
  | { readonly _tag: "rejected"; readonly reason: string | undefined }
  | { readonly _tag: "pending"; readonly lifecycle: "pending" | "finalized" }
  | { readonly _tag: "absent" }
  | { readonly _tag: "unobservable"; readonly error: unknown };

/** Whether the network has spoken, so there is no point looking again. */
export const isTerminalOutcome = (outcome: TxFinalityOutcome): boolean =>
  outcome._tag === "success" || outcome._tag === "settled" || outcome._tag === "rejected";

/**
 * Read one history observation as an outcome.
 *
 * `status` is optional on a `WalletEntry` and is only populated once the
 * transaction finalizes, so an entry that exists with no `status` is still waiting
 * rather than failed — the distinction the old `entry.status === "SUCCESS"` filter
 * silently discarded.
 *
 * `lifecycle` is the schema's own discriminator, so a still-unreported `status` is
 * reported alongside the lifecycle that produced it: a `finalized` entry with no
 * `status` is not "still pending", and saying so would send an operator looking for
 * a transaction that has in fact landed.
 */
export const classifyHistoryEntry = (entry: WalletEntry | undefined): TxFinalityOutcome => {
  if (entry === undefined) {
    return { _tag: "absent" };
  }
  if (entry.lifecycle.status === "rejected") {
    return { _tag: "rejected", reason: entry.lifecycle.reason };
  }
  if (entry.status === "SUCCESS") {
    return { _tag: "success" };
  }
  return entry.status === undefined
    ? { _tag: "pending", lifecycle: entry.lifecycle.status }
    : { _tag: "settled", status: entry.status };
};

/**
 * Watch a submitted transaction until the network settles it or the deadline
 * passes, resolving with the last thing observed.
 *
 * Never rejects: a transaction that cannot be observed is a reportable outcome,
 * not an error, so the caller has one thing to log rather than a success path and
 * a rejection path that mean overlapping things.
 *
 * `exhaustMap` bounds the work: ticks arriving while a lookup is in flight are
 * dropped, so at most one query runs at a time and none accumulate. The previous
 * version used `concatMap` over an unthrottled `wallet.state()`, which *buffers*
 * every emission it cannot service — on a source that emits far faster than the
 * lookup resolves, that queue grows without limit for as long as the watch lasts,
 * once per in-flight drip. It did not make the answers stale (each lookup reads
 * history when it runs), but it is unbounded retention for no benefit, and
 * `mergeMap` here would be worse still: one concurrent query per emission.
 */
export const observeTxFinality = (
  queryTxHistoryByHash: (
    hash: TransactionHistoryStorage.TransactionHash,
  ) => Promise<WalletEntry | undefined>,
  hash: TransactionHistoryStorage.TransactionHash,
  logger: pino.Logger,
  {
    pollIntervalMs = TX_HISTORY_POLL_INTERVAL_MS,
    deadlineMs = TX_FINALITY_DEADLINE_MS,
  }: { pollIntervalMs?: number; deadlineMs?: number } = {},
): Promise<TxFinalityOutcome> =>
  lastValueFrom(
    interval(pollIntervalMs).pipe(
      // Ask immediately rather than waiting out the first interval.
      startWith(0),
      exhaustMap(() =>
        from(queryTxHistoryByHash(hash)).pipe(
          map(classifyHistoryEntry),
          catchError((error: unknown) => {
            // A failed lookup says nothing about the transaction either way, so keep
            // polling — but report it as not having looked rather than as an
            // absence, which would read as a lost submission.
            logger.debug({ err: error, txHash: hash }, "Transaction history query failed");
            return of<TxFinalityOutcome>({ _tag: "unobservable", error });
          }),
        ),
      ),
      // Inclusive, so the terminal observation is the one that ends the stream.
      takeWhile((outcome) => !isTerminalOutcome(outcome), true),
      takeUntil(timer(deadlineMs)),
      // A deadline reached with no lookup yet finished is also "we never looked",
      // and without this `lastValueFrom` would reject on the empty stream.
      defaultIfEmpty<TxFinalityOutcome, TxFinalityOutcome>({
        _tag: "unobservable",
        error: undefined,
      }),
    ),
  );

/**
 * Report an outcome at the severity it deserves.
 *
 * Only `success` is unremarkable. The rest are all warnings, but they are different
 * warnings: the message has to say whether the network rejected the drip, whether it
 * is still waiting, or whether we simply could not look — which is the distinction
 * the single "validation failed" line used to destroy.
 */
export const logTxFinalityOutcome = (
  logger: pino.Logger,
  outcome: TxFinalityOutcome,
  hash: TransactionHistoryStorage.TransactionHash,
  deadlineMs: number = TX_FINALITY_DEADLINE_MS,
): void => {
  switch (outcome._tag) {
    case "success":
      logger.debug({ txHash: hash }, "Transaction confirmed in history");
      return;
    case "settled":
      logger.warn(
        { txHash: hash, status: outcome.status },
        "Transaction finalized without succeeding",
      );
      return;
    case "rejected":
      logger.warn({ txHash: hash, reason: outcome.reason }, "Transaction rejected by the network");
      return;
    case "pending":
      logger.warn(
        { txHash: hash, deadlineMs, lifecycle: outcome.lifecycle },
        outcome.lifecycle === "finalized"
          ? "Transaction finalized but its outcome was not reported before the deadline"
          : "Transaction still pending at the finality deadline",
      );
      return;
    case "absent":
      logger.warn(
        { txHash: hash, deadlineMs },
        "Transaction never appeared in wallet history before the finality deadline",
      );
      return;
    case "unobservable":
      logger.warn(
        { txHash: hash, deadlineMs, err: outcome.error },
        "Could not read wallet history to confirm the transaction",
      );
      return;
    default: {
      // Compiler-enforced exhaustiveness: a new outcome must be given a message
      // here rather than silently logging nothing.
      const unhandled: never = outcome;
      logger.warn({ txHash: hash, outcome: unhandled }, "Unhandled transaction finality outcome");
    }
  }
};
