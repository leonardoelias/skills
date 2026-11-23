# Script: validate publishing in a sandbox repository

The automated tests (`test/publish.test.mjs`) cover the git plumbing against a local remote and a
fake `gh`. What only real GitHub can answer (the link renders only for people who can read the
repo, the comment shows up and is edited in place) needs this manual test, done once per version
and always in a **throwaway private repository**, never in a product repo.

## Prepare

```bash
gh repo create <your-user>/visual-diff-sandbox --private --clone && cd visual-diff-sandbox
cp -r <skill-repo>/examples/sample-site/. .
git add -A && git commit -m before && git push -u origin HEAD
git checkout -b feature
sed -i '' 's/padding: 8px 14px; border-radius: 4px;/padding: 10px 18px; border-radius: 8px;/' styles.css
git commit -am after && git push -u origin feature
gh pr create --fill
```

## Script

| # | Step | Expected |
|---|---|---|
| 1 | `visual-diff run --pr <n>` | `stats.changed: 4` |
| 2 | `visual-diff publish --pr <n> --dry-run` | `publishable: true`, `visibility: PRIVATE`, 4 compositions + crops in `uploads` |
| 3 | `visual-diff publish --pr <n> --verify` | `posted: true`, `verify.ok: true`, `verify.anonymousStatus: 404` |
| 4 | Open the PR signed in, in the browser | comment with rendered images |
| 5 | Open an image URL in a private window | 404 |
| 6 | GitHub Mobile and the notification e-mail | note whether the images show up (they may not) |
| 7 | Write `.visual-diff/summary.md` and publish again | the same comment is edited (`commentAction: updated`), no new one |
| 8 | `git ls-remote origin visual-diff-assets` and `git log origin/visual-diff-assets` | 1 commit, no parent, message with `[skip ci]` |
| 9 | New commit on the PR, without running `run`, and `publish --pr <n>` | refused (exit 4): the report is from another commit |
| 10 | Close the PR and `visual-diff prune --closed` | `removed: [n]`; the branch has no `pr-<n>/` |
| 11 | Make the repo public and `publish --dry-run` | `[blocking] The repository is PUBLIC` |

Write down the result of each step (date, skill version, `gh` version). Then delete the repository:
`gh repo delete <your-user>/visual-diff-sandbox`.
