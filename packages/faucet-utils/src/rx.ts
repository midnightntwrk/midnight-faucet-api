import { concatMap, firstValueFrom, Observable, OperatorFunction } from "rxjs";
import { through } from "./functions.js";
import { Task } from "./task.js";

export const concatMapTask = <T, S>(cb: (t: T) => Task<S>): OperatorFunction<T, S> =>
  concatMap(through(cb, Task.unsafeRun));

export const firstL = <T>(t$: Observable<T>): Task<T> => Task.lift(() => firstValueFrom(t$));
