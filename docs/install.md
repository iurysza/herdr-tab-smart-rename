# Install or upgrade Smart Rename

Use a terminal inside Herdr. Install Herdr 0.7.0+ and Bun 1.1.34+ first. The installer checks these tools; it does not install them.

## macOS and Linux

Download the [latest installer and checksums](https://github.com/iurysza/herdr-tab-smart-rename/releases/latest). You can inspect the [installer source](../installer/install.sh) before running it.

From the folder containing both files, run:

```sh
shasum -a 256 -c SHA256SUMS && sh install.sh
```

The installer installs its exact release through Herdr, then opens setup. Setup finds connected providers, saves your choice, and starts the worker. Herdr installs the plugin's Bun dependencies for you.

To install without opening setup:

```sh
sh install.sh --install-only --yes
```

This leaves configuration and worker startup to you. Rerunning the same installer is safe: it recognizes its installed release and offers setup again.

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

Cancel before applying to leave configuration and worker state unchanged. A failed save or validation restores the old configuration. If only startup fails, setup keeps the valid settings and prints a retry command.

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
