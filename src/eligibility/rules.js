// Every eligibility rule in data/grants.json, one entry each. To add a rule, add an entry here
// (and a test in test/eligibility.test.js); match.js applies whatever is in this array.
//
// A rule is:
//   id                 short name
//   selectsCandidates  true when failing it means "not this kind of grant" (the grant is not
//                      listed at all) rather than "excluded, and here is why"
//   needs(grant, ctx)  name of a fact the rule needs but the project/community lacks, or null.
//                      A missing fact makes the assistant ask instead of guessing.
//   ask(ctx)           the question to ask when that fact is missing
//   check(grant, ctx)  null when the grant passes, otherwise the reason it fails
//   explainPass(...)   a short phrase for the eligible reason, or null when not worth saying
//
// ctx = { project, community, today, categories }. Failure reasons are joined with ", and " in this array's order.
// Wording note: no reason may contain the letters "categor". The fake model treats any earlier
// answer containing them as a question about categories (see model/fake.js).

const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const count = (n) => Number(n).toLocaleString('en-US');
const projectLabel = (p) => `project ${p.id} (${p.name})`;

export const rules = [
  {
    id: 'category',
    selectsCandidates: true,
    needs: (grant, { project }) => (project.category == null && grant.category != null ? 'category' : null),
    ask: ({ project, categories }) =>
      `${capitalize(projectLabel(project))} has no category recorded, so I can't tell which grants fit it. ` +
      `Which category is it: ${categories.join(', ')}?`,
    check: (grant, { project }) =>
      grant.category == null || grant.category === project.category
        ? null
        : `a ${grant.category} grant but this project is ${project.category}`,
    explainPass: (grant) => (grant.category == null ? 'open to any program area' : `${grant.category} program grant`),
  },
  {
    id: 'deadline',
    check: (grant, { today }) => (grant.deadline >= today ? null : `closed on ${grant.deadline}`),
    explainPass: (grant) => `open until ${grant.deadline}`,
  },
  {
    id: 'region',
    needs: (grant, { community }) => (grant.regions !== 'any' && community.region == null ? 'region' : null),
    ask: ({ community }) => `Which region is ${community.name} in?`,
    check: (grant, { community }) =>
      grant.regions === 'any' || grant.regions.includes(community.region)
        ? null
        : `${grant.regions.join(' or ')} region only but ${community.name} is ${community.region}`,
    explainPass: (grant, { community }) =>
      grant.regions === 'any' ? null : `for ${grant.regions.join(' or ')} region communities like ${community.name}`,
  },
  {
    id: 'stage',
    needs: (grant, { project }) => (project.status == null ? 'status' : null),
    ask: ({ project }) => `Is ${projectLabel(project)} in planning, active or completed?`,
    check: (grant, { project }) =>
      grant.stages.includes(project.status) ? null : `funds ${grant.stages.join(' or ')} projects but this one is ${project.status}`,
    explainPass: (grant) => (grant.stages.length === 1 ? `for ${grant.stages[0]} projects only, which this one is` : null),
  },
  {
    id: 'matching_funds',
    needs: (grant, { project }) => (grant.requires_matching_funds && project.has_matching_funds == null ? 'has_matching_funds' : null),
    ask: ({ project }) => `Does ${projectLabel(project)} have matching funds confirmed? Some grants require them.`,
    check: (grant, { project }) =>
      !grant.requires_matching_funds || project.has_matching_funds === true ? null : 'requires matching funds but this project has none',
    explainPass: (grant) => (grant.requires_matching_funds ? 'matching funds in place' : null),
  },
  {
    id: 'population',
    needs: (grant, { community }) => (grant.max_population != null && community.population == null ? 'population' : null),
    ask: ({ community }) => `How many members does ${community.name} have?`,
    // "Communities under 1,000 members only": strictly below the limit.
    check: (grant, { community }) =>
      grant.max_population == null || community.population < grant.max_population
        ? null
        : `only for communities under ${count(grant.max_population)} members but ${community.name} has ${count(community.population)}`,
    explainPass: (grant, { community }) =>
      grant.max_population == null ? null : `${community.name}'s ${count(community.population)} members are under its ${count(grant.max_population)} limit`,
  },
];

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Phrase describing how much of the budget the grant can cover. Not a rule: max_amount never excludes. */
export function amountPhrase(grant, project) {
  if (grant.max_amount == null) return 'amount set per proposal';
  if (project.budget == null) return `up to ${money(grant.max_amount)}`;
  return grant.max_amount >= project.budget
    ? `up to ${money(grant.max_amount)} covers the ${money(project.budget)} budget`
    : `up to ${money(grant.max_amount)} of the ${money(project.budget)} budget`;
}
