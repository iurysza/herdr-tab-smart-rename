# Naming language

Smart Rename names three kinds of Herdr items. A pane can supply task evidence even when its own label belongs to the user.

## Language

**Target**:
The workspace, tab, or agent pane whose label Smart Rename may change. A tab and its panes are separate targets.
_Avoid_: Calling every target a tab.

**Source pane**:
A pane whose task context informs a target's candidate. A manually named pane can still be a source pane for its tab.
_Avoid_: Treating manual ownership as exclusion from context.

**Candidate**:
A proposed label for a target. A model may abstain, leaving no task candidate; a candidate does not guarantee a rename.
_Avoid_: Calling a candidate the applied label.

**Manual ownership**:
The user's claim on one target's label. Background naming preserves it until an explicit reset or rename of that target.
_Avoid_: Treating manual ownership as a lock on the whole tab or its context.

**Model selection**:
The chosen Direct, Pi, or OpenCode source, provider, model, and optional profile. It selects how a model request runs, not which target receives the result.
_Avoid_: Calling a model selection a naming candidate.
