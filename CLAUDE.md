# Notes for working on this repo

## Strength is parked

Player strength (the 1–10 estimate) is not used right now. Everything that
mentions it — the `strength` fields on players, people and registrations,
`SHOW_STRENGTH` in `tt/static/app.js`, `ASK_STRENGTH` in `tt/static/site.js`,
the matchmaker's strength tolerance, the directory's remembered number — is
kept only for future use. It stays stored, but no UI asks for it or shows it
(`SHOW_STRENGTH`, `ASK_STRENGTH`) and nothing pairs, seeds or draws on it
(`USE_STRENGTH` in `tt/formats.py`).

When designing or changing anything: do not build new features around
strength, do not surface it in new UI, and do not treat its absence as a bug.
Keep existing plumbing intact so it can be switched back on later.
