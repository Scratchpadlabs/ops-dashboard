import { ref } from 'vue'

// Shared across the whole app, same singleton-ref idiom as useGlobalSearch's
// isSearchOpen / useStepUpAuth's isElevated. This tracks the root
// `schools/{id}` config tree (terms/subjects/classes/assessments/...) that
// School Setup edits — NOT the CRM's `operations/ops/schools` id space that
// SchoolProfile.vue (`/schools/:id`) uses; those are different schools
// entirely (see SchoolSetup.vue's own comment on this). The AI Assistant
// cares about the former, since that's the schema it can actually read.
export const activeSchoolId = ref(null)
export const activeSchoolName = ref(null)

export function useActiveSchool() {
  function setActiveSchool(id, name = null) {
    activeSchoolId.value = id || null
    activeSchoolName.value = id ? name : null
  }
  function clearActiveSchool() {
    activeSchoolId.value = null
    activeSchoolName.value = null
  }
  return { activeSchoolId, activeSchoolName, setActiveSchool, clearActiveSchool }
}
