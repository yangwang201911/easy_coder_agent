---
name: code-review
description: Use when asked to review a diff, a file, or a change for correctness, safety and style. Produces a short prioritized list of findings with file:line references.
effort: medium
---
# Code review

## Method
1. Read the change in full first (`git_diff` or `read_file`). Understand intent before judging.
2. Check, in priority order:
   - **Correctness**: logic bugs, off-by-one, null/empty handling, error paths, races.
   - **Safety**: unvalidated input, secret leakage, path traversal, injection, resource leaks.
   - **Consistency**: matches surrounding code style, naming, and project conventions.
   - **Tests**: is the change covered? What is the cheapest test to add?
3. Verify each suspected issue by reading the actual lines - do not report from memory.

## Output format
- At most 5 findings, most important first.
- Each: `file:line - issue - why it matters - suggested fix (one line)`.
- If nothing is wrong, say so explicitly - do not invent findings.
- Separate "must fix" from "nice to have".
