# Contributing

Thanks for helping with dsh-swarm. This project is small on purpose: a coordination layer with zero runtime dependencies.

## Development

Requirements: Node.js 22+ and npm. No install step is needed for the core; there are no runtime or development dependencies.

```bash
npm run lint          # node --check over src/ and test/
npm test              # node:test suite
npm run test:coverage # line/branch report
npm run demo          # end-to-end run without model calls
```

## Rules for changes

1. **Events first.** Any state change must append an event before mutating the projection. Do not mutate `run.state` outside `applyEvent`.
2. **No hidden time.** Reducers must use timestamps from the event payload, never `Date.now()`. Time-dependent checks belong in the service.
3. **One transition table.** Add task/member/swarm states to `src/state.js` and cover both the legal and the illegal paths.
4. **Budget is a guard.** If a code path calls a model, it must reserve first and settle in a `finally`.
5. **Secrets never land.** New persisted fields go through `scrub()`; add a redaction test when adding a new free-text surface.
6. **Tests are part of the patch.** Bug fixes need a regression test. Features need at least one happy path and one failure path.
7. **Small core.** Aim for files under 400 lines. If a module grows past that, split it by responsibility rather than adding conditionals.
8. **No new runtime dependencies** without a design note in the PR. The bundle must stay installable from a plain git checkout.

## Commit and PR checklist

- [ ] `npm run lint` and `npm test` pass locally.
- [ ] New behaviour is documented (README / docs/config.md / CHANGELOG).
- [ ] Illegal-state and security paths are covered.
- [ ] The patch can be reverted independently; write the revert steps in the PR.
- [ ] No credentials, absolute local paths, or machine names are added to fixtures.

## Release process

1. Update `CHANGELOG.md` and bump `package.json` with `npm version <minor|patch> --no-git-tag-version`.
2. Run `npm pack --dry-run` and inspect the file list.
3. Tag `vX.Y.Z`; the release workflow publishes to npm and creates the GitHub release.
4. Attach a bench/report artifact when the release changes scheduling or budget behaviour.
