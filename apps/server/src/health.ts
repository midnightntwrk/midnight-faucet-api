import { pipe } from "@midnightntwrk/faucet-utils";
import pino from "pino";
import { type Observable, type Subscription } from "rxjs";
import * as rx from "rxjs";

export type CheckStatus = "ok" | "not_ok";

const joinStatuses = (prev: CheckStatus, next: CheckStatus): CheckStatus => {
  if (prev === "not_ok") {
    return "not_ok";
  } else {
    return next;
  }
};

type CheckResult = { status: CheckStatus; details: Record<string, CheckStatus> };

export type Check = () => Promise<CheckStatus>;
type Checks<TKeys extends string> = Record<TKeys, Record<string, Check>>;

export type BackgroundCheckOptions = {
  intervalMs?: number;
  attemptTimeoutMs?: number;
  maxAgeMs?: number;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class HealthService<TKeys extends string> {
  static checkFromObservable(results$: Observable<CheckStatus>): Check {
    return () =>
      pipe(
        results$,
        rx.catchError(() => {
          return ["not_ok"] as const;
        }),
        (x) => rx.firstValueFrom(x),
      );
  }

  /**
   * Build a check whose result is populated by a background poller and read
   * synchronously on the probe path. Use for any check that performs network
   * I/O — keeps the probe latency independent of upstream latency and Node
   * event-loop pressure.
   *
   * Returns the {@link Check} plus the {@link Subscription} that drives it,
   * which must be passed to the {@link HealthService} constructor so its
   * lifecycle is tied to the service.
   *
   * Stale results (older than `maxAgeMs`) are reported as `not_ok`, so a
   * silently dead poller cannot keep reporting `ok` forever.
   */
  static makeBackgroundCheck(
    name: string,
    thunk: () => Promise<unknown>,
    logger: pino.Logger,
    opts: BackgroundCheckOptions = {},
  ): { check: Check; subscription: Subscription } {
    const intervalMs = opts.intervalMs ?? 10_000;
    const attemptTimeoutMs = opts.attemptTimeoutMs ?? 8_000;
    const maxAgeMs = opts.maxAgeMs ?? 60_000;

    let cached: { status: CheckStatus; at: number } = { status: "not_ok", at: 0 };
    let lastReported: CheckStatus | null = null;

    const subscription = rx
      .timer(0, intervalMs)
      .pipe(
        rx.exhaustMap(() =>
          rx
            .defer(() => thunk())
            .pipe(
              rx.timeout(attemptTimeoutMs),
              rx.map((): CheckStatus => "ok"),
              rx.catchError((err) => {
                logger.debug(
                  { checkName: name, err: errMsg(err) },
                  `Background check attempt failed: ${name}`,
                );
                return rx.of<CheckStatus>("not_ok");
              }),
            ),
        ),
      )
      .subscribe((status) => {
        cached = { status, at: Date.now() };
        if (lastReported !== status) {
          logger.info(
            { checkName: name, status },
            `Background check status changed: ${name} -> ${status}`,
          );
          lastReported = status;
        }
      });

    const check: Check = () => {
      const age = Date.now() - cached.at;
      if (age > maxAgeMs) {
        return Promise.resolve("not_ok");
      }
      return Promise.resolve(cached.status);
    };

    return { check, subscription };
  }

  constructor(
    private readonly checks: Checks<TKeys>,
    private readonly logger: pino.Logger,
    private readonly backgroundSubscriptions: Subscription[] = [],
  ) {}

  dispose(): void {
    for (const s of this.backgroundSubscriptions) {
      s.unsubscribe();
    }
  }

  doChecks(key: TKeys): Promise<CheckResult> {
    return pipe(
      rx.from(Object.entries(this.checks[key])),
      rx.mergeMap(async ([name, check]: [string, Check]): Promise<[string, CheckStatus]> => [
        name,
        await pipe(
          rx.defer(() => check()),
          // Safety net for misbehaving inline checks. Background-cached
          // checks resolve immediately. Observable-based readiness checks
          // are gated by upstream `auditTime` (250ms) on the wallet state
          // stream, so the first emission can take that long; subsequent
          // checks read the shareReplay-cached value instantly. Anything
          // that takes longer than this bound is, by definition, broken.
          rx.timeout(500),
          rx.materialize(),
          rx.map((notification: rx.ObservableNotification<CheckStatus>) => {
            if (notification.kind === "N") {
              this.logger.trace(
                { checkName: name, result: notification.value },
                `Check finished: ${name}: ${notification.value}`,
              );
              return notification.value;
            } else {
              this.logger.error(
                {
                  checkName: name,
                  result:
                    notification.kind === "E" ? notification.error : "Completed without value",
                },
                `Check failed: ${name}`,
              );
              return "not_ok";
            }
          }),
          (x) => rx.firstValueFrom(x),
        ),
      ]),
      rx.reduce((acc, [name, status]) => {
        return { ...acc, [name]: status };
      }, {}),
      rx.map((statuses: Record<string, CheckStatus>): CheckResult => {
        const finalStatus = Object.values(statuses).reduce(joinStatuses, "ok");
        return {
          status: finalStatus,
          details: statuses,
        };
      }),
      (x) => rx.firstValueFrom(x),
    );
  }
}
