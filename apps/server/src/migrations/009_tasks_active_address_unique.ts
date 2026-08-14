import { Knex } from "knex";

const INDEX_NAME = "tasks_active_address_unique";

const ACTIVE = "status in ('scheduled', 'in_progress')";

/**
 * One active task per address, enforced by the database rather than by a read the
 * application does before it writes.
 *
 * `registerTask` reads `getByAddress` and then `create`s, which is check-then-act
 * with nothing behind it: concurrent requests for one address each saw no active
 * task and each created one. The daily counters cap what that costs, but a UI
 * double-submit still produced two drips and burned two slots — the outcome the
 * dedup exists to prevent (#595).
 *
 * A partial index is what makes this expressible: an address may hold any number of
 * finished tasks and only one unfinished one.
 */
export const up = async (knex: Knex) => {
  // Existing rows can already violate this — the dedup predicate was a no-op, so a
  // repeat requester's live task was routinely shadowed and a duplicate created.
  // Keep the oldest active task per address (the one `pick` would run first) and
  // record the rest as failures: they never dispensed, so a failure is what they
  // are. Deliberately no slot refund — that would need per-row window matching
  // against `rate_counts`, and the counters roll over at the next day boundary
  // anyway. Spending an allowance is the conservative way to be wrong here.
  await knex.raw(
    `UPDATE tasks
        SET status = 'failure',
            state = ?,
            end_time = now()
      WHERE ${ACTIVE}
        AND id NOT IN (
              SELECT DISTINCT ON (address) id
                FROM tasks
               WHERE ${ACTIVE}
               ORDER BY address, created_at ASC
            )`,
    [JSON.stringify("Superseded by an earlier request for the same address")],
  );

  return knex.raw(`CREATE UNIQUE INDEX ${INDEX_NAME} ON tasks (address) WHERE ${ACTIVE}`);
};

/** Only the index is reversible; the superseded tasks stay failed. */
export const down = (knex: Knex) => knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
