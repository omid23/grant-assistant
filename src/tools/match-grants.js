// match_grants: which grants can this project apply for, and why (or why not).
import { matchProject } from '../eligibility/match.js';
import { resolveProjectFacts } from '../eligibility/facts.js';
import { ok, failed } from './result.js';

export const grantLabel = (grant) => `${grant.name} [${grant.id}]`;

export const matchGrants = {
  name: 'match_grants',
  description:
    'Find the grants a project is eligible for, ranked, with one reason each, plus the grants in the same area that are excluded and why. ' +
    'Pass category only when the user has just named the category of a project that has none. Returns a question when a fact is missing.',
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'integer', description: 'Project id, e.g. 1' },
      category: { type: 'string', description: 'Category the user gave for a project that has none' },
    },
    required: ['project_id'],
  },

  async run(input, ctx) {
    const { catalog, communityId, conversation } = ctx;
    const community = catalog.getCommunity(communityId);
    const record = catalog.getProject(communityId, input.project_id);
    if (!record) return failed(`Project ${input.project_id} was not found in ${community.name}`);

    const facts = resolveProjectFacts(record, { inputCategory: input.category, facts: conversation.facts, categories: catalog.categories });
    if (facts.invalidCategory) {
      const question =
        `"${facts.invalidCategory}" is not a category I know. Which category is project ${record.id} (${record.name}): ` +
        `${catalog.categories.join(', ')}?`;
      ctx.askQuestion({ project_id: record.id, field: 'category', question });
      return ok({ question });
    }
    if (facts.learned) conversation.facts[facts.learned.key] = facts.learned.value;

    const project = facts.project;
    const today = ctx.clock.today();
    const outcome = matchProject({ project, community, grants: catalog.grants, today, categories: catalog.categories });
    if (outcome.question) {
      ctx.askQuestion({ project_id: project.id, field: outcome.question.fact, question: outcome.question.question });
      return ok({ question: outcome.question.question });
    }
    ctx.clearPending(project.id);

    const entry = ({ grant, reason }) => ({ id: grant.id, name: grantLabel(grant), reason });
    return ok({
      project: { id: project.id, name: project.name, category: project.category, status: project.status, budget: project.budget },
      as_of: today,
      eligible: outcome.eligible.map(entry),
      excluded: outcome.excluded.map(entry),
    });
  },
};
