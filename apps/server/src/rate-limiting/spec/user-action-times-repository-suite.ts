/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { pipe, Resource, Task } from "@midnight-ntwrk/faucet-utils";
import { UserId } from "@midnight-ntwrk/faucet-auth";
import * as fc from "fast-check";
import pino from "pino";
import { UserActionTimesRepository } from "../rate-limiting.js";
import * as UAT from "../user-action-times.js";

export type UserActionTimesRepositorySpecContext<T = unknown> = {
  implementationName: string;
  infrastructure: (logger: pino.Logger) => Resource<T>;
  instance: (infrastructure: T) => Resource<UserActionTimesRepository>;
};

export function runUserActionTimesRepositorySuite<T>(
  context: UserActionTimesRepositorySpecContext<T>,
) {
  describe(`${context.implementationName} User Action Times Repository`, () => {
    const logger = pino({ level: "silent" });
    let infrastructure: T;
    let infrastructureTeardown: Task<void>;

    beforeAll(async () => {
      const allocated = await Task.unsafeRun(Resource.allocate(context.infrastructure(logger)));
      infrastructure = allocated.value;
      infrastructureTeardown = allocated.teardown;
    });

    afterAll(async () => {
      await Task.unsafeRun(infrastructureTeardown);
    });

    it("returns empty actions if not found", async () => {
      return pipe(
        context.instance(infrastructure),
        Resource.use((repo) =>
          Task.lift(async () => {
            const id = UserId.generate();
            const result = await repo.getActionsOfUser(id);

            expect(UAT.isEmpty(result)).toBe(true);
          }),
        ),
        Task.unsafeRun,
      );
    });

    type Command = {
      applyRepo: (repo: UserActionTimesRepository) => Promise<void>;
      applyActions: (
        initial: Record<string, UAT.UserActionTimes>,
      ) => Record<string, UAT.UserActionTimes>;
    };
    const startedActionCommand = (userId: UserId, time: Date): Command => ({
      applyRepo: (repo) => repo.actionStarted(userId, time),
      applyActions: (record) => ({
        ...record,
        [userId.value]: UAT.started(record[userId.value], time),
      }),
    });
    const succeededCommand = (userId: UserId, time: Date): Command => ({
      applyRepo: (repo) => repo.actionSucceeded(userId, time),
      applyActions: (record) => ({
        ...record,
        [userId.value]: UAT.succeeded(record[userId.value], time),
      }),
    });
    const failedCommand = (userId: UserId, time: Date): Command => ({
      applyRepo: (repo) => repo.actionFailed(userId, time),
      applyActions: (record) => ({
        ...record,
        [userId.value]: UAT.failed(record[userId.value], time),
      }),
    });
    const noopCommand = (): Command => ({
      applyRepo: () => Promise.resolve(undefined),
      applyActions: (a) => a,
    });

    const commandsArbitrary: fc.Arbitrary<{
      userIds: UserId[];
      commands: Command[];
    }> = fc
      .array(
        fc.uuid().map((u) => new UserId(u)),
        { minLength: 1, maxLength: 20 },
      )
      .chain((userIds) =>
        fc.record({
          userIds: fc.constant(userIds),
          commands: fc.array(
            fc
              .record({
                actionTime: fc.date({ noInvalidDate: true, min: new Date(-4000, 0) }),
                userId: fc.constantFrom(...userIds),
              })
              .chain(({ userId, actionTime }) =>
                fc.constantFrom(
                  startedActionCommand(userId, actionTime),
                  succeededCommand(userId, actionTime),
                  failedCommand(userId, actionTime),
                  noopCommand(),
                ),
              ),
          ),
        }),
      );

    it("saves action time and then retrieves it properly", () => {
      return fc.assert(
        fc.asyncProperty(commandsArbitrary, ({ userIds, commands }) => {
          return pipe(
            context.instance(infrastructure),
            Resource.use((repo) => {
              type Acc = {
                current: Record<string, UAT.UserActionTimes>;
                results: Array<{
                  initial: Record<string, UAT.UserActionTimes>;
                  expected: Record<string, UAT.UserActionTimes>;
                  got: Record<string, UAT.UserActionTimes>;
                  command: Command;
                }>;
              };
              return pipe(
                commands,
                Task.reduceArray<Command, Acc>(
                  {
                    current: Object.fromEntries(userIds.map((id) => [id.value, UAT.empty(id)])),
                    results: [],
                  },
                  (acc, command) =>
                    Task.lift(async () => {
                      const expected = command.applyActions(acc.current);
                      await command.applyRepo(repo);
                      const results: Record<string, UAT.UserActionTimes> = await Promise.all(
                        userIds.map((userId) => repo.getActionsOfUser(userId)),
                      )
                        .then((actions) => actions.map((a) => [a.userId.value, a]))
                        .then(Object.fromEntries);

                      return {
                        current: expected,
                        results: acc.results.concat({
                          initial: acc.current,
                          expected,
                          got: results,
                          command,
                        }),
                      };
                    }),
                ),
              );
            }),
            Task.tap(({ results }) => {
              results.forEach((result) => {
                expect(result.got).toEqual(result.expected);
              });
            }),
            Task.mapVoid,
            Task.unsafeRun,
          );
        }),
      );
    });
  });
}
