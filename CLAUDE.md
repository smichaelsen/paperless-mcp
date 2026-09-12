# paperless-mcp — working conventions

MCP server exposing the Paperless-ngx REST API. Hard fork of `nloui/paperless-mcp`,
published as `@smichaelsen/paperless-mcp`. No upstream PRs.

## Layout

- `src/index.ts` — CLI parsing, stdio + Streamable HTTP transports, tool registration.
- `src/api/PaperlessAPI.ts` — the only place that talks to Paperless over HTTP.
- `src/tools/*.ts` — one `register*Tools(server, api)` per Paperless resource.
- `tests/**/*.test.ts` — vitest. `npm test` runs them; `npm run typecheck` type-checks.

## Rules

- Every tool handler returns `toTextResult(...)` from `src/tools/result.ts`. A bare
  object is not a valid MCP tool result.
- `tsconfig.json` must keep `"include": ["src/**/*.ts"]`. Widening it moves the
  compiled entrypoint off `build/index.js` and breaks the `paperless-mcp` bin.
- Tests live in `tests/`, never in `src/` — `src/` is compiled into the shipped package.
- Integration tests that need a real Paperless instance must skip themselves when
  `PAPERLESS_TEST_URL` is unset.
- Never log tokens, authorization headers, request bodies, or raw Paperless responses.
- `gh` defaults to the upstream repo. Always pass `--repo smichaelsen/paperless-mcp`.
