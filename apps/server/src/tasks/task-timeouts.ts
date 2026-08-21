/**
 * When the sweep gives up on a task, fails it, and refunds its rate-limit slot
 * (#595, #622).
 *
 * Shared by both {@link "./task-repository".PostgresqlTaskRepository} and the
 * in-memory repository so the two implementations cannot drift apart.
 *
 * Both non-terminal statuses are swept, because both can pin an address. Since
 * migration 009 an address may hold only one `scheduled`-or-`in_progress` task, so
 * an unfinished row is not merely idle — it is what stops that address requesting
 * again. Leaving `scheduled` unswept rested on "`pick` selects on that status, so a
 * healthy instance eventually runs it", which bounds the wait only while some
 * instance *is* healthy: with no wallet able to pick, the row never advances, the
 * requester holds a burned slot, and the API reports `PENDING` with no way out
 * (#622). A timeout gives them an escape hatch instead.
 *
 * The two windows differ by an order of magnitude on purpose. An `in_progress` task
 * orphaned by a restart is genuinely dead — its work is lost the moment the process
 * that owned it went away — so five minutes is generous. A `scheduled` task is only
 * stale if nothing has drained the queue for an hour, which means the poller is
 * down rather than merely busy; failing it sooner would abandon requests that a
 * backlog or a brief outage would still have served.
 */
export const IN_PROGRESS_TIMEOUT_MINUTES = 5;

/** @see {@link IN_PROGRESS_TIMEOUT_MINUTES} */
export const SCHEDULED_TIMEOUT_MINUTES = 60;
