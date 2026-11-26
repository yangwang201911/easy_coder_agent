#!/usr/bin/env bash
# Regression suite for Coder Agent: backend pytest + GUI CDP smoke tests.
#
# Usage:
#   ./run_tests.sh            # everything (remote test skipped: needs a live server)
#   ./run_tests.sh backend    # backend pytest only
#   ./run_tests.sh gui        # all GUI CDP tests
#   ./run_tests.sh files      # one GUI test by name (files, theme, split, proj, ctxmenu, ...)
#   ./run_tests.sh remote     # remote test (start a standalone server on :8931 first)
#
# Exit code 0 = all green. Run it after every feature before calling it done.
set -u
cd "$(dirname "$0")"

# the CDP tests default to this repo as the project under test
export TEST_ROOT="${TEST_ROOT:-$PWD}"

target="${1:-all}"
failed=()

run_backend() {
  echo "=== backend pytest ==="
  if ! .venv/bin/python -m pytest tests/ -q; then
    failed+=("backend")
  fi
}

run_gui() { # $1... = suite names (see gui/tests/e2e/run_all_tests.cjs for the list)
  if ! (cd gui/tests/e2e && node run_all_tests.cjs "$@"); then
    failed+=("gui:$*")
  fi
}

case "$target" in
  backend) run_backend ;;
  gui) run_gui ;;
  remote) run_gui remote ;;
  all)
    run_backend
    run_gui
    ;;
  cdp_*_test.cjs|*.cjs) run_gui "$(basename "$target" .cjs | sed 's/^cdp_//;s/_test$//')" ;;
  *)
    run_gui "$target"
    ;;
esac

echo
if [ "${#failed[@]}" -eq 0 ]; then
  echo "ALL TESTS PASSED"
else
  echo "FAILED: ${failed[*]}"
  exit 1
fi
