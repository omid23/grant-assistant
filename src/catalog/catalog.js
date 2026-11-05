// Read-only access to data/: the grant catalogue and each community's profile and projects.
// Everything community-specific is reached through a community id; there is deliberately no
// "find project by id" across communities, so a tenant can only ever see its own projects.
import fs from 'node:fs';
import path from 'node:path';

const COMMUNITY_ID = /^[a-z0-9-]+$/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not load ${file}: ${e.message}`);
  }
}

function expectArray(value, file) {
  if (!Array.isArray(value)) throw new Error(`Could not load ${file}: expected a JSON array`);
  return value;
}

export function loadCatalog(dataDir) {
  const grantsFile = path.join(dataDir, 'grants.json');
  const grants = expectArray(readJson(grantsFile), grantsFile);
  const grantsById = new Map(grants.map((g) => [g.id, g]));
  const categories = [...new Set(grants.map((g) => g.category).filter(Boolean))];

  const communities = new Map();
  const root = path.join(dataDir, 'communities');
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !COMMUNITY_ID.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const profileFile = path.join(dir, 'profile.json');
    if (!fs.existsSync(profileFile)) continue;
    const projectsFile = path.join(dir, 'projects.json');
    const profile = readJson(profileFile);
    const projects = fs.existsSync(projectsFile) ? expectArray(readJson(projectsFile), projectsFile) : [];
    communities.set(entry.name, {
      community: { id: entry.name, name: profile.name, region: profile.region ?? null, population: profile.population ?? null },
      projects,
      docsDir: path.join(dir, 'docs'),
    });
  }

  return {
    grants,
    categories,
    getGrant: (id) => grantsById.get(id) ?? null,
    communityIds: () => [...communities.keys()],
    hasCommunity: (cid) => communities.has(cid),
    getCommunity: (cid) => communities.get(cid)?.community ?? null,
    listProjects: (cid) => communities.get(cid)?.projects ?? [],
    getProject: (cid, projectId) => communities.get(cid)?.projects.find((p) => p.id === projectId) ?? null,
    docsDir: (cid) => communities.get(cid)?.docsDir ?? null,
  };
}
