import { useState } from "react";

export type Submit<Input, Output = unknown> =
  | { status: "in_progress"; lastResult: Output | null; error: string | null }
  | {
      status: "ready";
      doSubmit: (value: Input) => void;
      lastResult: Output | null;
      error: string | null;
    };

export function useSubmit<Input, Output = unknown>(
  handler: (value: Input) => Promise<Output>,
): Submit<Input, Output> {
  const [inProgress, setInProgress] = useState(false);
  const [currentError, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Output | null>(null);

  return inProgress
    ? {
        status: "in_progress",
        lastResult,
        error: currentError,
      }
    : {
        status: "ready",
        lastResult,
        error: currentError,
        doSubmit: (value: Input) => {
          setInProgress(true);
          setError(null);
          handler(value).then(
            (result) => {
              setLastResult(result);
              setInProgress(false);
            },
            (error) => {
              setLastResult(null);
              setError(error.message);
              setInProgress(false);
            },
          );
        },
      };
}
