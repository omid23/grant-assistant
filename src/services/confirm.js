// The confirm gate: the only code that creates applications.
// It runs when a request names a proposal id, never because the model asked for it: no tool
// can reach this function. Eligibility is checked again here, because time has passed since the
// proposal (a deadline may have closed).
import { randomUUID } from 'node:crypto';
import { evaluateGrant, excludedReason } from '../eligibility/match.js';
import { resolveProjectFacts } from '../eligibility/facts.js';
import { grantLabel } from '../tools/match-grants.js';
import { auditor } from './chat.js';

export async function confirmProposal(deps, { communityId, proposalId }) {
  const { store, catalog, clock, logger, withLock } = deps;
  const started = Date.now();
  const audit = auditor(store, communityId, logger);
  const finish = async (outcome, response, detail) => {
    await audit({ tool: 'confirm_proposal', input: { proposal_id: proposalId }, outcome, ms: Date.now() - started, at: new Date(started).toISOString(), detail });
    return response;
  };

  return withLock(`apply:${communityId}`, async () => {
    // Looked up inside this community only: another community's proposal id is simply not found.
    const proposal = typeof proposalId === 'string' ? await store.proposals.get(communityId, proposalId) : null;
    if (!proposal) return finish('failed', { reply: 'I could not find that proposal.', applied: false }, 'not found');

    const project = catalog.getProject(communityId, proposal.project_id);
    const grant = catalog.getGrant(proposal.grant_id);
    if (!project || !grant) return finish('failed', { reply: 'That proposal refers to a project or grant that no longer exists.', applied: false }, 'missing data');

    const existing = await store.applications.findByProjectGrant(communityId, project.id, grant.id);
    if (existing) {
      if (proposal.status !== 'applied') await store.proposals.update(communityId, proposal.id, { status: 'applied', application_id: existing.id });
      return finish('ok', {
        reply: `This was already confirmed: ${project.name} has an application to ${grantLabel(grant)} (${existing.id}). Nothing new was created.`,
        applied: true,
      }, 'already applied');
    }
    if (proposal.status !== 'pending') {
      return finish('refused', { reply: `That proposal can no longer be confirmed (it is ${proposal.status}). Ask me to prepare a new one.`, applied: false }, `status ${proposal.status}`);
    }

    const { project: resolved } = resolveProjectFacts(project, { inputCategory: proposal.resolved_facts?.category, categories: catalog.categories });
    const evaluation = evaluateGrant(grant, { project: resolved, community: catalog.getCommunity(communityId), today: clock.today(), categories: catalog.categories });
    if (!evaluation.candidate || evaluation.failures.length || evaluation.missing.length) {
      await store.proposals.update(communityId, proposal.id, { status: 'stale' });
      const why = evaluation.failures.length ? excludedReason(evaluation) : 'a fact it depends on is missing';
      return finish('refused', {
        reply: `${project.name} can no longer apply to ${grantLabel(grant)}: ${why}. Nothing was created.`,
        applied: false,
      }, 'no longer eligible');
    }

    const application = await store.applications.create(communityId, {
      id: `app_${randomUUID()}`,
      community_id: communityId,
      project_id: project.id,
      grant_id: grant.id,
      proposal_id: proposal.id,
      status: 'pending_review',
      created_at: new Date().toISOString(),
    });
    await store.proposals.update(communityId, proposal.id, { status: 'applied', application_id: application.id, confirmed_at: application.created_at });
    return finish('ok', {
      reply:
        `Done: the application of ${project.name} to ${grantLabel(grant)} is created (${application.id}) and recorded as pending review. ` +
        'It has not been submitted to the funder.',
      applied: true,
    });
  });
}
