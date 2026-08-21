/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Knex } from "knex";
import pino from "pino";
import * as t from "io-ts";
import * as td from "io-ts-types";
import { subMinutes } from "date-fns";
import { IN_PROGRESS_TIMEOUT_MINUTES } from "./task-timeouts.js";

export const TABLE_NAME = "tasks";

export const Status = t.union([
  t.literal("scheduled"),
  t.literal("in_progress"),
  t.literal("failure"),
  t.literal("success"),
]);

export const Task = t.type({
  id: t.string,
  address: t.string,
  state: t.string,
  status: Status,
  picked_by: t.string,
  start_time: td.date,
  end_time: td.date,
  created_at: td.date,
  updated_at: td.date,
  amount: t.union([t.bigint, t.null]),
});

export type StatusType = t.TypeOf<typeof Status>;

export type TaskType = t.TypeOf<typeof Task>;

/**
 * The statuses a task can still dispense from, and so the ones an address may hold
 * only one of. {@link PostgresqlTaskRepository.getByAddress} selects on these and
 * the `tasks_active_address_unique` partial index (migration 009) enforces them, so
 * the two cannot drift into disagreeing about what "already requesting" means.
 */
export const ACTIVE_STATUSES: readonly StatusType[] = ["scheduled", "in_progress"];

export class PostgresqlTaskRepository {
  private readonly Tasks: () => Knex.QueryBuilder<TaskType, TaskType>;

  constructor(
    private readonly knex: Knex,
    private readonly identifier: string,
    private readonly logger: pino.Logger,
  ) {
    this.Tasks = () => knex<TaskType, TaskType>(TABLE_NAME);
  }

  async getById(id: string): Promise<TaskType | undefined> {
    return this.Tasks()
      .where("id", id)
      .first()
      .catch((error: Error) => {
        this.logger.error({ error }, "Error retrieving task snapshot data from DB");
        return undefined;
      });
  }

  /**
   * The task `address` is still waiting on, if any — what {@link
   * "../TaskManager".TaskManager.registerTask} deduplicates a repeat request onto.
   *
   * Selects the active statuses rather than excluding the finished ones. The
   * previous `whereNot("status", ["failure", "succeeded"])` bound a Postgres array
   * literal instead of a `NOT IN` list, so it compared a varchar column against the
   * string `{"failure","succeeded"}` and excluded nothing; with no ordering behind
   * `first()` it then returned an arbitrary row — in practice the oldest, and task
   * rows are never deleted, so a repeat requester's completed first drip shadowed
   * their live one and the dedup missed it every time.
   *
   * Ordered oldest-first to match {@link pick}, so if more than one active row does
   * exist this returns the task that will actually run first.
   */
  async getByAddress(address: string): Promise<TaskType | undefined> {
    return this.Tasks()
      .where("address", address)
      .whereIn("status", [...ACTIVE_STATUSES])
      .orderBy("created_at", "asc")
      .first()
      .catch((error: Error) => {
        this.logger.error({ error }, "Error retrieving task snapshot data from DB");
        return undefined;
      });
  }

  async pick(): Promise<TaskType | undefined> {
    const transaction = await this.knex.transaction();

    try {
      const task = await transaction(TABLE_NAME)
        .where("status", "scheduled")
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .first();

      if (task) {
        await transaction(TABLE_NAME).where("id", task.id).update({
          status: "in_progress",
          picked_by: this.identifier,
          start_time: this.knex.fn.now(),
        });

        await transaction.commit();
        return task;
      } else {
        await transaction.rollback();
        return undefined;
      }
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  async failTimedOutTasks(): Promise<Array<Pick<TaskType, "address" | "created_at">>> {
    return this.Tasks()
      .update({ status: "failure", state: JSON.stringify("Token request failed due to timeout") })
      .where("status", "in_progress")
      .where("start_time", "<", subMinutes(Date.now(), IN_PROGRESS_TIMEOUT_MINUTES))
      .returning(["address", "created_at"]);
  }

  async update(
    id: string,
    task: Partial<Omit<TaskType, "id" | "created_at" | "updated_at">>,
  ): Promise<TaskType> {
    return this.Tasks()
      .update(task)
      .where("id", id)
      .returning("*")
      .then((tasks) => tasks[0]);
  }

  /**
   * Finalize a picked task, but only while it is still `in_progress`. Returns
   * the updated row, or `undefined` if no in-progress row matched — i.e. the
   * timeout sweep already failed (and refunded) it. Lets the caller refund a
   * failed slot exactly once (#595).
   */
  async finalizeIfInProgress(
    id: string,
    task: Partial<Omit<TaskType, "id" | "created_at" | "updated_at">>,
  ): Promise<TaskType | undefined> {
    return this.updateFromStatus(id, "in_progress", task);
  }

  /**
   * Record a success on a task the timeout sweep already marked `failure`.
   *
   * Matching on `status = 'failure'` does double duty: it proves the sweep — not
   * {@link finalizeIfInProgress} — transitioned the row, so the sweep's refund is
   * the one to reclaim, and it makes the reclaim idempotent, because a second
   * call finds no failed row to update (#595).
   */
  async succeedIfFailed(
    id: string,
    task: Partial<Omit<TaskType, "id" | "created_at" | "updated_at">>,
  ): Promise<TaskType | undefined> {
    return this.updateFromStatus(id, "failure", task);
  }

  /**
   * Apply `task` only while the row is still in `expected` status, returning the
   * updated row or `undefined` when nothing matched. The status guard is what makes
   * the slot transitions single-winner under concurrency (#595).
   */
  private async updateFromStatus(
    id: string,
    expected: StatusType,
    task: Partial<Omit<TaskType, "id" | "created_at" | "updated_at">>,
  ): Promise<TaskType | undefined> {
    return this.Tasks()
      .update(task)
      .where("id", id)
      .where("status", expected)
      .returning("*")
      .then((tasks) => tasks[0]);
  }

  async create({
    address,
    id,
    amount,
  }: {
    address: string;
    id: string;
    amount?: bigint;
  }): Promise<TaskType> {
    return this.Tasks()
      .insert({
        address,
        id,
        status: "scheduled",
        amount: amount ?? null,
      })
      .returning("*")
      .then((tasks) => tasks[0]);
  }
}
