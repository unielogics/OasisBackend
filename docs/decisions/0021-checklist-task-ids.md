# 0021 Checklist tasks keep stable ids

Status: accepted (2026-10-06)

The Settings UI edits a package's tasks as an ordered list of strings and PUTs the whole list; job checklists must match
tasks by id, never by label (review B23, B49). `checklist_tasks` therefore has stable ids and the server diffs the list:

1. An entry that carries an `id` keeps that task (rename and reorder never change ids; a retired id is revived).
2. An id-less entry whose label equals a still-unclaimed active task keeps that task (a reordered string list).
3. A remaining id-less entry takes the still-unclaimed active task of the same rank (an in-place edit is a rename).
4. Anything else is a new task. Active tasks nobody claimed are **retired** (`retired_at`), never deleted.

Labels are trimmed and blank entries dropped before diffing; at most 60 tasks of 200 characters. An unknown or repeated id
is a 422 naming the entry. A change bumps `services.version` once; `expectedVersion` makes the PUT conflict-safe, and an
unchanged list writes nothing. The result returns renamed, created, retired, revived and moved ids so the later
`ChecklistSync` (jobs not yet started) can propagate them. Typing the label of a retired task creates a new task rather
than silently reviving the old one; clients restore it by sending its id.

Consequence of rule 3 being rank-based: a reorder and a rename in one string-array edit creates a new task and retires the
renamed one. The dashboard should send `{id, label}` to avoid this; the string form is the fallback for the design's UI.
The seed applies the design's `/inspection/i` filter at seed time (it also removes "Hand-dry pre-inspection").
