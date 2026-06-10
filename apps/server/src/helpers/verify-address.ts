import { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

export class InvalidAddressError extends Error {
  constructor(
    public readonly address: string,
    options?: ErrorOptions,
  ) {
    super("Provided address is invalid", options);
    this.name = "InvalidAddressError";
  }
}

const isValidBech32mAddress = (value: string, networkId: NetworkId.NetworkId): boolean => {
  try {
    const parsed = MidnightBech32m.parse(value);

    UnshieldedAddress.codec.decode(networkId, parsed);

    return true;
  } catch {
    return false;
  }
};

export const verifyAddress = ({
  unshieldedAddress,
  networkId,
}: {
  unshieldedAddress: string;
  networkId: NetworkId.NetworkId;
}): void => {
  const bechValid = isValidBech32mAddress(unshieldedAddress, networkId);

  if (!bechValid) {
    throw new InvalidAddressError(unshieldedAddress, {
      cause: "Invalid Address",
    });
  }
};
