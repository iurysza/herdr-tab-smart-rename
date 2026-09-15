#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for herdr-tab-smart-rename.
#
# The project runs TypeScript directly with Bun (there is no build step), but
# Bun is not part of the default Cloud Agent image. This script provisions the
# pinned Bun toolchain when it is missing and then installs dependencies from
# the committed lockfile. It is safe to run repeatedly.
set -euo pipefail

# Keep in sync with the "packageManager"/"engines" fields in package.json.
BUN_VERSION="1.1.34"

if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
fi

# Expose bun to non-interactive lifecycle phases and future shells, not only
# interactive sessions that source ~/.bashrc.
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bunx

export PATH="$HOME/.bun/bin:$PATH"
bun --version

# Install exactly what the lockfile pins and fail if it would drift.
bun install --frozen-lockfile
