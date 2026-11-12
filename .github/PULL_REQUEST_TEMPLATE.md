<!-- Thanks for sending a pull request! Here are some reminders:

1. Conventional Commit title: feat(<scope>): ..., fix(<scope>): ..., docs(<scope>): ...,
   refactor(<scope>): ..., test(<scope>): ..., chore(<scope>): ... (<= 80 characters).
2. If this PR is a work in progress, open it as a Draft.
3. Every commit must include a Developer Certificate of Origin (DCO) sign-off:
   `git commit -s` -> `Signed-off-by: Full Name <email>`.
4. Strict policy: `.github/workflows/` must maintain least-privilege `permissions` and remain strictly protected against untrusted taskpack/sandbox writes.
-->

#### What type of PR is this?

<!--
Add one of the following kinds:
/kind bug
/kind cleanup
/kind documentation
/kind feature
/kind design

Optionally add one or more of the following kinds if applicable:
/kind api-change
/kind deprecation
/kind failing-test
/kind regression

Set the affected area(s):
/area core
/area state
/area agent-pi
/area controller
/area taskpack-runner
/area memory
/area decisions
/area github-app
/area cli
/area docs
/area site
-->

## Summary

<!-- Why this change is needed, technical approach, and any contract or upgrade considerations. -->

## Related Issues

<!--
Keep the line below that matches what this PR actually does to the issue, and delete the other two.
`Fixes #<n>`     — the issue is fully resolved by this PR; GitHub closes it on merge.
`Addresses #<n>` — this PR advances the issue but does not finish it; leaves issue open.
`Relates #<n>`   — context only, no resolution claimed; leaves issue open.
-->
Fixes #
Addresses #
Relates #

## Verification

<!-- Confirm verification steps performed locally: -->
- [ ] `npm run build` passed cleanly
- [ ] `npm run typecheck` passed cleanly
- [ ] `npm run lint` passed cleanly
- [ ] `npm run lint:docs` passed cleanly
- [ ] `npm run site` built and verified with zero broken links
- [ ] Focused tests passed (`node --test ...`)
- [ ] OS sandbox diagnostics verified if touching runtime (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`, `docker`)
- [ ] Verified `.github/workflows/` maintains least-privilege `permissions` and remains protected against untrusted taskpack/sandbox writes
- [ ] `Signed-off-by: Full Name <email>` Developer Certificate of Origin (DCO) included on all commits

#### Does this PR introduce a user-facing change?

<!--
If no, write "NONE" in the release-note block below.
If yes, provide a concise explanation and note any required operator migration steps.
-->
```release-note
NONE
```
