# Phase 2 local native-app verification

This is the local-only checkpoint at `c9ad49f`, not the current remote support matrix. See [remote verification](remote/verification.md) for the extension and current checks.

Verified on 7 November 2026 in `feat/herdr-app`, based on fresh main `d93f0f6`. The native app was version 0.1.13, core was 0.1.18 and Bun was 1.4.2.

## Required gate

| Check | Result |
| --- | --- |
| `bun run check` | Passed |
| `bun run lint` | Passed |
| `git diff --check` | Passed |
| `bun scripts/test-contained.ts` | 171 passed, 7 opt-in tests skipped, 0 failed |
| `visual-artifact validate ai-artifacts/herdr-app/report.json` | Passed |

The contained suite runs `bun test` inside a disposable home and an operating-system sandbox. It includes 21 native client, ownership, context and watcher regressions. No real provider credentials are available there.

## Live checks

```sh
SMART_RENAME_NATIVE_LIVE_TEST=1 bun test test/herdr-app-live.test.ts
SMART_RENAME_LIVE_TEST=1 bun test test/herdr-live.test.ts --test-name-pattern 'manual pane labels'
```

Both targeted live checks passed. The native test runs the actual native CLI with a localhost-only OpenAI-compatible fixture. It does not substitute the native client or issue an external provider request.

The native test verifies these behaviours:

- an explicit rename changes `Tab Rename Scratch` to `Native Library Works`
- ordinary naming preserves manual title `123` without contacting the fixture
- a manual title set while inference is pending survives the late response
- invalid provider output returns exit 1 without changing the title
- the real core event subscription reaches readiness and cancels cleanly
- the watcher lock is released
- other tab names stay unchanged and the original native selection returns
- the scratch tab closes and its terminal reaches `finished`

The exact receipt is in [live-proof.json](live-proof.json). [Command results](live-commands.log) contain only the owned fixture's IDs and naming results. The screenshots are real app frames cropped to the relevant tab bar. The separate daemon regression created and closed `wB6:t3`, pane `wB6:p3`, without relinking its plugin.

During test development, immediate tab-close acknowledgement did not yet mean the shell had finished. Cleanup now waits through `hc wait`. Another test attempt correctly discarded an inference after shell startup changed the source identity. The final test first observes its owned `cat` fixture and fails promptly if the provider request never starts. All scratch terminals from these attempts are finished. Historical core records were retained.

## Designed report

The report is a constrained visual-artifact specification, rendered as a web page rather than a raw Markdown dump. It uses screenshot evidence, one progressively revealed runtime diagram, short chapters and expandable technical receipts. Its source is [report.json](report.json). The report URL is:

```text
http://127.0.0.1:9998/herdr-tab-smart-rename/native-tab-rename-design/
```

The design applies the requested frontend-design, design-taste-frontend, emil-design-eng and article-explainer principles within the trusted renderer's supported components. No standalone HTML, CSS or JavaScript page was generated.

Checked the rendered report at 1512 by 945 and 390 by 844. The diagram and screenshots load. The mobile document width equals its viewport width, with no horizontal overflow.

## Checks that are not green

The extra `bun scripts/scan-secrets.ts` check flags `scripts/scan-secrets.ts` itself, at byte 964. Its hard-coded basic-auth example URL matches the scanner. Scanning the unchanged main-branch source reproduces the same finding, and the scanner file matches HEAD byte for byte. No other finding appeared. This pre-existing false positive was not hidden or changed as part of native integration.

The existing report viewer emits React hydration error 418 on reload. The report content, diagram and images render afterward. This is a renderer warning outside the native backend; browser verification is not claimed to have a clean error console.

## Scope limits

No real provider account was exercised. Native remote spaces and pane-label writes are unsupported. The final read-to-rename race remains because the app API has no conditional write. No plugin links, provider configuration, native mods, layouts, startup services or agents2 pins were changed. This work does not enable global automatic naming.
