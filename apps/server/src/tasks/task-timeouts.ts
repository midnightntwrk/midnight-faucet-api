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
 * that owned it went away — so five minutes is generous.
 */
export const IN_PROGRESS_TIMEOUT_MINUTES = 5;

/**
 * How old a `scheduled` task must be before the sweep will consider it stranded.
 *
 * Age alone is not enough to call it that, which is why {@link
 * QUEUE_STALLED_MINUTES} gates it as well: with `maxConcurrentTasks` at 1 the server
 * dispenses one drip at a time, so a burst past capacity leaves the head of the
 * queue genuinely older than an hour while the poller is perfectly healthy. Failing
 * those rows would abandon requests that were about to be served — `pick` is
 * oldest-first, so they are precisely the next ones up.
 */
export const SCHEDULED_TIMEOUT_MINUTES = 60;

/**
 * How long the queue must go without anything being picked before it counts as
 * stalled rather than merely busy.
 *
 * This is the signal {@link SCHEDULED_TIMEOUT_MINUTES} is really appealing to. A
 * healthy instance picks every `pollTime` (5s by default) for as long as there is
 * anything queued, so several minutes of no picks at all means nothing is draining
 * the queue — a wallet that cannot sync, or no live instance. An idle queue does not
 * trip it: a newly queued task is nowhere near the age threshold, and by the time it
 * is, either it has been picked or the queue really is stuck.
 */
export const QUEUE_STALLED_MINUTES = 5;
