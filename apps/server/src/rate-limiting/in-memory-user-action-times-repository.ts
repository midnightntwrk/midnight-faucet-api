import { UserId } from "@midnight-ntwrk/faucet-auth";
import { UserActionTimesRepository } from "./rate-limiting.js";
import * as UA from "./user-action-times.js";

export class InMemoryUserActionTimesRepository implements UserActionTimesRepository {
  #actionsPerUser: Map<string, UA.UserActionTimes> = new Map();

  getActionsOfUser(userId: UserId): Promise<UA.UserActionTimes> {
    return Promise.resolve(this.#getActionsOfUserSync(userId));
  }

  actionFailed(userId: UserId, time: Date): Promise<void> {
    return this.#doUpdate(userId, (actions) => UA.failed(actions, time));
  }

  actionStarted(userId: UserId, time: Date): Promise<void> {
    return this.#doUpdate(userId, (actions) => UA.started(actions, time));
  }

  actionSucceeded(userId: UserId, time: Date): Promise<void> {
    return this.#doUpdate(userId, (actions) => UA.succeeded(actions, time));
  }

  #getActionsOfUserSync(userId: UserId): UA.UserActionTimes {
    return this.#actionsPerUser.get(userId.value) ?? UA.empty(userId);
  }

  #saveActionsSync(actions: UA.UserActionTimes): void {
    this.#actionsPerUser.set(actions.userId.value, actions);
  }

  #doUpdate(
    userId: UserId,
    update: (actions: UA.UserActionTimes) => UA.UserActionTimes,
  ): Promise<void> {
    const actions = this.#getActionsOfUserSync(userId);
    const newActions = update(actions);
    this.#saveActionsSync(newActions);
    return Promise.resolve(undefined);
  }
}
