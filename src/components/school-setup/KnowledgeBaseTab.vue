<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="text-sm font-bold text-slate-900">Education Knowledge Base</div>
        <div class="text-xs text-slate-400 mt-0.5">
          What the system knows about subjects, co-scholastic areas, grades and sections. Shared by School Setup and every import, for every school.
        </div>
      </div>
      <div class="flex gap-2">
        <Button label="Migrate import aliases" icon="pi pi-arrow-right-arrow-left" size="small" outlined @click="openMigration" />
        <Button label="Reload" icon="pi pi-refresh" text size="small" @click="reload" />
      </div>
    </div>

    <!-- ── Try it ───────────────────────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Classify a value</div>
      <div class="max-w-md">
        <KbClassifiedInput
          v-model="probe"
          context="a manual check in the School Setup knowledge base"
          placeholder="Type anything — Eng, Jr KG, Rose, Moral Science…"
        />
      </div>
      <p class="text-xs text-slate-400 mt-2">
        Anything you confirm here is remembered permanently and applies to every school's imports from then on.
      </p>
    </div>

    <!-- ── Seeded knowledge ─────────────────────────────────────────────── -->
    <div class="grid grid-cols-2 gap-4 mb-4">
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Seeded ({{ seededTotal }})</div>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between"><span class="text-slate-500">Scholastic subjects</span><span class="font-semibold text-slate-800">{{ subjects.length }}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Co-scholastic areas</span><span class="font-semibold text-slate-800">{{ coscholastic.length }}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Grades</span><span class="font-semibold text-slate-800">{{ grades.length }}</span></div>
          <div class="flex justify-between"><span class="text-slate-500">Section names</span><span class="font-semibold text-slate-800">{{ sectionNames.length }}</span></div>
        </div>
        <p class="text-xs text-slate-400 mt-3">
          Seeded knowledge lives in code (<span class="font-mono">education_kb.json</span>) and is edited by hand — the same file the import Cloud Function reads.
        </p>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Learned ({{ learnedCount }})</div>
        <p v-if="!entries.length" class="text-sm text-slate-400 py-4 text-center">
          Nothing learned yet. Values the seeded knowledge doesn't recognize get classified once, confirmed by you, and remembered here.
        </p>
        <div v-else class="max-h-48 overflow-auto space-y-1">
          <div v-for="e in entries" :key="e.id" class="flex items-center gap-2 text-sm py-0.5">
            <span class="font-medium text-slate-700">{{ e.original || e.value }}</span>
            <span class="px-1.5 py-0.5 rounded text-[11px] font-semibold" :class="typeChipClass(e.type)">{{ typeLabel(e.type) }}</span>
            <span v-if="e.canonical" class="text-xs text-slate-400">→ {{ e.canonical }}</span>
            <Button icon="pi pi-times" text rounded size="small" severity="danger" class="ml-auto"
              v-tooltip="'Forget this — it will be asked about again'" @click="forget(e)" />
          </div>
        </div>
      </div>
    </div>

    <!-- ── Browse seeded vocabulary ─────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div class="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
        <div class="text-sm font-bold text-slate-900">Vocabulary</div>
        <div class="flex gap-1 ml-2">
          <button
            v-for="t in browseTabs" :key="t.key"
            class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
            :class="browse === t.key ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'"
            @click="browse = t.key"
          >{{ t.label }}</button>
        </div>
      </div>
      <DataTable :value="browseRows" size="small" stripedRows :paginator="browseRows.length > 25" :rows="25">
        <Column field="canonical" header="Canonical" style="width:220px">
          <template #body="{ data }"><span class="font-medium text-slate-800">{{ data.canonical }}</span></template>
        </Column>
        <Column header="Also recognized as">
          <template #body="{ data }">
            <span class="text-xs text-slate-500">{{ data.aliases.join(', ') || '—' }}</span>
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- ── Migration dialog ─────────────────────────────────────────────── -->
    <Dialog v-model:visible="migrationVisible" header="Migrate Import Aliases" modal :style="{ width: '600px' }">
      <div v-if="migrationLoading" class="flex items-center justify-center py-10"><ProgressSpinner style="width:28px;height:28px" /></div>
      <div v-else-if="migration" class="space-y-3">
        <p class="text-sm text-slate-600">
          Import aliases record <b>spelling</b> ("eng" → the school's "English"). The knowledge base records <b>meaning</b>.
          An alias can be migrated when its target is something the knowledge base recognizes.
        </p>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <div class="bg-green-50 text-green-700 rounded-lg px-3 py-2">{{ migration.planned.length }} can be migrated</div>
          <div class="bg-slate-50 text-slate-500 rounded-lg px-3 py-2">{{ migration.skipped.length }} skipped</div>
        </div>
        <div v-if="migration.planned.length" class="max-h-48 overflow-auto border border-slate-200 rounded-lg p-2 space-y-1">
          <div v-for="p in migration.planned" :key="p.value" class="text-xs text-slate-600">
            <span class="font-medium">{{ p.original }}</span> → {{ p.canonical }}
            <span class="text-slate-400">· {{ typeLabel(p.type) }}</span>
          </div>
        </div>
        <details v-if="migration.skipped.length" class="text-xs">
          <summary class="cursor-pointer text-slate-500">Why {{ migration.skipped.length }} were skipped</summary>
          <div class="mt-1 max-h-32 overflow-auto space-y-0.5">
            <div v-for="(s, i) in migration.skipped" :key="i" class="text-slate-400">
              <span class="font-medium text-slate-500">{{ s.from }}</span> — {{ s.reason }}
            </div>
          </div>
        </details>
        <p class="text-xs text-slate-400">
          Existing knowledge-base entries are never overwritten, and this is safe to run more than once.
        </p>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="migrationVisible = false" />
        <Button label="Migrate" :loading="migrating" :disabled="!migration?.planned.length" @click="runMigration" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import KbClassifiedInput from '../shared/KbClassifiedInput.vue'
import { useEducationKB } from '../../composables/useEducationKB.js'
import {
  listSubjects, listCoScholastic, listGrades, listSectionNames, aliasesFor,
  TYPE_LABELS, SUBJECT, COSCHOLASTIC, GRADE, SECTION,
} from '../../utils/educationKB.js'

const toast = useToast()
const {
  entries, learnedCount, loadKB, forgetClassification, migrateImportAliases,
} = useEducationKB()

const probe = ref('')
const browse = ref(SUBJECT)

const subjects = computed(() => listSubjects())
const coscholastic = computed(() => listCoScholastic())
const grades = computed(() => listGrades())
const sectionNames = computed(() => listSectionNames())
const seededTotal = computed(() =>
  subjects.value.length + coscholastic.value.length + grades.value.length + sectionNames.value.length)

const browseTabs = [
  { key: SUBJECT, label: 'Subjects' },
  { key: COSCHOLASTIC, label: 'Co-Scholastic' },
  { key: GRADE, label: 'Grades' },
  { key: SECTION, label: 'Sections' },
]

const browseRows = computed(() => {
  if (browse.value === SECTION) {
    // Sections are open-ended vocabularies rather than canonical+aliases, so
    // they're listed by family instead.
    return listSectionNames().map(n => ({ canonical: n, aliases: [] }))
  }
  const list = browse.value === SUBJECT ? subjects.value
    : browse.value === COSCHOLASTIC ? coscholastic.value : grades.value
  return list.map(c => ({ canonical: c, aliases: aliasesFor(c, browse.value) }))
})

function typeLabel(t) { return TYPE_LABELS[t] || t }
function typeChipClass(t) {
  return {
    [SUBJECT]: 'bg-blue-50 text-blue-700',
    [COSCHOLASTIC]: 'bg-violet-100 text-violet-700',
    [GRADE]: 'bg-emerald-50 text-emerald-700',
    [SECTION]: 'bg-amber-50 text-amber-700',
  }[t] || 'bg-slate-100 text-slate-600'
}

async function reload() { await loadKB(true) }

async function forget(entry) {
  try {
    await forgetClassification(entry.value || entry.id)
    toast.add({ severity: 'info', summary: 'Forgotten', detail: `“${entry.original || entry.value}” will be asked about again`, life: 2500 })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not forget', detail: e.message, life: 4000 })
  }
}

// ── import_aliases → kb_entries migration ───────────────────────────────────
const migrationVisible = ref(false)
const migrationLoading = ref(false)
const migrating = ref(false)
const migration = ref(null)

async function openMigration() {
  migrationVisible.value = true
  migrationLoading.value = true
  migration.value = null
  try {
    migration.value = await migrateImportAliases({ dryRun: true })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not read aliases', detail: e.message, life: 4000 })
    migrationVisible.value = false
  } finally {
    migrationLoading.value = false
  }
}

async function runMigration() {
  migrating.value = true
  try {
    const r = await migrateImportAliases({ dryRun: false })
    toast.add({ severity: 'success', summary: 'Migrated', detail: `${r.planned.length} alias(es) added to the knowledge base`, life: 3000 })
    migrationVisible.value = false
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Migration failed', detail: e.message, life: 4000 })
  } finally {
    migrating.value = false
  }
}

onMounted(loadKB)
</script>
