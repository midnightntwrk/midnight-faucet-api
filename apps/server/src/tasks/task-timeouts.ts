/**
 * When the sweep gives up on a task and refunds its rate-limit slot (#595).
 *
 * Shared by both {@link "./task-repository".PostgresqlTaskRepository} and the
 * in-memory repository so the two implementations cannot drift apart.
 *
 * Only `in_progress` tasks are swept. A `scheduled` task is not stranded — `pick`
 * selects on that status, so any healthy instance eventually runs it — whereas an
 * `in_progress` task orphaned by a restart is genuinely dead, its work lost, and
 * refunding is what lets the requester retry the same day.
 */
export const IN_PROGRESS_TIMEOUT_MINUTES = 5;
