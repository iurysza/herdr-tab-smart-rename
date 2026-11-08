# Smart Rename

Name Herdr tabs from the current task.

## Install the native service

Use this path for the Herdr app (`herdr-app`) and Herdr Core (`hc`) on macOS. The legacy `herdr` daemon is a [separate install](#install-the-legacy-daemon).

The Herdr app and the Sheprd companion can both be named `Herdr.app`. Confirm the executables:

```sh
herdr-app --version
hc --version
```

You need Bun 1.2.23 or newer. `herdr-app` and `hc` must be on `PATH`. If they are not, set absolute `HERDR_APP_BIN_PATH` and `HC_BIN_PATH`. Open the Herdr app before you install. The installer waits up to 180 seconds for the worker to list tabs and connect to core events. If the worker is not ready, the installer stops and restores the previous activation. It does not install Bun, `herdr-app`, or `hc`.

Install [v0.7.0](https://github.com/iurysza/herdr-tab-smart-rename/releases/tag/v0.7.0):

```sh
curl -fsSL https://github.com/iurysza/herdr-tab-smart-rename/releases/download/v0.7.0/install.sh | sh -s -- --native
```

That release contains `install.sh`, `SHA256SUMS`, and `smart-rename-native.tar.gz`. The script checks the archive against the checksum in the installer and in `SHA256SUMS` before it writes files.

To check `install.sh` before you run it, download `install.sh` and `SHA256SUMS` from that release, then run:

```sh
grep '  install.sh$' SHA256SUMS | shasum -a 256 -c - && sh install.sh --native
```

If native configuration is missing or invalid, setup copies existing `model-selection.json`, `naming-prompt.md`, and `provider.env` from the daemon config directory. The original files stay unchanged. A valid imported selection skips the model questions. With nothing valid to import, setup asks you to choose a model. The directory and other flags are in [Native macOS app](./docs/install.md#native-macos-app).

Put `~/.local/bin` on `PATH`.

```sh
smart-rename-native status
smart-rename-native uninstall
```

`uninstall` removes the service, the owned in-app mod, and the `ctrl-shift-r` binding. It keeps configuration, naming state, and the installed source.

## Name a tab

The service names local tabs and tabs on machines already connected to this core, and it keeps a name you set. Install it only on the computer that runs the Herdr app. Model configuration stays on this computer. A model request sends that tab's bounded context to your provider. Redaction can miss secrets. Read [Private files and context](./docs/configuration.md#private-files-and-context) before you name tabs that contain sensitive text.

Press `ctrl-shift-r` to name the focused local or remote tab. The key replaces a name you set, and the app shows the result in a toast. If `ctrl-shift-r` is already bound to another command, install leaves that binding and reports `colliding`. Bind `mod.open:smart-rename` to a free key.

To name one tab by ID from a checkout, see [Name one tab](./docs/install.md#name-one-tab).

## Install the legacy daemon

The `herdr` plugin does not name Herdr app tabs. It needs Herdr 0.7.5 or newer and Bun 1.2.23 or newer. From a Herdr terminal, run the same v0.7.0 installer without `--native`:

```sh
curl -fsSL https://github.com/iurysza/herdr-tab-smart-rename/releases/download/v0.7.0/install.sh | sh
```

Windows, upgrades, and a local checkout are in [Install](./docs/install.md). Actions and shortcuts are in [Configuration](./docs/configuration.md).

## Troubleshoot

| Problem | What to do |
| --- | --- |
| Install rolls back | Open the Herdr app, confirm `herdr-app` and `hc` run, then install again. |
| `ctrl-shift-r` does nothing | Run `smart-rename-native status`. If install reported `colliding`, bind `mod.open:smart-rename`. |
| A name you set stays | Press `ctrl-shift-r`. The background service keeps that name. |
| A remote tab stays unnamed | Connect that machine to this core. A changed core alias stays blocked until the native service process starts again. `smart-rename-native status` reports blocked targets. |
| The daemon worker is stopped | See [Troubleshooting](./docs/configuration.md#troubleshooting). |

## Documentation

- [Install](./docs/install.md)
- [Configuration](./docs/configuration.md)
- [Naming policy](./docs/naming-policy.md)
- [Development](./docs/development.md)
- [Changelog](./CHANGELOG.md)
