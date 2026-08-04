<template>
  <div class="bg-white rounded-xl border border-dashed border-slate-300 py-10 px-6 text-center">
    <i class="pi pi-inbox text-2xl text-slate-300"></i>
    <div class="text-sm font-semibold text-slate-700 mt-3">{{ label }} is not set up for this school</div>
    <p class="text-xs text-slate-500 mt-1.5 max-w-md mx-auto">
      <span class="font-mono text-slate-400">{{ collection }}</span> has no documents yet.
      <template v-if="blockedBy">
        {{ blockedBy }} first — {{ label.toLowerCase() }} depends on it.
      </template>
      <template v-else>
        This is expected for a school that hasn't been through setup; it is not an error.
      </template>
    </p>
    <div class="flex items-center justify-center gap-2 mt-4">
      <Button
        v-if="blockedBy && blockedTab"
        :label="`Go to ${blockedBy}`" icon="pi pi-arrow-right" size="small" outlined
        @click="goTo(blockedTab)"
      />
      <Button
        v-else-if="!blockedBy"
        label="Set up with the wizard" icon="pi pi-sparkles" size="small" outlined
        @click="goTo('new-school')"
      />
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup>
/**
 * Shown when a config collection has zero documents.
 *
 * Most schools in the estate have never been through School Setup, so every
 * config tab renders empty for them. Empty used to be indistinguishable from
 * broken — the Overview hygiene panel reporting all-zero counts reads as "this
 * school is damaged" when it means "this school is unmigrated" (AUDIT.md §3.1).
 * This says which it is, and where to go next.
 */
import { inject } from 'vue'
import Button from 'primevue/button'

// Provided by SchoolSetup.vue. Falls back to a no-op so this component can be
// dropped anywhere without exploding.
const goToSetupTab = inject('goToSetupTab', null)
function goTo(tab) { if (goToSetupTab) goToSetupTab(tab) }

defineProps({
  /** Human name, e.g. "Assessments". */
  label: { type: String, required: true },
  /** Firestore collection name, shown verbatim so it matches the console. */
  collection: { type: String, required: true },
  /**
   * Set when another collection must exist first (e.g. assessments need terms).
   * Suppresses the wizard button — sending someone to the wizard for a
   * dependency they cannot satisfy yet is worse than saying nothing.
   */
  blockedBy: { type: String, default: '' },
  /** Tab value to jump to when `blockedBy` is set, e.g. "terms-scales". */
  blockedTab: { type: String, default: '' },
})
</script>
