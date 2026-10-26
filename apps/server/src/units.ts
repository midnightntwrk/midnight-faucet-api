/**
 * Token denominations.
 *
 * Every amount the faucet moves — `dropAmount`, whatever reaches `FaucetImpl`'s
 * transfer — is in the ledger's atomic unit for NIGHT. The `amount` field on
 * both HTTP routes is whole tNIGHT. This module is where that conversion is
 * named rather than scattered as a magic literal, which is how the original bug
 * arose.
 */

/**
 * Atomic units per whole tNIGHT.
 *
 * This faucet pins `@midnight-ntwrk/ledger-v8` (^8.1.0) and nothing else — there
 * is no ledger-v9 in the dependency tree. That package does not export the
 * constant: `ledger-v8.d.ts` says only "atomic units dependent on the
 * currency". So the factor is grounded in this repo's own arithmetic rather
 * than in a ledger export:
 *
 * - `config.ts` ships `dropAmount` of 5,000,000,000 atomic units, and the page
 *   tells the user it dispenses "5000 tNight" — a factor of 10^6.
 * - The pre-fix code capped the public route at 1000 and multiplied by
 *   5,000,000, landing on that same 5,000,000,000.
 *
 * Corroborated externally by the Star being NIGHT's atomic unit at 1 NIGHT =
 * 10^6 Stars, but treat `dropAmount` as the source of truth here: the two must
 * agree or the page's copy is wrong.
 *
 * Note this only fixes the *labelling* of a drip. `resolveDripAmount` derives
 * its ceiling as `dropAmount / STARS_PER_NIGHT` and returns `amount *
 * STARS_PER_NIGHT`, so a request for the maximum dispenses exactly `dropAmount`
 * whatever this value is; changing it changes how many units the drop is
 * divided into, not the size of a full drop.
 *
 * Do not confuse this with DUST, whose atomic unit is the SPECK.
 */
export const STARS_PER_NIGHT = 1_000_000n;

/**
 * Renders a STAR amount as whole tNIGHT for display. Deliberately integer-only
 * and ungrouped: the faucet's drop is a whole number of tNIGHT, and the page's
 * existing copy reads "5000 tNight".
 */
export const starToWholeTNight = (star: bigint): string => (star / STARS_PER_NIGHT).toString();
