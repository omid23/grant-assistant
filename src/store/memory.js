// The store keeps four kinds of records, always per community:
//   conversations  messages, remembered facts and the question the assistant is waiting on
//   proposals      prepared applications waiting for a person to confirm them
//   applications   created only by services/confirm.js
//   audit          one entry per tool call
// Every method takes the community id first; there is no way to read across communities.
// Conversation ids are only unique inside a community: (community, id) is the key.
//
// This in-memory version is used by tests and as the core of the file store.
// Records are copied in and out, so callers can never mutate stored state by accident.

export const MAX_STORED_MESSAGES = 200;

const copy = (x) => (x == null ? null : structuredClone(x));

export function createMemoryStore({ onChange = async () => {}, initial = {} } = {}) {
  /** @type {Map<string, {conversations: object, proposals: object, applications: object, audit: object[]}>} */
  const communities = new Map();
  const state = (cid) => {
    if (!communities.has(cid)) communities.set(cid, { conversations: {}, proposals: {}, applications: {}, audit: [] });
    return communities.get(cid);
  };
  for (const [cid, s] of Object.entries(initial)) Object.assign(state(cid), s);

  return {
    snapshot: (cid) => {
      const { conversations, proposals, applications } = state(cid);
      return { conversations, proposals, applications };
    },

    conversations: {
      get: async (cid, id) => copy(state(cid).conversations[id]),
      save: async (cid, conversation) => {
        const record = copy(conversation);
        record.messages = record.messages.slice(-MAX_STORED_MESSAGES);
        state(cid).conversations[record.id] = record;
        await onChange(cid, 'state');
      },
    },

    proposals: {
      create: async (cid, proposal) => {
        state(cid).proposals[proposal.id] = copy(proposal);
        await onChange(cid, 'state');
        return copy(proposal);
      },
      get: async (cid, id) => copy(state(cid).proposals[id]),
      update: async (cid, id, patch) => {
        const existing = state(cid).proposals[id];
        if (!existing) return null;
        Object.assign(existing, copy(patch));
        await onChange(cid, 'state');
        return copy(existing);
      },
      findPending: async (cid, projectId, grantId) =>
        copy(Object.values(state(cid).proposals).find((p) => p.status === 'pending' && p.project_id === projectId && p.grant_id === grantId)),
    },

    applications: {
      create: async (cid, application) => {
        state(cid).applications[application.id] = copy(application);
        await onChange(cid, 'state');
        return copy(application);
      },
      list: async (cid) => Object.values(state(cid).applications).map(copy).sort((a, b) => a.created_at.localeCompare(b.created_at)),
      findByProjectGrant: async (cid, projectId, grantId) =>
        copy(Object.values(state(cid).applications).find((a) => a.project_id === projectId && a.grant_id === grantId)),
    },

    audit: {
      append: async (cid, entry) => {
        state(cid).audit.push(copy(entry));
        await onChange(cid, 'audit', entry);
      },
      list: async (cid) => state(cid).audit.map(copy),
    },

    close: async () => {},
  };
}
