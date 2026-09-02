import pino from "pino";
import { isLeft } from "fp-ts/lib/Either.js";
import { PostgresqlStateSnapshotsRepository, StateData } from "./state-persistence-repository.js";

export const getState = async ({
  logger,
  stateRepository,
}: {
  stateRepository: PostgresqlStateSnapshotsRepository;
  logger: pino.Logger;
}) => {
  const stateData = await stateRepository.getState(logger);
  const decoded = StateData.decode(stateData);

  if (isLeft(decoded)) {
    return undefined;
  }

  const { shielded, unshielded, dust } = decoded.right;

  return { shielded, unshielded, dust };
};
