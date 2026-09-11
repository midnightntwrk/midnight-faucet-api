#!/usr/bin/env -S node  --experimental-specifier-resolution=node

import { FaucetClient } from "@midnightntwrk/faucet-client";

const client = FaucetClient({ url: "http://localhost:5300/api", pollInterval: 100 });

const response = await client.requestTokens(
  "mn_shield-addr_undeployed1mjngjmnlutcq50trhcsk3hugvt9wyjnhq3c7prryd5nqmvtzva0sxqpvzkdy4k9u7eyffff53cge62tqylevq3wqps86tdjuahsquwvucsy9kffv",
  "XXXX.DUMMY.TOKEN.XXXX",
);

console.log(response);
