# Local scripts

Workflows that run on a developer machine and never push, tag, or publish on
their own. CI owns the corresponding remote actions.

## `bump-and-build.ts`

Sync the repo with `origin`, bump the dsh family version, and produce a full
build, leaving the resulting commit on the current branch.

```sh
pnpm tsx scripts/local/bump-and-build.ts <version> [options]
```

| Argument / flag  | Effect                                                                 |
|------------------|------------------------------------------------------------------------|
| `<version>`      | Target version (`0.1.0-rc.8`) or release type (`major`/`minor`/`patch`) |
| `--skip-sync`    | Skip `git fetch` + fast-forward merge                                   |
| `--skip-bump`    | Sync + build only; no version change                                    |
| `--branch <name>`| Create or switch to `<name>` before any other step                       |

The script refuses to run on a dirty working tree, refuses to fast-forward
into a non-fast-forwardable state, and refuses to bump to the current version.
`vendor/` packages are out of scope (see
`scripts/release/bump.ts --family vendor`).

Exit code is non-zero on any failure; the offending command's output is the
last thing printed before the summary.

## Why these are not in `scripts/release/`

`scripts/release/` is the canonical bump and publish surface and CI reads it
verbatim. Local conveniences belong next to other dev-tooling scripts (see
`scripts/dev-web.ts` for the existing pattern) and are intentionally
excluded from the published surface.