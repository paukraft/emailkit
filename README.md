# EmailKit

Monorepo for the `emailkit` package and a small Next.js app used for local webhook and send-flow testing.

## Workspace

- `packages/emailkit`: published package source
- `apps/sandbox`: local sandbox app for manual testing

## Commands

```sh
bun install
bun run build
bun run dev
bun run lint
bun run check-types
bun --filter emailkit test
```
