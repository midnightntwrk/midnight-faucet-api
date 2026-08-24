import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { WalletEntry } from "@midnightntwrk/wallet-sdk-facade";
import {
  classifyHistoryEntry,
  observeTxFinality,
  TxFinalityOutcome,
} from "../observe-tx-finality.js";

const HASH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const logger = pino({ level: "silent" });

const POLL_MS = 1_000;
const DEADLINE_MS = 10_000;

/**
 * `WalletEntry` is a large effect-schema type and these tests only exercise the
 * three fields `classifyHistoryEntry` reads. Casting once here keeps that
 * narrowing in a named place rather than scattering casts through the tests.
 */
const asEntry = (entry: Record<string, unknown>): WalletEntry => entry as unknown as WalletEntry;

const pendingEntry = () =>
  asEntry({ hash: HASH, lifecycle: { status: "pending", submittedAt: new Date(0) } });

const finalizedEntry = (status: "SUCCESS" | "FAILURE" | "PARTIAL_SUCCESS") =>
  asEntry({
    hash: HASH,
    status,
    lifecycle: {
      status: "finalized",
      finalizedBlock: { hash: "b", height: 1, timestamp: new Date(0) },
    },
  });

const rejectedEntry = (reason?: string) =>
  asEntry({ hash: HASH, lifecycle: { status: "rejected", rejectedAt: new Date(0), reason } });

const observe = (query: () => Promise<WalletEntry | undefined>) =>
  observeTxFinality(query, HASH, logger, { pollIntervalMs: POLL_MS, deadlineMs: DEADLINE_MS });

/**
 * A lookup that takes `ms` to answer, reading `value` at the moment it resolves —
 * the same way a real query reflects the store when it runs rather than when it was
 * requested.
 */
const delayedBy = <T>(ms: number, value: () => T): Promise<T> =>
  new Promise<T>((resolve) => {
    setTimeout(() => resolve(value()), ms);
  });

describe("classifyHistoryEntry", () => {
  it("reads a missing entry as absent", () => {
    expect(classifyHistoryEntry(undefined)).toEqual({ _tag: "absent" });
  });

  it("reads an entry with no status yet as pending, not as a failure", () => {
    expect(classifyHistoryEntry(pendingEntry())).toEqual({ _tag: "pending" });
  });

  it("reads a successful entry as success", () => {
    expect(classifyHistoryEntry(finalizedEntry("SUCCESS"))).toEqual({ _tag: "success" });
  });

  it.each(["FAILURE", "PARTIAL_SUCCESS"] as const)("reads %s as settled", (status) => {
    expect(classifyHistoryEntry(finalizedEntry(status))).toEqual({ _tag: "settled", status });
  });

  it("reads a rejected entry as rejected, carrying the reason", () => {
    expect(classifyHistoryEntry(rejectedEntry("ttl expired"))).toEqual({
      _tag: "rejected",
      reason: "ttl expired",
    });
  });

  it("reports a rejection with no stated reason rather than dropping it", () => {
    expect(classifyHistoryEntry(rejectedEntry())).toEqual({ _tag: "rejected", reason: undefined });
  });
});

describe("observeTxFinality", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run the deadline out, so an inconclusive watch resolves rather than hanging. */
  const runToDeadline = () => vi.advanceTimersByTimeAsync(DEADLINE_MS);

  it("resolves as soon as the transaction succeeds, without waiting for the deadline", async () => {
    const query = vi.fn(() => Promise.resolve(finalizedEntry("SUCCESS")));
    const outcome = observe(query);

    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toEqual({ _tag: "success" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  // The case that mattered most: a transaction the network finalized as FAILURE used
  // to sit out the full timeout and then log an indistinguishable TimeoutError, so a
  // genuinely failed drip looked exactly like a slow one.
  it("reports a finalized failure as such instead of as a timeout", async () => {
    const outcome = observe(() => Promise.resolve(finalizedEntry("FAILURE")));

    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toEqual({ _tag: "settled", status: "FAILURE" });
  });

  it("reports a network rejection with its reason", async () => {
    const outcome = observe(() => Promise.resolve(rejectedEntry("ttl expired")));

    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toEqual({ _tag: "rejected", reason: "ttl expired" });
  });

  it("resolves pending when the transaction is in history but never finalizes", async () => {
    const outcome = observe(() => Promise.resolve(pendingEntry()));

    await runToDeadline();

    expect(await outcome).toEqual({ _tag: "pending" });
  });

  it("resolves absent when the transaction never reaches history", async () => {
    const outcome = observe(() => Promise.resolve(undefined));

    await runToDeadline();

    expect(await outcome).toEqual({ _tag: "absent" });
  });

  it("keeps watching after a failed lookup rather than giving up", async () => {
    const query = vi
      .fn<() => Promise<WalletEntry | undefined>>()
      .mockRejectedValueOnce(new Error("indexer unreachable"))
      .mockResolvedValue(finalizedEntry("SUCCESS"));
    const outcome = observe(query);

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(await outcome).toEqual({ _tag: "success" });
    expect(query.mock.calls.length).toBeGreaterThan(1);
  });

  // Guards the backpressure choice: lookups must be paced by how long a lookup takes,
  // not by how often the source ticks. `mergeMap` here would fire one concurrent query
  // per tick — ten overlapping lookups per slow one — which is how the original
  // unthrottled pipeline would have behaved had it not been serialised.
  // Note this does not distinguish `exhaustMap` from `concatMap`: both run lookups
  // serially and so make the same number of calls. `exhaustMap` is chosen because it
  // drops the ticks it cannot service instead of buffering them.
  it("paces lookups by their duration rather than by the poll interval", async () => {
    const queryDurationMs = 5_000;
    const query = vi.fn(
      () =>
        new Promise<WalletEntry | undefined>((resolve) => {
          setTimeout(() => resolve(undefined), queryDurationMs);
        }),
    );
    const outcome = observe(query);

    await runToDeadline();

    expect(await outcome).toEqual({ _tag: "absent" });
    // One lookup per query-duration, not one per tick: 10s/5s, not 10s/1s.
    expect(query.mock.calls.length).toBeLessThanOrEqual(DEADLINE_MS / queryDurationMs + 1);
  });

  // Fact 1: a serialising operator does not invoke the lookup for a tick it has
  // queued — it invokes it when it is ready to run it. That is why `concatMap` and
  // `exhaustMap` make the same number of calls, and why a growing backlog is a
  // retention problem rather than a load one. `mergeMap` is the choice this pins
  // against: it would run one lookup per tick, concurrently.
  it("never runs more than one lookup at a time", async () => {
    const queryDurationMs = 3_000;
    // Instrumentation counters — the accepted test-setup exception to const-only.
    const inFlight = { current: 0, max: 0 };
    const query = vi.fn(() => {
      inFlight.current = inFlight.current + 1;
      inFlight.max = Math.max(inFlight.max, inFlight.current);
      return delayedBy(queryDurationMs, () => undefined).finally(() => {
        inFlight.current = inFlight.current - 1;
      });
    });
    const outcome = observe(query);

    await runToDeadline();
    await outcome;

    expect(inFlight.max).toBe(1);
    expect(query.mock.calls.length).toBeGreaterThan(1);
  });

  // Fact 2: each lookup reads history at the moment it runs, so queued or dropped
  // ticks cannot produce a stale answer. This is the claim that corrected the
  // original diagnosis — the 30s timeouts were not a backlog reporting the past,
  // they were `SUCCESS` genuinely not being there yet.
  //
  // Deliberately passes under `concatMap` too: being backlogged is not the same as
  // being stale, and that is the whole point of the test. It fails under `switchMap`,
  // which cancels each in-flight lookup on the next tick and so never reads anything.
  it("reports history as of when the lookup ran, not when its tick fired", async () => {
    const finalizesAtMs = 6_000;
    const queryDurationMs = 2_000;
    const query = vi.fn(() =>
      delayedBy(queryDurationMs, () =>
        Date.now() >= finalizesAtMs ? finalizedEntry("SUCCESS") : pendingEntry(),
      ),
    );
    const startedAt = Date.now();

    const observed = observe(query).then((outcome) => ({
      outcome,
      elapsedMs: Date.now() - startedAt,
    }));
    await runToDeadline();
    const { outcome, elapsedMs } = await observed;

    expect(outcome).toEqual({ _tag: "success" });
    // Seen within one lookup plus one tick of finalization. Were observations
    // accumulating lag, this would drift out towards the deadline instead.
    expect(elapsedMs).toBeLessThanOrEqual(finalizesAtMs + queryDurationMs + POLL_MS);
  });

  it("resolves rather than rejecting when every lookup fails", async () => {
    const outcome: TxFinalityOutcome = await (async () => {
      const promise = observe(() => Promise.reject(new Error("indexer down")));
      await runToDeadline();
      return promise;
    })();

    expect(outcome).toEqual({ _tag: "absent" });
  });
});
