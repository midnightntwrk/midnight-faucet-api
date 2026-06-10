import { array } from "fp-ts";
import { block, pipe, through } from "./functions.js";
import { Task } from "./task.js";

export interface Allocated<T> {
  value: T;
  teardown: Task<void>;
}

// A type, which handles resource allocation and deallocation, also in presence of errors
// For it to work well, it's important to always suspend side-effects, so, e.g. all promises need to be wrapped in thunks, etc.
// It's inspired a lot by Scala's cats-effect Resource type
export interface Resource<T> {
  // The most low-level representation of a resource
  // Prepare the value to use, and teardown manually later. Particularly useful in tests or to build other combinators on top of it
  allocate: Task<Allocated<T>>;
}
export const Resource = block(() => {
  const make = <T>(setup: Task<T>, teardown: (t: T) => Task<void>): Resource<T> => {
    return {
      allocate: pipe(
        setup,
        Task.map((value) => ({
          value,
          teardown: pipe(
            teardown(value),
            Task.catchError((error) =>
              Task.delay(() => {
                // eslint-disable-next-line no-console
                console.warn("Caught error while releasing resource, ignoring...", error);
              }),
            ),
          ),
        })),
      ),
    };
  };

  const fromTask = <T>(task: Task<T>): Resource<T> => ({
    allocate: pipe(
      task,
      Task.map((value) => ({
        value,
        teardown: Task.of(undefined),
      })),
    ),
  });

  const of = <T>(value: T): Resource<T> => ({
    allocate: Task.of({
      value,
      teardown: Task.of(undefined),
    }),
  });

  const allocate = <T>(resource: Resource<T>): Task<Allocated<T>> => resource.allocate;

  // The most preferred way of using resource - pass a callback and don't care about anything
  const use =
    <T, S>(cb: (t: T) => Task<S>) =>
    (resource: Resource<T>): Task<S> =>
      pipe(
        resource.allocate,
        Task.flatMap((allocated) => {
          return pipe(allocated.value, cb, Task.finalize(allocated.teardown));
        }),
      );

  const useSync =
    <T, S>(cb: (t: T) => S) =>
    (resource: Resource<T>): Task<S> =>
      use(through(cb, Task.of))(resource);

  const map =
    <T, S>(cb: (t: T) => S) =>
    (resource: Resource<T>): Resource<S> => ({
      allocate: pipe(
        resource.allocate,
        Task.map((allocated) => ({
          ...allocated,
          value: cb(allocated.value),
        })),
      ),
    });

  const mapPromise =
    <T, S>(cb: (t: T) => Promise<S>) =>
    (resource: Resource<T>): Resource<S> => ({
      allocate: pipe(
        resource.allocate,
        Task.flatMapPromise((allocated) =>
          cb(allocated.value).then((newValue) => ({
            ...allocated,
            value: newValue,
          })),
        ),
      ),
    });

  const traverseArray =
    <T, S>(cb: (t: T) => Resource<S>) =>
    (arr: Array<T>): Resource<S[]> =>
      arr.reduce(
        (acc: Resource<S[]>, value: T) =>
          pipe(
            acc,
            Resource.flatMap((wallets) =>
              pipe(
                value,
                cb,
                Resource.map((wallet) => array.append(wallet)(wallets)),
              ),
            ),
          ),
        of<S[]>([]),
      );

  const flatMap =
    <T, S>(cb: (t: T) => Resource<S>) =>
    (resource: Resource<T>): Resource<S> => ({
      allocate: pipe(
        resource.allocate,
        Task.flatMap((tAllocated) =>
          pipe(
            tAllocated.value,
            cb,
            (res) => res.allocate,
            Task.map((sAllocated) => ({
              value: sAllocated.value,
              teardown: pipe(sAllocated.teardown, Task.finalize(tAllocated.teardown)),
            })),
          ),
        ),
      ),
    });

  const zip =
    <S>(sResource: Resource<S>) =>
    <T>(tResource: Resource<T>): Resource<[T, S]> =>
      pipe(
        tResource,
        flatMap((t) =>
          pipe(
            sResource,
            map((s) => [t, s]),
          ),
        ),
      );

  const mproduct =
    <S, T>(factory: (original: T) => Resource<S>) =>
    (tResource: Resource<T>): Resource<[T, S]> =>
      pipe(
        tResource,
        flatMap((t) =>
          pipe(
            factory(t),
            map((s) => [t, s]),
          ),
        ),
      );

  return {
    make,
    use,
    useSync,
    allocate,
    map,
    flatMap,
    mapPromise,
    mproduct,
    zip,
    fromTask,
    traverseArray,
    of,
  };
});
