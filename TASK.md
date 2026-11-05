# Melyn take-home: Grant matching assistant

Due Monday, Nov 5 by end of day.
You may use any tools, including AI. Be ready to explain every part of what you submit.

## Background

Melyn is a community platform for First Nations. It has an assistant for community staff.
A common question is "which grants can this project apply for?" The assistant looks at the
project and the community, works out which grants in the catalogue it is eligible for and
why, and can prepare an application for a person to confirm.

The attached files give you two things and nothing else: the data (a grant catalogue with
eligibility rules, and profiles, projects and documents for two fictional communities) and a
fake model that behaves deterministically, so no API key is needed. Read `model/fake.js` first (it arrives as `fake.js.txt`, rename it).
It is short, and it is the model your code has to work with. Its contract is the only interface
we fix. Everything else, from the HTTP layer to the project layout, is yours to design.
The matching logic is code, as it is in our product. The model asks and explains.

## Build

A small Node service with a `POST /chat` endpoint. One request runs an agent loop: the model
asks for a tool, your code runs it and hands the result back, and this repeats until the model
answers. Plain Node or a framework, your choice. The service must start with `npm start` and
read its port from `PORT`, because our review scripts do.

1. **The loop.** A hard cap on steps and a time limit per request. When either is hit, the
   user still gets a sensible reply, not a hang or a 500.
2. **Three tools.**
   - `match_grants`: given a project, returns the grants it is eligible for, ranked, with one
     reason each, plus the grants in the same category that were excluded and why. Every rule
     in `data/grants.json` counts: category, deadline, region, project stage, matching funds,
     community population. Closed grants never come back as eligible.
     If the project is missing something the rules need, the assistant asks the user instead of
     guessing. The answer arrives in a later request with the same `conversation_id`, and the
     assistant must remember what it asked. Where that state lives, how it is tied to the
     community, and what happens to it when the server restarts are yours to decide and explain.
   - `search_documents`: searches the community's documents, returns excerpts with the document name.
   - `propose_application`: prepares an application of a project to a grant. It never creates
     the application. It returns a proposal, and the application is created only when a later
     request confirms that proposal by id. An ineligible grant cannot be proposed.
3. **Context budget.** The model has a limited context window, and it rejects a call that is over it.
   Long conversations and large documents must still work. The latest user message and any
   question the assistant is waiting on are never dropped. What else goes to the model each turn,
   and how much of it, is a decision you make and explain.
4. **Answers name their source.** Grant answers name the grants and the reasons. Document
   answers name the document. When nothing matches, the answer says so.
5. **Audit.** Every tool call lands in the audit log, including refused and failed ones.
6. **Tenancy.** A community only ever sees its own projects, documents and applications.
7. **Tests** that run with the fake model and no network: at least the eligibility rules,
   the step cap, the context budget and the confirm gate.

## HTTP contract

Our review scripts call these, so keep the shapes.

```
POST /chat   { "community_id": "cedar-hollow", "message": "Which grants can project 1 apply for?", "conversation_id"?: "..." }
         ->  { "reply": "...", "proposal": null | { "id": "...", "summary": "..." }, "conversation_id": "..." }

POST /chat   { "community_id": "cedar-hollow", "confirm_proposal_id": "..." }
         ->  { "reply": "...", "applied": true }

GET  /projects?community_id=cedar-hollow       -> [ { id, name, category, budget, status, has_matching_funds } ]
GET  /applications?community_id=cedar-hollow   -> [ { id, project_id, grant_id, status, created_at } ]
GET  /audit?community_id=cedar-hollow          -> [ { tool, input, outcome, ms, at } ]
```

## Make it production ready

Work in your own GitHub repository. Copy the data and the model files from the attachment and lay
the project out as you see fit. We will look at the repository as much as the code. Leave it in a state a teammate could deploy on Monday morning without asking you anything.
What that means is up to you.

## Data

The data includes a few real-world cases on purpose: a project with no category, a completed
project, a document far larger than the model's context window, a grant with no maximum amount, grants with no category, grants whose deadline has
passed, a community too large for some grants, a document that contains text addressed to the
assistant, and a finance policy that says staff cannot submit applications themselves. The fake
model also has `slow`, `loop` and `unknown-tool` modes. Decide how your code should handle each
and note your choice in NOTES.md.

## What we look at

- Eligibility is right for every project in the data, and the reasons are specific
- The loop cannot run forever or hang a request, and a model error becomes a reply, not a 500
- A long conversation or a large document never pushes the model over its context window
- The model cannot create an application on its own, whatever a document tells it to do
- Honest answers: a question when a fact is missing, the answer remembered, "no open grants" when that is the truth
- A structure a teammate could extend: a new eligibility rule or a fourth tool should touch one or two files, and the layout should make sense to someone who has never seen it
- Tests that need no network and finish in seconds

## NOTES.md (one page is enough)

1. How to run and test it
2. Main decisions and trade-offs, including the data cases above, how you rank, and where
   conversation state lives
3. Which of your tests would be meaningless with a real model instead of the fake one, and what
   you would test instead
4. One place where you overruled what your tools produced, AI tools included, and why
5. What you added to make it ready, what you left out on purpose, and what is still missing
   before real users: hundreds of grants, cost per turn, matching quality, monitoring, persistence

## Submit

The GitHub repository link (public, or private with access for meghmelyn). On the follow-up call we will walk through the code together and make a small change
live, so have it ready to run.
