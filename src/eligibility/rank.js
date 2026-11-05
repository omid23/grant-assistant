// How eligible grants are ordered. Change the ranking here and nowhere else.
//   1. grants made for the project's own program area before open-to-anything grants
//   2. how much of the budget the grant can fund, min(max_amount, budget), largest first;
//      grants with no stated maximum come after those with a known amount (we don't promise money we can't see)
//   3. the earlier deadline first (act on it sooner)
//   4. grant id, so the order is stable

const fundable = (grant, project) =>
  project.budget == null ? grant.max_amount : Math.min(grant.max_amount, project.budget);

export function compareGrants(a, b, project) {
  const tier = (g) => (g.category == null ? 1 : 0);
  const unknownAmount = (g) => (g.max_amount == null ? 1 : 0);
  return (
    tier(a) - tier(b) ||
    unknownAmount(a) - unknownAmount(b) ||
    (b.max_amount == null ? 0 : fundable(b, project)) - (a.max_amount == null ? 0 : fundable(a, project)) ||
    a.deadline.localeCompare(b.deadline) ||
    a.id.localeCompare(b.id)
  );
}
