// Pure diff for PUT /packages/:id/checklist. The UI edits an ordered list of strings; the server keeps stable task ids
// so job checklists can be matched later. Tie-break, in order:
//   1. an entry carrying an id keeps that task (rename and reorder never change ids; a retired id is revived);
//   2. an id-less entry whose label equals a still-unclaimed active task keeps that task (reorder of plain strings);
//   3. a remaining id-less entry takes the still-unclaimed active task at the same rank (rename in place);
//   4. otherwise it is a new task. Active tasks nobody claimed are retired, never deleted.
export interface ChecklistInput {
  id?: string | null
  label: string
}

export interface ExistingTask {
  id: string
  label: string
  position: number
  retired: boolean
}

export type MatchedBy = 'id' | 'label' | 'position' | 'new'

export interface PlannedTask {
  /** null for a task that does not exist yet. */
  id: string | null
  label: string
  position: number
  matchedBy: MatchedBy
}

export interface ChecklistPlan {
  /** The final ordered active list. */
  tasks: PlannedTask[]
  renamed: { id: string; from: string; to: string }[]
  created: PlannedTask[]
  retired: ExistingTask[]
  revived: string[]
  /** Existing tasks whose stored position differs from the new order. */
  moved: string[]
  changed: boolean
}

export class ChecklistDiffError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(message)
    this.name = 'ChecklistDiffError'
  }
}

export const MAX_TASKS = 60
export const MAX_LABEL_LENGTH = 200

/** Trims labels and drops entries that are empty after trimming (the UI ignores blank input too). */
export function normalizeChecklist(input: readonly ChecklistInput[]): ChecklistInput[] {
  const out: ChecklistInput[] = []
  for (const entry of input) {
    const label = String(entry.label ?? '').trim()
    if (label === '') continue
    out.push(entry.id ? { id: entry.id, label } : { label })
  }
  return out
}

export function diffChecklist(
  existingTasks: readonly ExistingTask[],
  rawInput: readonly ChecklistInput[],
): ChecklistPlan {
  const input = normalizeChecklist(rawInput)
  if (input.length > MAX_TASKS)
    throw new ChecklistDiffError(MAX_TASKS, `A checklist can hold at most ${MAX_TASKS} tasks.`)
  input.forEach((e, i) => {
    if (e.label.length > MAX_LABEL_LENGTH)
      throw new ChecklistDiffError(i, `A task can be at most ${MAX_LABEL_LENGTH} characters.`)
  })

  const byId = new Map(existingTasks.map((t) => [t.id, t]))
  const active = existingTasks.filter((t) => !t.retired).sort((a, b) => a.position - b.position)
  const claimed = new Set<string>()
  const assigned: (ExistingTask | null)[] = new Array(input.length).fill(null)
  const matchedBy: MatchedBy[] = new Array(input.length).fill('new')

  input.forEach((e, i) => {
    if (!e.id) return
    const task = byId.get(e.id)
    if (!task) throw new ChecklistDiffError(i, 'That task does not belong to this checklist.')
    if (claimed.has(task.id)) throw new ChecklistDiffError(i, 'A task appears twice in the list.')
    claimed.add(task.id)
    assigned[i] = task
    matchedBy[i] = 'id'
  })

  input.forEach((e, i) => {
    if (e.id) return
    const task = active.find((t) => !claimed.has(t.id) && t.label === e.label)
    if (!task) return
    claimed.add(task.id)
    assigned[i] = task
    matchedBy[i] = 'label'
  })

  input.forEach((e, i) => {
    if (e.id || assigned[i]) return
    const task = active[i]
    if (!task || claimed.has(task.id)) return
    claimed.add(task.id)
    assigned[i] = task
    matchedBy[i] = 'position'
  })

  const tasks: PlannedTask[] = input.map((e, i) => ({
    id: assigned[i]?.id ?? null,
    label: e.label,
    position: i,
    matchedBy: matchedBy[i]!,
  }))
  const renamed: ChecklistPlan['renamed'] = []
  const moved: string[] = []
  const revived: string[] = []
  tasks.forEach((t, i) => {
    const prev = assigned[i]
    if (!prev) return
    if (prev.label !== t.label) renamed.push({ id: prev.id, from: prev.label, to: t.label })
    if (prev.retired) revived.push(prev.id)
    else if (prev.position !== t.position) moved.push(prev.id)
  })
  const created = tasks.filter((t) => t.id === null)
  const retired = active.filter((t) => !claimed.has(t.id))
  return {
    tasks,
    renamed,
    created,
    retired,
    revived,
    moved,
    changed: renamed.length + created.length + retired.length + revived.length + moved.length > 0,
  }
}
