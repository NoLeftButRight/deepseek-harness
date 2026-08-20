/**
 * Local-only bump-and-build workflow for the dsh family.
 *
 * Sequences a sync from `origin`, bumps the dsh family version (one shared
 * version across every `packages/*` leaf and every `apps/*` entry), and
 * produces a full build. It never pushes, tags, or publishes: `release.yml`
 * owns those steps on a `dsh-v<version>` tag cut from master.
 *
 * Why this script exists:
 *
 * - `release:dsh` is the canonical bump primitive, but it makes no decision
 *   about whether the working tree is clean, whether the branch is fast-
 *   forwardable, or whether the build will succeed after the bump. Repeating
 *   that judgement by hand is easy to skip.
 * - The build (`pnpm run build`) composes three independent compile steps
 *   (`tsc -b tsconfig.host.json`, `tsc -b tsconfig.client.json`, the web
 *   frontend bundler). Running them out of order is the most common local
 *   mistake.
 *
 * Usage:
 *
 *   pnpm tsx scripts/local/bump-and-build.ts <version> [--skip-sync] [--skip-bump] [--branch <name>]
 *
 * Examples:
 *
 *   pnpm tsx scripts/local/bump-and-build.ts 0.1.0-rc.8
 *   pnpm tsx scripts/local/bump-and-build.ts patch
 *   pnpm tsx scripts/local/bump-and-build.ts 0.1.0-rc.8 --branch feature/local-build
 *   pnpm tsx scripts/local/bump-and-build.ts --skip-bump   # sync + clean + build only
 *
 * Exit codes:
 *
 *   0  success
 *   1  preflight, sync, or build failure (the offending command's output is
 *      the last thing on stderr before the script prints its error line)
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { compareVersions } from '../release/bump.ts'

/** Parsed CLI options. */
interface Options {
  /** Target version (e.g. `0.1.0-rc.8`) or release type (`major|minor|patch`). */
  readonly version: string | undefined
  /** Skip `git fetch` + `git merge --ff-only`. */
  readonly skipSync: boolean
  /** Skip the `release:dsh` step; only sync and build. */
  readonly skipBump: boolean
  /** Create or switch to this branch before any other step. */
  readonly branch: string | undefined
  /** Prompt for a version choice instead of auto-picking the latest. */
  readonly interactive: boolean
}

/**
 * Parse CLI arguments.
 * @param argv - slice of `process.argv` after the node + script path.
 * @returns Parsed options.
 */
function parseOptions(argv: readonly string[]): Options {
  let version: string | undefined
  let skipSync = false
  let skipBump = false
  let branch: string | undefined
  let interactive = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--skip-sync') {
      skipSync = true
    } else if (arg === '--skip-bump') {
      skipBump = true
    } else if (arg === '--interactive' || arg === '-i') {
      interactive = true
    } else if (arg === '--branch') {
      const next = argv[++i]
      if (next === undefined) throw new Error('--branch requires a value')
      branch = next
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`)
    } else if (version === undefined) {
      version = arg
    } else {
      throw new Error(`unexpected positional argument: ${arg}`)
    }
  }

  return { version, skipSync, skipBump, branch, interactive }
}

/**
 * Print a step header in cyan.
 * @param name - step name.
 */
function step(name: string): void {
  process.stdout.write(`\n\u001B[36m\u25B6 ${name}\u001B[0m\n`)
}

/**
 * Print an error and exit.
 * @param message - error message.
 */
function fail(message: string): never {
  process.stderr.write(`\u001B[31m\u2717 ${message}\u001B[0m\n`)
  process.exit(1)
}

/**
 * Extract the exit code from a `spawnSync` result. `status` is documented as
 * `number | null`; null means the process was killed by a signal and we treat
 * it as failure for orchestration purposes.
 * @param result - spawn result.
 * @returns The exit code (non-zero on signal).
 */
function exitCode(result: SpawnSyncReturns<unknown>): number {
  return result.status ?? 1
}

/**
 * Run a command, inheriting stdio, and exit on non-zero.
 * @param cmd - command.
 * @param args - arguments.
 */
function run(cmd: string, args: readonly string[]): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (exitCode(result) !== 0) fail(`${cmd} ${args.join(' ')} exited with status ${exitCode(result)}`)
}

/**
 * Run a command and capture its stdout (UTF-8).
 * @param cmd - command.
 * @param args - arguments.
 * @returns Trimmed stdout.
 */
function capture(cmd: string, args: readonly string[]): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (exitCode(result) !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr : ''
    fail(`${cmd} ${args.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`)
  }
  return result.stdout.trim()
}

/**
 * Read the `version` field of a JSON file at the repo root.
 * @param manifestPath - repo-relative manifest path.
 * @returns The version string.
 */
function readVersion(manifestPath: string): string {
  const probe = `JSON.parse(require('node:fs').readFileSync(${JSON.stringify(manifestPath)}, 'utf8')).version`
  const result = spawnSync('node', ['-p', probe], { encoding: 'utf8' })
  if (exitCode(result) !== 0) fail(`cannot read version from ${manifestPath}`)
  return result.stdout.trim()
}

/**
 * Decide whether the active node satisfies the engine constraint declared in
 * `package.json`. Exits with a clear message on a mismatch rather than
 * failing later with an opaque node error from pnpm.
 */
function assertNodeEngine(): void {
  const [majorRaw, minorRaw] = process.versions.node.split('.')
  const major = Number(majorRaw)
  const minor = Number(minorRaw)
  const majorOk = major > 24 || (major === 22 && minor >= 19)
  if (!majorOk) fail(`node >= 22.19 or >= 24 required, got ${process.versions.node}`)
}

/**
 * Decide whether a branch ref exists locally.
 * @param branch - branch name.
 * @returns `true` when the branch exists.
 */
function branchExists(branch: string): boolean {
  return exitCode(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) === 0
}

/**
 * Apply a fast-forward merge against the current branch's upstream. Skips
 * silently when no upstream is configured.
 */
function fastForwardSync(): void {
  const upstreamResult = spawnSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { encoding: 'utf8' })
  if (exitCode(upstreamResult) !== 0) {
    process.stdout.write('  no upstream configured; skipping sync\n')
    return
  }
  const upstream = upstreamResult.stdout.trim()
  run('git', ['merge', '--ff-only', upstream])
}

/** A published dsh release candidate, as read from a `dsh-v*` tag. */
interface PublishedVersion {
  /** Tag name as found on `origin`, e.g. `dsh-v0.1.0-rc.4`. */
  readonly tag: string
  /** The version segment, e.g. `0.1.0-rc.4`. */
  readonly version: string
}

/**
 * Read published dsh versions from `origin`'s `dsh-v*` tags. Returns an empty
 * list when no remote tags exist or the `git ls-remote` call fails; callers
 * decide how to handle the empty case.
 * @returns Versions sorted newest-first by semver precedence.
 */
function fetchPublishedVersions(): PublishedVersion[] {
  const result = spawnSync('git', ['ls-remote', '--tags', 'origin', 'dsh-v*'], { encoding: 'utf8' })
  if (exitCode(result) !== 0) return []

  const tagPattern = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/
  const seen = new Set<string>()
  const versions: PublishedVersion[] = []
  for (const line of result.stdout.split('\n')) {
    const ref = line.split('\t')[1] ?? ''
    const match = tagPattern.exec(ref)
    if (match === null) continue
    const version = match[1]
    if (version === undefined || seen.has(version)) continue
    seen.add(version)
    versions.push({ tag: `dsh-v${version}`, version })
  }
  // Newest first; `compareVersions` returns positive when `left > right`, so
  // pass the candidate second to invert the sort.
  return versions.sort((a, b) => compareVersions(b.version, a.version))
}

/**
 * Strip an optional `dsh-v` prefix and any whitespace from a user-supplied
 * version string. Accepts both `0.1.0-rc.8` and `dsh-v0.1.0-rc.8`.
 * @param raw - the raw version or tag.
 * @returns The bare version.
 */
function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^dsh-v/, '')
}

/**
 * Print a numbered menu and ask the user to pick. Empty input returns the
 * default (first) entry.
 * @param prompt - the question to print.
 * @param choices - entries to choose from, in display order.
 * @param format - render an entry for display.
 * @returns The user's chosen entry.
 */
async function promptChoice<T>(prompt: string, choices: readonly T[], format: (item: T) => string): Promise<T> {
  if (choices.length === 0) throw new Error('cannot prompt from an empty menu')

  const rl: ReadlineInterface = createInterface({ input, output })
  try {
    process.stdout.write(`${prompt}\n`)
    choices.forEach((choice, index) => {
      const marker = index === 0 ? ' (default)' : ''
      process.stdout.write(`  ${String(index + 1).padStart(2)}. ${format(choice)}${marker}\n`)
    })
    while (true) {
      const answer = (await rl.question(`Enter a number [1-${String(choices.length)}] (default 1): `)).trim()
      if (answer === '') {
        const fallback = choices[0]
        if (fallback === undefined) throw new Error('prompt menu has no default entry')
        return fallback
      }
      const parsed = Number(answer)
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= choices.length) {
        const picked = choices[parsed - 1]
        if (picked === undefined) throw new Error('parsed index out of range')
        return picked
      }
      process.stdout.write(`  invalid input: ${answer}\n`)
    }
  } finally {
    rl.close()
  }
}

/**
 * Resolve the target version when the user did not pass one explicitly.
 * Defaults to the highest published version from `origin` tags; in
 * `--interactive` mode, presents the recent tags as a menu. Fails loudly when
 * no tags exist so the user is not silently bumped to a guessed value.
 * @param interactive - whether to prompt for a selection.
 * @returns The chosen version (already normalized).
 */
async function resolveVersion(interactive: boolean): Promise<string> {
  const published = fetchPublishedVersions()
  if (published.length === 0) {
    fail('no published dsh versions found on origin (no `dsh-v*` tags); pass an explicit version, e.g. `pnpm run local:bump-and-build 0.1.0-rc.6`.')
  }
  if (!interactive) {
    const latest = published[0]
    if (latest === undefined) throw new Error('published list became empty during resolve')
    process.stdout.write(`  auto-selected latest published version: ${latest.version} (tag ${latest.tag})\n`)
    return latest.version
  }
  return normalizeVersion(await promptChoice(
    'Choose a target version:',
    published,
    entry => `${entry.version}  (tag ${entry.tag})`,
  ))
}

/** Main workflow. */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))

  step('Preflight')
  assertNodeEngine()
  run('pnpm', ['--version'])

  const dirty = capture('git', ['status', '--porcelain'])
  if (dirty !== '') fail(`working tree is dirty; commit or stash first:\n${dirty}`)

  if (options.branch !== undefined) {
    step(`Switch to branch ${options.branch}`)
    if (branchExists(options.branch)) {
      run('git', ['switch', options.branch])
    } else {
      run('git', ['switch', '-c', options.branch])
    }
  }

  if (!options.skipSync) {
    step('Sync with origin (fast-forward only)')
    run('git', ['fetch', 'origin'])
    fastForwardSync()
  }

  step('Install dependencies')
  // No `--frozen-lockfile`: upstream may have added deps, in which case the
  // pre-fetch lockfile no longer matches `package.json`. `release:dsh` later
  // updates the lockfile for the version bump.
  run('pnpm', ['install'])

  let version = options.version
  if (version !== undefined) version = normalizeVersion(version)

  if (!options.skipBump) {
    if (version === undefined) {
      step('Resolve target version')
      version = await resolveVersion(options.interactive)
    }
    const fromVersion = readVersion('package.json')
    if (fromVersion === version) {
      fail(`refusing to bump: requested version equals current (${fromVersion}). Pick a different version or pass --skip-bump.`)
    }

    step(`Bump dsh version: ${fromVersion} -> ${version} (dry-run preview)`)
    run('pnpm', ['run', 'release:dsh', '--dry-run', version])

    step(`Bump dsh version: ${fromVersion} -> ${version} (apply)`)
    run('pnpm', ['run', 'release:dsh', version])

    const sha = capture('git', ['rev-parse', 'HEAD'])
    process.stdout.write(`  committed as ${sha.slice(0, 12)}\n`)
  }

  step('Clean previous build outputs')
  run('pnpm', ['run', 'clean'])

  step('Build (host lib + client lib + web frontend)')
  run('pnpm', ['run', 'build'])

  const newVersion = readVersion('package.json')
  step('Done')
  process.stdout.write(`  dsh family version: ${newVersion}\n`)
  process.stdout.write('  artifacts:\n')
  process.stdout.write('    packages/<leaf>/lib/  compiled host and client libraries\n')
  process.stdout.write('    apps/web/dist/        web frontend bundle\n')
  process.stdout.write('    apps/cli/lib/bin.js   built dsh CLI entry (run with `node`)\n')
  process.stdout.write('  try it:  pnpm run dsh -- --profile headless "echo hello"\n')
  if (!options.skipBump) {
    process.stdout.write('  next steps:\n')
    process.stdout.write('    git log -1                            inspect the version commit\n')
    process.stdout.write('    git reset --hard HEAD~1               discard the bump and the build\n')
    process.stdout.write('    git push origin HEAD                  publish the bump to a remote branch\n')
    process.stdout.write(`    git tag dsh-v${newVersion} <merge commit> && git push origin dsh-v${newVersion}\n`)
    process.stdout.write('      hand off to CI for npm publish\n')
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  fail(message)
})
