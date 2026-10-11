# AGENTS.md

Commits use Conventional Commits: type(scope): subject.

Never push to `main`; open a PR and squash-merge. PR titles follow Conventional Commits.

`skills/zentao/SKILL.md` documents the CLI's commands and options; update it in the same PR whenever they change.

Releases are cut by release-please: merging its release PR bumps the version, updates CHANGELOG.md, tags, creates the GitHub Release, and publishes to npm. Don't bump versions or publish by hand. PR titles become the changelog entries, so write them for users.

If the `publish` job fails after a release PR merges, it won't run again on later pushes. For config or registry failures (such as the npm trusted publisher), fix the setting, then re-run that failed job with `gh run rerun <run-id> --failed`; the re-run builds the same release commit.
