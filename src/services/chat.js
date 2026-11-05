// One chat request: load the conversation, run the agent loop, save what happened.
//
// Conversation state lives in the store under (community id, conversation id):
//   messages  what was said, including this request's tool calls and results
//   facts     what the user told the assistant, e.g. { "project:3:category": "food" }
//   pending   the question the assistant is waiting on; kept until answered or replaced
// A conversation id from another community simply does not exist here.
import { randomUUID } from 'node:crypto';
import { runAgent } from '../agent/loop.js';
import { buildSystemPrompt } from '../agent/prompt.js';

export const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,100}$/;

const newConversation = (id, communityId) => {
  const now = new Date().toISOString();
  return { id, community_id: communityId, created_at: now, updated_at: now, last_turn: 0, messages: [], facts: {}, pending: null };
};

/** Audit writes must never turn a reply into an error; a failure is logged loudly instead. */
export const auditor = (store, communityId, logger, extra = {}) => async (entry) => {
  try {
    await store.audit.append(communityId, { ...entry, ...extra });
  } catch (error) {
    logger.error('audit_write_failed', { community_id: communityId, tool: entry.tool, message: String(error?.message || error) });
  }
};

/**
 * @returns {Promise<{ reply: string, proposal: object|null, conversation_id: string }>}
 */
export async function handleChat(deps, { communityId, message, conversationId }) {
  const { model, store, catalog, docs, clock, config, logger, withLock, tools } = deps;
  const id = conversationId || randomUUID();

  if (message.length > config.maxMessageChars) {
    return {
      reply: `Your message is ${message.length} characters long. Please keep it under ${config.maxMessageChars} characters so I can read all of it.`,
      proposal: null,
      conversation_id: id,
    };
  }

  return withLock(`conv:${communityId}:${id}`, async () => {
    const conversation = (await store.conversations.get(communityId, id)) || newConversation(id, communityId);
    const turnNumber = (conversation.last_turn || 0) + 1;
    let askedThisTurn = false;

    const toolContext = {
      communityId, catalog, docs, store, clock, config, withLock, conversation,
      askQuestion: ({ project_id, field, question }) => {
        askedThisTurn = true;
        conversation.pending = { turn: turnNumber, project_id, field, question, user_message: message };
      },
      clearPending: (projectId) => {
        if (conversation.pending && conversation.pending.project_id === projectId) conversation.pending = null;
      },
    };

    const result = await runAgent({
      model,
      tools,
      system: buildSystemPrompt({ communityName: catalog.getCommunity(communityId).name, today: clock.today() }),
      conversation,
      userMessage: message,
      toolContext,
      audit: auditor(store, communityId, logger, { conversation_id: id }),
      config,
      logger,
    });

    conversation.messages.push(
      { role: 'user', content: message, turn: turnNumber },
      ...result.turnMessages.map((m) => ({ ...m, turn: turnNumber })),
      { role: 'assistant', content: { type: 'text', text: result.reply }, turn: turnNumber },
    );
    if (askedThisTurn && conversation.pending && result.endedBy !== 'answer') {
      // The question never reached the user (timeout, step cap): don't wait on it.
      conversation.pending = null;
    }
    conversation.last_turn = turnNumber;
    conversation.updated_at = new Date().toISOString();
    await store.conversations.save(communityId, conversation);

    return { reply: result.reply, proposal: result.proposal, conversation_id: id };
  });
}
