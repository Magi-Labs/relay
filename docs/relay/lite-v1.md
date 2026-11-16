# Relay v1 — focused Orca fork

The default `dev`, `build`, and `start` commands now launch Relay's focused desktop entry point. Orca's phone pairing, tasks, automations, skills, account dashboards, onboarding, telemetry, and general-purpose settings are absent from this application. The build rejects imports that pull their entry points or the old renderer store back in. Upstream source remains in the repository as reference for continued UI reuse; it is not the active app.

## Run

```sh
pnpm build
pnpm start
# Development:
pnpm dev
```

Requires Python 3, Git, and dtach on execution hosts. `gh` is required for GitHub cloning and PR status. Native Windows sess execution is not supported in this v1.

Local data defaults to `~/Documents/Relay`; SSH hosts default to `~/relay`. Set `RELAY_ROOT` to isolate local workspace data and `RELAY_USER_DATA_PATH` to isolate desktop preferences. `ORCA_BACKGROUND_LAUNCH=1` keeps test windows hidden.

## Architecture

Each host owns its backend process, registry, workspace manifests, Git operations, CLI, and actual dtach sessions. The Electron main process routes JSON requests to a persistent local Python worker or a worker bootstrapped over SSH. PR/Linear requests use a separate worker so network calls do not block session attachment. Losing an attachment does not kill its sess owner. Explicit End session stops it; an ended session is not silently restarted.

```text
relay/
  repos/                         # gh clones; existing repositories may be registered in place
  workspaces/<workspace>/
    workspace.json
    AGENTS.md
    repos/<repo>/                # independent worktree for each repository
  util_repos/                    # shared repos, no worktrees
  utils/
    registry.json
    relay/                        # installed host backend and sess
    bin/relay                     # agent CLI
    sess-state/
```

Every host gets a permanent `Genral` workspace. A new workspace can be blank or create worktrees from new/existing branches in any selected repos. Agents attach additional repositories using the host-local CLI, even when the desktop is disconnected:

```sh
relay repo attach web --new-branch task/example --json
relay repo attach api --new-branch task/example --json
relay status --json
```

Lazy worktrees are created explicitly by this CLI, not by intercepting arbitrary file writes. Workspace `AGENTS.md` directs agents to attach before editing canonical repos.

## UI retained

Orca's canonical CSS theme, shadcn/Radix controls, file-type icons, and Monaco editor/diff infrastructure are reused. The large original single-repo panel controllers depend on Orca's full store; Relay supplies focused host-aware controllers and multi-repo file/change lists instead. Xterm mounts only the selected tab’s terminal panes. Monaco is loaded only when a file or diff is opened. Git status refreshes while visible, and PR/Linear results are cached.

Appearance settings contain only dark/light theme, terminal font size, and compact sidebar rows. Files/diffs are read-only; changes, staging, unstaging, and commits are scoped to their individual repository. PR state and an explicitly attached Linear ticket appear in the bottom bar. Live Linear state uses [schpet/linear-cli](https://github.com/schpet/linear-cli) on the execution host. Install `linear` and run `linear auth login` there. Relay accepts ticket IDs and full `https://linear.app/team/issue/ENG-123/title` URLs, including copied query strings and fragments. It verifies `linear issue view ENG-123 --json --no-comments` before attaching a ticket, including the optional ticket field in New workspace. Failed verification does not create a workspace or replace its current ticket. Status refreshes every minute while visible; failures show an unavailable icon and hover explanation. Clear the ticket field to detach. Automatic ticket extraction from PR text is not implemented.

## Validation

- `pnpm test:relay`: 18 Python backend tests, including multi-repo isolation, permanent Genral, path boundaries, staged/working/renamed/binary/large file diff cases, CLI and session persistence.
- `pnpm tc:relay`: focused renderer and Node typechecks. The old full upstream web project has unrelated project-file-list errors; the Relay renderer has its own project.
- Changed TypeScript passes oxlint and oxfmt; production build passes the feature-scope guard.
- Hidden Electron/CDP: create two-repo workspace, inspect Monaco diffs, stage one repo, switch terminals, reload, inspect appearance; zero renderer errors after fixes.
- `local-vm`: actual SSH session, host-local CLI attached two worktrees, inspected remote diff, switched away/back; shell PID remained 3648343 throughout that smoke test. Temporary test sessions are cleaned up separately from user sessions.

Release signing, distribution packaging, and native Windows support remain separate from this local v1.

## Terminal layout and CLI names

Cmd+D and Cmd+Shift+D split the focused terminal vertically and horizontally; the same bindings use Ctrl outside macOS. Every pane has its own sess owner. Layout trees reference stable terminal IDs and save divider ratios in the workspace manifest. Tabs group related panes with `tab_id`; reordering a tab moves the entire group. Cmd+W closes the focused leaf and collapses its parent, preserving sibling sessions.

```sh
relay workspace rename --workspace WORKSPACE_ID --name 'API investigation'
relay terminal rename --workspace WORKSPACE_ID --terminal TERMINAL_ID --name 'Claude API'
relay terminal split --workspace WORKSPACE_ID --terminal TERMINAL_ID --axis columns
relay terminal split --workspace WORKSPACE_ID --terminal TERMINAL_ID --axis rows
```

From an agent launched in Relay, `RELAY_WORKSPACE` supplies the workspace automatically. A CLI-created split is attached when the desktop refreshes and displays that tab.

## Releases

`pnpm release:relay:mac` builds and stages the app, then creates the native Apple Silicon DMG, ZIP and update metadata under `dist-relay/`. The release identity is `me.deepaksilaych.relay`; the update feed is `DeepakSilaych/orca`. Never publish upstream Orca artifacts to this feed as Relay updates.

The first v0.2.0 build is unsigned and unnotarized, with `extraMetadata.relayAutoUpdate: false`. Settings routes users to Releases and does not attempt a Squirrel installation. To enable automatic Mac installation in a future release, configure Developer ID signing and notarization, then set `relayAutoUpdate: true` only for signed distributions. Preserve the same app identifier and signing identity across updates. Test an actual signed old-to-new installation before claiming that update path is verified.

Validation:

```sh
python3 -m unittest discover -s resources/relay/tests -v
node --test resources/relay/tests/updates.test.cjs
node resources/relay/tests/shortcuts-smoke.cjs
node resources/relay/tests/layout-smoke.cjs
```

Electron smoke tests launch hidden windows against disposable local roots and never touch real VM sessions. Set `RELAY_EXECUTABLE` to a packaged Relay executable to validate the shipped runtime.

### Homebrew and macOS signatures (v0.2.1)

Install with `brew install --cask deepaksilaych/tap/relay`. The tap is maintained at `DeepakSilaych/homebrew-tap`; update its cask version and SHA-256 after publishing each release. Casks retain normal macOS quarantine behavior and do not remove workspace data.

v0.2.0 shipped with an invalid residual app signature. v0.2.1 explicitly ad-hoc signs the bundle, uses Electron's JIT/library-loading entitlements and runs strict recursive signature verification before packaging. Ad-hoc signing is not Developer ID signing or notarization; first-launch approval can still be necessary and the automatic updater remains disabled. Finder launches seed standard Homebrew binary paths so the cask's Python/tmux dependencies are discoverable.
