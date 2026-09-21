---
name: relay-cli
description: Manage Relay workspaces and persistent agent terminals using the relay CLI, locally or on a VM. Use for Relay terminal launches, prompts, output inspection, and repository attachment. Relay is separate from Orca and has no orca-ide orchestration runtime.
---

# Relay CLI

Run `relay --version` and `relay --help` for the installed interface. Do not resolve Relay commands through `ORCA_CLI_COMMAND`, `orca`, or `orca-ide`. Orca's orchestration skill and its prohibition on alternative Orca runtimes apply to Orca tasks, not Relay tasks.

The CLI runs on the execution host. Inside a Relay terminal, `RELAY_ROOT` and `RELAY_WORKSPACE` identify its workspace; legacy `MAGI_ROOT` and `MAGI_WORKSPACE` are accepted. For imported sessions without these variables, run `relay workspace list --json` and select the workspace matching the task's checkout. Pass its ID explicitly. Do not assume an inherited Orca variable identifies Relay.

```sh
relay workspace list --json
relay --workspace WORKSPACE_ID terminal run --name Review --command 'codex' --json
relay --workspace WORKSPACE_ID terminal read --terminal TERMINAL_ID --lines 200 --json
relay --workspace WORKSPACE_ID terminal send --terminal TERMINAL_ID --input-text 'Review the requested change' --enter --json
relay --workspace WORKSPACE_ID terminal remove --terminal TERMINAL_ID --json
```

`terminal run` creates a persistent terminal and launches the shell command immediately; it returns the terminal ID and session name. `--cwd` selects a directory within the workspace. It can run an agent CLI with the arguments appropriate to that installed agent. Start separate terminals for user-authorized concurrent work, retain every returned ID, and inspect their output individually. `terminal new` only creates a tab; use `terminal run` for headless launches.

`terminal send` sends literal text; `--enter` explicitly submits it. `terminal read` reports terminal output, not a structured agent-completion verdict. A live terminal may contain a completed command or an agent waiting for input. Inspect actual output before reporting success. Closing Relay does not terminate sessions; `terminal remove` does, so remove only terminals owned by the task and intended to be stopped.

Relay does not implement Orca's worker messages, task DAGs, `worker_done`, blocking ask/reply, or ownership handoff API. Do not invent equivalents or present terminal output as those structured events. Use Relay's terminal commands for the user's Relay workflow; report a missing capability precisely if the task requires one.

Run `relay repo attach NAME --new-branch task/NAME --base HEAD --json` to attach an editing worktree when needed. Reuse the existing task checkout for read-only reviews. From the laptop, `--host NAME` targets a registered VM; on the VM, omit it to use that host directly.

File drops in Relay upload VM files through sess 0.7.0. Explicit uploads from the laptop use `sess upload --host SSH_ALIAS -- /absolute/file`. Uploads do not submit the agent prompt. Terminal persistence currently uses the legacy tmux adapter; do not claim a terminal is a zmx session.

Set the Files explorer comparison per workspace/repository with `relay --workspace WORKSPACE_ID repo compare REPO_NAME --ref dev --json`. Any local Git ref or commit is accepted, including `origin/main`. Use `--ref auto` to select dev, origin/dev, main, origin/main, master, origin/master, then HEAD. Relay compares the selected commit directly with the current working tree, including committed, staged, unstaged and untracked changes. It does not fetch automatically. The selection persists on the execution host and appears in the desktop Files view. `relay --workspace WORKSPACE_ID status --json` includes each repository's comparison ref and changed paths.
