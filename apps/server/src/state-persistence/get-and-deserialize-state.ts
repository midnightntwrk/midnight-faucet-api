import pino from "pino";
import { isLeft } from "fp-ts/lib/Either.js";
import { decryptData } from "./encryption.js";
import { PostgresqlStateSnapshotsRepository, StateData } from "./state-persistence-repository.js";

export const getState = async ({
  logger,
  stateRepository,
  encryptionKey,
}: {
  stateRepository: PostgresqlStateSnapshotsRepository;
  logger: pino.Logger;
  encryptionKey: Buffer;
}) => {
  const stateData = await stateRepository.getState(logger);
  const decoded = StateData.decode(stateData);

  if (isLeft(decoded)) {
    return undefined;
  }

  const decodedStateData = decoded.right;
  const { shielded, unshielded, dust } = decodedStateData;
  const decryptedShieldedContent = decryptData(encryptionKey, shielded);
  const decryptedUnshieldedContent = decryptData(encryptionKey, unshielded);
  const decryptedDustContent = decryptData(encryptionKey, dust);

  return {
    shielded: decryptedShieldedContent,
    unshielded: decryptedUnshieldedContent,
    dust: decryptedDustContent,
  };
};
