#!/bin/sh
set -eu

RELEASE_TAG="__RELEASE_TAG__"
RELEASE_COMMIT="__RELEASE_COMMIT__"
REPOSITORY="iurysza/herdr-tab-smart-rename"
PLUGIN_ID="tab-smart-rename"
BUN="${BUN_PATH:-bun}"
HERDR="${HERDR_BIN_PATH:-herdr}"

usage() {
  cat <<'EOF'
Usage: install.sh [--install-only --yes]

Without options, install Smart Rename and run interactive setup.
Use --install-only --yes for explicit non-interactive installation.
EOF
}

die() {
  printf '%s\n' "Smart Rename installer: $*" >&2
  exit 1
}

install_only=0
yes=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-only) install_only=1 ;;
    --yes) yes=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1. Use --install-only --yes." ;;
  esac
  shift
done

case "$RELEASE_TAG" in ""|__RELEASE_*) die "installer is not bound to a release tag" ;; esac
case "$RELEASE_COMMIT" in ""|__RELEASE_*) die "installer is not bound to a release commit" ;; esac
[ "$yes" -eq 0 ] || [ "$install_only" -eq 1 ] || die "--yes is only valid with --install-only"
[ "$install_only" -eq 0 ] || [ "$yes" -eq 1 ] || die "--install-only requires --yes"

if [ "$install_only" -eq 0 ]; then
  tty=/dev/tty
  { tty -s <"$tty" && [ -r "$tty" ] && [ -w "$tty" ]; } || die "an interactive caller terminal is required. For automation use --install-only --yes."
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/smart-rename-install.XXXXXX")" || die "could not create a temporary directory"
cleanup() {
  rm -f "$temporary/server.json" "$temporary/server.stderr" \
    "$temporary/managed.json" "$temporary/managed.stderr" \
    "$temporary/root" "$temporary/config.stderr"
  rmdir "$temporary" || printf '%s\n' "Smart Rename installer: temporary files remain at $temporary" >&2
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

case "$BUN" in
  */*) [ -x "$BUN" ] || die "Bun executable not found: $BUN" ;;
  *) command -v "$BUN" >/dev/null 2>&1 || die "Bun 1.1.34 or newer is required before installation" ;;
esac
bun_version="$("$BUN" --version 2>/dev/null || true)"
SMART_RENAME_BUN_VERSION="$bun_version" "$BUN" -e '
const value = process.env.SMART_RENAME_BUN_VERSION || "";
const found = value.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
const minimum = [1, 1, 34];
if (!found) process.exit(1);
for (let index = 0; index < minimum.length; index += 1) {
  if (found[index] > minimum[index]) process.exit(0);
  if (found[index] < minimum[index]) process.exit(1);
}
' || die "Bun 1.1.34 or newer is required (found ${bun_version:-unknown})"

case "$HERDR" in
  */*) [ -x "$HERDR" ] || die "Herdr executable not found: $HERDR" ;;
  *) command -v "$HERDR" >/dev/null 2>&1 || die "Herdr executable not found: $HERDR" ;;
esac
"$HERDR" --version >/dev/null 2>&1 || die "Herdr executable is not runnable: $HERDR"

server_json="$temporary/server.json"
"$HERDR" status server --json >"$server_json" 2>"$temporary/server.stderr" || {
  detail="$(cat "$temporary/server.stderr")"
  die "target Herdr server is unreachable${detail:+: $detail}"
}
SMART_RENAME_SERVER_JSON="$server_json" "$BUN" -e '
const value = JSON.parse(await Bun.file(process.env.SMART_RENAME_SERVER_JSON).text());
const server = value?.result ?? value;
if (!server?.running) process.exit(1);
if (server.compatible === false) process.exit(1);
' || die "target Herdr server is not running or is incompatible"

managed_json="$temporary/managed.json"
managed_root() {
  "$HERDR" plugin list --plugin "$PLUGIN_ID" --json >"$managed_json" 2>"$temporary/managed.stderr" || return 1
  SMART_RENAME_MANAGED_JSON="$managed_json" \
  SMART_RENAME_RELEASE_TAG="$RELEASE_TAG" \
  SMART_RENAME_RELEASE_COMMIT="$RELEASE_COMMIT" \
  "$BUN" -e '
const value = JSON.parse(await Bun.file(process.env.SMART_RENAME_MANAGED_JSON).text());
const plugins = value?.result?.plugins;
const plugin = Array.isArray(plugins) ? plugins.find((item) => (item.plugin_id ?? item.id) === "tab-smart-rename") : undefined;
const source = plugin?.source ?? {};
const ref = source.requested_ref ?? source.ref;
const commit = plugin?.resolved_commit ?? plugin?.commit ?? source.resolved_commit ?? source.commit;
const root = plugin?.plugin_root ?? plugin?.root;
if (!root || source.kind !== "github" || source.owner !== "iurysza" || source.repo !== "herdr-tab-smart-rename" || ref !== process.env.SMART_RENAME_RELEASE_TAG || commit !== process.env.SMART_RENAME_RELEASE_COMMIT) process.exit(1);
process.stdout.write(root);
'
}

if managed_root >"$temporary/root"; then
  root="$(cat "$temporary/root")"
  if [ "$install_only" -eq 1 ]; then
    printf '%s\n' "Smart Rename ${RELEASE_TAG} is already installed."
    exit 0
  fi
  printf '%s' "Smart Rename ${RELEASE_TAG} is already installed. Run setup again? [Y/n] " >"$tty"
  if ! IFS= read -r answer <"$tty"; then
    exit 0
  fi
  case "$answer" in
    n|N|no|NO|No) exit 0 ;;
  esac
else
  if [ "$install_only" -eq 1 ]; then
    "$HERDR" plugin install "$REPOSITORY" --ref "$RELEASE_TAG" --yes
  else
    "$HERDR" plugin install "$REPOSITORY" --ref "$RELEASE_TAG" <"$tty" >"$tty" 2>&1
  fi
  managed_root >"$temporary/root" || die "Herdr did not install the expected managed repository, ref, root, and commit. Setup did not run."
  root="$(cat "$temporary/root")"
fi

[ "$install_only" -eq 1 ] && exit 0
config_directory="$("$HERDR" plugin config-dir "$PLUGIN_ID" 2>"$temporary/config.stderr")" || {
  detail="$(cat "$temporary/config.stderr")"
  die "Herdr did not report the Smart Rename config directory${detail:+: $detail}"
}
[ -n "$config_directory" ] || die "Herdr did not report the Smart Rename config directory"
if HERDR_PLUGIN_ROOT="$root" HERDR_PLUGIN_CONFIG_DIR="$config_directory" \
  "$BUN" "$root/src/setup.ts" <"$tty" >"$tty" 2>&1; then
  printf '%s\n' "Smart Rename is installed and setup completed." >"$tty"
else
  setup_status=$?
  printf '%s\n' "Smart Rename installer: setup exited ${setup_status}" >"$tty"
  exit "$setup_status"
fi
