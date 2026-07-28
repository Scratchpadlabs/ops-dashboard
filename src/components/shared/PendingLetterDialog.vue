<template>
  <Dialog
    :visible="visible"
    @update:visible="v => $emit('update:visible', v)"
    header="Generate Pending Letter"
    modal
    :style="{ width: '720px' }"
    :contentStyle="{ maxHeight: '75vh', overflow: 'auto' }"
  >
    <Tabs v-model:value="activeTab">
      <TabList>
        <Tab value="0">1 · Select Items</Tab>
        <Tab value="1">2 · Preview &amp; Edit</Tab>
      </TabList>
      <TabPanels>
        <!-- ── Tab 1: scope selection ─────────────────────────────────────── -->
        <TabPanel value="0">
          <div v-if="!groups.length" class="text-center text-sm text-slate-400 py-10">
            Nothing pending — every item is checked off.
          </div>
          <div v-else class="space-y-4 pt-2">
            <div v-for="group in groups" :key="group.title" class="border border-slate-200 rounded-lg p-3">
              <div class="flex items-center gap-2 mb-2">
                <Checkbox :modelValue="isGroupFullyChecked(group)" binary @update:modelValue="v => toggleGroup(group, v)" />
                <span class="text-sm font-bold text-slate-900">{{ group.title }}</span>
                <span class="text-xs text-slate-400 ml-auto">{{ group.items.filter(i => i.checked).length }}/{{ group.items.length }}</span>
              </div>
              <div v-for="item in group.items" :key="item.id" class="ml-6 py-1.5 border-t border-slate-100 first:border-0">
                <div class="flex items-center gap-2">
                  <Checkbox v-model="item.checked" binary />
                  <span class="flex-1 text-sm" :class="item.checked ? 'text-slate-800' : 'text-slate-400 line-through'">{{ item.label }}</span>
                </div>
                <InputText
                  v-if="item.checked"
                  v-model="item.comment"
                  class="w-full text-xs mt-1"
                  placeholder="Optional comment — shown as an indented note under this item"
                />
              </div>
            </div>
          </div>
        </TabPanel>

        <!-- ── Tab 2: editable preview ─────────────────────────────────────── -->
        <TabPanel value="1">
          <div class="pt-2 space-y-4">
            <div v-if="drafting" class="flex items-center justify-center py-10">
              <ProgressSpinner style="width:28px;height:28px" />
            </div>
            <template v-else>
              <div v-if="draftError" class="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">{{ draftError }}</div>

              <div>
                <label class="form-label">Intro paragraph</label>
                <Textarea v-model="intro" class="w-full" rows="4" autoResize />
              </div>

              <div>
                <label class="form-label">Pending items ({{ selectedCount }})</label>
                <div class="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-56 overflow-auto">
                  <div v-for="(g, gi) in groupsWithSelection" :key="gi">
                    <div class="px-3 py-1.5 bg-slate-50 text-xs font-semibold text-slate-500">{{ g.title }}</div>
                    <div v-for="item in g.items" :key="item.id" class="px-3 py-1.5">
                      <div class="text-sm text-slate-800">{{ item.label }}</div>
                      <div v-if="item.comment" class="text-xs text-slate-400 italic ml-2">{{ item.comment }}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <label class="form-label">Additional note <span class="normal-case font-normal text-slate-400">(optional, shown before the closing)</span></label>
                <Textarea v-model="extraNote" class="w-full" rows="2" autoResize placeholder="Any extra context for this letter..." />
              </div>

              <div>
                <label class="form-label">Closing paragraph</label>
                <Textarea v-model="closing" class="w-full" rows="3" autoResize />
              </div>
            </template>
          </div>
        </TabPanel>
      </TabPanels>
    </Tabs>

    <template #footer>
      <Button label="Cancel" text @click="$emit('update:visible', false)" />
      <Button
        v-if="activeTab === '0'"
        label="Draft letter"
        icon="pi pi-arrow-right"
        :disabled="!selectedCount"
        @click="goToPreview"
      />
      <template v-else>
        <Button label="Regenerate draft" icon="pi pi-refresh" text :loading="drafting" @click="runDraft" />
        <Button label="Generate PDF" icon="pi pi-file-pdf" :loading="generating" :disabled="drafting" @click="onGenerate" />
      </template>
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { addDoc, serverTimestamp } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'

import Dialog from 'primevue/dialog'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'
import ProgressSpinner from 'primevue/progressspinner'

import { auth } from '../../firebase/config'
import { opsCollection } from '../../firebase/collections.js'
import { draftPendingLetter, generatePendingLetterPDF } from '../../utils/api.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  school: { type: Object, required: true },
  operations: { type: Object, default: null },
})
const emit = defineEmits(['update:visible', 'generated'])
const toast = useToast()

// Client-side mirror of the Cloud Function's own fallback prose (functions/
// generate_pending_letter/main.py) — belt-and-braces for the rare case the
// draft HTTP call itself fails outright (network/server error), since the
// function's OWN fallback only covers the LLM call failing, not the request
// never landing at all. Either way "Draft letter" must always produce
// something editable (task requirement).
const DEFAULT_INTRO = (schoolName) =>
  `We hope this note finds you well. As we continue working together on ${schoolName}'s ` +
  "Holistic Progress Cards, we wanted to share a quick update on a few items that are still pending from your end."
const DEFAULT_CLOSING =
  "We'd be grateful if these could be shared with us at the earliest so we can stay on track with the delivery " +
  "timeline. Please don't hesitate to reach out if you have any questions — thank you for your continued support and partnership."

// ── Scope: pending items grouped by phase, sourced from the Operations tab
// (Phase 1 Onboarding / Phase 2 Setup / Phase 3 Digital Print incl. UDISE +
// Affiliation / per-term groups / Final Term) — a deep-cloned, ephemeral
// working copy so dialog edits never touch the live operations doc. ────────
function buildGroups(ops) {
  if (!ops) return []
  const groups = []
  const pushGroup = (title, items) => {
    const pending = (items || [])
      .filter(i => !i.done)
      .map(i => ({ id: i.id, label: i.label, checked: true, comment: i.comment || '' }))
    if (pending.length) groups.push({ title, items: pending })
  }

  pushGroup('Phase 1 · Onboarding', ops.phase1)
  pushGroup('Phase 2 · Setup', ops.phase2)

  const phase3Pseudo = []
  if (!(ops.udise_number || '').trim()) phase3Pseudo.push({ id: 'udise', label: 'UDISE Number', checked: true, comment: '' })
  if (!(ops.affiliation_number || '').trim()) phase3Pseudo.push({ id: 'affiliation', label: 'Affiliation Number', checked: true, comment: '' })
  if (phase3Pseudo.length) groups.push({ title: 'Phase 3 · Digital Print', items: phase3Pseudo })

  for (const t of ops.terms || []) {
    pushGroup(t.name || `Term ${t.term_number}`, t.items)
  }
  pushGroup('Final Term', ops.final_term)
  return groups
}

// No draft persistence in v2 — closing the dialog discards everything below
// (task explicitly scopes this to dialog-only state). If wanted later, the
// slot-in point is here: hydrate these refs from a Firestore doc keyed on
// school_id instead of always resetting to blank on open, and add a debounced
// watcher that saves them back as the user types.
const groups = ref([])
const activeTab = ref('0')
const intro = ref('')
const closing = ref('')
const extraNote = ref('')
const draftedIntro = ref('')
const draftedClosing = ref('')
const drafting = ref(false)
const generating = ref(false)
const draftError = ref('')

watch(() => props.visible, (v) => {
  if (!v) return
  groups.value = buildGroups(props.operations)
  activeTab.value = '0'
  intro.value = ''
  closing.value = ''
  extraNote.value = ''
  draftedIntro.value = ''
  draftedClosing.value = ''
  draftError.value = ''
})

function isGroupFullyChecked(group) {
  return group.items.every(i => i.checked)
}
function toggleGroup(group, value) {
  group.items.forEach(i => { i.checked = value })
}

const selectedCount = computed(() => groups.value.reduce((n, g) => n + g.items.filter(i => i.checked).length, 0))
const groupsWithSelection = computed(() => groups.value
  .map(g => ({ title: g.title, items: g.items.filter(i => i.checked) }))
  .filter(g => g.items.length))

async function runDraft() {
  drafting.value = true
  draftError.value = ''
  try {
    const result = await draftPendingLetter({
      schoolName: props.school.name,
      contactName: props.school.contact_person || '',
      contactDesignation: props.school.contact_designation || '',
    })
    intro.value = result.intro
    closing.value = result.closing
  } catch (e) {
    console.error(e)
    intro.value = DEFAULT_INTRO(props.school.name)
    closing.value = DEFAULT_CLOSING
    draftError.value = 'Could not reach the drafting service — loaded a default template instead. You can still edit and generate.'
  } finally {
    draftedIntro.value = intro.value
    draftedClosing.value = closing.value
    drafting.value = false
  }
}

function goToPreview() {
  activeTab.value = '1'
  runDraft()
}

async function onGenerate() {
  if (!selectedCount.value) {
    toast.add({ severity: 'warn', summary: 'Nothing selected', detail: 'Select at least one pending item first', life: 3000 })
    return
  }
  generating.value = true
  try {
    const selectedItems = []
    const selectedPhases = []
    for (const g of groups.value) {
      const checkedItems = g.items.filter(i => i.checked)
      if (checkedItems.length) selectedPhases.push(g.title)
      checkedItems.forEach(i => selectedItems.push({ section: g.title, label: i.label, comment: i.comment || '' }))
    }

    await generatePendingLetterPDF({
      schoolName: props.school.name,
      contactName: props.school.contact_person || '',
      contactDesignation: props.school.contact_designation || '',
      date: new Date().toLocaleDateString('en-GB'),
      intro: intro.value,
      closing: closing.value,
      extraNote: extraNote.value,
      items: selectedItems,
    })

    const textEdited = intro.value !== draftedIntro.value || closing.value !== draftedClosing.value
    await addDoc(opsCollection('pending_letters'), {
      school_id: props.school.id,
      school_name: props.school.name,
      item_count: selectedItems.length,
      selected_phases: selectedPhases,
      text_edited: textEdited,
      generated_by: auth.currentUser?.email || 'unknown',
      generated_at: serverTimestamp(),
    })

    toast.add({
      severity: 'success', summary: 'Downloaded',
      detail: `Pending items letter generated (${selectedItems.length} item${selectedItems.length !== 1 ? 's' : ''})`,
      life: 3000,
    })
    emit('generated', { itemCount: selectedItems.length })
    emit('update:visible', false)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Generation failed', detail: e.message || 'Could not generate pending letter', life: 4000 })
  } finally {
    generating.value = false
  }
}
</script>

<style scoped>
.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
