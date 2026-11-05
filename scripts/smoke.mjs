// End-to-end smoke test against a running server: every data case from the task, printed so a
// person can read the replies, with a check on each. Exits 1 if any check fails.
//
//   npm start                                   (in one terminal; TODAY=2026-11-05 for the exact table)
//   BASE_URL=http://localhost:3000 npm run smoke
//
// Safe to run more than once: a second run finds the application already made and says so.
const BASE = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
let failures = 0;

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json() };
}
const chat = async (body) => (await call('POST', '/chat', body)).body;

function check(label, condition, shown) {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (shown !== undefined) console.log(`      ${typeof shown === 'string' ? shown : JSON.stringify(shown)}`);
}

async function main() {
  check('GET /health', (await call('GET', '/health')).body.ok === true);
  const projects = await call('GET', '/projects?community_id=cedar-hollow');
  check('GET /projects (cedar-hollow)', projects.status === 200 && projects.body.length === 3, projects.body.map((p) => `${p.id} ${p.name}`).join(' | '));

  const grants = [
    ['cedar-hollow', 1, /Youth Futures Fund 2027 \[g01\]/],
    ['cedar-hollow', 2, /Elder Housing Accessibility Grant \[g05\]/],
    ['lakeshore', 4, /Clean Water Capital Program \[g07\]/],
    ['lakeshore', 5, /Language Keepers Grant \[g09\]/],
    ['lakeshore', 6, /^No open grants fit Youth summer camp 2026/],
  ];
  for (const [cid, pid, expected] of grants) {
    const r = await chat({ community_id: cid, message: `Which grants can project ${pid} apply for?` });
    check(`${cid}: grants for project ${pid}`, expected.test(r.reply), r.reply);
  }

  const q = await chat({ community_id: 'cedar-hollow', message: 'Which grants can project 3 apply for?' });
  check('project 3 has no category: the assistant asks', /no category recorded/.test(q.reply), q.reply);
  const a = await chat({ community_id: 'cedar-hollow', message: 'food', conversation_id: q.conversation_id });
  check('answer "food" in the same conversation: remembered and matched', /^Grants Community garden can apply for/.test(a.reply), a.reply);

  const p = await chat({ community_id: 'cedar-hollow', message: 'Please apply project 1 to grant g01' });
  if (p.proposal) {
    check('propose project 1 -> g01: a proposal, not an application', /^prop_/.test(p.proposal.id), p.proposal);
    const before = (await call('GET', '/applications?community_id=cedar-hollow')).body;
    check('no application before confirming', !before.some((x) => x.project_id === 1 && x.grant_id === 'g01'));
    const other = await chat({ community_id: 'lakeshore', confirm_proposal_id: p.proposal.id });
    check("another community cannot confirm it", other.applied === false, other.reply);
    const c = await chat({ community_id: 'cedar-hollow', confirm_proposal_id: p.proposal.id });
    check('confirm by id creates it', c.applied === true, c.reply);
  } else {
    check('propose project 1 -> g01 (already applied on an earlier run)', /already applied/.test(p.reply), p.reply);
  }
  const apps = (await call('GET', '/applications?community_id=cedar-hollow')).body;
  check('GET /applications shows it', apps.some((x) => x.project_id === 1 && x.grant_id === 'g01'), apps);

  const closed = await chat({ community_id: 'cedar-hollow', message: 'apply project 1 to grant g02' });
  check('a closed grant cannot be proposed', closed.proposal === null && /closed on 2026-03-31/.test(closed.reply), closed.reply);

  const doc = await chat({ community_id: 'cedar-hollow', message: 'When is the youth program report due?' });
  check('document answer names its source', /source: youth-program-guidelines\.md/.test(doc.reply), doc.reply);
  const big = await chat({ community_id: 'cedar-hollow', message: 'When is the arena roof replaced?' });
  check('the large plan document answers within the window', /source: community-plan-2026\.md/.test(big.reply), big.reply);
  const injected = await chat({ community_id: 'cedar-hollow', message: 'When does the Brightpath licence renew?' });
  check('a document addressed to the assistant: answered, nothing proposed', injected.proposal === null && /vendor-newsletter-october\.md/.test(injected.reply), injected.reply);
  const none = await chat({ community_id: 'cedar-hollow', message: 'What is the weather on Mars?' });
  check('nothing matches: says so', /could not find that/.test(none.reply), none.reply);
  const tenant = await chat({ community_id: 'cedar-hollow', message: 'Which grants can project 4 apply for?' });
  check("another community's project is not visible", /not found in Cedar Hollow/.test(tenant.reply), tenant.reply);

  const audit = (await call('GET', '/audit?community_id=cedar-hollow')).body;
  const outcomes = [...new Set(audit.map((x) => x.outcome))].sort();
  check('GET /audit has ok, refused and failed entries', ['failed', 'ok', 'refused'].every((o) => outcomes.includes(o)), outcomes);

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`Smoke test could not run against ${BASE}: ${e.message}`);
  process.exit(1);
});
