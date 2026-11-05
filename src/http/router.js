// Routes. The response shapes here are a contract with the review scripts: keep them.
//   POST /chat          { community_id, message, conversation_id? } -> { reply, proposal, conversation_id }
//   POST /chat          { community_id, confirm_proposal_id }       -> { reply, applied }
//   GET  /projects      ?community_id=  -> [ { id, name, category, budget, status, has_matching_funds } ]
//   GET  /applications  ?community_id=  -> [ { id, project_id, grant_id, status, created_at } ]
//   GET  /audit         ?community_id=  -> [ { tool, input, outcome, ms, at } ]
//   GET  /health                        -> { ok: true }
import { send, sendError, readJson, HttpError } from './json.js';
import { handleChat, CONVERSATION_ID } from '../services/chat.js';
import { confirmProposal } from '../services/confirm.js';

function communityFrom(deps, value) {
  if (typeof value !== 'string' || !value) throw new HttpError(400, 'missing_community_id', 'community_id is required.');
  if (!deps.catalog.hasCommunity(value)) throw new HttpError(404, 'unknown_community', `There is no community "${value.slice(0, 60)}".`);
  return value;
}

const pick = (keys) => (row) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

async function chat(deps, req, meta) {
  const body = await readJson(req, deps.config.maxBodyBytes);
  const communityId = communityFrom(deps, body.community_id);
  meta.community_id = communityId;

  if (body.confirm_proposal_id !== undefined) {
    // Confirming is a separate, explicit request. The model is never involved.
    return confirmProposal(deps, { communityId, proposalId: body.confirm_proposal_id });
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    throw new HttpError(400, 'missing_message', 'Send a message, or a confirm_proposal_id to confirm a proposal.');
  }
  if (body.conversation_id != null && (typeof body.conversation_id !== 'string' || !CONVERSATION_ID.test(body.conversation_id))) {
    throw new HttpError(400, 'invalid_conversation_id', 'conversation_id must be 1 to 100 letters, digits, "-" or "_".');
  }
  const result = await handleChat(deps, { communityId, message: body.message.trim(), conversationId: body.conversation_id || null });
  meta.conversation_id = result.conversation_id;
  return result;
}

const routes = {
  'POST /chat': chat,
  'GET /projects': async (deps, req, meta, url) => {
    const cid = (meta.community_id = communityFrom(deps, url.searchParams.get('community_id')));
    return deps.catalog.listProjects(cid).map(pick(['id', 'name', 'category', 'budget', 'status', 'has_matching_funds']));
  },
  'GET /applications': async (deps, req, meta, url) => {
    const cid = (meta.community_id = communityFrom(deps, url.searchParams.get('community_id')));
    return (await deps.store.applications.list(cid)).map(pick(['id', 'project_id', 'grant_id', 'status', 'created_at']));
  },
  'GET /audit': async (deps, req, meta, url) => {
    const cid = (meta.community_id = communityFrom(deps, url.searchParams.get('community_id')));
    return (await deps.store.audit.list(cid)).map(pick(['tool', 'input', 'outcome', 'ms', 'at']));
  },
  'GET /health': async () => ({ ok: true }),
};

export function createHandler(deps) {
  const paths = new Set(Object.keys(routes).map((r) => r.split(' ')[1]));

  return async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const meta = {};
    let status = 200;
    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        throw paths.has(url.pathname)
          ? new HttpError(405, 'method_not_allowed', `${req.method} is not supported on ${url.pathname}.`)
          : new HttpError(404, 'not_found', `There is no ${url.pathname} endpoint.`);
      }
      send(res, status, await route(deps, req, meta, url));
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        sendError(res, error);
      } else {
        // A bug in our code. Model and tool errors are turned into replies long before this point.
        status = 500;
        deps.logger.error('internal_error', { path: url.pathname, message: String(error?.stack || error).slice(0, 1000) });
        if (!res.headersSent) send(res, 500, { error: 'internal_error', reply: 'Something went wrong on our side. Please try again.' });
      }
    } finally {
      deps.logger.info('request', { method: req.method, path: url.pathname, status, ms: Date.now() - started, ...meta });
    }
  };
}
