// Picks the store implementation. Both have the same interface (see memory.js).
import { createMemoryStore } from './memory.js';
import { createFileStore } from './file.js';

export function createStore({ driver = 'file', dir, communityIds = [], withLock, logger }) {
  if (driver === 'memory') return createMemoryStore();
  if (driver === 'file') return createFileStore({ dir, communityIds, withLock, logger });
  throw new Error(`Unknown store driver "${driver}"`);
}
