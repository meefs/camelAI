# Project build sandbox warmup manifest

`package.json` in this directory is the UNION of the dependency sets of both
project scaffold templates in `workers/main/src/project-scaffold.ts` (the
minimal worker/api template and the react-router template), with the exact
same version ranges.

It exists solely so `workers/main/project-build-sandbox.Dockerfile` can run
`bun install` against it at image build time, prebaking a warm bun global
cache (`~/.bun/install/cache`) into the ProjectBuildSandbox image. Cold
project builds then resolve the scaffold dependency tree from the local cache
instead of downloading everything from npm on every fresh container.

This package is never installed at runtime — the temp install dir and its
`node_modules` are deleted in the same Dockerfile layer; only the cache is
kept.

When you change a dependency or version range in either scaffold template,
update this file to match. The drift-guard test
`workers/main/tests/project-scaffold-warmup.test.ts` fails if the two get out
of sync.
