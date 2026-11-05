// propose_application: prepare an application of a project to a grant for a person to confirm.
// It never creates an application. Only services/confirm.js does, on a later request that
// names the proposal id.
import { randomUUID } from 'node:crypto';
import { evaluateGrant, questionFor, excludedReason } from '../eligibility/match.js';
import { amountPhrase } from '../eligibility/rules.js';
import { resolveProjectFacts } from '../eligibility/facts.js';
import { grantLabel } from './match-grants.js';
import { ok, refused, failed } from './result.js';

const money = (n) => (n == null ? 'not set' : `$${Number(n).toLocaleString('en-US')}`);

function summarize(project, grant) {
  return (
    `Apply ${project.name} (project ${project.id}, budget ${money(project.budget)}) to ${grantLabel(grant)} from ${grant.funder}: ` +
    `${amountPhrase(grant, project)}, deadline ${grant.deadline}.` +
    (grant.requires_matching_funds ? ' Matching funds are required and recorded on the project.' : '') +
    ' Confirming records the application as pending review; it is not submitted to the funder.'
  );
}

export const proposeApplication = {
  name: 'propose_application',
  description:
    'Prepare an application of a project to a grant, for the user to confirm by its id. Does not create the application. ' +
    'Only use when the user asks to apply. Ineligible grants are refused.',
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'integer', description: 'Project id, e.g. 1' },
      grant_id: { type: 'string', pattern: '^g\\d+$', description: 'Grant id, e.g. g01' },
    },
    required: ['project_id', 'grant_id'],
  },
  sideEffect: true,

  async run(input, ctx) {
    const { catalog, communityId, conversation, store } = ctx;
    const community = catalog.getCommunity(communityId);
    const record = catalog.getProject(communityId, input.project_id);
    if (!record) return failed(`Project ${input.project_id} was not found in ${community.name}`);
    const grant = catalog.getGrant(input.grant_id);
    if (!grant) return failed(`Grant ${input.grant_id} is not in the catalogue`);

    const { project } = resolveProjectFacts(record, { facts: conversation.facts, categories: catalog.categories });
    const evalCtx = { project, community, today: ctx.clock.today(), categories: catalog.categories };
    const evaluation = evaluateGrant(grant, evalCtx);
    if (evaluation.failures.length) {
      return refused(`${grantLabel(grant)} cannot be proposed for ${project.name}: ${excludedReason(evaluation)}`);
    }
    const question = questionFor([evaluation], evalCtx);
    if (question) {
      ctx.askQuestion({ project_id: project.id, field: question.fact, question: question.question });
      return ok({ question: question.question });
    }

    return ctx.withLock(`apply:${communityId}`, async () => {
      const existing = await store.applications.findByProjectGrant(communityId, project.id, grant.id);
      if (existing) return refused(`${project.name} has already applied to ${grantLabel(grant)} (${existing.id})`);

      const pending = await store.proposals.findPending(communityId, project.id, grant.id);
      if (pending) return ok({ proposal: { id: pending.id, summary: pending.summary } });

      const proposal = await store.proposals.create(communityId, {
        id: `prop_${randomUUID()}`,
        community_id: communityId,
        conversation_id: conversation.id,
        project_id: project.id,
        grant_id: grant.id,
        // Facts the user supplied in conversation, so the confirm step judges the same project.
        resolved_facts: record.category == null ? { category: project.category } : {},
        summary: summarize(project, grant),
        status: 'pending',
        created_at: new Date().toISOString(),
      });
      return ok({ proposal: { id: proposal.id, summary: proposal.summary } });
    });
  },
};
