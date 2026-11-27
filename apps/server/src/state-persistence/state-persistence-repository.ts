import { Knex } from "knex";
import pino from "pino";
import * as t from "io-ts";
import * as td from "io-ts-types";

export const StateData = t.type({
  id: t.number,
  shielded: t.string,
  unshielded: t.string,
  dust: t.string,
  identifier: t.string,
  created_at: td.date,
});

export type StateDataType = t.TypeOf<typeof StateData>;

export class PostgresqlStateSnapshotsRepository {
  constructor(
    private readonly knex: Knex<object>,
    private readonly identifier: string,
  ) {}

  async getState(logger: pino.Logger): Promise<StateDataType | undefined> {
    return this.knex<StateDataType, StateDataType>("state_snapshots")
      .where("identifier", this.identifier)
      .orderBy("created_at", "desc")
      .first()
      .then((result) => {
        if (result) {
          return {
            ...result,
            shielded: result.shielded.toString(),
            unshielded: result.unshielded.toString(),
            dust: result.dust.toString(),
          };
        }
      })
      .catch((error: Error) => {
        // `err`, not `error`: pino's error serializer only fires on `err`, and
        // under any other key the non-enumerable `message` is dropped.
        logger.error({ err: error }, "Error retrieving state snapshot data from DB");
        return undefined;
      });
  }

  async truncate(logger: pino.Logger): Promise<void> {
    await this.knex("state_snapshots").truncate();
    logger.warn("state_snapshots table truncated");
  }

  /**
   * Rejects when the write fails rather than swallowing the error (#77): the
   * caller turns a rejection into `statePersistenceStatus = 0`, which is what
   * lets the health routes report STATE_PERSISTENCE_FAILURE.
   *
   * Deliberately does not log — `persistWalletState` logs the same error once,
   * under pino's `err` key. Logging here as well produced two ERROR lines per
   * failed write.
   */
  async saveState({
    shielded,
    unshielded,
    dust,
  }: {
    shielded: string;
    unshielded: string;
    dust: string;
  }): Promise<Pick<StateDataType, "id">> {
    return this.knex.transaction(async (trx) => {
      const [inserted] = await trx<StateDataType>("state_snapshots")
        .insert({
          shielded,
          unshielded,
          dust,
          identifier: this.identifier,
        })
        .returning("id");

      await trx("state_snapshots")
        .where("identifier", this.identifier)
        .whereNot("id", inserted.id)
        .delete();

      return inserted;
    });
  }
}
