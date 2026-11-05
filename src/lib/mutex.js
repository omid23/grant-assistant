// A keyed async lock: calls with the same key run one at a time, in arrival order.
// Key families in use (distinct, so nesting conv -> apply -> file never deadlocks):
//   conv:<community>:<conversation>   one chat turn at a time per conversation
//   apply:<community>                 check-then-write for proposals and applications
//   file:<community>                  writes to that community's state file

export function createMutex() {
  const tails = new Map();
  return async function withLock(key, fn) {
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
