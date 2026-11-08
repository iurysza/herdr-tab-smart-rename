# Install or upgrade Smart Rename

For the daemon plugin, use a terminal inside Herdr with Herdr 0.7.5+ and Bun 1.2.23+. The native macOS app uses the separate path below. Neither installer installs Bun or Herdr for you.

## Native macOS app

The native service needs macOS, Bun 1.2.23+, and the native `herdr-app` and `hc` executables on PATH. It does not need the older `herdr` daemon. Open the native app before installation so the worker can discover its tabs. Connected remote machines need no second installation.

From a local checkout, run:

```sh
sh installer/install.sh --native
```

This packages the current checkout, binds it to the package version and Git HEAD, and installs a persistent copy. The source checkout stays unchanged. Repeating the same snapshot reuses its verified version directory. Changed source needs a new commit before replacing an already-installed snapshot with that commit ID; existing version directories are never overwritten.

A release containing `smart-rename-native.tar.gz`, `install.sh`, and `SHA256SUMS` supports this one-liner:

```sh
curl -fsSL https://github.com/iurysza/herdr-tab-smart-rename/releases/latest/download/install.sh | sh -s -- --native
```

This change prepares those assets but does not publish a release. Until an approved release includes them, use the local checkout command. The command verifies the payload against the checksum bound into its installer and the release checksum manifest before writing source files. It checks the embedded tag, commit, and file manifest, and rejects unsafe archive entries.

Both paths stage the source in the native data directory and run `bun install --production --frozen-lockfile --ignore-scripts`. They publish the version directory only after verification and dependency installation succeed. The native service installer then handles setup and the user LaunchAgent. It preserves the previous activation if startup fails.

If native configuration is missing or invalid, setup first copies existing `model-selection.json`, `naming-prompt.md`, and `provider.env` from the conventional daemon config directory. The original files stay unchanged. A valid imported selection skips interactive setup. Otherwise, the normal model-source wizard runs without daemon keybinding prompts. A piped install uses the caller's terminal when setup needs input.

To choose a private configuration directory:

```sh
sh installer/install.sh --native --config-dir "$HOME/.config/my-native-rename"
```

An existing `HERDR_PLUGIN_CONFIG_DIR` is also respected. Provider keys stay in private configuration, not the LaunchAgent, command arguments, or service logs. Set absolute `HERDR_APP_BIN_PATH` and `HC_BIN_PATH` values if those tools are not on PATH. Keep `HERDR_APP_HOME` and `HC_SESSION` consistent with your foreground native commands so they share ownership and state.

The default locations are:

- config: `$XDG_CONFIG_HOME/herdr-tab-smart-rename/native`, falling back to `~/.config/herdr-tab-smart-rename/native`
- versioned source: `$XDG_DATA_HOME/herdr-tab-smart-rename/native/versions/<commit>`, falling back to `~/.local/share/herdr-tab-smart-rename/native/versions/<commit>`
- supervisor health: `$XDG_STATE_HOME/herdr-tab-smart-rename/native-service/status.json`, falling back to `~/.local/state/herdr-tab-smart-rename/native-service/status.json`
- command: `~/.local/bin/smart-rename-native`

Ensure `~/.local/bin` is on PATH. Check or remove the installed service with:

```sh
smart-rename-native status
smart-rename-native uninstall
```

Uninstall removes only owned activation files and the service. It keeps private configuration, naming state, and versioned source. Status reports launchd process state, worker health, target counts, and the latest safe failure summary. A ready supervisor can have offline or blocked targets. Those targets preserve their state without blocking other tabs.

The local installer also accepts `--native --status` and `--native --uninstall`. A native-enabled release installer supports the same flags, including through `sh -s --` after curl. Status and uninstall need neither a running app nor provider availability. They never invoke the daemon. Native setup and supervision can send bounded context from eligible tabs to the selected provider, as described in [privacy and context](configuration.md#private-files-and-context).

For bootstrap testing with already-rendered local release assets, set `SMART_RENAME_NATIVE_ASSET_DIR` to their absolute directory. It must contain the bound archive and checksum manifest. This skips asset downloads, not dependency installation. Contained tests replace Bun's install command and curl with local fakes to avoid network access.

## macOS and Linux

Download the [latest installer and checksums](https://github.com/iurysza/herdr-tab-smart-rename/releases/latest). You can inspect the [installer source](../installer/install.sh) before running it.

From the folder containing both files, run:

```sh
grep '  install.sh$' SHA256SUMS | shasum -a 256 -c - && sh install.sh
```

The checksum manifest also covers the optional native archive. The command above checks only the daemon installer you downloaded.

The installer installs its exact release through Herdr, then opens setup. Setup finds connected providers, saves your choice, and starts the worker. Herdr installs the plugin's Bun dependencies for you.

To install without opening setup:

```sh
sh install.sh --install-only --yes
```

This leaves configuration and worker startup to you. Herdr starts the worker on server start only after setup saves `model-selection.json` or `provider.env`. Rerunning the same installer is safe: it recognizes its installed release and offers setup again.

## Windows

With Bun available on Herdr's `PATH`, run:

```sh
herdr plugin install iurysza/herdr-tab-smart-rename
herdr plugin action invoke setup --plugin tab-smart-rename
```

This also works on macOS and Linux. To choose a specific release, add `--ref` with a tag from the [release list](https://github.com/iurysza/herdr-tab-smart-rename/releases).

## Choose a model

1. If you already have a valid configuration, choose whether to keep it.
2. To change it, choose Pi, OpenCode, or Direct.
3. Select a connected provider and model. Pi offers supported thinking levels; OpenCode offers model variants. Direct asks for an API key and endpoint.
4. Choose whether to see shortcut instructions.
5. Review the choices and confirm **Apply this setup?**

Setup validates configuration without making a model completion. Normal naming uses the selected provider after the worker starts.

Cancel before applying to leave configuration and worker state unchanged. A cancelled setup does not start the worker when the server starts. A failed save or validation restores the old configuration. If only startup fails, setup keeps the valid settings and prints a retry command.

## Upgrade an existing install

Stop the old worker before replacing its code. Wait for the action log to report that it stopped:

```sh
herdr plugin action invoke stop --plugin tab-smart-rename
herdr plugin log list --plugin tab-smart-rename --limit 1
```

On macOS or Linux, download and verify the new release's installer, then run it. On Windows, repeat `herdr plugin install` with `--ref` set to the release tag, then run setup.

Keep your existing AI setup when prompted. Your private configuration and custom prompt live outside the installed code, so replacing the plugin does not require new keys.

Check the worker after setup:

```sh
herdr plugin action invoke status --plugin tab-smart-rename
```

If installation fails after stopping the worker, inspect the error before continuing. Do not delete the private config directory or reset naming state to fix an upgrade.

## Move from a local checkout

Herdr cannot install a GitHub release over a local plugin link. Stop the worker and confirm it stopped, as above. Then remove only the link:

```sh
herdr plugin unlink tab-smart-rename
```

Run the release installer, or follow the Windows steps. Unlinking keeps your checkout and private settings. There is no need to delete files or copy credentials.

## Switch from Direct to Pi or OpenCode

Sign in to the provider in Pi or OpenCode first. Then rerun setup:

```sh
herdr plugin action invoke setup --plugin tab-smart-rename
```

Choose **No** at **Keep existing AI setup?**, then select the source and model. The new choice applies to the next model-backed rename. Your old Direct `provider.env` remains in place.

The old `configure-ai` action still works as an alias for setup. It no longer opens a provider-file editor.

For older pre-release installations named `autoname`, stop that plugin's worker before installing Smart Rename. Automatic migration between the old and current plugin IDs is not provided. Keep the old config and set up `tab-smart-rename` separately.
