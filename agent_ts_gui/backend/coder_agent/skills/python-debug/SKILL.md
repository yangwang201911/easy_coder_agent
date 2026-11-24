---
name: python-debug
description: Use when a Python program fails (traceback, wrong output, hang) after you wrote or changed code. Disciplined debugging for Python - read the traceback, list suspects, verify one at a time.
triggers: Traceback|ModuleNotFoundError|ImportError|NameError|TypeError|AttributeError|KeyError|ValueError|IndentationError|SyntaxError
---
# Debugging newly written Python code

Do NOT try random fixes. Follow these steps in order.

## 1. Read the traceback
- The LAST frame in YOUR code is where it happened; the lines above show how you got there.
- Note the exception type and message - it usually names the exact problem.

## 2. List suspects BEFORE touching anything
Write 2-3 suspected causes in your reply, most likely first, each with its evidence:
- Suspect 1: <cause> - evidence: <traceback line> - check: <one cheap check>
Typical suspects: undefined name (typo / missing import); wrong type (None where a value is expected); wrong key/index into a dict/list; off-by-one; a variable shadowed by a loop; missing `await`; stale import (`.pyc` / wrong path); config not loaded.

## 3. Verify ONE suspect at a time
- Re-read the exact lines involved and compare with the traceback.
- Make the smallest change for that suspect, rerun, and look at the result.
- Maximum 2 attempts per suspect. If it did not help, REVERT and go to the next.

## 4. Escalate
- Two suspects checked and the problem remains: add a `print`/`logging` line with the actual values at the failing frame, or use `debug_backtrace` with `python` as the program.
- A hang: check for a blocking call (input, network, lock) on the current thread.

## 5. Finish
Once fixed: rerun the original command, then the test suite if there is one, and report root cause + fix + verification.
