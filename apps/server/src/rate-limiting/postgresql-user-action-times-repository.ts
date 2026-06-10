import { UserId } from "@midnight-ntwrk/faucet-auth";
import { Knex } from "knex";
import { UserActionTimesRepository } from "./rate-limiting.js";
import * as UA from "./user-action-times.js";

type UserActionTimesData = Readonly<{
  user_id: string;
  last_started: Date | null;
  last_failed: Date | null;
  last_succeeded: Date | null;
}>;
export class PostgresqlUserActionTimesRepository implements UserActionTimesRepository {
  constructor(private readonly knex: Knex<object>) {}

  getActionsOfUser(userId: UserId): Promise<UA.UserActionTimes> {
    return this.knex<UserActionTimesData, UserActionTimesData>("user_action_times")
      .where("user_id", userId.value)
      .first()
      .then((result) => {
        if (result) {
          return {
            userId,
            lastStarted: result.last_started,
            lastFailed: result.last_failed,
            lastSucceeded: result.last_succeeded,
          };
        } else {
          return UA.empty(userId);
        }
      });
  }

  actionFailed(user: UserId, time: Date): Promise<void> {
    return this.#doUpdate(user, "last_failed", time);
  }

  actionStarted(user: UserId, time: Date): Promise<void> {
    return this.#doUpdate(user, "last_started", time);
  }

  actionSucceeded(user: UserId, time: Date): Promise<void> {
    return this.#doUpdate(user, "last_succeeded", time);
  }

  #doUpdate<P extends keyof UserActionTimesData>(
    user: UserId,
    property: P,
    value: UserActionTimesData[P],
  ) {
    return this.knex<UserActionTimesData>("user_action_times")
      .insert({ user_id: user.value, [property]: value })
      .onConflict("user_id")
      .merge([property])
      .then(() => undefined);
  }
}
