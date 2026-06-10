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
        logger.error({ error }, "Error retrieving state snapshot data from DB");
        return undefined;
      });
  }

  async truncate(logger: pino.Logger): Promise<void> {
    await this.knex("state_snapshots").truncate();
    logger.warn("state_snapshots table truncated");
  }

  async saveState({
    logger,
    shielded,
    unshielded,
    dust,
  }: {
    logger: pino.Logger;
    shielded: string;
    unshielded: string;
    dust: string;
  }): Promise<Pick<StateDataType, "id"> | undefined> {
    return this.knex
      .transaction(async (trx) => {
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
      })
      .catch((error: Error) => {
        logger.error({ error }, "Error while saving faucet state snapshot data to DB");
        return undefined;
      });
  }
}
