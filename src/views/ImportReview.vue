<template>
  <!-- ── Step-up reauth gate ──────────────────────────────────────────────── -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">Import writes into School Setup's data — re-enter your password to proceed.</p>

      <Password v-model="password" class="w-full" input-class="w-full" placeholder="Password" :feedback="false" toggleMask @keyup.enter="submitReauth" />
      <div v-if="reauthError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ reauthError }}</div>
      <Button label="Continue" class="w-full mt-4" :loading="reauthing" @click="submitReauth" />
    </div>
  </div>

  <!-- ── Page shell ───────────────────────────────────────────────────────── -->
  <div v-else @click.capture="markActivity" @keydown.capture="markActivity" @mousemove="throttledActivity">
    <div class="flex items-center gap-3 mb-4">
      <Button icon="pi pi-arrow-left" text rounded @click="router.push({ name: 'import' })" />
      <div>
        <div class="text-sm font-bold text-slate-900">{{ schoolName }} · <span class="capitalize">{{ job?.entity }}</span></div>
        <div class="text-xs text-slate-400">{{ job?.created_by }} · {{ formatTs(job?.created_at) }}</div>
      </div>
      <span v-if="job" class="px-2.5 py-1 rounded-full text-xs font-semibold ml-1" :class="statusClass(job.status)">{{ job.status }}</span>
    </div>

    <div v-if="!job" class="flex items-center justify-center py-20"><ProgressSpinner style="width:28px;height:28px" /></div>

    <div v-else-if="job.status === 'processing'" class="bg-white rounded-xl border border-slate-200 p-10 text-center">
      <ProgressSpinner style="width:32px;height:32px" />
      <div class="text-sm text-slate-500 mt-3">Extracting from {{ (job.source_files || []).length }} file(s)… this can take a few minutes for large PDFs.</div>
    </div>

    <div v-else-if="job.status === 'failed'" class="bg-white rounded-xl border border-red-200 p-6">
      <div class="text-sm font-bold text-red-600 mb-1"><i class="pi pi-times-circle mr-1"></i>Extraction failed</div>
      <div class="text-sm text-slate-600">{{ job.error }}</div>
    </div>

    <!-- Extraction completed but produced 0 usable rows — never "ready" with
         an empty table; always a distinct error state with the detected
         file type(s) and a named reason per file. -->
    <div v-else-if="job.status === 'error'" class="bg-white rounded-xl border border-orange-200 p-6">
      <div class="text-sm font-bold text-orange-600 mb-3"><i class="pi pi-exclamation-triangle mr-1"></i>0 usable rows extracted</div>
      <div v-if="(job.file_summaries || []).length" class="space-y-3">
        <div v-for="fs in job.file_summaries" :key="fs.name" class="border border-slate-100 rounded-lg p-3">
          <div class="flex items-center gap-2 text-sm">
            <span class="font-semibold text-slate-800 truncate">{{ fs.name }}</span>
            <span class="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">{{ fs.file_type_detected || 'unknown' }}</span>
            <span class="text-xs text-slate-400">{{ fs.row_count }} rows · {{ fs.warning_count }} warnings · {{ fs.error_count }} errors</span>
          </div>
          <div v-if="(fs.sheets_skipped || []).length" class="mt-2 space-y-0.5">
            <div v-for="s in fs.sheets_skipped" :key="s.name" class="text-xs text-slate-500">
              <span class="font-medium">{{ s.name }}:</span> {{ s.reason }}
            </div>
          </div>
        </div>
      </div>
      <div v-if="(job.parse_errors || []).length" class="mt-3 pt-3 border-t border-slate-100 space-y-1">
        <div v-for="(e, i) in job.parse_errors" :key="i" class="text-xs text-slate-600">
          <span v-if="e.file" class="font-medium">{{ e.file }}<span v-if="e.sheet">/{{ e.sheet }}</span>:</span> {{ e.message }}
        </div>
      </div>
    </div>

    <div v-else>
      <!-- ── Summary ──────────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div class="flex items-center gap-6 flex-wrap">
          <div><span class="text-lg font-bold text-slate-900">{{ rows.length }}</span> <span class="text-xs text-slate-400">rows</span></div>
          <div><span class="text-lg font-bold" :class="flaggedCount ? 'text-amber-600' : 'text-slate-900'">{{ flaggedCount }}</span> <span class="text-xs text-slate-400">flagged</span></div>
          <div><span class="text-lg font-bold" :class="autoFixedCount ? 'text-blue-600' : 'text-slate-900'">{{ autoFixedCount }}</span> <span class="text-xs text-slate-400">auto-fixed</span></div>
          <div><span class="text-lg font-bold" :class="suggestionsPendingCount ? 'text-amber-600' : 'text-slate-900'">{{ suggestionsPendingCount }}</span> <span class="text-xs text-slate-400">suggestions pending</span></div>
          <div><span class="text-lg font-bold text-slate-900">{{ excludedCount }}</span> <span class="text-xs text-slate-400">excluded</span></div>
          <div v-if="job.entity === 'students'" class="flex-1 flex flex-wrap gap-1.5">
            <span v-for="(count, cls) in perClassCounts" :key="cls" class="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">{{ cls }}: {{ count }}</span>
          </div>
          <div class="ml-auto flex gap-2">
            <Button
              v-if="hiddenColumnCount > 0 || showAllColumns"
              :label="showAllColumns ? 'Show key columns' : `Show all columns (+${hiddenColumnCount})`"
              :icon="showAllColumns ? 'pi pi-compress' : 'pi pi-expand'"
              size="small" outlined @click="showAllColumns = !showAllColumns"
            />
            <Button label="Download error report" icon="pi pi-download" size="small" outlined :disabled="!hasReportableIssues" @click="downloadErrorReport" />
            <Button label="Source Files" icon="pi pi-file" size="small" outlined @click="sourceFilesVisible = true" />
          </div>
        </div>
        <!-- Nothing the file carried may disappear without being named. Two
             separate cases, deliberately distinguished: a column the parser
             could not map to any field at all, and a column it mapped fine but
             the student schema has no home for. Both used to vanish silently. -->
        <div v-if="(job.unmapped_headers || []).length || reviewOnlyPresent.length"
             class="mt-3 border-t border-slate-100 pt-3">
          <div class="text-xs font-semibold text-slate-600 mb-1.5">Columns not written to the student record</div>
          <div v-if="(job.unmapped_headers || []).length" class="mb-1.5">
            <div class="text-[11px] text-slate-500 mb-1">Not recognized — no field matches this header:</div>
            <div class="flex flex-wrap gap-1">
              <span v-for="h in job.unmapped_headers" :key="h"
                class="px-2 py-0.5 rounded bg-red-50 border border-red-100 text-[11px] font-mono text-red-700">{{ h }}</span>
            </div>
          </div>
          <div v-if="reviewOnlyPresent.length">
            <div class="text-[11px] text-slate-500 mb-1">Read and shown below, but the student schema has no field for them:</div>
            <div class="flex flex-wrap gap-1">
              <span v-for="c in reviewOnlyPresent" :key="c"
                class="px-2 py-0.5 rounded bg-amber-50 border border-amber-100 text-[11px] font-mono text-amber-800">{{ colLabel(c) }}</span>
            </div>
          </div>
          <p class="text-[11px] text-slate-400 mt-1.5">
            Adding a field for any of these is a schema decision — say so and it gets added deliberately, not guessed.
          </p>
        </div>
        <div v-if="(job.class_level_flags || []).length" class="mt-3 border-t border-slate-100 pt-3">
          <div class="text-xs font-semibold text-amber-600 mb-1">Class-level flags</div>
          <div v-for="(f, i) in job.class_level_flags" :key="i" class="text-xs text-slate-500">{{ f }}</div>
        </div>
        <!-- Per-file summary chips: parsed N rows, W warnings, E errors, S sheets skipped -->
        <div v-if="(job.file_summaries || []).length" class="mt-3 border-t border-slate-100 pt-3 flex flex-wrap gap-2">
          <div v-for="fs in job.file_summaries" :key="fs.name"
               class="px-2.5 py-1 rounded-lg text-xs bg-slate-50 text-slate-600 flex items-center gap-1.5"
               v-tooltip="(fs.sheets_skipped || []).map(s => `${s.name}: ${s.reason}`).join('\n') || undefined">
            <i class="pi pi-file text-slate-400"></i>
            <span class="font-medium truncate max-w-[160px]">{{ fs.name }}</span>
            <span v-if="fs.file_type_detected" class="text-slate-400">{{ fs.file_type_detected }}</span>
            <span>·</span><span>{{ fs.row_count }} parsed</span>
            <span v-if="fs.warning_count" class="text-amber-600">· {{ fs.warning_count }} warnings</span>
            <span v-if="fs.error_count" class="text-red-500">· {{ fs.error_count }} errors</span>
            <span v-if="(fs.sheets_skipped || []).length" class="text-orange-600">· {{ fs.sheets_skipped.length }} sheets skipped</span>
          </div>
        </div>
      </div>

      <!-- ── Rows table ───────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
        <DataTable
          :value="tableRows"
          editMode="cell"
          size="small"
          stripedRows
          :rowClass="rowClass"
          v-model:expandedRows="expandedRows"
          dataKey="_id"
          :paginator="tableRows.length > 100"
          :rows="100"
          @cell-edit-init="editingCell = true"
          @cell-edit-complete="onCellEditComplete"
          @cell-edit-cancel="editingCell = false"
        >
          <Column expander style="width:3rem" />
          <Column style="width:3rem">
            <template #body="{ data }">
              <Checkbox :modelValue="!data._excluded" binary @update:modelValue="v => onToggleExclude(data, v)" />
            </template>
          </Column>
          <Column v-for="col in columns" :key="col" :field="col" :header="colLabel(col)" style="min-width:96px; max-width:180px">
            <template #body="{ data, field }">
              <ImportFieldResolver
                v-if="isResolverField(field) && (fieldFlag(data, field) || fieldSuggestion(data, field))"
                :model-value="data[field]"
                :flag="fieldFlag(data, field)"
                :suggestion="fieldSuggestion(data, field)"
                :options="resolverOptions(data, field)"
                :match-count="pendingMatchCount(data, field)"
                :kb-hint="kbHint(data, field)"
                @resolve="v => onResolve(data, field, v)"
                @resolve-all="v => onResolveAll(data, field, v)"
              />
              <div v-else class="flex items-center gap-1 min-w-0">
                <span class="cell-truncate" :title="data[field]">{{ data[field] }}</span>
                <i v-if="fieldFix(data, field)" class="pi pi-check-circle text-blue-500 text-xs flex-shrink-0"
                  v-tooltip="fixTooltip(data, field)"></i>
              </div>
            </template>
            <template #editor="{ data, field }"><InputText v-model="data[field]" class="w-full" size="small" /></template>
          </Column>
          <Column header="" style="width:40px">
            <template #body="{ data }"><i v-if="(data._flags || []).length" class="pi pi-exclamation-triangle text-amber-500" v-tooltip="`${data._flags.length} flag(s)`"></i></template>
          </Column>
          <template #expansion="{ data }">
            <div class="px-4 py-2 bg-slate-50 text-xs text-slate-600">
              <div v-if="!(data._flags || []).length" class="text-slate-400">No flags</div>
              <div v-for="(f, i) in data._flags" :key="i" class="flex items-center gap-1.5 py-0.5">
                <i class="pi pi-exclamation-triangle text-amber-500 text-xs"></i>
                <span v-if="f.field" class="font-semibold">{{ colLabel(f.field) }}:</span>{{ f.message }}
              </div>
            </div>
          </template>
        </DataTable>
        <div v-if="!tableRows.length" class="text-center text-sm text-slate-400 py-10">No rows staged</div>
      </div>

      <!-- ── Commit ───────────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div v-if="job.entity === 'assessments'" class="mb-3">
          <label class="form-label">Term (assessments commit into a term) *</label>
          <Select v-model="selectedTermId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-80" />
        </div>
        <div v-if="job.status === 'committed'" class="text-sm text-green-600">
          <i class="pi pi-check-circle mr-1"></i>Committed {{ formatTs(job.committed_at) }} by {{ job.committed_by }} —
          <router-link to="/school-setup" class="underline">view in School Setup</router-link>
        </div>
        <div v-else class="flex items-center gap-3">
          <Button
            label="Commit to School Setup"
            icon="pi pi-check"
            :loading="committing"
            :disabled="editingCell || !rows.length"
            @click="openCommitConfirm"
          />
          <span v-if="editingCell" class="text-xs text-slate-400">Finish editing the row before committing</span>
        </div>
      </div>
    </div>

    <!-- ── Source files drawer ──────────────────────────────────────────── -->
    <Dialog v-model:visible="sourceFilesVisible" header="Source Files" modal :style="{ width: '640px' }">
      <div class="space-y-3">
        <div v-for="(url, path) in sourceUrls" :key="path" class="border border-slate-200 rounded-lg p-3">
          <div class="text-xs text-slate-500 mb-2 truncate">{{ path }}</div>
          <embed v-if="isPdf(path) && url" :src="url" type="application/pdf" style="width:100%;height:400px" />
          <img v-else-if="isImage(path) && url" :src="url" class="max-w-full max-h-96 rounded" />
          <a v-else-if="url" :href="url" target="_blank" class="text-sm text-violet-600 underline">Download</a>
          <ProgressSpinner v-else style="width:20px;height:20px" />
        </div>
      </div>
    </Dialog>

    <!-- ── Commit confirm ───────────────────────────────────────────────── -->
    <Dialog v-model:visible="commitConfirmVisible" header="Commit to School Setup" modal :style="{ width: '520px' }">
      <div v-if="plan" class="space-y-3">
        <p class="text-sm text-slate-600">Writing to <span class="font-semibold">{{ schoolName }}</span>'s live <span class="capitalize">{{ job.entity }}</span> data:</p>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <div class="bg-green-50 text-green-700 rounded-lg px-3 py-2">{{ plan.summary.create }} new</div>
          <div class="bg-amber-50 text-amber-700 rounded-lg px-3 py-2">{{ plan.summary.changed }} changed</div>
          <div class="bg-slate-50 text-slate-500 rounded-lg px-3 py-2">{{ plan.summary.unchanged }} unchanged</div>
          <div class="bg-blue-50 text-blue-700 rounded-lg px-3 py-2">{{ plan.summary.autoFixed }} auto-fixed</div>
        </div>
        <div v-if="plan.summary.suggestionsPending" class="bg-amber-50 text-amber-700 rounded-lg px-3 py-2 text-sm">
          <i class="pi pi-exclamation-triangle mr-1"></i>{{ plan.summary.suggestionsPending }} row(s) have a pending suggestion — resolve them in the table above before committing (they'll be skipped otherwise).
        </div>
        <div v-if="plan.summary.errors" class="bg-red-50 text-red-600 rounded-lg px-3 py-2 text-sm">{{ plan.summary.errors }} skipped (errors)</div>

        <!-- The name split is a guess the file cannot settle (surname-first is
             common in this estate), so it is shown before it is written rather
             than discovered in Firestore afterwards. -->
        <div v-if="nameSplitPreview.length" class="rounded-lg border border-slate-200 px-3 py-2">
          <div class="text-xs font-semibold text-slate-600 mb-1">Name split — firstName / lastName</div>
          <div class="text-[11px] text-slate-500 space-y-0.5 max-h-24 overflow-auto">
            <div v-for="(p, i) in nameSplitPreview" :key="i">
              <span class="font-mono">{{ p.name }}</span>
              <span class="text-slate-400"> → </span>
              <span class="font-mono">{{ p.firstName }}</span> / <span class="font-mono">{{ p.lastName || '(none)' }}</span>
            </div>
          </div>
        </div>

        <!-- Inferred subject assignments are NOT the same as an explicit
             subject list from the file, and must not read as one: a school
             with subject specialists (common Grade VI up) has to spot and
             correct these. -->
        <div v-if="inferredSubjectRows.length" class="rounded-lg bg-violet-50 border border-violet-100 px-3 py-2">
          <div class="text-xs font-semibold text-violet-800 mb-1">
            <i class="pi pi-info-circle mr-1"></i>
            {{ inferredSubjectRows.length }} teacher row(s): subjects inferred from class assignment — verify
          </div>
          <p class="text-[11px] text-violet-700 mb-1">
            These rows had no subject in the file. Each is being given every subject configured for its
            grade. Correct them in Classes &amp; Teachers if the school uses subject specialists.
          </p>
          <div class="text-[11px] text-violet-700 space-y-0.5 max-h-24 overflow-auto">
            <div v-for="(r, i) in inferredSubjectRows.slice(0, 20)" :key="i">
              <span class="font-mono">{{ r.classId }}</span> — {{ r.name }}
              <span class="text-violet-500">({{ r.count }} subject(s))</span>
            </div>
          </div>
        </div>

        <div v-if="noSubjectRows.length" class="rounded-lg bg-red-50 border border-red-100 px-3 py-2">
          <div class="text-xs font-semibold text-red-700 mb-1">
            {{ noSubjectRows.length }} teacher row(s) still have no subjects
          </div>
          <p class="text-[11px] text-red-600">
            Their grade has nothing configured in the Subjects tab yet, so there was nothing to infer.
            They commit with class-level access only; assign subjects manually afterwards.
          </p>
        </div>

        <div v-if="planNotes.length" class="rounded-lg bg-amber-50 px-3 py-2">
          <div class="text-xs font-semibold text-amber-800 mb-1">{{ planNotes.length }} row(s) with notes</div>
          <div class="text-[11px] text-amber-700 space-y-0.5 max-h-24 overflow-auto">
            <div v-for="(n, i) in planNotes" :key="i">{{ n }}</div>
          </div>
        </div>
        <div v-if="plan.summary.changed" class="flex items-center gap-2 pt-1">
          <Checkbox v-model="overwriteExisting" binary inputId="overwrite" />
          <label for="overwrite" class="text-sm text-slate-600">Overwrite the {{ plan.summary.changed }} changed record(s) with the imported values</label>
        </div>
        <p v-else class="text-xs text-slate-400">No existing records would change — only new ones are written.</p>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="commitConfirmVisible = false" />
        <Button label="Confirm Commit" :loading="committing" @click="confirmCommit" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getDocs, getDoc, query, orderBy } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL } from 'firebase/storage'
import { useToast } from 'primevue/usetoast'
import Papa from 'papaparse'

import Password from 'primevue/password'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { storage } from '../firebase/config'
import { rootSchoolDoc, schoolCollection } from '../firebase/schoolCollections.js'
import {
  listenJob, listenRows, updateRowData, setRowExcluded, buildCommitPlan, commitImport,
  normalizeGrade, canonicalize, resolveFieldValue, resolveFieldValueForAllMatching,
  loadSectionsByGrade, loadSubjectsByGrade,
} from '../composables/useImport.js'
import ImportFieldResolver from '../components/shared/ImportFieldResolver.vue'
import { useEducationKB } from '../composables/useEducationKB.js'
import { TYPE_LABELS, SUBJECT, SECTION, UNKNOWN } from '../utils/educationKB.js'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const jobId = computed(() => route.params.jobId)

const { isElevated, markActivity, reauthenticate } = useStepUpAuth()
const password = ref('')
const reauthing = ref(false)
const reauthError = ref('')

async function submitReauth() {
  if (!password.value) { reauthError.value = 'Enter your password'; return }
  reauthError.value = ''
  reauthing.value = true
  try {
    await reauthenticate(password.value)
    password.value = ''
  } catch (e) {
    reauthError.value = e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
      ? 'Incorrect password'
      : (e.message || 'Could not verify your password')
  } finally {
    reauthing.value = false
  }
}
let lastMove = 0
function throttledActivity() {
  const now = Date.now()
  if (now - lastMove < 5000) return
  lastMove = now
  markActivity()
}

const COLUMNS = {
  students: ['grade', 'section', 'roll_no', 'student_name', 'gender', 'dob', 'sr_no', 'adm_no',
             'gr_emis_sts', 'aadhaar', 'mother_name', 'father_name', 'contact', 'email', 'city',
             'father_mobile', 'father_email', 'mother_mobile', 'mother_email', 'branch_name',
             'board', 'enrollment_code', 'date_of_admission', 'status', 'using_transport'],
  teachers: ['teacher_name', 'email', 'class_teacher_of', 'subject', 'grade', 'section'],
  subjects: ['stream', 'grade_band', 'subject', 'area'],
  assessments: ['stream', 'grade_band', 'assessment', 'date_start', 'date_end', 'instructional_days', 'syllabus_covered', 'exam_syllabus', 'max_written', 'activity_weight', 'total', 'duration'],
}
/**
 * The columns worth seeing at a glance. Students parse 13 fields, which at
 * 130px each is ~1.8x a 1366px laptop's content width — so the default view
 * shows what a reviewer actually scans (who, which class, the fields most
 * often wrong) and everything else is one toggle away. Nothing is dropped
 * from the data, only from the default view.
 */
const ESSENTIAL_COLUMNS = {
  students: ['grade', 'section', 'roll_no', 'student_name', 'gender', 'dob', 'contact'],
  teachers: ['teacher_name', 'email', 'subject', 'grade', 'section'],
  subjects: ['grade_band', 'subject', 'area'],
  assessments: ['grade_band', 'assessment', 'date_start', 'date_end', 'max_written', 'total'],
}

const LABELS = { roll_no: 'Roll No', student_name: 'Name', dob: 'DOB', sr_no: 'Sr No', adm_no: 'Adm No',
  gr_emis_sts: 'GR/EMIS/STS', aadhaar: 'Aadhaar', father_mobile: 'Father Mobile', father_email: 'Father Email',
  mother_mobile: 'Mother Mobile', mother_email: 'Mother Email', branch_name: 'Branch', board: 'Board',
  enrollment_code: 'Enrollment Code', date_of_admission: 'Date of Admission', using_transport: 'Transport',
  mother_name: 'Mother', father_name: 'Father', teacher_name: 'Teacher', class_teacher_of: 'Class Teacher Of', grade_band: 'Grade Band', date_start: 'Start', date_end: 'End', instructional_days: 'Inst. Days', syllabus_covered: 'Syllabus Covered', exam_syllabus: 'Exam Syllabus', max_written: 'Max Written', activity_weight: 'Activity Wt', total: 'Total', duration: 'Duration' }
function colLabel(c) { return LABELS[c] || c.charAt(0).toUpperCase() + c.slice(1) }

// Only section (students, teachers) and subject (teachers) go through
// canonicalize/alias/fuzzy matching server-side — see functions/
// generate_import/main.py's clean_students_rows/clean_teachers_rows. Every
// other field only ever gets a plain auto-fix (name/email/grade), never a
// suggestion, so only these two need the resolver dropdown.
function isResolverField(field) { return field === 'section' || field === 'subject' }

const job = ref(null)
const rows = ref([])
const schoolName = ref('')
let unsubJob = null, unsubRows = null

// A fixed list silently swallowed any column the parser learned to read but
// this file had not been told about — the bug where uploading a 24-column
// roster showed 13 columns and the rest vanished. The declared order below is
// preserved for readability, then ANY other key present on a row is appended,
// so a newly mapped field appears in Review without a second edit here.
const allColumns = computed(() => {
  const declared = COLUMNS[job.value?.entity] || []
  const seen = new Set(declared)
  const extra = []
  for (const r of rows.value) {
    for (const k of Object.keys(r.data || {})) {
      if (!seen.has(k)) { seen.add(k); extra.push(k) }
    }
  }
  return [...declared, ...extra]
})
const showAllColumns = ref(false)
// Columns carrying a flag or a pending suggestion are always shown, whatever
// the toggle says — hiding the column a reviewer needs to act on would make
// the compact view actively harmful rather than merely terse.
const flaggedColumns = computed(() => {
  const set = new Set()
  for (const r of rows.value) {
    ;(r.flags || []).forEach(f => f.field && set.add(f.field))
    ;(r.suggestions || []).forEach(sg => sg.field && set.add(sg.field))
  }
  return set
})
const columns = computed(() => {
  if (showAllColumns.value) return allColumns.value
  const essential = new Set(ESSENTIAL_COLUMNS[job.value?.entity] || allColumns.value)
  return allColumns.value.filter(c => essential.has(c) || flaggedColumns.value.has(c))
})
const hiddenColumnCount = computed(() => allColumns.value.length - columns.value.length)
// Review-only fields that ACTUALLY have a value somewhere in this job. Listing
// the whole static set would cry wolf on files that never carried them.
const reviewOnlyPresent = computed(() => {
  const declared = job.value?.review_only_fields || []
  return declared.filter(f => rows.value.some(r => String(r.data?.[f] ?? '').trim()))
})

const tableRows = computed(() => rows.value.map(r => ({
  _id: r.id, _flags: r.flags || [], _fixes: r.fixes || [], _suggestions: r.suggestions || [],
  _excluded: !!r.excluded, ...r.data,
})))
const flaggedCount = computed(() => rows.value.filter(r => (r.flags || []).length).length)
const hasReportableIssues = computed(() =>
  !!flaggedCount.value || !!(job.value?.parse_errors || []).length || !!(job.value?.parse_warnings || []).length)
const autoFixedCount = computed(() => rows.value.filter(r => (r.fixes || []).length).length)
const suggestionsPendingCount = computed(() => rows.value.filter(r => (r.suggestions || []).length).length)
const excludedCount = computed(() => rows.value.filter(r => r.excluded).length)
const expandedRows = ref({})
const editingCell = ref(false)

const perClassCounts = computed(() => {
  const out = {}
  for (const r of rows.value) {
    if (r.excluded) continue
    const key = `${r.data.grade || '?'}${r.data.section ? ' ' + r.data.section : ''}`
    out[key] = (out[key] || 0) + 1
  }
  return out
})

function rowClass(data) {
  return (data._flags || []).length ? 'bg-amber-50/60' : ''
}

// ── Fixes / flags / suggestions per field ───────────────────────────────────
function fieldFix(data, field) { return (data._fixes || []).find(f => f.field === field) }
function fieldFlag(data, field) { return (data._flags || []).find(f => f.field === field) }
function fieldSuggestion(data, field) { return (data._suggestions || []).find(s => s.field === field) }
function fixTooltip(data, field) {
  const f = fieldFix(data, field)
  return f ? `${f.original || '(empty)'} → ${f.fixed}` : ''
}

const sectionsByGrade = ref(new Map())
const subjectsByGrade = ref(new Map())
async function loadResolverOptions() {
  if (!job.value?.school_id) return
  sectionsByGrade.value = await loadSectionsByGrade(job.value.school_id)
  if (job.value.entity === 'teachers') subjectsByGrade.value = await loadSubjectsByGrade(job.value.school_id)
}
function resolverOptions(data, field) {
  const grade = normalizeGrade(data.grade)
  if (field === 'section') return sectionsByGrade.value.get(grade) || []
  if (field === 'subject') return subjectsByGrade.value.get(grade) || []
  return []
}

// Count of OTHER rows (excluding this one) with the identical unresolved
// value for this field — surfaced as "Apply to N other rows" in the resolver.
function pendingMatchCount(data, field) {
  const raw = fieldSuggestion(data, field)?.original ?? data[field]
  const canon = canonicalize(raw)
  if (!canon) return 0
  return rows.value.filter(r => {
    if (r.id === data._id) return false
    const sugg = (r.suggestions || []).find(s => s.field === field)
    if (sugg) return canonicalize(sugg.original) === canon
    return canonicalize(r.data[field]) === canon && (r.flags || []).some(f => f.field === field)
  }).length
}
function aliasTypeFor(field) { return field === 'section' ? 'class' : 'subject' }

// ── Education knowledge base ────────────────────────────────────────────────
// The same shared KB the Cloud Function's cleaning stage uses (its seed file
// IS this module's seed file), so review shows the same understanding the
// parser had. Purely advisory here: it explains an unresolved value, it
// never picks one — resolving stays Sid's call.
const { loadKB, classify: classifyKb } = useEducationKB()

function kbHint(data, field) {
  const raw = fieldSuggestion(data, field)?.original ?? data[field]
  if (!raw) return null
  const r = classifyKb(raw, field === 'section' ? SECTION : SUBJECT)
  if (r.type === UNKNOWN || !r.canonical) return null
  // Nothing to add when the KB just echoes what's already in the cell.
  if (r.canonical === String(raw).trim()) return null
  return { canonical: r.canonical, typeLabel: TYPE_LABELS[r.type] || r.type }
}

async function onResolve(data, field, value) {
  const raw = rows.value.find(r => r.id === data._id)
  if (!raw) return
  try {
    await resolveFieldValue(jobId.value, raw, field, value, aliasTypeFor(field))
    toast.add({ severity: 'success', summary: 'Resolved', life: 2000 })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not resolve', detail: e.message, life: 4000 })
  }
}
async function onResolveAll(data, field, value) {
  const raw = fieldSuggestion(data, field)?.original ?? data[field]
  try {
    const n = await resolveFieldValueForAllMatching(jobId.value, rows.value, field, raw, value, aliasTypeFor(field))
    toast.add({ severity: 'success', summary: 'Resolved', detail: `Applied to ${n} row(s)`, life: 2500 })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not resolve', detail: e.message, life: 4000 })
  }
}

async function onCellEditComplete(event) {
  const { data, newValue, field } = event
  data[field] = newValue
  // Writes every parsed column, not just the visible ones — the column
  // toggle is a view concern and must never truncate the staged row.
  const payload = {}
  allColumns.value.forEach(c => { payload[c] = data[c] })
  try {
    await updateRowData(jobId.value, data._id, payload)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not save edit', detail: e.message, life: 3000 })
  }
}

async function onToggleExclude(data, included) {
  try {
    await setRowExcluded(jobId.value, data._id, !included)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not update', detail: e.message, life: 3000 })
  }
}

function statusClass(status) {
  return {
    processing: 'bg-amber-50 text-amber-700', ready: 'bg-blue-50 text-blue-700',
    committed: 'bg-green-50 text-green-700', error: 'bg-orange-50 text-orange-700',
    failed: 'bg-red-50 text-red-700',
  }[status] || 'bg-slate-100 text-slate-600'
}
function formatTs(ts) {
  if (!ts?.toDate) return ''
  return ts.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ── Error report CSV — file, sheet, row, field, severity, problem, action
// taken. One row per flag, so the same staged row can appear more than once
// if it has multiple problems, PLUS one row per file/sheet-level issue that
// never became a staged row at all (empty file, no recognizable header,
// password-protected...) sourced from job.parse_errors/parse_warnings.
// Sent back to the school to fix at source when a fix/suggestion isn't
// available in-app. ──────────────────────────────────────────────────────
const ID_FIELD_BY_ENTITY = { students: 'student_name', teachers: 'teacher_name', subjects: 'subject', assessments: 'assessment' }
function actionTakenFor(r, field) {
  const fix = (r.fixes || []).find(f => f.field === field)
  if (fix) return `auto-fixed: '${fix.original || ''}' -> '${fix.fixed}'`
  const sugg = (r.suggestions || []).find(s => s.field === field)
  if (sugg) return `suggestion pending: '${sugg.suggested}'`
  if (r.excluded) return 'excluded'
  return 'kept — flagged for review'
}
function downloadErrorReport() {
  const idField = ID_FIELD_BY_ENTITY[job.value?.entity] || ''
  const csvRows = []
  rows.value.forEach(r => {
    (r.flags || []).forEach(f => {
      csvRows.push({
        file: r.source_file || '',
        sheet: r.source_sheet || '',
        row: r.source_row ?? r.id,
        [idField || 'identifier']: r.data[idField] || '',
        field: f.field || '',
        severity: f.severity || 'warning',
        problem: f.message,
        action_taken: actionTakenFor(r, f.field),
      })
    })
  })
  // File/sheet-level issues with no row of their own (never staged) —
  // row-scoped ones are already covered above via r.flags.
  const jobLevel = [...(job.value?.parse_errors || []), ...(job.value?.parse_warnings || [])]
    .filter(e => e.row == null)
  jobLevel.forEach(e => {
    csvRows.push({
      file: e.file || '', sheet: e.sheet || '', row: '',
      [idField || 'identifier']: '', field: e.field || '',
      severity: e.severity || 'warning', problem: e.message,
      action_taken: 'file/sheet skipped',
    })
  })
  if (!csvRows.length) {
    toast.add({ severity: 'info', summary: 'Nothing to export', detail: 'No flagged rows in this job', life: 2500 })
    return
  }
  const csv = Papa.unparse(csvRows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `import-errors-${(job.value?.school_id || 'school')}-${jobId.value}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── Source file viewer ─────────────────────────────────────────────────────
const sourceFilesVisible = ref(false)
const sourceUrls = ref({})
function isPdf(path) { return path.toLowerCase().endsWith('.pdf') }
function isImage(path) { return /\.(png|jpe?g|webp)$/i.test(path) }
watch(sourceFilesVisible, async (visible) => {
  if (!visible || !job.value) return
  for (const path of job.value.source_files || []) {
    if (sourceUrls.value[path]) continue
    try {
      const url = await getDownloadURL(storageRef(storage, path))
      sourceUrls.value = { ...sourceUrls.value, [path]: url }
    } catch (e) {
      console.error('Could not resolve source file URL', path, e)
    }
  }
})

// ── Commit ───────────────────────────────────────────────────────────────
const terms = ref([])
const selectedTermId = ref(null)
const plan = ref(null)

// Surfaced in the commit dialog: the derived name split and any per-row notes
// (dropped source columns, unreadable dates) that buildStudentsPlan attached.
const nameSplitPreview = computed(() => (plan.value?.items || [])
  .filter(i => i.derived && i.payload?.name)
  .slice(0, 25)
  .map(i => ({ name: i.payload.name, firstName: i.derived.firstName, lastName: i.derived.lastName })))

const inferredSubjectRows = computed(() => (plan.value?.items || [])
  .filter(i => i.subjectsInferred)
  .map(i => ({
    classId: i.classId,
    name: i.staffBase?.name || i.row?.data?.teacher_name || '(unnamed)',
    count: (i.subjectIds || []).length,
  })))

// Rows that ended up with no subjects at all — the grade has none configured,
// so the default had nothing to offer. Reported separately from the inferred
// ones because the fix is different: configure the grade's subjects first.
const noSubjectRows = computed(() => (plan.value?.items || [])
  .filter(i => i.status !== 'ERROR' && i.status !== 'SUGGESTION_PENDING'
    && i.classId && !(i.subjectIds || []).length))

const planNotes = computed(() => {
  const seen = new Map()
  for (const i of plan.value?.items || []) {
    for (const n of i.notes || []) seen.set(n, (seen.get(n) || 0) + 1)
  }
  return Array.from(seen.entries()).map(([note, count]) => count > 1 ? `${note} (${count} rows)` : note)
})

const commitConfirmVisible = ref(false)
const committing = ref(false)
const overwriteExisting = ref(false)

async function loadTerms() {
  if (job.value?.entity !== 'assessments' || !job.value?.school_id) return
  const snap = await getDocs(query(schoolCollection(job.value.school_id, 'terms'), orderBy('name')))
  terms.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

async function openCommitConfirm() {
  if (job.value.entity === 'assessments' && !selectedTermId.value) {
    toast.add({ severity: 'warn', summary: 'Select a Term first', life: 2500 })
    return
  }
  try {
    plan.value = await buildCommitPlan(job.value, rows.value, { termId: selectedTermId.value })
    overwriteExisting.value = false
    commitConfirmVisible.value = true
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not build commit plan', detail: e.message, life: 4000 })
  }
}

async function confirmCommit() {
  committing.value = true
  try {
    const result = await commitImport(job.value, plan.value, { overwriteExisting: overwriteExisting.value })
    commitConfirmVisible.value = false
    toast.add({ severity: 'success', summary: 'Committed', detail: `${result.written} record(s) written`, life: 3000 })
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Commit failed', detail: e.message, life: 4000 })
  } finally {
    committing.value = false
  }
}

onMounted(() => {
  unsubJob = listenJob(jobId.value, async (j) => {
    const isFirstLoad = !job.value
    job.value = j
    if (j?.school_id && !schoolName.value) {
      const snap = await getDoc(rootSchoolDoc(j.school_id))
      schoolName.value = snap.exists() ? (snap.data().name || j.school_id) : j.school_id
    }
    await loadTerms()
    if (isFirstLoad) await loadResolverOptions()
  })
  unsubRows = listenRows(jobId.value, (list) => { rows.value = list })
  loadKB()
})
onUnmounted(() => { unsubJob?.(); unsubRows?.() })
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
