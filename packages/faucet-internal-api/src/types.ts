import { either } from "fp-ts/lib/Either.js";
import * as t from "io-ts";

// Generic map
export const ObjectToMap = new t.Type<Map<string, number>, Record<string, number>>(
  "ObjectToMap",
  (u): u is Map<string, number> => u instanceof Map,
  (u, c) =>
    either.chain(t.record(t.string, t.number).validate(u, c), (s) => {
      try {
        return t.success(new Map(Object.entries(s)));
      } catch {
        return t.failure(u, c);
      }
    }),
  (map) => Object.fromEntries(map.entries()),
);
