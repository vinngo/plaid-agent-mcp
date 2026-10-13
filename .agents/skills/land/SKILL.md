---
name: land
description: >-
  Land changes in vinngo/plaid-agent-mcp through a GitHub pull request using
  rebase-and-merge. Invoke only when the user explicitly requests landing, not
  for review, preparation, verification alone, or skill installation.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Land changes

Use this workflow only in the `vinngo/plaid-agent-mcp` repository. An invocation
is already authorization to carry out the complete landing workflow; do not ask
again for routine permission to commit, publish the branch, open the pull
request, or merge it. Stop for a blocker or an ambiguity identified below.

## 1. Establish scope and prerequisites

1. Confirm the repository root, the `origin` URL, the current branch and commit,
   and the complete working-tree status and diff. The destination must be
   `origin/main` in `vinngo/plaid-agent-mcp`.
2. Identify exactly which changes belong to the user's landing request. Review
   staged, unstaged, and untracked files. Never include `.env`, `data/`,
   credentials, Plaid access tokens, generated snapshots, dependency folders,
   or unrelated user work. Stop and ask if scope is ambiguous.
3. Require `gh` and authenticated access to the repository. Check
   `command -v gh`, `gh --version`, and `gh auth status`. Also confirm that the
   installed version supports `gh pr create`, `gh pr view`, `gh pr checks`, and
   `gh pr merge`. If the CLI is absent, unauthenticated, or lacks those
   commands, report the blocker and do not publish anything.
4. Fetch `origin/main`. Do not force-push, rewrite a shared branch, bypass
   protections, or change repository settings.

## 2. Prepare the pull-request branch

1. If the work is still on `main`, create a uniquely named `land/<short-topic>`
   branch from the current commit while preserving the working tree. If it is
   already on a dedicated, unpublished branch based on `origin/main`, keep that
   branch. Stop before modifying a branch that is shared or has unrelated
   commits.
2. Stage only the intended paths and review the complete staged diff, including
   file names and whitespace errors.
3. Create a concise imperative commit using a non-interactive commit command.
   Do not amend or rewrite an existing shared commit.
4. Rebase the dedicated branch onto the fetched `origin/main` before
   verification. If any conflict occurs, do not resolve it, skip it, or choose a
   side automatically. Pause and ask the user how to proceed, listing the
   conflicted paths and leaving the conflict visible.

## 3. Verify the exact submitted commit

Run all of these checks after the rebase and before pushing:

- `git diff --check origin/main...HEAD`
- `npm test` (`package.json:16`)
- `npm run typecheck` (`package.json:15`)
- `npm run build` (`package.json:13`)

Every command must pass against the commit that will be submitted. A prior run
against another commit is not sufficient. If a check fails, stop, report that
the changes have not landed, and do not weaken or bypass the check.

Confirm the working tree contains no uncommitted intended changes after the
checks. Build output ignored by the repository may remain, but it must not be
added to the commit.

## 4. Open the pull request

1. Push the dedicated branch to `origin` without force.
2. Open a pull request targeting `main` with `gh pr create`. Give it a concise
   title, a body that accurately summarizes the change, and a `Testing` section
   containing only checks actually run and passed.
3. Record the pull-request number, URL, and submitted head SHA. Confirm through
   `gh pr view` that the PR targets `main` and its head SHA is exactly the
   locally verified commit.
4. Check the authenticated repository settings and require rebase merging to
   be enabled. If it is unavailable, stop and report the blocker; do not
   substitute squash or merge-commit mode.

## 5. Verify GitHub and merge

1. Inspect the destination's branch protection/rules and the PR's complete
   check rollup. Wait for checks associated with the submitted head SHA.
2. Require every applicable required check to exist and pass. Also require all
   reported non-required checks to finish without failure. Pending, queued,
   failing, missing, cancelled, stale, or unverifiable required checks block
   the merge. If the repository has no configured remote checks, explicitly
   confirm that fact through authenticated repository and PR data rather than
   treating an empty display as success.
3. Confirm the PR is mergeable and that `origin/main` has not changed in a way
   that introduces a conflict. On any conflict or ambiguous destination update,
   pause and ask the user; never resolve conflicts automatically.
4. Rebase-and-merge the PR with `gh pr merge --rebase --delete-branch`. Do not
   enable auto-merge in place of verifying checks, and do not use administrator
   bypasses.

## 6. Confirm completion

1. Verify through GitHub that the pull request state is `MERGED` and record its
   resulting merge commit.
2. Fetch `origin/main` and confirm the reported merge commit is present in its
   history. Confirm the remote feature branch was deleted.
3. Fast-forward the local `main` to `origin/main` only when that is safe and
   would not overwrite unrelated local work, then delete the local feature
   branch. Otherwise leave local cleanup untouched and report why.
4. Report the PR URL, final commit on `origin/main`, verification commands, and
   cleanup state. If any publication or verification step failed, state plainly
   that the changes did not land.
