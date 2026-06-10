/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
import { array, either } from "fp-ts";
import { Either } from "fp-ts/lib/Either";
import { block, pipe } from "./functions.js";

export class TimeoutError extends Error {}

const taskSymbol: unique symbol = Symbol("task");
export type Task<T> = { [taskSymbol]: () => Promise<T> };
export const Task = block(() => {
  const wrap = <T>(value: () => Promise<T>): Task<T> => ({ [taskSymbol]: value });
  const lift = <T>(thunk: () => Promise<T>): Task<T> => wrap(thunk);
  const delay = <T>(thunk: () => T): Task<T> =>
    wrap(() => {
      try {
        const out = thunk();
        return Promise.resolve(out);
      } catch (e) {
        return Promise.reject(e);
      }
    });
  const of = <T>(value: T): Task<T> => wrap(() => Promise.resolve(value));

  const never: Task<never> = wrap(() => new Promise<never>(() => {}));

  const flatMap =
    <T, S>(callback: (t: T) => Task<S>) =>
    (task: Task<T>): Task<S> =>
      wrap(() => task[taskSymbol]().then((value) => callback(value)[taskSymbol]()));

  const flatMapPromise =
    <T, S>(callback: (t: T) => Promise<S>) =>
    (task: Task<T>): Task<S> =>
      wrap(() => task[taskSymbol]().then((value) => callback(value)));

  const map =
    <T, S>(callback: (t: T) => S) =>
    (task: Task<T>): Task<S> =>
      wrap(() => task[taskSymbol]().then((value) => callback(value)));

  const zip =
    <S>(theSTask: Task<S>) =>
    <T>(theTTask: Task<T>): Task<[T, S]> =>
      pipe(
        theTTask,
        flatMap((theT) =>
          pipe(
            theSTask,
            Task.map((theS) => [theT, theS]),
          ),
        ),
      );

  const tap =
    <T>(callback: (t: T) => void) =>
    (task: Task<T>): Task<T> =>
      wrap(() =>
        task[taskSymbol]().then((value) => {
          callback(value);
          return value;
        }),
      );

  const mapVoid = <T>(task: Task<T>): Task<void> => map(() => undefined)(task);
  const finalize =
    (finalizer: Task<void>) =>
    <T>(task: Task<T>): Task<T> =>
      wrap(() =>
        task[taskSymbol]()
          .then((result) => finalizer[taskSymbol]().then(() => result))
          .catch((err) => finalizer[taskSymbol]().then(() => Promise.reject(err))),
      );

  const traverseArray =
    <T, S>(cb: (t: T) => Task<S>) =>
    (arr: T[]): Task<S[]> =>
      pipe(
        arr,
        array.reduce(Task.of([]), (prev: Task<S[]>, value: T) =>
          pipe(
            prev,
            Task.flatMap((acc) =>
              pipe(
                value,
                cb,
                Task.map((res): S[] => array.append(res)(acc)),
              ),
            ),
          ),
        ),
      );

  const sequenceArray = <T>(arr: Array<Task<T>>): Task<T[]> =>
    traverseArray<Task<T>, T>((x) => x)(arr);

  const reduceArray =
    <T, S>(initial: S, cb: (accumulator: S, item: T) => Task<S>) =>
    (arr: T[]): Task<S> => {
      return arr.reduce((accumulatorTask: Task<S>, item: T): Task<S> => {
        return pipe(
          accumulatorTask,
          Task.chain((accumulator) => cb(accumulator, item)),
        );
      }, of(initial));
    };

  const attempt = <T>(task: Task<T>): Task<Either<Error, T>> => {
    return wrap(() =>
      task[taskSymbol]().then(
        (value) => either.right(value),
        (error: Error) => either.left(error),
      ),
    );
  };

  const catchError =
    <T>(cb: (error: Error) => Task<T>) =>
    (task: Task<T>): Task<T> =>
      wrap(() =>
        task[taskSymbol]().catch((reason) => {
          const errorToReport =
            reason instanceof Error ? reason : new Error(JSON.stringify(reason));
          return cb(errorToReport)[taskSymbol]();
        }),
      );

  const timeout =
    (timeoutMs: number) =>
    <T>(task: Task<T>): Task<T> => {
      return wrap(() => {
        let runningTimeout: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<T>((_, reject) => {
          runningTimeout = setTimeout(() => {
            reject(new TimeoutError(`Task did not finish in ${timeoutMs}`));
          }, timeoutMs);
        });
        const runningTask = task[taskSymbol]().then((value) => {
          clearTimeout(runningTimeout);
          return value;
        });

        return Promise.race([timeoutPromise, runningTask]);
      });
    };
  const raiseError = (err: Error): Task<never> => wrap(() => Promise.reject(err));
  const unsafeRun = <T>(task: Task<T>): Promise<T> => task[taskSymbol]();

  return {
    unsafeRun,
    of,
    lift,
    flatMap,
    chain: flatMap,
    flatMapPromise,
    map,
    zip,
    tap,
    finalize,
    delay,
    traverseArray,
    sequenceArray,
    raiseError,
    attempt,
    reduceArray,
    catchError,
    timeout,
    never,
    mapVoid,
  };
});
