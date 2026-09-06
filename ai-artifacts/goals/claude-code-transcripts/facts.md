# Facts

- A recognised Claude Code pane contributes the same bounded origin, midpoint, and recent user-request excerpts that Pi panes already contribute.
- When Herdr reports a Claude session path, Smart Rename reads that file if it is a regular file under the allowed Claude roots.
- When Herdr reports a Claude session id and no usable path, Smart Rename looks up a unique `<id>.jsonl` under the Claude config directory's transcripts or projects trees.
- Allowed Claude roots are `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`, limited to `transcripts` and `projects`. Session ids cannot contain path separators, and lookup does not use cwd slugs.
- If no unique allowed transcript is found, or it yields no user request, naming continues with process and output evidence only.
- Extraction accepts both `{type:"user", content}` records and `{type:"user"|"message", message:{role:"user", content}}` records.
- Meta, sidechain, tool-result, slash-command wrapper, and interrupt or no-response records are dropped before sampling.
- Existing Pi sampling, sandbox, byte windows, sanitisation, ownership, and sibling-pane rules stay unchanged.
- Automated tests cover path reads, id lookup, sandbox rejection, both JSONL shapes, noise filtering, and the empty fallback, using fixtures rather than the real Claude directory.
- Docs state that Claude Code panes can contribute short user-request excerpts.
