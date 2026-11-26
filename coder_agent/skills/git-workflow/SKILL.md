---
name: git-workflow
description: Use when committing, branching, rebasing, resolving conflicts, or preparing a change for review. Safe git habits - inspect before acting, small focused commits, never rewrite shared history.
tools: git_status,git_diff,git_log,git_show,git_commit,git_branch,git_checkout
effort: low
---
# Git workflow

## Inspect before acting
- `git_status` first: know the branch and what is dirty.
- `git_diff` (staged vs unstaged) before committing - never commit blind.
- `git_log -n 10` to match the repo's commit-message style.

## Committing
- Commit only the files the task touched (`git_commit` with `paths`).
- One logical change per commit; clear message (what and why, not which files).
- `git_commit` stages only what is already staged unless `paths` is given - stage deliberately.
- Never `--amend` a commit that has been pushed. Never `--no-verify`.

## Branching / switching
- Create a branch before a non-trivial change if the user expects one; otherwise work on the current branch.
- `git_checkout` needs a clean worktree - commit or stash first, or the call is refused.

## Conflicts
- On a merge/rebase conflict: read the conflicted files, resolve by intent (not by picking a side), then continue.
- Never resolve by deleting code you do not understand.

## Safety
- No force-push, no rewriting shared history, no push unless the user asks.
- Destructive commands (`reset --hard`, `clean -fd`) only with explicit user confirmation.
