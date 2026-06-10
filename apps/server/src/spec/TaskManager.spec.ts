/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import _ from "lodash";
import pino from "pino";
import * as rx from "rxjs";
import { asyncScheduler } from "rxjs";
import { StatusResponse } from "@midnight-ntwrk/faucet-internal-api";
import {
  CompletedResponse,
  isCompleted,
  TaskManager,
  TaskManagerConfig,
  Response,
} from "../TaskManager.js";
import { InMemoryTaskRepository } from "../tasks-in-memory/task-repository.js";
import { PostgresqlTaskRepository } from "../tasks/task-repository.js";

const logger = pino({
  level: "fatal",
});

const $isReady = rx.of(true);

class Deferred<T> {
  #subject = new rx.Subject<T>();

  public readonly promise: Promise<T> = rx.firstValueFrom(this.#subject);

  resolve(value: T): void {
    this.#subject.next(value);
    this.#subject.complete();
  }

  reject(error: Error): void {
    this.#subject.error(error);
  }
}

// @TODO: update tests
describe.todo("Task Manager", () => {
  it("limits number of tasks processed in parallel to a configured amount", async () => {
    const config: TaskManagerConfig = {
      maxStoredResults: 5,
      maxConcurrentTasks: 3,
      pollTime: 1,
    };
    const tasksRepository = new InMemoryTaskRepository(
      config.maxStoredResults,
    ) as unknown as PostgresqlTaskRepository;
    const taskRange = _.range(0, config.maxConcurrentTasks + 1);
    const didRuns = taskRange.map(() => false);
    const deferreds = taskRange.map(() => new Deferred<number>());
    return pipe(
      TaskManager.create(
        logger,
        config,
        tasksRepository,
        async (taskNr: string) => {
          didRuns[parseInt(taskNr, 2)] = true;
          return deferreds[parseInt(taskNr, 2)].promise;
        },
        $isReady,
      ),
      Resource.use((taskManager) =>
        Task.lift(async () => {
          const registeredTaskIds = await pipe(
            rx.from(taskRange),
            rx.concatMap((taskNr) => {
              return rx.defer(() => taskManager.registerTask(taskNr.toString(2)));
            }),
            rx.toArray(),
            (x) => rx.firstValueFrom(x),
          );

          const runStatesBefore = [...didRuns];

          const awaitedStatusesBefore = await Promise.allSettled(
            registeredTaskIds.map(async (id) => taskManager.getStatus(id)),
          );

          const statusesBefore = awaitedStatusesBefore
            .filter(
              (res): res is PromiseFulfilledResult<Response<number>> => res.status === "fulfilled",
            )
            ?.map((result) => (result as PromiseFulfilledResult<Response<number>>).value);

          const taskResults = await pipe(
            rx.scheduled(taskRange, asyncScheduler),
            rx.concatMap((taskNr) => {
              return rx.defer(async () => {
                const runStateAtStep = [...didRuns];
                const awaitedStatusesAtStep = await Promise.allSettled(
                  registeredTaskIds.map(async (id) => taskManager.getStatus(id)),
                );

                const statusesAtStep = awaitedStatusesAtStep
                  .filter(
                    (res): res is PromiseFulfilledResult<Response<number>> =>
                      res.status === "fulfilled",
                  )
                  ?.map((result) => (result as PromiseFulfilledResult<Response<number>>).value);

                deferreds[taskNr].resolve(taskNr);
                return deferreds[taskNr].promise.then(() => ({
                  taskNr,
                  runStateAtStep,
                  statusesAtStep,
                }));
              });
            }),
            rx.toArray(),
            (x) => rx.firstValueFrom(x),
          );

          expect(runStatesBefore).toEqual([true, true, true, false]);
          expect(taskResults[0].runStateAtStep).toEqual([true, true, true, false]);
          expect(taskResults[1].runStateAtStep).toEqual([true, true, true, true]);
          expect(statusesBefore).toEqual([
            ..._.range(0, config.maxConcurrentTasks).map(() => ({ status: "in_progress" })),
            { status: "scheduled" },
          ]);
          expect(taskResults[0].statusesAtStep).toEqual([
            ..._.range(0, config.maxConcurrentTasks).map(() => ({ status: "in_progress" })),
            { status: "scheduled" },
          ]);
          expect(taskResults[1].statusesAtStep).toEqual([
            { status: "success", value: 0 },
            ..._.range(0, config.maxConcurrentTasks).map(() => ({ status: "in_progress" })),
          ]);
        }),
      ),
      Task.unsafeRun,
    );
  });

  it("captures sync errors", () => {
    const config: TaskManagerConfig = {
      maxStoredResults: 5,
      maxConcurrentTasks: 3,
      pollTime: 1,
    };

    const taskRepository = new InMemoryTaskRepository(
      config.maxStoredResults,
    ) as unknown as PostgresqlTaskRepository;

    const tasks = ["failingInSync"];

    return pipe(
      TaskManager.create<StatusResponse>(
        logger,
        config,
        taskRepository,
        () => Promise.reject(new Error("failingInPromise")),
        $isReady,
      ),
      Resource.use((taskManager) =>
        Task.lift(async () => {
          return pipe(
            rx.from(tasks),
            rx.concatMap(async (address: string) => {
              const taskId = await taskManager.registerTask(address);
              return pipe(
                rx.interval(2000),
                rx.concatMap(() => taskManager.getStatus(taskId)),
                rx.filter(isCompleted),
                (x) => rx.firstValueFrom(x),
              );
            }),
            (x) => rx.from(x),
            rx.toArray(),
            (x) => rx.firstValueFrom(x),
          );
        }),
      ),
      Task.tap((results) => {
        const expectedResults = tasks.map(
          ([expectedFail]): CompletedResponse<unknown> => ({
            status: "failure",
            error: expectedFail,
          }),
        );
        expect(results).toEqual(expectedResults);
      }),
      Task.unsafeRun,
    );
  });

  it("captures errors", () => {
    const config: TaskManagerConfig = {
      maxStoredResults: 5,
      maxConcurrentTasks: 3,
      pollTime: 1,
    };

    const taskRepository = new InMemoryTaskRepository(
      config.maxStoredResults,
    ) as unknown as PostgresqlTaskRepository;

    const tasks = ["failingInPromise", "failingSync"] as const;

    return pipe(
      TaskManager.create<StatusResponse>(
        logger,
        config,
        taskRepository,
        (address) => {
          if (address === "failingSync") {
            throw new Error("failingSync");
          }

          return Promise.reject(new Error("failingInPromise"));
        },
        $isReady,
      ),
      Resource.use((taskManager) =>
        Task.lift(async () => {
          return pipe(
            rx.from(tasks),
            rx.concatMap(async (address) => {
              const taskId = await taskManager.registerTask(address);
              return pipe(
                rx.interval(1),
                rx.concatMap(() => taskManager.getStatus(taskId)),
                rx.filter(isCompleted),
                (x) => rx.firstValueFrom(x),
              );
            }),
            (x) => rx.from(x),
            rx.toArray(),
            (x) => rx.firstValueFrom(x),
          );
        }),
      ),
      Task.tap((results) => {
        const expectedResults = tasks.map(
          ([expectedFail]): CompletedResponse<unknown> => ({
            status: "failure",
            error: expectedFail,
          }),
        );
        expect(results).toEqual(expectedResults);
      }),
      Task.unsafeRun,
    );
  });

  it("does not stop on errors", () => {
    const config: TaskManagerConfig = {
      maxStoredResults: 5,
      maxConcurrentTasks: 3,
      pollTime: 1,
    };

    const taskRepository = new InMemoryTaskRepository(
      config.maxStoredResults,
    ) as unknown as PostgresqlTaskRepository;

    const taskHandler = async (address: string) => {
      if (address === "failingSync") {
        throw new Error("failingSync");
      }

      if (address === "failingInPromise") {
        return Promise.reject(new Error("failingInPromise"));
      }

      return Promise.resolve(42);
    };

    const tasks: Array<[CompletedResponse<number>, string]> = [
      [{ status: "failure", error: "failingInPromise" }, "failingInPromise"],
      [{ status: "failure", error: "failingSync" }, "failingSync"],
      [{ status: "success", value: 42 }, "success"],
    ];

    return pipe(
      TaskManager.create(logger, config, taskRepository, taskHandler, $isReady),
      Resource.use((taskManager) =>
        Task.lift(async () => {
          return pipe(
            rx.from(tasks),
            rx.mergeMap(async ([, address]) => {
              const taskId = await taskManager.registerTask(address);
              return pipe(
                rx.interval(1),
                rx.concatMap(() => taskManager.getStatus(taskId)),
                rx.filter(isCompleted),
                (x) => rx.firstValueFrom(x),
              );
            }, 1),
            rx.toArray(),
            (x) => rx.firstValueFrom(x),
          );
        }),
      ),
      Task.tap((results) => {
        const expectedResults = tasks.map(([expectedStatus]) => expectedStatus);
        expect(results).toEqual(expectedResults);
      }),
      Task.unsafeRun,
    );
  });

  describe("with dependant values", () => {
    const defaultConfig: TaskManagerConfig = {
      maxStoredResults: 5,
      maxConcurrentTasks: 3,
      pollTime: 1,
    };
    const taskRepository = new InMemoryTaskRepository(
      defaultConfig.maxStoredResults,
    ) as unknown as PostgresqlTaskRepository;

    const delay = (timeoutMS: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMS);
      });
    const runTasksPipeline = (tasks: [() => Promise<void>, string][], concurrent?: number) =>
      pipe(
        TaskManager.create(
          logger,
          defaultConfig,
          taskRepository,
          () => Promise.resolve(),
          $isReady,
        ),
        Resource.use((taskManager) =>
          Task.lift(() => {
            return pipe(
              rx.from(tasks),
              rx.mergeMap(async ([, hash]) => {
                const taskId = await taskManager.registerTask(hash);

                return pipe(
                  rx.interval(100),
                  rx.concatMap(() => taskManager.getStatus(taskId)),
                  rx.filter(isCompleted),
                  (x) => rx.firstValueFrom(x),
                );
              }, concurrent),
              rx.distinct(),
              rx.toArray(),
              (x) => rx.firstValueFrom(x),
            );
          }),
        ),
      );
    const runSequentialTasksPipeline = (tasks: [() => Promise<void>, string][]) =>
      runTasksPipeline(tasks, 1);
    const runConcurrentTasksPipeline = (tasks: [() => Promise<void>, string][]) =>
      runTasksPipeline(tasks);

    it("returns in-progress Task for equal dependant values", async () => {
      await pipe(
        runConcurrentTasksPipeline([
          [() => delay(1_000), "value-1"],
          [() => Promise.resolve(), "value-1"],
        ]),
        Task.tap((results) => {
          expect(results).toHaveLength(1);
        }),
        Task.unsafeRun,
      );
    });

    it("returns new Task for independent values", async () => {
      await pipe(
        runConcurrentTasksPipeline([
          [() => delay(1_000), "value-1"],
          [() => Promise.resolve(), "value-2"],
        ]),
        Task.tap((results) => {
          expect(results).toHaveLength(2);
        }),
        Task.unsafeRun,
      );
    });

    it("returns new Task for equal dependant values when prior Task has completed", async () => {
      await pipe(
        runSequentialTasksPipeline([
          [() => Promise.resolve(), "value-1"],
          [() => Promise.resolve(), "value-1"],
        ]),
        Task.tap((results) => {
          expect(results).toHaveLength(2);
        }),
        Task.unsafeRun,
      );
    });

    it("returns new Task post completed Task eviction", async () => {
      const tasks: [() => Promise<void>, string][] = Array.from(
        { length: defaultConfig.maxStoredResults * 2 },
        (__, idx) => [() => Promise.resolve(), `value-${idx + 1}`],
      );

      await pipe(
        runSequentialTasksPipeline([...tasks, [() => Promise.resolve(), "value-1"]]),
        Task.tap((results) => {
          expect(results).toHaveLength(tasks.length + 1);
        }),
        Task.unsafeRun,
      );
    });
  });

  // eslint-disable-next-line vitest/expect-expect
  it("does not run tasks when not ready", () => {
    // when $isReady observable is omitting false, the task manager shouldn't pick tasks
    // it should continue picking them when $isReady observable is emitting true
    throw new Error("Please implement this test when fixing this spec");
  });
});
