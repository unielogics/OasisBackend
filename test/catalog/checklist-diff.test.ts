import { describe, expect, it } from 'vitest'
import {
  ChecklistDiffError,
  MAX_LABEL_LENGTH,
  MAX_TASKS,
  diffChecklist,
  normalizeChecklist,
  type ExistingTask,
} from '../../src/modules/catalog/checklist-diff.js'

const task = (id: string, label: string, position: number, retired = false): ExistingTask => ({
  id,
  label,
  position,
  retired,
})
const BASE = [task('a', 'Rinse', 0), task('b', 'Wash', 1), task('c', 'Dry', 2)]
const labels = (...l: string[]) => l.map((label) => ({ label }))
const ids = (plan: ReturnType<typeof diffChecklist>) => plan.tasks.map((t) => t.id)
const view = (plan: ReturnType<typeof diffChecklist>) =>
  plan.tasks.map((t) => `${t.id ?? 'NEW'}:${t.label}:${t.matchedBy}`)

describe('normalizeChecklist', () => {
  it('trims labels and drops entries that are empty after trimming', () => {
    expect(
      normalizeChecklist([
        { label: '  Rinse ' },
        { label: '   ' },
        { label: '' },
        { id: 'x', label: ' Dry' },
      ]),
    ).toEqual([{ label: 'Rinse' }, { id: 'x', label: 'Dry' }])
  })
})

describe('diffChecklist: id-less input (the UI sends a string array)', () => {
  it('is a no-op when the list is unchanged', () => {
    const p = diffChecklist(BASE, labels('Rinse', 'Wash', 'Dry'))
    expect(p.changed).toBe(false)
    expect(ids(p)).toEqual(['a', 'b', 'c'])
    expect(p.tasks.every((t) => t.matchedBy === 'label')).toBe(true)
  })

  it('keeps ids when tasks are reordered', () => {
    const p = diffChecklist(BASE, labels('Dry', 'Rinse', 'Wash'))
    expect(ids(p)).toEqual(['c', 'a', 'b'])
    expect(p.moved.sort()).toEqual(['a', 'b', 'c'])
    expect(p.created).toHaveLength(0)
    expect(p.retired).toHaveLength(0)
    expect(p.renamed).toHaveLength(0)
  })

  it('treats an edit in place as a rename that keeps the id', () => {
    const p = diffChecklist(BASE, labels('Rinse', 'Two-bucket wash', 'Dry'))
    expect(view(p)).toEqual(['a:Rinse:label', 'b:Two-bucket wash:position', 'c:Dry:label'])
    expect(p.renamed).toEqual([{ id: 'b', from: 'Wash', to: 'Two-bucket wash' }])
    expect(p.changed).toBe(true)
  })

  it('renames every task when every label changed in place', () => {
    const p = diffChecklist(BASE, labels('R', 'W', 'D'))
    expect(ids(p)).toEqual(['a', 'b', 'c'])
    expect(p.renamed).toHaveLength(3)
  })

  it('creates a task inserted in the middle without disturbing the others', () => {
    const p = diffChecklist(BASE, labels('Rinse', 'Foam', 'Wash', 'Dry'))
    expect(view(p)).toEqual(['a:Rinse:label', 'NEW:Foam:new', 'b:Wash:label', 'c:Dry:label'])
    expect(p.created.map((t) => t.label)).toEqual(['Foam'])
    expect(p.moved.sort()).toEqual(['b', 'c'])
  })

  it('appends a new task at the end', () => {
    const p = diffChecklist(BASE, labels('Rinse', 'Wash', 'Dry', 'Wax'))
    expect(p.created.map((t) => [t.label, t.position])).toEqual([['Wax', 3]])
    expect(p.moved).toEqual([])
  })

  it('retires a removed task instead of deleting it and keeps the others', () => {
    const p = diffChecklist(BASE, labels('Rinse', 'Dry'))
    expect(ids(p)).toEqual(['a', 'c'])
    expect(p.retired.map((t) => t.id)).toEqual(['b'])
    expect(p.moved).toEqual(['c'])
  })

  it('retires everything when the list is emptied', () => {
    const p = diffChecklist(BASE, [])
    expect(p.tasks).toEqual([])
    expect(p.retired.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops blank entries before diffing, so a blank row changes nothing', () => {
    const p = diffChecklist(BASE, [
      ...labels('Rinse', '  '),
      { label: 'Wash' },
      { label: '' },
      { label: 'Dry' },
    ])
    expect(p.changed).toBe(false)
  })

  it('matches duplicate labels pairwise in order', () => {
    const existing = [task('a', 'Wipe', 0), task('b', 'Wipe', 1), task('c', 'Dry', 2)]
    const p = diffChecklist(existing, labels('Dry', 'Wipe', 'Wipe'))
    expect(ids(p)).toEqual(['c', 'a', 'b'])
  })

  it('prefers an exact label match over a position match (insert plus remove is not two renames)', () => {
    const p = diffChecklist(BASE, labels('Foam', 'Rinse', 'Wash'))
    expect(view(p)).toEqual(['NEW:Foam:new', 'a:Rinse:label', 'b:Wash:label'])
    expect(p.retired.map((t) => t.id)).toEqual(['c'])
    expect(p.renamed).toHaveLength(0)
  })

  it('does not bring a retired task back by typing its old label', () => {
    const existing = [...BASE, task('z', 'Wax', 3, true)]
    const p = diffChecklist(existing, labels('Rinse', 'Wash', 'Dry', 'Wax'))
    expect(p.tasks[3]).toMatchObject({ id: null, label: 'Wax', matchedBy: 'new' })
    expect(p.revived).toEqual([])
  })

  it('is case sensitive: changing only the case is a rename', () => {
    const p = diffChecklist(BASE, labels('Rinse', 'wash', 'Dry'))
    expect(p.renamed).toEqual([{ id: 'b', from: 'Wash', to: 'wash' }])
  })

  it('ranks positions among active tasks only, ignoring retired ones', () => {
    const existing = [task('x', 'Gone', 0, true), task('a', 'Rinse', 1), task('b', 'Wash', 2)]
    const p = diffChecklist(existing, labels('Rinse', 'Wash up'))
    expect(ids(p)).toEqual(['a', 'b'])
    expect(p.renamed).toEqual([{ id: 'b', from: 'Wash', to: 'Wash up' }])
  })
})

describe('diffChecklist: input with ids', () => {
  it('keeps ids across rename and reorder at once', () => {
    const p = diffChecklist(BASE, [
      { id: 'c', label: 'Towel dry' },
      { id: 'a', label: 'Rinse' },
      { id: 'b', label: 'Wash' },
    ])
    expect(view(p)).toEqual(['c:Towel dry:id', 'a:Rinse:id', 'b:Wash:id'])
    expect(p.renamed).toEqual([{ id: 'c', from: 'Dry', to: 'Towel dry' }])
    expect(p.retired).toHaveLength(0)
  })

  it('claims ids first, so an id-less entry never steals a task an id-bearing entry owns', () => {
    const p = diffChecklist(BASE, [{ label: 'Rinse' }, { id: 'a', label: 'Rinse again' }])
    expect(view(p)).toEqual(['NEW:Rinse:new', 'a:Rinse again:id'])
    expect(p.retired.map((t) => t.id).sort()).toEqual(['b', 'c'])
  })

  it('mixes ids, labels and new rows', () => {
    const p = diffChecklist(BASE, [{ id: 'b', label: 'Wash' }, { label: 'Dry' }, { label: 'Wax' }])
    expect(view(p)).toEqual(['b:Wash:id', 'c:Dry:label', 'NEW:Wax:new'])
    expect(p.retired.map((t) => t.id)).toEqual(['a'])
  })

  it('revives a retired task addressed by id, with the label sent', () => {
    const existing = [...BASE, task('z', 'Wax', 3, true)]
    const p = diffChecklist(existing, [
      ...BASE.map((t) => ({ id: t.id, label: t.label })),
      { id: 'z', label: 'Hand wax' },
    ])
    expect(p.revived).toEqual(['z'])
    expect(p.renamed).toEqual([{ id: 'z', from: 'Wax', to: 'Hand wax' }])
    expect(p.changed).toBe(true)
  })

  it('rejects an unknown id and a repeated id', () => {
    expect(() => diffChecklist(BASE, [{ id: 'nope', label: 'X' }])).toThrow(ChecklistDiffError)
    expect(() =>
      diffChecklist(BASE, [
        { id: 'a', label: 'X' },
        { id: 'a', label: 'Y' },
      ]),
    ).toThrow(/twice/)
  })

  it('reports the index of the offending entry', () => {
    try {
      diffChecklist(BASE, [{ id: 'a', label: 'ok' }, { label: '  ' }, { id: 'zzz', label: 'bad' }])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ChecklistDiffError).index).toBe(1)
    }
  })
})

describe('diffChecklist: limits', () => {
  it('rejects an over-long label and too many tasks', () => {
    expect(() => diffChecklist([], labels('x'.repeat(MAX_LABEL_LENGTH + 1)))).toThrow(ChecklistDiffError)
    expect(() =>
      diffChecklist([], labels(...Array.from({ length: MAX_TASKS + 1 }, (_, i) => `Task ${i}`))),
    ).toThrow(ChecklistDiffError)
    expect(
      diffChecklist([], labels(...Array.from({ length: MAX_TASKS }, (_, i) => `Task ${i}`))).created,
    ).toHaveLength(MAX_TASKS)
  })

  it('creates every task of a first save', () => {
    const p = diffChecklist([], labels('A', 'B'))
    expect(p.created.map((t) => [t.label, t.position])).toEqual([
      ['A', 0],
      ['B', 1],
    ])
    expect(p.changed).toBe(true)
  })
})
