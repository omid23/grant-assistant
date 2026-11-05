// The matching engine. It knows nothing about specific rules: it runs every rule in rules.js
// against every grant and sorts the outcome into eligible, excluded, or "we need a fact first".
import { rules as defaultRules, amountPhrase } from './rules.js';
import { compareGrants } from './rank.js';

/**
 * Evaluate one grant for one project.
 * @returns {{ grant, candidate: boolean, missing: {fact, rule}[], failures: string[], passes: string[] }}
 */
export function evaluateGrant(grant, ctx, rules = defaultRules) {
  const missing = [];
  const failures = [];
  const passes = [];
  let candidate = true;
  for (const rule of rules) {
    const fact = rule.needs ? rule.needs(grant, ctx) : null;
    if (fact) {
      missing.push({ fact, rule });
      continue;
    }
    const failure = rule.check(grant, ctx);
    if (failure) {
      failures.push(failure);
      if (rule.selectsCandidates) candidate = false;
    } else if (rule.explainPass) {
      const phrase = rule.explainPass(grant, ctx);
      if (phrase) passes.push(phrase);
    }
  }
  return { grant, candidate, missing, failures, passes };
}

/** The question to ask for the first missing fact in a list of evaluations, or null. */
export function questionFor(evaluations, ctx) {
  // Ask only when the fact could change the answer: the grant has no other failure.
  const open = evaluations.find((e) => e.missing.length && e.failures.length === 0);
  if (!open) return null;
  const { fact, rule } = open.missing[0];
  const question = rule.ask ? rule.ask(ctx) : `I need the ${fact} of project ${ctx.project.id} before I can check grants.`;
  return { fact, question };
}

export const eligibleReason = (evaluation, project) =>
  [...evaluation.passes, amountPhrase(evaluation.grant, project)].join(', ');

export const excludedReason = (evaluation) => evaluation.failures.join(', and ');

/**
 * Match a project against the whole catalogue.
 * @param {{ project, community, grants, today, categories }} input  project facts already resolved (see facts.js)
 * @returns {{ question: {fact, question} } | { eligible: object[], excluded: object[] }}
 */
export function matchProject({ project, community, grants, today, categories = [] }, rules = defaultRules) {
  const ctx = { project, community, today, categories };
  const evaluations = grants.map((g) => evaluateGrant(g, ctx, rules)).filter((e) => e.candidate);

  const question = questionFor(evaluations, ctx);
  if (question) return { question };

  const eligible = evaluations
    .filter((e) => e.failures.length === 0)
    .sort((a, b) => compareGrants(a.grant, b.grant, project))
    .map((e) => ({ grant: e.grant, reason: eligibleReason(e, project) }));
  const excluded = evaluations
    .filter((e) => e.failures.length > 0)
    .sort((a, b) => a.grant.id.localeCompare(b.grant.id))
    .map((e) => ({ grant: e.grant, reason: excludedReason(e) }));
  return { eligible, excluded };
}
