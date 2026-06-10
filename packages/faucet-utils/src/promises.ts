export const wait = (ms: number): Promise<void> =>
  ms === 0
    ? Promise.resolve(undefined)
    : new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
