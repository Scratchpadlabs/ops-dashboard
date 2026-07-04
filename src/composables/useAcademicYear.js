import { ref } from 'vue'

export function computeCurrentAcademicYear() {
  const today = new Date()
  const startYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  return `${startYear}-${String(startYear + 1).slice(-2)}`
}

// Module-level refs — shared globally across every component that imports them.
export const activeYear = ref('All Years')
export const availableYears = ref([])

// The year new records should be tagged with. Falls back to the actual current
// academic year when the user is browsing "All Years" rather than a specific one.
export function effectiveAcademicYear() {
  return activeYear.value && activeYear.value !== 'All Years'
    ? activeYear.value
    : computeCurrentAcademicYear()
}

export function matchesActiveYear(record) {
  if (!activeYear.value || activeYear.value === 'All Years') return true
  return record.academic_year === activeYear.value
}

export function useAcademicYear() {
  return { activeYear, availableYears, effectiveAcademicYear, matchesActiveYear, computeCurrentAcademicYear }
}
