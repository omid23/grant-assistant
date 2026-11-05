// The tools the model may call. To add a tool: write src/tools/<name>.js exporting an object
// with the shape below, and add it to this list. The loop, audit log and validation pick it up.
//
//   name, description, input_schema   what the model sees (input_schema is a small JSON Schema)
//   untrustedOutput   the result carries text from outside (documents). Once such a result is in
//                     a turn, tools with sideEffect are refused for the rest of that turn.
//   sideEffect        the tool writes something (a proposal). Never true for read-only tools.
//   run(input, ctx)   returns { outcome: 'ok'|'refused'|'failed', result } (use the helpers in result.js)
//
// ctx: { communityId, catalog, docs, store, clock, config, withLock, conversation, askQuestion, clearPending }
import { matchGrants } from './match-grants.js';
import { searchDocuments } from './search-documents.js';
import { proposeApplication } from './propose-application.js';

export const tools = [matchGrants, searchDocuments, proposeApplication];

export const toolDefinitions = (list = tools) =>
  list.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

/**
 * Validate model-supplied input against a tool's input_schema (the subset our tools use:
 * object with typed properties, required, pattern, maxLength). Integers given as numeric
 * strings are accepted, since models do that.
 * @returns {{ input: object } | { error: string }}
 */
export function validateInput(tool, raw) {
  const schema = tool.input_schema;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${tool.name} needs an object as input` };
  const input = {};
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    let value = raw[key];
    if (value === undefined || value === null || value === '') {
      if ((schema.required || []).includes(key)) return { error: `${tool.name} is missing ${key}` };
      continue;
    }
    if (spec.type === 'integer') {
      if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
      if (!Number.isInteger(value)) return { error: `${key} must be a whole number` };
    } else if (spec.type === 'string') {
      if (typeof value !== 'string') return { error: `${key} must be text` };
      value = value.trim();
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) return { error: `${key} "${value.slice(0, 40)}" is not valid` };
      if (spec.maxLength) value = value.slice(0, spec.maxLength);
    }
    input[key] = value;
  }
  return { input };
}
