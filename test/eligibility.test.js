// Eligibility rules: every project in data/ against every grant, plus each rule on its own.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../src/catalog/catalog.js';
import { matchProject, evaluateGrant } from '../src/eligibility/match.js';
import { rules } from '../src/eligibility/rules.js';
import { resolveProjectFacts } from '../src/eligibility/facts.js';
import { DATA_DIR, TODAY } from './helpers.js';

const catalog = loadCatalog(DATA_DIR);

function run(communityId, projectId, { category, today = TODAY } = {}) {
  const project = catalog.getProject(communityId, projectId);
  return matchProject({
    project: category ? { ...project, category } : project,
    community: catalog.getCommunity(communityId),
    grants: catalog.grants,
    today,
    categories: catalog.categories,
  });
}

const ids = (list) => list.map((x) => x.grant.id);
const reasonOf = (list, id) => list.find((x) => x.grant.id === id).reason;

// Expected results on 2026-11-05. This table is also in the plan and NOTES.md.
const EXPECTED = [
  { cid: 'cedar-hollow', pid: 1, eligible: ['g01', 'g22', 'g18', 'g16', 'g19'],
    excluded: { g02: ['closed on 2026-03-31'], g03: ['south region only'], g23: ['funds planning projects', 'active'] } },
  { cid: 'cedar-hollow', pid: 2, eligible: ['g05', 'g19'],
    excluded: { g04: ['requires matching funds'], g06: ['closed on 2026-09-30', 'funds planning projects'], g16: ['requires matching funds'], g24: ['south region only', 'requires matching funds'] } },
  { cid: 'cedar-hollow', pid: 3, category: 'food', eligible: ['g13', 'g12', 'g16', 'g19'], excluded: {} },
  { cid: 'cedar-hollow', pid: 3, category: 'culture', eligible: ['g14', 'g16', 'g19'], excluded: { g20: ['closed on 2026-10-01'] } },
  { cid: 'lakeshore', pid: 4, eligible: ['g07', 'g08', 'g17', 'g16'], excluded: { g19: ['under 1,000 members', 'Lakeshore has 2,400'] } },
  { cid: 'lakeshore', pid: 5, eligible: ['g09'],
    excluded: { g10: ['closed on 2026-08-01'], g16: ['requires matching funds'], g19: ['under 1,000'], g21: ['under 1,000'], g25: ['funds planning projects', 'requires matching funds'] } },
  { cid: 'lakeshore', pid: 6, eligible: [],
    excluded: {
      g01: ['completed'], g02: ['closed on 2026-03-31', 'completed'], g03: ['completed'], g16: ['completed'], g18: ['completed'],
      g19: ['completed', 'under 1,000'], g22: ['north region only', 'completed'], g23: ['completed'],
    } },
];

describe('every project in the data', () => {
  for (const row of EXPECTED) {
    test(`${row.cid} project ${row.pid}${row.category ? ` as ${row.category}` : ''}`, () => {
      const result = run(row.cid, row.pid, { category: row.category });
      assert.equal(result.question, undefined);
      assert.deepEqual(ids(result.eligible), row.eligible, 'eligible grants, in rank order');
      assert.deepEqual(ids(result.excluded), Object.keys(row.excluded).sort(), 'excluded grants, by id');
      for (const [id, fragments] of Object.entries(row.excluded)) {
        let at = -1;
        for (const fragment of fragments) {
          const pos = reasonOf(result.excluded, id).indexOf(fragment, at + 1);
          assert.ok(pos > at, `${id} reason "${reasonOf(result.excluded, id)}" should contain "${fragment}" in rule order`);
          at = pos;
        }
      }
    });
  }

  test('closed grants are never eligible, for any project or category', () => {
    const closed = catalog.grants.filter((g) => g.deadline < TODAY).map((g) => g.id);
    assert.deepEqual(closed.sort(), ['g02', 'g06', 'g10', 'g20']);
    for (const cid of catalog.communityIds()) {
      for (const project of catalog.listProjects(cid)) {
        for (const category of project.category ? [undefined] : catalog.categories) {
          const result = run(cid, project.id, { category });
          for (const id of ids(result.eligible)) assert.ok(!closed.includes(id), `${id} is closed but came back eligible`);
        }
      }
    }
  });

  test('a project with no category gets a question, not a guess', () => {
    const result = run('cedar-hollow', 3);
    assert.equal(result.eligible, undefined);
    assert.equal(result.question.fact, 'category');
    assert.match(result.question.question, /Project 3 \(Community garden\)/);
    assert.match(result.question.question, /category/);
    for (const c of catalog.categories) assert.ok(result.question.question.includes(c));
  });
});

describe('reasons', () => {
  test('eligible reasons are specific: program area, deadline and amount', () => {
    const { eligible } = run('cedar-hollow', 1);
    assert.equal(reasonOf(eligible, 'g01'), 'youth program grant, open until 2027-01-31, up to $50,000 covers the $48,000 budget');
    assert.match(reasonOf(eligible, 'g22'), /for north region communities like Cedar Hollow/);
    assert.match(reasonOf(eligible, 'g22'), /up to \$20,000 of the \$48,000 budget/);
    assert.match(reasonOf(eligible, 'g16'), /^open to any program area, .*matching funds in place/);
    assert.match(reasonOf(eligible, 'g19'), /Cedar Hollow's 850 members are under its 1,000 limit/);
  });

  test('a grant with no maximum says the amount is set per proposal', () => {
    assert.match(reasonOf(run('cedar-hollow', 1).eligible, 'g18'), /amount set per proposal$/);
  });

  test('no reason contains "categor" (the fake model would read it as a category question)', () => {
    for (const cid of catalog.communityIds()) {
      for (const project of catalog.listProjects(cid)) {
        for (const category of project.category ? [undefined] : catalog.categories) {
          const { eligible, excluded } = run(cid, project.id, { category });
          for (const x of [...eligible, ...excluded]) assert.doesNotMatch(x.reason, /categor/i);
        }
      }
    }
    const wrongArea = evaluateGrant(catalog.getGrant('g04'), ctxFor('cedar-hollow', 1));
    assert.doesNotMatch(wrongArea.failures.join(' '), /categor/i);
  });
});

// ---- each rule on its own, with synthetic grants ----

const baseGrant = {
  id: 'gx', name: 'Test grant', category: 'youth', max_amount: 10000, deadline: '2027-01-31',
  regions: 'any', stages: ['planning', 'active'], requires_matching_funds: false, max_population: null,
};
const baseProject = { id: 99, name: 'Test project', category: 'youth', budget: 5000, status: 'active', has_matching_funds: false };
const baseCommunity = { id: 'test', name: 'Testville', region: 'north', population: 500 };

function ctxFor(cid, pid) {
  return { project: catalog.getProject(cid, pid), community: catalog.getCommunity(cid), today: TODAY, categories: catalog.categories };
}
function check(grant = {}, project = {}, community = {}, today = TODAY) {
  return evaluateGrant({ ...baseGrant, ...grant }, {
    project: { ...baseProject, ...project }, community: { ...baseCommunity, ...community }, today, categories: catalog.categories,
  });
}
const ok = (e) => e.candidate && e.failures.length === 0 && e.missing.length === 0;

describe('rules one by one', () => {
  test('rules run in a fixed, documented order', () => {
    assert.deepEqual(rules.map((r) => r.id), ['category', 'deadline', 'region', 'stage', 'matching_funds', 'population']);
  });

  test('category: same area or open grant is a candidate, another area is not listed', () => {
    assert.ok(ok(check({ category: 'youth' })));
    assert.ok(ok(check({ category: null })));
    const other = check({ category: 'housing' });
    assert.equal(other.candidate, false);
    assert.match(other.failures[0], /a housing grant but this project is youth/);
  });

  test('deadline: open on the deadline day, closed the day after', () => {
    assert.ok(ok(check({ deadline: '2026-11-05' })));
    assert.deepEqual(check({ deadline: '2026-11-04' }).failures, ['closed on 2026-11-04']);
  });

  test('region: "any" or a listed region', () => {
    assert.ok(ok(check({ regions: 'any' })));
    assert.ok(ok(check({ regions: ['north'] })));
    assert.deepEqual(check({ regions: ['south'] }).failures, ['south region only but Testville is north']);
  });

  test('stage: planning-only grant, completed project', () => {
    assert.ok(ok(check({ stages: ['active'] })));
    assert.match(check({ stages: ['planning'] }).failures[0], /funds planning projects but this one is active/);
    assert.match(check({}, { status: 'completed' }).failures[0], /this one is completed/);
  });

  test('matching funds: only checked when the grant requires them', () => {
    assert.ok(ok(check({ requires_matching_funds: false }, { has_matching_funds: false })));
    assert.ok(ok(check({ requires_matching_funds: true }, { has_matching_funds: true })));
    assert.deepEqual(check({ requires_matching_funds: true }, { has_matching_funds: false }).failures, ['requires matching funds but this project has none']);
  });

  test('population: strictly under the limit ("under 1,000 members")', () => {
    assert.ok(ok(check({ max_population: 1000 }, {}, { population: 999 })));
    assert.match(check({ max_population: 1000 }, {}, { population: 1000 }).failures[0], /under 1,000 members but Testville has 1,000/);
    assert.ok(ok(check({ max_population: null }, {}, { population: 50000 })));
  });

  test('max_amount never excludes a grant', () => {
    assert.ok(ok(check({ max_amount: 100 }, { budget: 1_000_000 })));
    assert.ok(ok(check({ max_amount: null })));
  });
});

describe('ranking', () => {
  const rank = (grants, project = {}) =>
    ids(matchProject({ project: { ...baseProject, ...project }, community: baseCommunity, grants, today: TODAY, categories: catalog.categories }).eligible);

  test('own-area grants before open grants, then more of the budget funded, then earlier deadline', () => {
    const grants = [
      { ...baseGrant, id: 'g1', category: null, max_amount: 5000 },
      { ...baseGrant, id: 'g2', max_amount: 1000 },
      { ...baseGrant, id: 'g3', max_amount: 9000, deadline: '2027-03-01' },
      { ...baseGrant, id: 'g4', max_amount: 7000, deadline: '2027-02-01' },
    ];
    // budget 5000: g3 and g4 both fund 5000, g4 closes sooner
    assert.deepEqual(rank(grants), ['g4', 'g3', 'g2', 'g1']);
  });

  test('a grant with no maximum ranks after grants with a known amount in its tier', () => {
    const grants = [{ ...baseGrant, id: 'g1', max_amount: null }, { ...baseGrant, id: 'g2', max_amount: 100 }];
    assert.deepEqual(rank(grants), ['g2', 'g1']);
  });
});

describe('missing facts', () => {
  test('a missing fact that could change the answer is asked about', () => {
    const grants = [{ ...baseGrant, requires_matching_funds: true }];
    const result = matchProject({ project: { ...baseProject, has_matching_funds: null }, community: baseCommunity, grants, today: TODAY, categories: [] });
    assert.equal(result.question.fact, 'has_matching_funds');
    assert.match(result.question.question, /matching funds/);
  });

  test('a missing fact is not asked about when the grant fails anyway', () => {
    const grants = [{ ...baseGrant, requires_matching_funds: true, deadline: '2020-01-01' }];
    const result = matchProject({ project: { ...baseProject, has_matching_funds: null }, community: baseCommunity, grants, today: TODAY, categories: [] });
    assert.equal(result.question, undefined);
    assert.deepEqual(ids(result.excluded), ['gx']);
  });
});

describe('remembered facts', () => {
  const project = catalog.getProject('cedar-hollow', 3);
  const categories = catalog.categories;

  test('the project record wins, then the category just given, then the remembered one', () => {
    const recorded = catalog.getProject('cedar-hollow', 1);
    assert.equal(resolveProjectFacts(recorded, { inputCategory: 'food', categories }).project.category, 'youth');
    const given = resolveProjectFacts(project, { inputCategory: 'Culture', facts: { 'project:3:category': 'food' }, categories });
    assert.equal(given.project.category, 'culture');
    assert.deepEqual(given.learned, { key: 'project:3:category', value: 'culture' });
    assert.equal(resolveProjectFacts(project, { facts: { 'project:3:category': 'food' }, categories }).project.category, 'food');
    assert.equal(resolveProjectFacts(project, { categories }).project.category, null);
  });

  test('an unknown category is flagged, not used', () => {
    const r = resolveProjectFacts(project, { inputCategory: 'sports', categories });
    assert.equal(r.invalidCategory, 'sports');
    assert.equal(r.project.category, null);
  });
});
