---
name: sync-upstream
description: >-
  Sync this York IE fork with upstream OpenCoworkAI/open-cowork via merge,
  resolving conflicts file-by-file (keep York branding/auth/Hub; take upstream
  bugfixes and new features). Use when the user runs /sync-upstream, asks to
  sync upstream, merge Open Cowork, or update from the original repo.
disable-model-invocation: true
---

# Sync Upstream

Merge new commits from **OpenCoworkAI/open-cowork** into this York fork without
blindly overwriting York changes and without blindly preferring York when
upstream has a real fix.

Read [conflict-rules.md](conflict-rules.md) before resolving any conflict.

## Repo facts

| Item               | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Origin (York fork) | `YorkIE-Launchpad/open-cowork`                                           |
| Upstream           | `https://github.com/OpenCoworkAI/open-cowork.git`                        |
| First York commit  | `0ceef2db749de901ac19e11a4d809e5940310f25`                               |
| Fork base          | `6f0c04741386b8600aa977f14ac0679d2203bd1b` (parent of first York commit) |

## Workflow

Copy and track:

```
Sync progress:
- [ ] 1. Preflight
- [ ] 2. Fetch + up-to-date check
- [ ] 3. Create sync branch
- [ ] 4. Merge upstream/main
- [ ] 5. Resolve conflicts (if any)
- [ ] 6. Verify
- [ ] 7. Report (no push/PR unless asked)
```

### 1. Preflight

1. `git status --porcelain` — if non-empty, **stop** and ask the user to commit or stash first.
2. Ensure remote `upstream` exists and points at `OpenCoworkAI/open-cowork`:
   - If missing: `git remote add upstream https://github.com/OpenCoworkAI/open-cowork.git`
   - If wrong URL: fix with `git remote set-url upstream https://github.com/OpenCoworkAI/open-cowork.git`
3. Confirm current branch is `main`. If not, **ask** before continuing.

### 2. Fetch + up-to-date check

```bash
git fetch upstream
```

If `HEAD` already contains `upstream/main` (e.g. `git merge-base --is-ancestor upstream/main HEAD` succeeds), report **already up to date** and stop. Do not create a branch.

### 3. Create sync branch

From current `main`:

```bash
git checkout -b sync/upstream-YYYYMMDD
```

Use today's date in `YYYYMMDD`. If the branch name already exists, append `-2`, `-3`, etc.

### 4. Merge (not rebase)

```bash
git merge upstream/main --no-edit
```

Use merge only — never rebase onto upstream (preserves York history).

Do **not** use `-X ours` / `-X theirs`.

### 5. Resolve conflicts

If the merge succeeds with no conflicts, skip to Verify.

Otherwise:

1. List conflicted files: `git diff --name-only --diff-filter=U`
2. For each file, read both sides and apply [conflict-rules.md](conflict-rules.md).
3. Bias: keep York intentional product changes; take upstream bugfixes and net-new features.
4. If both sides look like real product intent and rules do not decide, **stop and ask the user**.
5. After all resolutions: `git add` the files and complete the merge commit (`git commit` if needed — merge may already have a message staged).

Never delete York-only trees (`backend/`, LaunchPad/Hub skill paths) just because upstream lacks them.

### 6. Verify

1. Run `npm run typecheck`.
2. If practical (not excessively long), run `npm test`.
3. Fix only breakage clearly caused by the merge — no unrelated refactors.

### 7. Report

Summarize for the user:

- Upstream range merged (`upstream/main` SHA and short log since previous merge-base)
- Conflicted files and how each was decided (York / upstream / combined / asked user)
- Verification results
- Next steps: review the sync branch; push/PR only if they ask

**Do not** push or open a PR unless the user explicitly asks.

## Hard stops

- Dirty working tree
- Not on `main` without user confirmation
- Ambiguous conflict that conflict-rules cannot resolve
- Merge would require force-push or history rewrite
