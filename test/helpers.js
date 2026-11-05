// Shared test setup: a real app wired to the fake model, an in-memory store and a fixed date.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
// Tests pin the date so real deadlines passing never changes the expected results.
export const TODAY = '2026-11-05';
