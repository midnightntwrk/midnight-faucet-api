import { Counter, Gauge, Histogram } from "prom-client";

export const syncProgressApplyGap = new Gauge({
  name: "faucet_sync_apply_gap",
  help: "The total number of indices the faucet is behind the tip of the indexer.",
});

export const totalAvailableFunds = new Gauge({
  name: "faucet_total_available_funds",
  help: "The total value of DUST available in the Faucet wallet.",
});

// Shielded wallet metrics
export const shieldedAvailableBalance = new Gauge({
  name: "faucet_shielded_available_balance",
  help: "Available balance in the shielded wallet.",
});

export const shieldedCoinCount = new Gauge({
  name: "faucet_shielded_coin_count",
  help: "Number of coins in the shielded wallet.",
});

export const shieldedSynced = new Gauge({
  name: "faucet_shielded_synced",
  help: "Whether the shielded wallet is synced (1) or not (0).",
});

// Unshielded wallet metrics
export const unshieldedAvailableBalance = new Gauge({
  name: "faucet_unshielded_available_balance",
  help: "Available balance in the unshielded wallet.",
});

export const unshieldedTotalBalance = new Gauge({
  name: "faucet_unshielded_total_balance",
  help: "Total balance in the unshielded wallet.",
});

export const unshieldedCoinCount = new Gauge({
  name: "faucet_unshielded_coin_count",
  help: "Number of coins in the unshielded wallet.",
});

export const unshieldedSynced = new Gauge({
  name: "faucet_unshielded_synced",
  help: "Whether the unshielded wallet is synced (1) or not (0).",
});

export const unshieldedConnected = new Gauge({
  name: "faucet_unshielded_connected",
  help: "Whether the unshielded wallet is connected to the indexer (1) or not (0).",
});

// Dust wallet metrics
export const dustAvailableBalance = new Gauge({
  name: "faucet_dust_available_balance",
  help: "Available balance in the dust wallet.",
});

export const dustTotalBalance = new Gauge({
  name: "faucet_dust_total_balance",
  help: "Total balance in the dust wallet.",
});

export const dustPendingBalance = new Gauge({
  name: "faucet_dust_pending_balance",
  help: "Pending balance in the dust wallet.",
});

export const dustCoinCount = new Gauge({
  name: "faucet_dust_coin_count",
  help: "Number of coins in the dust wallet.",
});

export const dustSynced = new Gauge({
  name: "faucet_dust_synced",
  help: "Whether the dust wallet is synced (1) or not (0).",
});

export const tokenRequestCount = new Counter({
  name: "faucet_token_request_count",
  help: "The total number of token requests.",
  labelNames: ["address", "captchaToken"],
});

export const taskQueueTimer = new Histogram({
  name: "faucet_task_queue_duration_secs",
  help: "The duration of time tasks wait before starting (in seconds).",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25],
});

export const taskTimer = new Histogram({
  name: "faucet_task_duration_secs",
  help: "The duration of time tasks take to execute (in seconds).",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25],
});

export const taskSuccessCount = new Counter({
  name: "faucet_task_success_total",
  help: "The total number of successfully completed tasks.",
});

export const taskFailureCount = new Counter({
  name: "faucet_task_failure_total",
  help: "The total number of failed tasks.",
});

// Third-party API metrics
export const statePersistenceStatus = new Gauge({
  name: "faucet_state_persistence_status",
  help: "Whether the last state persistence attempt succeeded (1) or failed (0).",
});

export const thirdPartyDripRequestCount = new Counter({
  name: "faucet_third_party_drip_request_total",
  help: "The total number of third-party drip requests.",
  labelNames: ["origin", "amount"],
});

export const thirdPartyDripSuccessCount = new Counter({
  name: "faucet_third_party_drip_success_total",
  help: "The total number of successful third-party drip requests.",
  labelNames: ["origin"],
});

export const thirdPartyDripFailureCount = new Counter({
  name: "faucet_third_party_drip_failure_total",
  help: "The total number of failed third-party drip requests.",
  labelNames: ["origin", "reason"],
});

export const thirdPartyHealthCheckCount = new Counter({
  name: "faucet_third_party_health_check_total",
  help: "The total number of third-party health check requests.",
  labelNames: ["origin", "status"],
});

export const thirdPartyHttpRequestTimer = new Histogram({
  name: "faucet_third_party_http_request_duration_secs",
  help: "The duration of third-party API HTTP requests (in seconds).",
  labelNames: ["method", "endpoint", "status_code"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
