/* eslint-disable @typescript-eslint/require-await */
import QuickLRU from "quick-lru";
import { Duration, DateTime } from "luxon";
import { subMinutes } from "date-fns";
import {
  CreateITask,
  ITask,
  TaskId,
  TaskRepository,
  TaskStatuses,
  UpdateITask,
} from "../TaskManager.js";

export class InMemoryTaskRepository implements TaskRepository {
  MAX_TASK_AGE = Duration.fromObject({ days: 1 });

  #tasks: QuickLRU<string, ITask>;

  constructor(maxStoredResults: number) {
    this.#tasks = new QuickLRU({
      maxAge: this.MAX_TASK_AGE.toMillis(),
      maxSize: maxStoredResults,
    });
  }

  store = async ({ id, address, amount }: CreateITask): Promise<ITask> => {
    const task = {
      id,
      address,
      state: "",
      status: TaskStatuses.scheduled,
      start_time: DateTime.now().toJSDate(),
      end_time: DateTime.now().toJSDate(),
      created_at: DateTime.now().toJSDate(),
      updated_at: DateTime.now().toJSDate(),
      picked_by: "",
      amount: amount ?? null,
    };

    this.#tasks.set(id, task);

    return task;
  };

  pick = async (): Promise<ITask | undefined> => {
    const task = Array.from(this.#tasks.values()).find(
      (innerTask) => innerTask.status === TaskStatuses.scheduled,
    );

    if (task !== undefined) {
      return task;
    }

    return undefined;
  };

  getByAddress = async (address: string): Promise<ITask | undefined> => {
    const task = Array.from(this.#tasks.values()).find(
      (innerTask) => innerTask.address === address,
    );

    if (task) {
      return task;
    }

    return undefined;
  };

  getById = async (id: TaskId): Promise<ITask | undefined> => {
    const task = this.#tasks.get(id.value);

    if (task) {
      return task;
    }

    return undefined;
  };

  failTimedOutTasks = async (): Promise<void> => {
    Array.from(this.#tasks.values())
      .filter((task) => task.start_time < subMinutes(Date.now(), 5))
      .map((task) => {
        this.#tasks.set(task.id, { ...task, status: "failure" });
      });
  };

  update = async (id: TaskId, task: UpdateITask): Promise<ITask> => {
    const currentTask = this.#tasks.get(id.value);

    if (currentTask) {
      const updatedTask = {
        ...currentTask,
        ...task,
        updated_at: DateTime.now().toJSDate(),
      };

      this.#tasks.set(id.value, updatedTask);

      return updatedTask;
    }

    throw new Error("Task not found");
  };
}
