# Program assistant take-home

Start with TASK.md.

```
TASK.md                 the task
model/fake.js.txt       deterministic stand-in for the model, read it first; its contract is the fixed interface
model/anthropic.js.txt  optional real model with the same interface, not needed for the task
model/index.js.txt      picks between the two

The three model files end in .txt only so that mail filters let them through. Rename each to .js.
data/grants.json        grant catalogue with eligibility rules
data/communities/<id>/  profile.json, projects.json, docs/*.md for two fictional communities
```

Copy `model/` (renamed) and `data/` into your own repository and build the service around them, laid out as you see fit.
