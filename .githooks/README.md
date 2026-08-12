# Git hooks

`pre-commit` runs the IS pipeline harness (`npm test` = template contract + IS 694
golden report) before any commit that touches templates, the report renderer, or
the extraction agent — the surfaces where the IS 694 silent-failure family lives.

Enable once per clone:

    git config core.hooksPath .githooks

Bypass a single commit (use sparingly): `git commit --no-verify`.

The CI workflow `.github/workflows/is-pipeline-harness.yml` is the backstop — it
runs the same `npm test` on every push, so a `--no-verify` commit or a push from a
machine without the hook is still caught before merge.
