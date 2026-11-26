---
name: write-tests
description: Use when asked to add or improve tests for existing code. Covers what to test, how to structure a test, and how to verify it fails for the right reason.
effort: medium
---
# Writing tests

## What to test
- Public behaviour, not implementation details.
- The interesting cases: boundaries (0, 1, max), empty input, error paths.
- The bug you just fixed: a regression test that fails without the fix.

## How
1. Read the function under test and its callers first.
2. One behaviour per test; name it after the behaviour, not the method.
3. Arrange / act / assert, clearly separated.
4. No shared mutable state between tests; each test sets up what it needs.
5. Mock only the boundary (network, disk, time) - not the code under test.

## Verify the test
- Run it: it must pass.
- For a regression test: temporarily revert the fix and confirm the test FAILS, then restore.
- Keep the suite fast: no sleeps, no real network.

## Anti-patterns to avoid
- Asserting on internal state or private methods.
- Testing the framework instead of the code.
- A test that passes no matter what the code does (assert nothing).
