# Repository notes

`dsh-provider-commandcode` is an out-of-tree DeepSeek Harness provider plugin. It ships a
built `lib/` and a `cordis.patch.yml` bundle layer.

## Ground rules

- The adapter contract lives in `@deepseek-ai/dsh-llm`; read
  `docs/cookbook/adding-an-llm-adapter.md` in deepseek-harness before changing
  chunk ordering, usage placement, or error codes.
- Wire translation stays in `chat.ts` and `messages.ts`; transport, headers, and
  learned downgrades stay in `adapter.ts`; capability data stays in `catalog.ts`,
  `reference.ts`, `static-catalog.ts`, and `static-reference.ts`.
- Plan filtering (`plan.ts`), account reads (`account.ts`), and the quota
  reading (`quota.ts`) never fail a model request: they fail open with a
  warning that the `/commandcode` status report shows.
- The browser half is `client.js` in the client module system's lazy-CJS factory
  format. Keep it dependency-free apart from the shared module table, and run
  `node --check client.js` after editing.
- Never print a credential. Diagnostics name the source, not the value.
- `npm run typecheck && npm test` must pass before a commit; `npm run build`
  must produce a loadable `lib/`.

## Changing the bundled catalog

`static-catalog.ts` is a snapshot. Regenerate it from a live
`GET /provider/v1/models` plus the `command-code` CLI manifest rather than
hand-editing ids; keep the header comment honest about the snapshot date.
