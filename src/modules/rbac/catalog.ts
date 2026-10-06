// The permission catalog, money-limit vocabulary and the default role grants (Settings design, set-domain 1.5 and 1.6).
// The permissions table is seeded by the people_auth migration from the same list; a test keeps the two in step.

export const LIMIT_KINDS = ['refund', 'adjust', 'credit'] as const
export type LimitKind = (typeof LIMIT_KINDS)[number]
export const isLimitKind = (s: string): s is LimitKind => (LIMIT_KINDS as readonly string[]).includes(s)

/** Money limit applied when a role has no role_limits row for a kind, and to an Allow exception no role backs. */
export const DEFAULT_LIMIT_CENTS = 2500

/** The limit chips of the roles matrix, in dollars; null = No limit. Stored as cents. */
export const LIMIT_CHOICES_DOLLARS = [25, 50, 100, 250, 500, 1000, null] as const
export const LIMIT_CHOICES_CENTS: ReadonlyArray<number | null> = LIMIT_CHOICES_DOLLARS.map((d) =>
  d === null ? null : d * 100,
)

export interface PermissionDef {
  key: string
  module: string
  label: string
  limit?: LimitKind
}

const mod = (module: string, defs: Array<[key: string, label: string, limit?: LimitKind]>): PermissionDef[] =>
  defs.map(([key, label, limit]) => ({ key, module, label, ...(limit ? { limit } : {}) }))

export const PERMISSIONS: readonly PermissionDef[] = [
  ...mod('Schedule & jobs', [
    ['sched.view', 'View schedule & calendar'],
    ['sched.edit', 'Create & edit appointments'],
    ['sched.cancel', 'Cancel & mark no-shows'],
    ['sched.override', 'Override bay capacity'],
    ['jobs.status', 'Move jobs between stages'],
    ['jobs.checklist', 'Complete checklists & photos'],
  ]),
  ...mod('Clients', [
    ['cli.view', 'View client files'],
    ['cli.contact', 'See phone & email'],
    ['cli.edit', 'Edit client & vehicle details'],
    ['cli.export', 'Export client data'],
    ['cli.member', 'Manage memberships & VIP'],
  ]),
  ...mod('Payments', [
    ['pay.collect', 'Collect payments'],
    ['pay.refund', 'Issue refunds', 'refund'],
    ['pay.adjust', 'Apply adjustments & discounts', 'adjust'],
    ['pay.credit', 'Issue account credits', 'credit'],
    ['pay.void', 'Void transactions'],
    ['pay.reports', 'View payment reports'],
  ]),
  ...mod('Messaging', [
    ['msg.send', 'Message customers'],
    ['msg.auto', 'Edit automations & templates'],
    ['msg.broadcast', 'Send offers & broadcasts'],
  ]),
  ...mod('Team', [
    ['team.view', 'View team'],
    ['team.edit', 'Add & edit employees'],
    ['team.roles', 'Assign roles & permissions'],
  ]),
  ...mod('Settings', [
    ['set.hours', 'Working hours & holidays'],
    ['set.emergency', 'Emergency closing'],
    ['set.services', 'Services, pricing & checklists'],
    ['set.billing', 'Billing & integrations'],
  ]),
]

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key)
export const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS)
export const isPermissionKey = (s: string): boolean => PERMISSION_KEY_SET.has(s)

export const LIMITED_PERMISSION: Readonly<Record<string, LimitKind>> = Object.fromEntries(
  PERMISSIONS.filter((p) => p.limit).map((p) => [p.key, p.limit!]),
)

/** Only a Super Admin may grant these (role grant or per-person Allow exception). */
export const SUPER_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(['set.billing', 'pay.void'])

export const SKILLS = [
  'Interior detailing',
  'Paint correction',
  'Ceramic coating',
  'Exotic vehicles',
  'Front desk',
  'Mobile service',
] as const

export const BUILTIN_ROLE_KEYS = ['super', 'mgmt', 'acct', 'support', 'crew'] as const
export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number]

export interface DefaultRole {
  key: BuiltinRoleKey
  name: string
  description: string
  locked: boolean
  perms: readonly string[]
  /** Dollars per kind; null = No limit. Crew has 25 for all three even though it holds none of those permissions. */
  limits: Readonly<Record<LimitKind, number | null>>
}

const ALL = PERMISSION_KEYS

export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    key: 'super',
    name: 'Super Admin',
    description: 'Owner level. Everything, including billing.',
    locked: true,
    perms: ALL,
    limits: { refund: null, adjust: null, credit: null },
  },
  {
    key: 'mgmt',
    name: 'Management',
    description: 'Runs the shop day to day.',
    locked: false,
    perms: ALL.filter((k) => k !== 'set.billing'),
    limits: { refund: 1000, adjust: 500, credit: 500 },
  },
  {
    key: 'acct',
    name: 'Accounting',
    description: 'Payments, refunds, credits and reports.',
    locked: false,
    perms: [
      'sched.view',
      'cli.view',
      'cli.contact',
      'cli.export',
      'cli.member',
      'pay.collect',
      'pay.refund',
      'pay.adjust',
      'pay.credit',
      'pay.void',
      'pay.reports',
      'team.view',
      'set.billing',
    ],
    limits: { refund: 500, adjust: 250, credit: 250 },
  },
  {
    key: 'support',
    name: 'Customer Support',
    description: 'Front desk, bookings and messaging.',
    locked: false,
    perms: [
      'sched.view',
      'sched.edit',
      'sched.cancel',
      'cli.view',
      'cli.contact',
      'cli.edit',
      'cli.member',
      'pay.collect',
      'pay.refund',
      'pay.adjust',
      'pay.credit',
      'msg.send',
      'team.view',
    ],
    limits: { refund: 50, adjust: 25, credit: 50 },
  },
  {
    key: 'crew',
    name: 'Crew',
    description: 'Bay work: jobs, checklists, photos.',
    locked: false,
    perms: ['sched.view', 'jobs.status', 'jobs.checklist', 'cli.view'],
    limits: { refund: 25, adjust: 25, credit: 25 },
  },
]

/** Display order of a person's roles in the header chip: the first built-in role they hold, else the first by name. */
export const ROLE_PRECEDENCE: readonly string[] = BUILTIN_ROLE_KEYS

export const CUSTOM_ROLE_DEFAULTS = {
  name: 'Shift Lead',
  description: 'Custom role — starts from Crew.',
  extraPerms: ['sched.edit'],
  limitDollars: 25,
} as const
