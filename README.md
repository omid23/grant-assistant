# Grant assistant

A small Node service for community staff: "which grants can this project apply for?". One
`POST /chat` request runs an agent loop. The model asks for a tool, the service runs it, and the
model answers from the result. Eligibility is decided by code (`src/eligibility/`), not by the
model. The model asks questions and explains. Applications are only ever created by a separate,
explicit confirmation.

Plain Node 22+ with no runtime dependencies. It ships with a deterministic fake model
(`model/fake.js`), so it runs and tests with no API key and no network.

Design decisions and trade-offs are in [NOTES.md](NOTES.md). The original brief is [TASK.md](TASK.md).

## Run it

```bash
npm start                          # http://localhost:3000
PORT=4000 npm start                # any port
TODAY=2026-11-05 npm start         # pin "today" so the deadlines match the examples below
```

PowerShell:

```powershell
$env:PORT=4000; npm start
```

No `npm install` is needed to run, because there are no dependencies. `npm ci` is still the normal first step in CI and Docker.

```bash
npm test                                         # all tests, offline, about 2 seconds
BASE_URL=http://localhost:3000 npm run smoke     # every data case against a running server
```

## API

```bash
# Ask a question. Omit conversation_id to start a conversation; send it back to continue one.
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"community_id":"cedar-hollow","message":"Which grants can project 1 apply for?"}'
# -> { "reply": "Grants Youth Leadership Program can apply for: ...", "proposal": null, "conversation_id": "..." }

# Ask for an application: the reply carries a proposal. Nothing is created yet.
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"community_id":"cedar-hollow","message":"Apply project 1 to grant g01"}'
# -> { "reply": "I have prepared this for you to confirm: ...", "proposal": { "id": "prop_...", "summary": "..." }, "conversation_id": "..." }

# A person confirms it by id. This is the only way an application is created.
curl -s localhost:3000/chat -H 'content-type: application/json' \
  -d '{"community_id":"cedar-hollow","confirm_proposal_id":"prop_..."}'
# -> { "reply": "Done: ...", "applied": true }

curl -s 'localhost:3000/projects?community_id=cedar-hollow'      # [ { id, name, category, budget, status, has_matching_funds } ]
curl -s 'localhost:3000/applications?community_id=cedar-hollow'  # [ { id, project_id, grant_id, status, created_at } ]
curl -s 'localhost:3000/audit?community_id=cedar-hollow'         # [ { tool, input, outcome, ms, at } ]
curl -s localhost:3000/health                                     # { ok: true }
```

Status codes:

- **200:** every outcome a user can cause on `/chat`. This includes answers, questions, the step cap, timeouts, model errors, an over-long message, and a proposal that is unknown or can no longer be confirmed (`applied: false`).
- **400:** a malformed request: bad JSON, a missing `community_id`, or neither `message` nor `confirm_proposal_id`.
- **404:** an unknown community or route.
- **405:** the wrong method.
- **413:** a body over `MAX_BODY_BYTES`.
- **500:** only for bugs.

Every error body is `{ error, reply }`.

## Configuration

All settings are environment variables, and all are optional. [.env.example](.env.example) lists them with comments.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `MODEL` | fake | `fake` or `anthropic` (needs `ANTHROPIC_API_KEY`) |
| `FAKE_MODE` | | `slow`, `loop` or `unknown-tool`, to exercise failure handling |
| `MAX_STEPS` | 6 | model calls per request |
| `REQUEST_TIMEOUT_MS` | 10000 | time limit for one request |
| `CONTEXT_BUDGET_CHARS` | the model's limit (6000) | max characters sent to the model per call |
| `MAX_MESSAGE_CHARS` | 1000 | longer messages get a reply asking to shorten them |
| `MAX_TOOL_RESULT_CHARS` | 1800 | tool results are trimmed to this |
| `PENDING_RESERVE_CHARS` | 650 | room kept for the question the assistant is waiting on |
| `SEARCH_TOP_K` / `CHUNK_CHARS` | 3 / 400 | excerpts per search, and characters per excerpt |
| `MAX_BODY_BYTES` | 65536 | largest accepted request body |
| `DATA_DIR` | ./data | grant catalogue and community data (read only) |
| `STATE_DIR` | ./var | conversations, proposals, applications, audit log |
| `TODAY` | | pins today's date (YYYY-MM-DD) for demos and checks |
| `TZ` | system | timezone for "today" when checking deadlines |
| `LOG_LEVEL` | info | `info`, `error` or `silent` |

At startup the service checks that the limits fit the budget. It exits with a message naming the
numbers if they don't, and it does the same for a bad variable or an unreadable data or state file.

## Deploy

```bash
docker build -t grant-assistant .
docker run -d -p 3000:3000 -v grant-state:/app/var -e TZ=America/Toronto grant-assistant
```

- **Image:** runs `node src/server.js` as a non-root user, with a `HEALTHCHECK` on `/health`. On SIGTERM it stops accepting connections and finishes in-flight requests.
- **State:** everything the service writes is under `STATE_DIR` (`/app/var` in the image). Put it on a persistent volume and back it up.
- **One instance only:** run one instance per `STATE_DIR`. Scaling out needs a shared database; see NOTES.md.
- **Logs:** one JSON object per line on stdout (requests) and stderr (errors). They never include message text.
- **CI:** `.github/workflows/ci.yml` runs the tests on Node 22 and 24. It then builds the image and runs the smoke test against it.

## Layout

```
src/
  server.js              entry point: reads settings, starts HTTP, handles shutdown
  app.js                 wires everything together (everything injectable for tests)
  config.js  clock.js  log.js  lib/mutex.js
  http/                  routes and JSON handling; the response shapes above live in router.js
  catalog/catalog.js     read-only access to data/, always per community
  eligibility/
    rules.js             every eligibility rule, one entry each
    match.js             runs the rules: eligible / excluded / ask a question
    rank.js              the order eligible grants are listed in
    facts.js             facts the user supplies in conversation (e.g. a missing category)
  docs/index.js          document chunking, sanitising and search, per community
  tools/                 the three tools the model can call, plus the registry
  agent/
    loop.js              the agent loop: step cap, time limit, errors become replies
    context.js           what goes to the model each step, within the budget
    prompt.js            the system prompt
  services/
    chat.js              one chat turn: load the conversation, run the loop, save
    confirm.js           the confirm gate: the only code that creates applications
  store/                 memory (tests) and JSON-file (default) stores, same interface
model/                   fake.js, anthropic.js, index.js (provided, unchanged)
data/                    grants and the two communities (provided, unchanged)
test/                    node:test suites, one per concern
scripts/smoke.mjs        end-to-end check against a running server
```

How a request flows:

1. `http/router.js` validates the body and resolves the community.
2. `services/chat.js` loads that community's conversation and locks it.
3. `agent/loop.js` repeats until the model answers or a limit is hit: `agent/context.js` builds the messages, the model is called, and the tool it asks for runs (`tools/*`) and is audited.
4. The turn is saved, and `{ reply, proposal, conversation_id }` is returned.

A confirmation goes from `router.js` straight to `services/confirm.js`. The model is not involved.

### Add an eligibility rule

Add one entry to the `rules` array in `src/eligibility/rules.js`: `check` returns a failure reason
or null, and `explainPass` returns a phrase for the eligible reason. If the rule needs a fact that
can be missing, add `needs` and `ask`, so the assistant asks for it instead of guessing. Add a case
to `test/eligibility.test.js`. Nothing else changes: matching, proposals, confirmation and the
replies all run the same rules.

### Add a tool

Create `src/tools/<name>.js` exporting `{ name, description, input_schema, run }`. `run` returns
`ok(result)`, `refused(reason)` or `failed(reason)` from `src/tools/result.js`. Then add the tool
to the list in `src/tools/index.js`. Validation, the audit log, the step cap and the context budget
apply to it automatically.

- If its result contains outside text (documents, email, the web), mark it `untrustedOutput: true`.
- If it writes anything, mark it `sideEffect: true`. A tool with a side effect is refused for the rest of a turn once untrusted text has been read in that turn.
