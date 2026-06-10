import { UserId } from "@midnight-ntwrk/faucet-auth";

export type UserActionTimes = Readonly<{
  userId: UserId;
  lastStarted: Date | null;
  lastFailed: Date | null;
  lastSucceeded: Date | null;
}>;

export const isEmpty = (actions: UserActionTimes): boolean =>
  [actions.lastStarted, actions.lastFailed, actions.lastSucceeded].every((time) => time == null);

export const empty = (userId: UserId): UserActionTimes => ({
  userId,
  lastStarted: null,
  lastSucceeded: null,
  lastFailed: null,
});

export const started = (actions: UserActionTimes, time: Date): UserActionTimes => ({
  ...actions,
  lastStarted: time,
});

export const failed = (actions: UserActionTimes, time: Date): UserActionTimes => ({
  ...actions,
  lastFailed: time,
});
export const succeeded = (actions: UserActionTimes, time: Date): UserActionTimes => ({
  ...actions,
  lastSucceeded: time,
});
