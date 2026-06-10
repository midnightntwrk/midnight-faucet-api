import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";

const getHDWallet = (seedBuffer: Uint8Array): HDWallet => {
  const result = HDWallet.fromSeed(seedBuffer);
  if (result.type === "seedError") {
    throw new Error(`HD wallet seed error: ${String(result.error)}`);
  }
  return result.hdWallet;
};

export const getShieldedSeed = (seedBuffer: Uint8Array): Uint8Array => {
  const hdWallet = getHDWallet(seedBuffer);
  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);

  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error("Key derivation out of bounds");
  }

  return derivationResult.key;
};

export const getUnshieldedSeed = (seedBuffer: Uint8Array): Uint8Array => {
  const hdWallet = getHDWallet(seedBuffer);
  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);

  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error("Key derivation out of bounds");
  }

  return derivationResult.key;
};

export const getDustSeed = (seedBuffer: Uint8Array): Uint8Array => {
  const hdWallet = getHDWallet(seedBuffer);
  const derivationResult = hdWallet.selectAccount(0).selectRole(Roles.Dust).deriveKeyAt(0);

  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error("Key derivation out of bounds");
  }

  return derivationResult.key;
};
