#!/usr/bin/env bash
# Launch the Coder Agent GUI (Electron front-end + Python backend).
# Usage: ./start_gui.sh [--root /path/to/project] [--yes] [--proxy]
#   --yes        answer every preflight question with its default (no prompts)
#   --proxy      re-ask for a proxy (type the URL at the prompt)
#
# The preflight below checks the environment before building: proxy, GUI node
# deps, the Python backend venv and the Playwright Chromium browser. In a
# terminal you are asked (with a default in [brackets]); from a dock icon /
# IDE button (no keyboard attached) all defaults are used silently.
set -euo pipefail
cd "$(dirname "$0")"

# Node via nvm (installed at ~/.nvm)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# ============================================================================
# preflight: proxy / node deps / python venv / playwright chromium
# ============================================================================
PROXY_FLAG=0
PROXY_ARG=""
ASSUME_YES=0
prev=""
for arg in "$@"; do
  case "$prev" in
    --proxy) PROXY_ARG="$arg" ;;
  esac
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --proxy) PROXY_FLAG=1 ;;
  esac
  prev="$arg"
done

CONF_DIR="$HOME/.coder_agent"
CONF="$CONF_DIR/launcher.conf"
# the conf is in "set key=value" format so the Windows .bat can call it directly;
# a persisted value is only a default - the user can still change it at the prompt
PROXY=""
PY_TOOL=""
[ -f "$CONF" ] && {
  PROXY="$(sed -n 's/^set proxy=//p' "$CONF" | tail -1)"
  PY_TOOL="$(sed -n 's/^set py_tool=//p' "$CONF" | tail -1)"
}

INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0   # no keyboard (dock icon / IDE button): use defaults
[ "$ASSUME_YES" = 1 ] && INTERACTIVE=0

ask() { # ask <question> <default Y|n> -> 0 yes / 1 no
  local q="$1" def="$2" ans
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -p "$q [$def] " ans || ans=""
  else
    ans=""
  fi
  ans="${ans:-$def}"
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- 1. proxy (only relevant while the downloads below are still needed) ----
need_proxy=0
[ ! -d gui/node_modules ] && need_proxy=1
[ ! -x backend/.venv/bin/python ] && need_proxy=1
if [ "$need_proxy" = 1 ] || [ -n "$PROXY_ARG" ] || [ "$PROXY_FLAG" = 1 ]; then
  if [ "$INTERACTIVE" = 1 ] && [ -z "$PROXY_ARG" ]; then
    read -r -p "The next steps may download packages from the internet.
Proxy address (e.g. http://proxy-dmz.intel.com:912), empty = none [$PROXY]: " p || p=""
    PROXY="${p:-$PROXY}"
  elif [ -n "$PROXY_ARG" ]; then
    PROXY="$PROXY_ARG"
  fi
  if [ -n "$PROXY" ]; then
    export http_proxy="$PROXY" https_proxy="$PROXY"
    echo "[start_gui] using proxy $PROXY for downloads"
  fi
  mkdir -p "$CONF_DIR"
  { echo "set proxy=$PROXY"; [ -n "$PY_TOOL" ] && echo "set py_tool=$PY_TOOL"; } > "$CONF"
fi

# --- 2. GUI node deps (Electron binary download is the part that needs a proxy)
if [ ! -d gui/node_modules ]; then
  if ask "GUI node dependencies are missing (npm install downloads ~100MB,
including the Electron binary). Install now?" y; then
    (cd gui && npm install)
  else
    echo "[start_gui] skipping npm install - the GUI cannot start without node_modules"
    exit 1
  fi
fi

# --- 3. Python backend venv (the GUI spawns backend/.venv/bin/python) --------
if [ ! -x backend/.venv/bin/python ]; then
  have_uv=0
  command -v uv >/dev/null 2>&1 && have_uv=1
  if [ -z "$PY_TOOL" ] && [ "$INTERACTIVE" = 1 ]; then
    if [ "$have_uv" = 1 ]; then
      read -r -p "Create the Python venv for the backend (agent_ts_gui/backend/.venv).
uv (fast, detected) or pip (python -m venv, slower)? [uv/pip] " t || t=""
      t="${t:-uv}"
    else
      t="pip"
    fi
  else
    t="${PY_TOOL:-}"
    [ -z "$t" ] && t="uv"
    [ "$t" = "uv" ] && [ "$have_uv" = 0 ] && t="pip"
  fi
  if [ "$t" = "uv" ]; then
    (cd backend && uv sync)
  else
    echo "[start_gui] creating venv with python -m venv + pip (slower than uv)"
    (cd backend && python3 -m venv .venv && .venv/bin/pip install -e .)
  fi
  PY_TOOL="$t"
  mkdir -p "$CONF_DIR"
  { [ -n "$PROXY" ] && echo "set proxy=$PROXY"; echo "set py_tool=$PY_TOOL"; } > "$CONF"
fi
# deps changed since the venv was created? uv sync is a fast no-op when current.
if [ "$PY_TOOL" = "uv" ] && command -v uv >/dev/null 2>&1; then
  (cd backend && uv sync)
fi

# --- 4. Playwright Chromium (the browser tools' headless browser, ~150MB) ----
if [ -x backend/.venv/bin/python ] && \
   ! backend/.venv/bin/python -c "from playwright.sync_api import sync_playwright" >/dev/null 2>&1; then
  echo "[start_gui] playwright is not installed - skipping the Chromium question"
elif [ ! -d "$HOME/.cache/ms-playwright" ]; then
  if ask "Playwright Chromium (a ~150MB headless browser) is not installed.
It powers the agent's browser tools (browser_navigate/click/screenshot -
real web pages). Without it those tools are disabled; everything else
(files, shell, web_search, web_fetch) is unaffected. Install it?" y; then
    (cd backend && .venv/bin/python -m playwright install chromium)
  else
    echo "[start_gui] browser tools will be unavailable."
    echo "[start_gui] install later with: cd backend && .venv/bin/python -m playwright install chromium"
  fi
fi

# ============================================================================
# build + launch
# ============================================================================
cd gui
npm run build

# --- app icon on Linux (GNOME dock / taskbar) --------------------------------
# The dock does NOT use the window icon; it matches the window's WM_CLASS
# against a .desktop entry. Electron's default WM_CLASS is "electron", so
# install a "CoderAgent" .desktop entry (with our icon) and start with
# --class=CoderAgent so the dock shows the CC icon instead of the system default.
if [ "$(uname)" = "Linux" ]; then
  DESKTOP_DIR="$HOME/.local/share/applications"
  mkdir -p "$DESKTOP_DIR"
  # Never clobber a real launcher entry (e.g. "Exec=<...>.AppImage" created by
  # the user pinning the AppImage to the dock) - that would turn the dock icon
  # into a no-op (/bin/true).
  if [ ! -f "$DESKTOP_DIR/coder-agent.desktop" ] || grep -q "^Exec=/bin/true" "$DESKTOP_DIR/coder-agent.desktop"; then
    cat > "$DESKTOP_DIR/coder-agent.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Coder Agent
Comment=AI coding agent (Electron GUI + Python backend)
Exec=/bin/true
Icon=$PWD/build-resources/icon-512.png
StartupWMClass=CoderAgent
EOF
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
  fi
fi

exec node_modules/.bin/electron --no-sandbox --disable-gpu --class=CoderAgent . "$@"
