# Synthetic fixtures

Invented data for demos and tests. No real conversations, people or credentials.

- `kickoff-conversation.json`: a short product kickoff. It has one proposal (PostgreSQL) that a later decision replaces (on-device SQLite), and is used for acceptance scenarios A01–A03.
- `fixtures/extraction.json`: recorded extraction output for the kickoff, used by the `fixture` provider. It is hand-written and stands in for a model in CI and the offline demo; it shows validation and storage working, not model quality. `{{sourceId}}` is replaced with the source ID in the request.
- `demo.sh`: the offline end-to-end demo (`bash examples/synthetic/demo.sh [dir]`).
