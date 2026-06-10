import { option } from "fp-ts";

export { pipe } from "fp-ts/es6/function.js";
export { pipe as through } from "rxjs";

export const block = <T>(thunk: () => T): T => thunk();

export const identity = <T>(t: T): T => t;

export const lazy = <T>(factory: () => T) => {
  let valueRef: option.Option<T> = option.none;
  return (): T =>
    option.fold<T, T>(
      () => {
        const calculated = factory();
        valueRef = option.some(calculated);
        return calculated;
      },
      (value) => value,
    )(valueRef);
};
