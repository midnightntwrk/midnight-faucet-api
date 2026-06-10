import { RecursivePartial } from "../types.js";

export interface Assertions<T> {
  equal: (expected: T) => void;
  matchObject: <E extends T & object>(expected: RecursivePartial<E>) => void;
}
export const assert = <T>(actual: T): Assertions<T> => {
  const equal = (expected: T): void => expect(actual).toEqual(expected);

  const matchObject = <E extends T & {}>(expected: RecursivePartial<E>): void =>
    expect(actual).toMatchObject(expected);

  return { equal, matchObject };
};
