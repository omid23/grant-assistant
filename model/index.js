import * as fake from './fake.js';
import * as anthropic from './anthropic.js';

// Both modules expose complete({ system, messages, tools }) with the same shapes. See fake.js.
export const model = process.env.MODEL === 'anthropic' ? anthropic : fake;
