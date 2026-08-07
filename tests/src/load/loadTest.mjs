#!/usr/bin/env -S node --experimental-specifier-resolution=node
import { FaucetClient } from "@midnight-ntwrk/faucet-client";
import { WalletBuilder } from "@midnightntwrk/wallet";
import _ from "lodash";
import fetch from "node-fetch";
import { lastValueFrom } from "rxjs";
import * as rx from "rxjs";
import { getConfig } from "./envConfig.js"

const NUMBER_OF_USERS = process.env.NUMBER_OF_USERS;
const WARMUP_RUNS = process.env.WARMUP_RUNS;

const FAUCET_URL = getConfig().faucetUrl;
const NODE_URL = getConfig().nodeUrl;
const INDEXER_URL = getConfig().indexerURL;
const INDEXER_SUBSCRIPTION_URL = getConfig().indexerSubscriptionURL;
const NETWORK_ID = getConfig().networkId;

const client = FaucetClient(`${FAUCET_URL}/api`, 10_000, fetch);

const checks$ = rx.interval(1_000).pipe(
  rx.mergeMap(() => {
    return fetch(`${FAUCET_URL}/api/health`)
      .then((r) => r.json())
      .then((data) => {
        console.log("Health response", data);
      });
  }),
  rx.mergeMap(() => {
    return fetch(`${FAUCET_URL}/api/ready`)
      .then((r) => r.json())
      .then((data) => {
        console.log("Readiness response", data);
      });
  }),
);

const urls = {
  nodeURL: new URL(NODE_URL),
  provingServerURL: new URL("http://localhost:6300"),
  indexerURL: new URL(INDEXER_URL),
  indexerSubscriptionURL: new URL(INDEXER_SUBSCRIPTION_URL),
  networkId: NETWORK_ID,
};

const receiverWalletsP = Promise.all(
  _.range(0, NUMBER_OF_USERS).map((nr) =>
    WalletBuilder.build(
      urls.indexerURL.toString(),
      urls.indexerSubscriptionURL.toString(),
      urls.provingServerURL.toString(),
      urls.nodeURL.toString(),
      urls.networkId,
      "trace",
    )
    .then((wallet) => {
      wallet.start();
      return wallet;
    })
    .then(async (wallet) => {
      const state = await rx.firstValueFrom(wallet.state());
      return { wallet, state };
    }),
  ),
);

const handleRequest = (nr) => {
  return rx.of(nr).pipe(
    rx.tap((user) => {
      console.log(`Proceeding with request ${user}`);
    }),
    rx.concatMap(async (requestNr) => {
      const {
        state: { address },
      } = (await receiverWalletsP)[requestNr];;
      return { requestNr, address };
    }),
    rx.concatMap(async ({ requestNr, address }) => {
      console.log(`Performing request nr ${requestNr}`);
      const { transactionIdentifier } = await client.requestTokens(address);
      console.log(`Tx ${transactionIdentifier} submitted for user request ${requestNr}`);
    }),
    rx.tap({
      error: (err) => {
        console.error("Got error with request, retrying...", err);
      },
    }),
    // Made this addition because of 2 issues:
    // - networking issue, looks like faucet rejects connection if there is big number of concurrent connections opened
    // - increased block time of 6s and inability to create too many of outputs for wallet - transactions spend a lot of time before they are seen as finalized on chain
    // Should it be kept or removed?
    rx.retry({
      delay: 1_000,
    }),
  );
};

//Warmup to ensure proper setting of coins
const warmup = () => {
  console.log("Warming up faucet");
  return lastValueFrom(
    rx.from(_.range(0, WARMUP_RUNS)).pipe(
      rx.mergeMap(handleRequest),
    ),
  ).then(() => {
    console.log("Warmup finished");
  });
};

const run$ = rx
.defer(() => warmup())
  .pipe(
    rx.tap(() => {
      console.time("execution");
    }),
    rx.concatMap(() => rx.from(_.range(0, NUMBER_OF_USERS))),
    rx.mergeMap(handleRequest),
    rx.scan((acc) => {
      const next = acc + 1;
      console.timeLog("execution", next);
      console.log(`Finished ${next} requests out of ${NUMBER_OF_USERS}`);
      return next;
    }, 0),
  )
  rx.tap({
    error: (err) => {
      console.error("Run error", err);
    },
    complete: () => {
      console.timeEnd("execution");
      console.log(`${NUMBER_OF_USERS} requests managed successfully`);
    },
  });

  const receivers$ = rx.from(receiverWalletsP).pipe(
    rx.mergeMap((receivers) => receivers),
    rx.mergeMap((receiver) => receiver.wallet.state()),
    rx.tap({
      next: (state) => {
        console.log("Receiver wallet state update", {
          balances: state.balances,
          sync: state.syncProgress,
        });
      },
      error: (err) => {
        console.error("Receiver wallet error", err);
      },
      complete: () => {
        console.log("Receiver wallet stopped");
      },
    }),
  );

  checks$.subscribe();
  run$.subscribe({
    error: () => {
      process.exit(1);
    },
    complete: () => {
      process.exit(0);
    },
  });
  receivers$.subscribe();
