import { Knex } from "knex";

/**
 * Wallet state snapshots used to be encrypted with `ENCRYPTION_KEY` before being written here.
 * That key is gone and the columns now hold plaintext serialized state, so any row written by an
 * older server is ChaCha20-Poly1305 ciphertext that the wallet cannot deserialize. Clear them and
 * let the faucet resync — the same cost the sync-stuck detector already pays when it truncates
 * this table.
 *
 * `down` is a no-op: the snapshots are a disposable warm-start cache, so there is nothing a
 * rollback could restore and nothing that needs restoring.
 */
export const up = (knex: Knex) => knex("state_snapshots").del();

export const down = () => Promise.resolve();
