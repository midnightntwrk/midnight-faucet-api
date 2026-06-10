export const testWalletHalo2 = {
  seed: "e1a0af42b02db0a03cf05724749e650759eca84697763ed9cbbbaec24636e710",
  mnemonics: [
    "ticket",
    "air",
    "spawn",
    "gate",
    "swallow",
    "exotic",
    "video",
    "april",
    "caught",
    "pilot",
    "off",
    "attitude",
    "paddle",
    "feature",
    "bottom",
    "uphold",
    "disagree",
    "soft",
    "upon",
    "frown",
    "caught",
    "bread",
    "ordinary",
    "another",
  ],
  address:
    "9364cedf1b0b9fb8daf9c263f813b711321c8c325c78a1f5b3a7c505eed20fc6|030010f0cc0f565aa532c56f901800d43c0dc7653af501b91295c70c79579587cec786aa980229bccc2321e791f60cb5632896a46f06f35fb411",
};

export interface WalletConfig {
  seed: string;
  mnemonics: string[];
  address: string;
}
