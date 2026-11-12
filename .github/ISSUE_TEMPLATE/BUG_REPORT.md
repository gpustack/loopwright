---
name: Bug Report
about: Report a reproducible defect in Loopwright
title: "[Bug] "
labels: ["bug"]
type: Bug
---

<!-- Keep the title at or under 80 characters, prefix included: one clause naming the symptom, not
     the diagnosis. Detail belongs in the body.

Please use this template while reporting a defect and provide as much detail as possible.

If the matter is security related or involves sensitive credentials, do not file it here —
disclose it privately according to responsible disclosure practices.
-->

### Steps to Reproduce

<!-- Provide minimal, reproducible steps or a minimal taskpack/configuration snippet. -->
1. 
2. 
3. 

### Actual Behavior

<!-- What actually happened, including any error code or unexpected outcome. -->

### Expected Behavior

<!-- What should have happened under the contract or specification. -->

### How this was found

<!-- Tick one: -->
- [ ] **Hit it** — encountered while running Loopwright
- [ ] **Reported** — reported by an operator or user
- [ ] **Worked out** — derived from reading code, specifications, or contract schemas

### Environment

- Loopwright version / commit: 
- Node.js version (`node -v`): 
- Operating System / Kernel: 
- OS sandbox backend (`macos-seatbelt` | `linux-bwrap` | `linux-landlock` | `docker` | `direct-dedicated`): 
- Execution surface (`cli` | `github-action` | `github-app`): 

### Additional Context

<!-- Paste relevant log excerpts or diagnostics. Scrub all sensitive tokens, secrets, and private paths before submitting. -->
