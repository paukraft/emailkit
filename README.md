<p align="center">
  <img src="apps/docs/public/emailkit-logo.png" alt="emailkit" width="96" />
</p>

# emailkit

Monorepo for the `emailkit` package, its Blume documentation, and a small Next.js app used for local webhook and send-flow testing.

## Workspace

- `packages/emailkit`: published package source
- `apps/docs`: documentation site powered by Blume
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

To work on the docs alone:

```sh
cd apps/docs
bun run dev
```
