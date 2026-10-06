export const FEDERAL_HOLIDAYS_JOB = 'federal_holidays.generate'
export const EMERGENCY_AUTO_REOPEN_JOB = 'emergency.auto_reopen'
export const EMERGENCY_SWEEP_JOB = 'emergency.sweep'

export interface AutoReopenData {
  locationId: string
  emergencyClosureId: string
}
