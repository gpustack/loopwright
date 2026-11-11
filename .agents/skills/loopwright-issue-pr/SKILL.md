---
name: loopwright-issue-pr
description: Prepare Loopwright issues and pull requests.
---

# Loopwright Issue-Pr

Use issue prefixes `bug: `, `enhancement: `, `support: `, `docs: `, `cleanup: `, or `todo: ` and keep issue titles at most 80 characters. PR titles follow `^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w\-./]+\))?(!)?: .+`. Every commit requires a `Signed-off-by` trailer. Link issues with `Fixes #<n>`, `Addresses #<n>`, or `Relates #<n>` according to actual effect. Describe behavior, validation, and evidence limits; consult the [module map](../../../docs/README.md#module-map).
