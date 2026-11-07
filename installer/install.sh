#!/bin/sh
set -eu

RELEASE_TAG="__RELEASE_TAG__"
RELEASE_COMMIT="__RELEASE_COMMIT__"
NATIVE_PAYLOAD_SHA256="__NATIVE_PAYLOAD_SHA256__"
REPOSITORY="iurysza/herdr-tab-smart-rename"
PLUGIN_ID="tab-smart-rename"
BUN="${BUN_PATH:-bun}"
HERDR="${HERDR_BIN_PATH:-herdr}"

usage() {
  cat <<'EOF'
Usage: install.sh [--install-only --yes]
       install.sh --native [--status|--uninstall] [--config-dir ABSOLUTE_DIRECTORY]

Without options, install the daemon plugin and run interactive setup.
Use --install-only --yes for explicit non-interactive daemon installation.
Use --native for the native macOS app service; it never uses the daemon.
EOF
}

die() {
  printf '%s\n' "Smart Rename installer: $*" >&2
  exit 1
}

native_bootstrap() {
  [ "$(uname -s)" = Darwin ] || die "--native requires macOS"
  [ "$install_only" -eq 0 ] && [ "$yes" -eq 0 ] || die "--native does not accept --install-only or --yes"
  case "$BUN" in
    */*) [ -x "$BUN" ] || die "Bun 1.2.23 or newer is required before native installation" ;;
    *) BUN="$(command -v "$BUN")" || die "Bun 1.2.23 or newer is required before native installation" ;;
  esac
  BUN="$(cd "$(dirname "$BUN")" && pwd -P)/$(basename "$BUN")"
  native_bun_version="$("$BUN" --version 2>/dev/null || true)"
  SMART_RENAME_BUN_VERSION="$native_bun_version" "$BUN" -e '
const found = (process.env.SMART_RENAME_BUN_VERSION || "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
if (!found || found[0] < 1 || (found[0] === 1 && (found[1] < 2 || (found[1] === 2 && found[2] < 23)))) process.exit(1);
' || die "Bun 1.2.23 or newer is required (found ${native_bun_version:-unknown})"
  if [ "$native_action" = install ]; then
    for native_command in "${HERDR_APP_BIN_PATH:-herdr-app}" "${HC_BIN_PATH:-hc}"; do
      case "$native_command" in
        */*) [ -x "$native_command" ] || die "native app/core executable not found; set HERDR_APP_BIN_PATH and HC_BIN_PATH" ;;
        *) command -v "$native_command" >/dev/null 2>&1 || die "native app/core executable not found; set HERDR_APP_BIN_PATH and HC_BIN_PATH" ;;
      esac
    done
  fi
  umask 077
  native_temporary="$(mktemp -d "${TMPDIR:-/tmp}/smart-rename-native.XXXXXX")" || die "could not create a native download directory"
  native_stage=""
  native_cleanup() {
    [ -z "$native_stage" ] || rm -rf "$native_stage"
    rm -rf "$native_temporary"
  }
  trap native_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  case "$RELEASE_TAG" in
    __RELEASE_*)
      [ -f "$0" ] || die "unrendered native installer requires its local checkout"
      native_checkout="$(cd "$(dirname "$0")/.." && pwd -P)"
      [ -f "$native_checkout/scripts/package-native.ts" ] && [ -f "$native_checkout/scripts/render-installer.ts" ] || die "unrendered native installer requires its local checkout"
      native_local_commit="$(git -C "$native_checkout" rev-parse HEAD)" || die "local native installation requires a Git checkout"
      native_local_tag="$(NATIVE_CHECKOUT_ROOT="$native_checkout" "$BUN" -e 'process.stdout.write("v" + (await Bun.file(process.env.NATIVE_CHECKOUT_ROOT + "/package.json").json()).version)')"
      "$BUN" "$native_checkout/scripts/package-native.ts" "$native_local_tag" "$native_local_commit" "$native_temporary" >"$native_temporary/SHA256SUMS"
      "$BUN" "$native_checkout/scripts/render-installer.ts" "$native_local_tag" "$native_local_commit" "$native_temporary/install.sh" "$native_temporary/smart-rename-native.tar.gz"
      set -- --native
      [ "$native_action" = install ] || set -- "$@" "--$native_action"
      [ -z "$native_config" ] || set -- "$@" --config-dir "$native_config"
      SMART_RENAME_NATIVE_ASSET_DIR="$native_temporary" sh "$native_temporary/install.sh" "$@"
      return "$?"
      ;;
  esac
  NATIVE_RELEASE_TAG="$RELEASE_TAG" NATIVE_RELEASE_COMMIT="$RELEASE_COMMIT" NATIVE_PAYLOAD_SHA256="$NATIVE_PAYLOAD_SHA256" "$BUN" -e '
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(process.env.NATIVE_RELEASE_TAG) || !/^[a-f\d]{40}$/.test(process.env.NATIVE_RELEASE_COMMIT) || !/^[a-f\d]{64}$/.test(process.env.NATIVE_PAYLOAD_SHA256)) throw Error("Native installer requires a release-bound commit and payload checksum; render it with the native asset");
'
  for native_asset in smart-rename-native.tar.gz SHA256SUMS; do
    if [ -n "${SMART_RENAME_NATIVE_ASSET_DIR:-}" ]; then
      case "$SMART_RENAME_NATIVE_ASSET_DIR" in /*) ;; *) die "SMART_RENAME_NATIVE_ASSET_DIR must be absolute" ;; esac
      cp "$SMART_RENAME_NATIVE_ASSET_DIR/$native_asset" "$native_temporary/$native_asset" || die "could not read local native release assets"
    else
      curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/$REPOSITORY/releases/download/$RELEASE_TAG/$native_asset" -o "$native_temporary/$native_asset" || die "could not download the bound native release asset"
    fi
  done
  case "${HOME:-}" in /*) ;; *) die "native installation requires an absolute HOME directory" ;; esac
  native_data="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-tab-smart-rename/native"
  case "$native_data" in /*) ;; *) die "native data root must be an absolute directory" ;; esac
  native_versions="$native_data/versions"
  [ ! -L "$native_data" ] && [ ! -L "$native_versions" ] || die "native payload directories must not be symlinks"
  mkdir -p "$native_versions"
  [ "$(cd "$native_data" && pwd -P)" = "$native_data" ] || die "native data root must be a canonical absolute directory"
  native_version="$native_versions/$RELEASE_COMMIT"
  native_verify() {
    NATIVE_ARCHIVE="$native_temporary/smart-rename-native.tar.gz" NATIVE_SUMS="$native_temporary/SHA256SUMS" \
    NATIVE_RELEASE_TAG="$RELEASE_TAG" NATIVE_RELEASE_COMMIT="$RELEASE_COMMIT" NATIVE_PAYLOAD_SHA256="$NATIVE_PAYLOAD_SHA256" \
    NATIVE_DESTINATION="$1" NATIVE_PAYLOAD_MODE="$2" "$BUN" -e __NATIVE_PAYLOAD_PROGRAM__
  }
  if [ -e "$native_version" ] || [ -L "$native_version" ]; then
    native_verify "$native_version" check
  else
    native_stage="$(mktemp -d "$native_versions/.stage.$RELEASE_COMMIT.XXXXXX")"
    native_verify "$native_stage" extract
    (cd "$native_stage" && "$BUN" install --production --frozen-lockfile --ignore-scripts)
    NATIVE_DESTINATION="$native_stage" NATIVE_PAYLOAD_SHA256="$NATIVE_PAYLOAD_SHA256" "$BUN" -e '
import { chmod, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.env.NATIVE_DESTINATION;
const modules = await lstat(path.join(root, "node_modules"));
if (!modules.isDirectory() || modules.isSymbolicLink()) throw Error("Native production dependencies were not installed in the staged payload");
const marker = path.join(root, ".native-dependencies.json");
await writeFile(marker, JSON.stringify({version:1,payloadSha256:process.env.NATIVE_PAYLOAD_SHA256}) + "\n", {mode:0o600,flag:"wx"});
await chmod(marker, 0o600);
'
    native_verify "$native_stage" check
    NATIVE_STAGE="$native_stage" NATIVE_VERSION="$native_version" "$BUN" -e '
import { rename } from "node:fs/promises";
await rename(process.env.NATIVE_STAGE, process.env.NATIVE_VERSION);
'
    native_stage=""
  fi
  set -- "$native_version/src/native-install.ts" "$native_action"
  [ -z "$native_config" ] || set -- "$@" --config-dir "$native_config"
  if [ "$native_action" = install ] && { tty -s </dev/tty; } 2>/dev/null; then
    "$BUN" "$@" </dev/tty
  else
    "$BUN" "$@"
  fi
}

install_only=0
yes=0
native=0
native_action=install
native_config=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-only) install_only=1 ;;
    --yes) yes=1 ;;
    --native) native=1 ;;
    --status|--uninstall)
      [ "$native_action" = install ] || die "choose only one of --status or --uninstall"
      native_action="${1#--}" ;;
    --config-dir)
      [ "$#" -ge 2 ] || die "--config-dir requires an absolute directory"
      shift
      case "$1" in /*) native_config="$1" ;; *) die "--config-dir requires an absolute directory" ;; esac ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1. Use --install-only --yes." ;;
  esac
  shift
done

if [ "$native" -eq 1 ]; then
  native_bootstrap
  exit "$?"
fi
[ "$native_action" = install ] && [ -z "$native_config" ] || die "--status, --uninstall and --config-dir require --native"

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
  *) command -v "$BUN" >/dev/null 2>&1 || die "Bun 1.2.23 or newer is required before installation" ;;
esac
bun_version="$("$BUN" --version 2>/dev/null || true)"
SMART_RENAME_BUN_VERSION="$bun_version" "$BUN" -e '
const value = process.env.SMART_RENAME_BUN_VERSION || "";
const found = value.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
const minimum = [1, 2, 23];
if (!found) process.exit(1);
for (let index = 0; index < minimum.length; index += 1) {
  if (found[index] > minimum[index]) process.exit(0);
  if (found[index] < minimum[index]) process.exit(1);
}
' || die "Bun 1.2.23 or newer is required (found ${bun_version:-unknown})"

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
