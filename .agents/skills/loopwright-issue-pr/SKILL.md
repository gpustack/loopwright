---
name: loopwright-issue-pr
description: >-
  Prepare Loopwright GitHub issues and pull requests: enforce issue title prefixes,
  labels, types, <= 80-character title caps, template body structure without raw
  YAML frontmatter, Conventional-Commit PR titles, /kind and /area metadata,
  issue-linking verbs (Fixes, Addresses, Relates), DCO Signed-off-by trailers,
  and repository hygiene gates. Invoke before gh issue create or gh pr create.
allowed-tools: "Read, Write, Bash(gh issue create*), Bash(gh pr create*), Bash(gh issue view*), Bash(gh pr view*), Bash(gh label list*)"
---

# Loopwright Issue and Pull Request Conventions

Two distinct title grammars govern this repository and must never be mixed:

1. **Issues** use a bracketed kind prefix (`[Bug] `, `[Feat] `, `[Docs] `, `[Cleanup] `, `[Question] `, `[TODO] `) and a title of **at most 80 characters** (prefix included).
2. **Pull requests** use **Conventional Commits** (`feat(<scope>): ...`, `fix(<scope>): ...`, etc.) and a title of **at most 80 characters**.

All issue titles, issue bodies, PR titles, PR bodies, commit messages, and review threads must be written in clear English. Consult the [module map](../../../docs/README.md#module-map) to identify affected packages, guides, and specifications before filing.

## 1. GitHub Issue Rules

### Prefix, Label, Type, and Template Mapping

Every Loopwright issue must use one of these six categories:

| Prefix | Label (`--label`) | Issue Type (`--type`) | Template File (`.github/ISSUE_TEMPLATE/`) | Required Body Sections |
| --- | --- | --- | --- | --- |
| `[Bug] ` | `bug` | `Bug` | `BUG_REPORT.md` | `### Steps to Reproduce`, `### Actual Behavior`, `### Expected Behavior`, `### Environment`, `### Additional Context` |
| `[Feat] ` | `enhancement` | `Feature` | `ENHANCEMENT.md` | `### Problem / Motivation`, `### Proposed Change`, `### Authority & Safety Boundary Impact`, `### Alternatives Considered` |
| `[Docs] ` | `documentation` | `Task` | `DOCUMENTATION.md` | `### Affected Page(s)`, `### Issue Description`, `### Suggested Improvement` |
| `[Cleanup] ` | `cleanup` | `Task` | `CLEANUP.md` | `### Target Scope`, `### Rationale`, `### Verification Plan` |
| `[Question] ` | `question` | `Question` | `SUPPORT.md` | `### Question`, `### Configuration / Surface`, `### What You Tried` |
| `[TODO] ` | `todo` | `Task` | `TODO.md` | `### Objective`, `### Acceptance Criteria`, `### Owning Package(s)` |

### Issue Title Cap (`<= 80` Characters)

- Keep the complete issue title **at or under 80 characters**, including the `[Prefix] `.
- State one concise symptom, capability gap, or task outcome without embedding stack traces or multi-clause diagnoses in the title.

### Critical CLI Mechanism: Strip YAML Frontmatter & Avoid `mcp__github__create_issue`

1. **Web-only YAML frontmatter pitfall**:
   - The `---` YAML frontmatter block at the top of `.github/ISSUE_TEMPLATE/*.md` (`name`, `about`, `title`, `labels`) is parsed and stripped **only** by GitHub's web UI.
   - If you pass a raw template file directly to `gh issue create --body-file`, GitHub renders the raw YAML frontmatter inside the issue description and does **not** apply the label, title prefix, or issue type.
   - **Rule**: Always strip the leading `--- ... ---` YAML frontmatter when preparing `--body-file`, and pass `--label <label>` and `--type <Type>` explicitly on the command line.
2. **Prohibition of `mcp__github__create_issue`**:
   - Never use `mcp__github__create_issue` when issue type or template metadata is required, because its schema lacks the `type` field and cannot bind GitHub organization/repository issue types (`Bug`, `Feature`, `Task`, `Question`). Always use `gh issue create`.

### Issue Creation Recipe

```bash
# 1. Strip YAML frontmatter from the chosen .github/ISSUE_TEMPLATE/*.md template
#    and populate all required ### sections in a temporary body file.
# 2. Pass prefix in --title (<= 80 chars), --label, and --type explicitly:
gh issue create \
  --title "[Bug] Controller reconcile rejects valid lease after clock step" \
  --label "bug" \
  --type "Bug" \
  --body-file /tmp/loopwright-issue-body.md
```

## 2. Pull Request Rules

### Conventional Commit Title (`<= 80` Characters)

Every PR title (and commit subject) must match:

```text
^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w\-./]+\))?(!)?: .+
```

- **Total length**: `<= 80` characters.
- **Common scopes**: `core`, `state`, `agent-pi`, `controller`, `taskpack-runner`, `memory`, `decisions`, `github-app`, `cli`, `docs`, `site`, `skills`, `specs`.
- Never put an issue prefix (`[Bug]`, `bug:`) in a PR title.

### Pull Request Body Structure (`.github/PULL_REQUEST_TEMPLATE.md`)

Structure every PR body following `.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## Summary

- Explain why the change is needed, the design approach, and any public contract or upgrade impact.
- State verification scope and any remaining live/external boundaries honestly.

/kind <bug|feature|cleanup|documentation|design>
/area <core|state|agent-pi|controller|taskpack-runner|memory|decisions|github-app|cli|docs|site>

## Related Issues

Fixes #<issue-number>

## Verification

- [x] `npm run build`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run lint:docs`
- [x] `npm run site`
- [x] `npm test`
- [x] `Signed-off-by` DCO trailer present on all commits
```

### `/kind` and `/area` Directives

Every PR body must include at least one `/kind` line and one `/area` line:

- **Allowed `/kind` values**: `bug`, `feature`, `cleanup`, `documentation`, `design`
- **Allowed `/area` values**: `core`, `state`, `agent-pi`, `controller`, `taskpack-runner`, `memory`, `decisions`, `github-app`, `cli`, `docs`, `site`

### Issue-Linking Verbs (`Fixes` vs. `Addresses` vs. `Relates`)

Choose the linking verb that accurately reflects the PR's effect on merge:

- `Fixes #<n>` — Fully resolves issue `#<n>`; **GitHub automatically closes the issue when the PR merges**.
- `Addresses #<n>` — Advances or partially resolves `#<n>` without completing every acceptance criterion; **does not auto-close**.
- `Relates #<n>` — Provides related context or prerequisite refactoring; **does not auto-close**.

Never use `Fixes #<n>` on a partial implementation or diagnostic-only PR.

## 3. Mandatory DCO Sign-Off, Hygiene, and Verification Gates

Before committing or opening a PR, verify every item below:

1. **Developer Certificate of Origin (`Signed-off-by`)**:
   - Every commit must carry a `Signed-off-by: Name <email>` trailer (`git commit -s`).
   - Verify with `git log origin/main..HEAD --format='%h %s%n%b'` that every commit includes `Signed-off-by:`.
2. **Repository & Path Hygiene**:
   - **Protected `.github/workflows/`**: Ensure `.github/workflows/` maintains least-privilege `permissions` and remains strictly protected against untrusted taskpack and sandbox writes.
   - **Zero host paths or internal coordination refs**: Ensure zero local filesystem paths, agent scratch directories, or internal task/wave tags appear in tracked files, commit messages, or PR descriptions.
   - **Zero unredacted secrets**: Ensure all fixtures and examples use `${ENV}` placeholders or synthetic test tokens.
3. **Verification Gate Checklist**:
   - Run and pass before `gh pr create`:
     ```bash
     npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npm test
     ```
