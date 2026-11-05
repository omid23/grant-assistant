// Facts the user tells the assistant are remembered per conversation, never written back to data/.
// Precedence for a project's category:
//   1. the category recorded on the project (data/ is the source of truth)
//   2. a category the model passes in this call (the user just named one)
//   3. a category the user gave earlier in this conversation
// A category passed for a project that already has one is ignored.

export const factKey = (projectId, fact) => `project:${projectId}:${fact}`;

/**
 * @returns {{ project: object, invalidCategory: string|null, learned: {key, value}|null }}
 */
export function resolveProjectFacts(project, { inputCategory, facts = {}, categories }) {
  if (project.category != null) return { project, invalidCategory: null, learned: null };

  const given = typeof inputCategory === 'string' ? inputCategory.trim().toLowerCase() : '';
  if (given && !categories.includes(given)) {
    return { project, invalidCategory: given, learned: null };
  }
  if (given) {
    return { project: { ...project, category: given }, invalidCategory: null, learned: { key: factKey(project.id, 'category'), value: given } };
  }
  const remembered = facts[factKey(project.id, 'category')];
  return { project: remembered ? { ...project, category: remembered } : project, invalidCategory: null, learned: null };
}
