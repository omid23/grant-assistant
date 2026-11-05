# Notes

## 1. Run and test

`npm start` (reads `PORT`). `npm test` runs 128 offline tests in about 2 s, using the fake model and no network. To run the smoke test against a server: `TODAY=2026-11-05 npm start`, then `npm run smoke`. Node 22+, no dependencies. Docker and settings are in the README.

## 2. Decisions and trade-offs

**Eligibility is code.**
- `src/eligibility/rules.js` holds one entry per rule: category, deadline, region, stage, matching funds, population. `match.js` applies whatever is in that array.
- A grant is a candidate when its category matches the project's or the grant has none. Candidates that fail any rule are listed as excluded, with every failing reason in rule order. Non-candidates are not listed.
- `max_amount` never excludes a grant; it only feeds the reason and the ranking.

**Ranking.**
1. Grants made for the project's area come before open-category grants.
2. Then the amount the grant can fund, `min(max, budget)`, largest first. A grant with no maximum goes last in its tier, because we don't promise money we can't see.
3. Then the earliest deadline.

Reasons are specific, for example "youth program grant, open until 2027-01-31, up to $50,000 covers the $48,000 budget".

**The data cases:**
- **Project with no category (3):** the assistant asks, listing the categories. It doesn't guess.
- **Completed project (6):** "No open grants fit … right now", with each grant's reason.
- **7,000-character plan:** split into ≤400-character chunks at startup. Only top excerpts reach the model.
- **No maximum amount (g18):** "amount set per proposal", ranked after known amounts.
- **No-category grants (g16, g19):** open to any project, but still subject to every other rule.
- **Passed deadlines (g02, g06, g10, g20):** excluded with "closed on …". A grant is open through its deadline day, using the server's local date (`TZ`). Confirmation checks the deadline again.
- **Community too large (Lakeshore, 2,400):** g19 and g21 say "under 1,000 members". I read that strictly, so exactly 1,000 is also excluded.
- **Document addressed to the assistant:** three layers.
  1. Instruction-like lines are replaced before indexing.
  2. A tool that writes (`propose_application`) is refused for the rest of a turn once document text has entered it.
  3. A proposal creates nothing; only a later request naming its id does.
- **"Staff cannot submit" policy:** the system never submits. An application is created as `pending_review`, and the summary says it is not submitted to the funder. I didn't encode Cedar Hollow's policy as a per-community rule; the neutral wording is true everywhere.

**The fake model's modes:**
- **`slow`:** the request time limit (10 s) returns a reply and abandons the call.
- **`loop`:** after 6 model calls, the 6th tool request is refused (and audited) and the user gets a reply.
- **`unknown-tool`:** the call is refused and audited; the model then explains.

Model errors are replies, never a 500.

**Conversation state.**
- It lives in the store under the key (community id, conversation id). The same id in two communities is two conversations, so state can't leak between tenants.
- A record holds the messages, the facts the user gave (`project:3:category = food`, never written back to `data/`), and the one question being waited on. That question stays until it is answered or replaced.
- On disk, each community has a `var/<community>/state.json` (written atomically) and an append-only `audit.jsonl`. A restart loses nothing; the tests restart in the middle of a question.
- It runs as a single instance, which is the main limit.
- A category the user names beats a remembered one. The category on the project record beats both.

**Context budget.** I measure exactly the way the model measures, and every call stays under the limit.
- Never dropped:
  - the system prompt
  - the latest message, intact
  - the pending question, plus the message that led to it, cut to 300 characters around "project N"
  - the newest tool call and its result
- Then, while they fit: older tool calls in this turn as stubs, then earlier turns newest first, as question and answer only, with answers cut to 500 characters.
- The fake copies the whole message into its search query, so a message counts twice. Messages are therefore capped at 1,000 characters; longer ones get a reply asking to shorten them.
- Startup fails if the limits can't fit together.

**Status codes.** Every user-level outcome on `/chat` is a 200 with the contract shape. Only malformed requests get 4xx.

## 3. Tests that mean nothing with a real model

- **Exact reply text and tool routing.** The chat, tenancy and confirm tests, plus the "food" follow-up, depend on the fake's keyword routing: "grant" + "project N", a lone category word, and `results[0]`.
- **The injection test.** It shows that the fake's `ASSISTANT INSTRUCTION` pattern is neutralised. It says nothing about paraphrased attacks.
- **Character counting.** A real model counts tokens.

What I would test instead:
- A golden set of questions with judged answers, checking tool-choice accuracy and that grant names and reasons are cited.
- Multi-turn follow-ups phrased many ways.
- An adversarial injection suite against the structural guarantees, which do hold for any model: the taint gate, the confirm gate, and tenancy.
- Budget tests using the provider's token counter.

The eligibility, confirm-gate, tenancy, store and budget-arithmetic tests stay meaningful either way.

## 4. Where I overruled my tools

> **DRAFT for you to confirm or replace in your own words.**

An AI review of my plan suggested replacing the separate locks with one lock per community. I kept separate keys:
- one for each conversation, held while its turn runs
- one per community, only for the check-then-write steps in propose and confirm
- one per community, only for file writes

A single community lock would be held across model calls, so one slow call (`FAKE_MODE=slow`, 10 s) would freeze every other conversation in that community. The suggestion did fix a real race, two confirmations creating two applications, and that fix is kept. A test fires three confirmations at once.

## 5. Readiness

**Added:**
- startup validation of settings, data and state, failing fast with the reason
- atomic state writes that tolerate a partial audit line
- JSON logs that never include message text
- `/health`, and graceful shutdown on SIGTERM
- a Dockerfile (non-root, health check, state volume)
- CI on Node 22 and 24 that builds the image and runs the smoke test
- `.env.example` and the smoke script

**Left out on purpose:**
- Authentication: `community_id` is trusted from the body, as the contract has it. In production it must come from the caller's token.
- Proposal expiry: confirmation re-checks eligibility instead.
- Rate limits, a lint step, real embeddings.

**Still missing before real users:**
- **Persistence:** a database (Postgres) behind the same store interface, with migrations and backups. That is also what multi-instance needs.
- **Hundreds of grants:** pre-filter by category and deadline in the query, and send the model only the top N plus counts.
- **Cost per turn:** token metering per community, caching the system prompt and tool definitions, and fewer steps per question.
- **Matching quality:** an eval set reviewed by grant staff, and rule data owned by staff rather than code.
- **Monitoring:** metrics and alerts for p95 latency, timeouts, step-cap hits, refused tool calls and model errors.
- **Search:** embeddings, if keyword search falls short.
