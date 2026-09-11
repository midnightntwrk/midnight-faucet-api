import { Faucet } from "@midnightntwrk/faucet-internal-api";
import { firstL, pipe, Resource, Task } from "@midnightntwrk/faucet-utils";
import { debounceTime, filter, timeout } from "rxjs";
import { ServerConfig } from "../config.js";
import { prepareFaucet } from "../faucet.js";
import { createLogger } from "../logging.js";
import { UnshieldedAddress } from "@midnightntwrk/wallet-sdk-address-format";

export interface CheckConnectionResult {
  balance: bigint;
  address: Faucet["address"];
}
export function checkConnection(config: ServerConfig): Task<CheckConnectionResult> {
  const logger = createLogger(config.logging);
  return pipe(
    prepareFaucet(config, logger),
    Resource.use((faucet: Faucet) => {
      return pipe(
        faucet.state$,
        filter((state) => state.unshielded.availableBalance > 0n),
        timeout(60_000),
        debounceTime(1_000),
        firstL,
        Task.map((state) => ({
          balance: state.unshielded.availableBalance,
          address: UnshieldedAddress.codec
            .encode(config.networkId, state.unshielded.address)
            .asString(),
        })),
      );
    }),
  );
}
