<template>
  <ConfigEmptyState v-if="!props.schoolId" label="Reset Topic" collection="classes" />
  <div v-else class="space-y-4">
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <h3 class="text-base font-bold text-slate-900">Reset a marked topic</h3>
      <p class="text-sm text-slate-500 mt-1 max-w-2xl">
        Clears a topic back to never-marked: unchecks "complete" on the class, clears who
        initiated its survey, and deletes any survey responses already saved for it. Use this
        when a topic is stuck in a bad state (e.g. the wrong teacher/class got attached to it).
        Nothing is written until you preview and confirm.
      </p>

      <div class="grid grid-cols-3 gap-3 mt-4">
        <div>
          <label class="form-label">Class *</label>
          <Select v-model="selectedClassId" :options="classes" optionLabel="id" optionValue="id"
            placeholder="Select a class" class="w-full" :loading="loadingClasses" filter
            @update:modelValue="onClassChanged" />
        </div>
        <div>
          <label class="form-label">Subject *</label>
          <Select v-model="selectedSubjectId" :options="subjectOptions" optionLabel="subjectId" optionValue="subjectId"
            placeholder="Select a subject" class="w-full" :disabled="!selectedClassId"
            @update:modelValue="onSubjectChanged" />
        </div>
        <div>
          <label class="form-label">Topic *</label>
          <Select v-model="selectedTopicId" :options="topicOptions" optionLabel="topic" optionValue="id"
            placeholder="Select a topic" class="w-full" :disabled="!selectedSubjectId" />
        </div>
      </div>

      <div class="mt-4">
        <Button label="Preview reset" icon="pi pi-eye" size="small"
          :disabled="!selectedTopicId" :loading="previewing" @click="runPreview" />
      </div>
    </div>

    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>

    <div v-if="preview" class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div class="text-sm font-semibold text-slate-800">This will clear:</div>

      <div class="flex items-center gap-2 text-sm">
        <i class="pi" :class="preview.classProgress.willChange ? 'pi-check-circle text-emerald-600' : 'pi-minus-circle text-slate-300'"></i>
        <span class="text-slate-700">
          Class progress — isCompleted/completedAt on
          <span class="font-mono text-xs">{{ selectedClassId }}</span>
          <template v-if="!preview.classProgress.willChange"> (already unmarked)</template>
        </span>
      </div>

      <div class="flex items-center gap-2 text-sm">
        <i class="pi" :class="preview.subjectTopic.found ? 'pi-check-circle text-emerald-600' : 'pi-exclamation-triangle text-amber-500'"></i>
        <span class="text-slate-700">
          <template v-if="preview.subjectTopic.found">
            survey_initiated_by on the subject's topic —
            {{ preview.subjectTopic.teacherCount }} teacher entr{{ preview.subjectTopic.teacherCount === 1 ? 'y' : 'ies' }}
          </template>
          <template v-else>
            Topic id not found on <span class="font-mono text-xs">schools/{{ props.schoolId }}/subjects/{{ selectedSubjectId }}</span>
            — nothing to clear there. This can happen if the subject/class topic ids drifted; the
            class-side reset above will still run.
          </template>
        </span>
      </div>

      <div>
        <div class="flex items-center gap-2 text-sm">
          <i class="pi" :class="preview.responses.length ? 'pi-check-circle text-emerald-600' : 'pi-minus-circle text-slate-300'"></i>
          <span class="text-slate-700">
            {{ preview.responses.length }} saved survey response{{ preview.responses.length === 1 ? '' : 's' }} will be deleted
          </span>
        </div>
        <div v-if="preview.responses.length" class="ml-6 mt-1 space-y-0.5">
          <div v-for="r in preview.responses" :key="r.responseDocId" class="text-xs text-slate-500 font-mono">
            {{ r.teacherId }} — activity {{ r.activityId }}
          </div>
        </div>
      </div>

      <div v-if="!preview.classProgress.willChange && !preview.subjectTopic.found && !preview.responses.length"
           class="text-sm text-slate-400">
        Nothing to reset — this topic is already in a clean state for this class.
      </div>

      <div class="pt-2">
        <Button label="Reset topic" icon="pi pi-trash" severity="danger" size="small"
          :loading="applying"
          :disabled="!preview.classProgress.willChange && !preview.subjectTopic.found && !preview.responses.length"
          @click="confirmApply" />
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * Undo a bad "mark a lesson" — the teacher app (scratchpad_teacher) has no
 * way to unmark a topic once a teacher has initiated its survey, so a topic
 * stuck in a bad state (wrong activity picked, initiated by the wrong
 * teacher/class) has no recourse without this.
 *
 * Reset clears everything tied to one class+subject+topic: the class's own
 * isCompleted/completedAt, the subject doc's survey_initiated_by map for
 * that topic (every teacher's entry, not just one), and every survey
 * response doc that was ever saved for it. Writes go through guardedUpdateDoc
 * so a shape mismatch is surfaced rather than silently accepted, and only
 * the targeted array entry is ever touched — every other topic/subject
 * entry in the same array is passed through unchanged.
 */
import { ref, computed, watch } from 'vue'
import { getDocs, getDoc, query, where, deleteDoc, addDoc, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import Button from 'primevue/button'

import { auth } from '../../firebase/config'
import { schoolCollection, schoolDoc, surveysCollection, surveyResponseDoc, schoolResetsCollection } from '../../firebase/schoolCollections.js'
import { guardedUpdateDoc } from '../../schemas/guardedWrite.js'
import ConfigEmptyState from './ConfigEmptyState.vue'

const props = defineProps({
  schoolId: { type: String, default: null },
})

const confirm = useConfirm()
const toast = useToast()

const classes = ref([])
const loadingClasses = ref(false)
const selectedClassId = ref(null)
const selectedSubjectId = ref(null)
const selectedTopicId = ref(null)

const preview = ref(null)
const previewing = ref(false)
const applying = ref(false)
const error = ref('')

const selectedClass = computed(() => classes.value.find(c => c.id === selectedClassId.value) || null)
const subjectOptions = computed(() => selectedClass.value?.subjects || [])
const selectedSubjectEntry = computed(() =>
  subjectOptions.value.find(s => s.subjectId === selectedSubjectId.value) || null)
const topicOptions = computed(() => selectedSubjectEntry.value?.topics || [])

async function loadClasses(schoolId) {
  loadingClasses.value = true
  selectedClassId.value = null
  selectedSubjectId.value = null
  selectedTopicId.value = null
  preview.value = null
  try {
    const snap = await getDocs(schoolCollection(schoolId, 'classes'))
    classes.value = snap.docs.map(d => ({ ...d.data(), id: d.id }))
  } catch (e) {
    console.error('Could not load classes for Reset Topic', e)
    classes.value = []
  } finally {
    loadingClasses.value = false
  }
}

function onClassChanged() {
  selectedSubjectId.value = null
  selectedTopicId.value = null
  preview.value = null
}
function onSubjectChanged() {
  selectedTopicId.value = null
  preview.value = null
}

async function runPreview() {
  if (!props.schoolId || !selectedClassId.value || !selectedSubjectId.value || !selectedTopicId.value) return
  previewing.value = true
  error.value = ''
  preview.value = null
  try {
    const classSnap = await getDoc(schoolDoc(props.schoolId, 'classes', selectedClassId.value))
    if (!classSnap.exists()) throw new Error('Class no longer exists.')
    const classData = classSnap.data()
    const subjects = Array.isArray(classData.subjects) ? classData.subjects : []
    const subjectEntry = subjects.find(s => s.subjectId === selectedSubjectId.value)
    const topicEntry = subjectEntry?.topics?.find(t => t.id === selectedTopicId.value)
    const classProgress = {
      willChange: !!(topicEntry && (topicEntry.isCompleted || topicEntry.completedAt)),
    }

    const subjectSnap = await getDoc(schoolDoc(props.schoolId, 'subjects', selectedSubjectId.value))
    const subjectTopics = subjectSnap.exists() ? (subjectSnap.data().topics || []) : []
    const subjectTopicEntry = subjectTopics.find(t => t.id === selectedTopicId.value)
    const initiatedBy = subjectTopicEntry?.survey_initiated_by || {}
    const teacherIds = Object.keys(initiatedBy)

    const responses = []
    for (const teacherId of teacherIds) {
      const activityId = initiatedBy[teacherId]
      const surveySnap = await getDocs(query(surveysCollection(props.schoolId), where('id', '==', activityId)))
      if (surveySnap.empty) continue
      const surveyDocId = surveySnap.docs[0].id
      const responseDocId = `${teacherId}_${selectedClassId.value}_${selectedTopicId.value}`
      const responseSnap = await getDoc(surveyResponseDoc(props.schoolId, surveyDocId, responseDocId))
      if (responseSnap.exists()) {
        responses.push({ teacherId, activityId, surveyDocId, responseDocId })
      }
    }

    preview.value = {
      subjectTopic: { found: !!subjectTopicEntry, teacherCount: teacherIds.length },
      classProgress,
      responses,
    }
  } catch (e) {
    error.value = e.message || 'Could not build the preview.'
  } finally {
    previewing.value = false
  }
}

function confirmApply() {
  confirm.require({
    message: `Reset "${selectedTopicId.value}" for class ${selectedClassId.value}? This clears the class's completion state, the subject's survey_initiated_by entries for this topic, and deletes ${preview.value.responses.length} saved response(s). This cannot be undone.`,
    header: 'Reset Topic',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Reset', acceptClass: 'p-button-danger',
    accept: runReset,
  })
}

async function runReset() {
  if (!preview.value) return
  applying.value = true
  error.value = ''
  try {
    // Class: clear isCompleted/completedAt on the one matched topic entry,
    // pass every other subject/topic through untouched.
    if (preview.value.classProgress.willChange) {
      const classSnap = await getDoc(schoolDoc(props.schoolId, 'classes', selectedClassId.value))
      const classData = classSnap.data()
      const updatedSubjects = (classData.subjects || []).map(s => {
        if (s.subjectId !== selectedSubjectId.value) return s
        return {
          ...s,
          topics: (s.topics || []).map(t => t.id === selectedTopicId.value
            ? { ...t, isCompleted: false, completedAt: null }
            : t),
        }
      })
      await guardedUpdateDoc('classes', schoolDoc(props.schoolId, 'classes', selectedClassId.value), { subjects: updatedSubjects })
    }

    // Subject: drop survey_initiated_by entirely off the one matched topic,
    // every other topic entry passed through untouched.
    if (preview.value.subjectTopic.found) {
      const subjectSnap = await getDoc(schoolDoc(props.schoolId, 'subjects', selectedSubjectId.value))
      const subjectData = subjectSnap.data()
      const updatedTopics = (subjectData.topics || []).map(t => {
        if (t.id !== selectedTopicId.value) return t
        const { survey_initiated_by, ...rest } = t
        return rest
      })
      await guardedUpdateDoc('subjects', schoolDoc(props.schoolId, 'subjects', selectedSubjectId.value), { topics: updatedTopics })
    }

    // Responses: delete every response doc the preview found.
    for (const r of preview.value.responses) {
      await deleteDoc(surveyResponseDoc(props.schoolId, r.surveyDocId, r.responseDocId))
    }

    // Audit trail — travels with the school, same as Reset School's run log.
    await addDoc(schoolResetsCollection(props.schoolId), {
      type: 'reset_topic',
      classId: selectedClassId.value,
      subjectId: selectedSubjectId.value,
      topicId: selectedTopicId.value,
      cleared: {
        class_progress: preview.value.classProgress.willChange,
        survey_initiated_by: preview.value.subjectTopic.found,
        response_docs: preview.value.responses.map(r => r.responseDocId),
      },
      created_by: auth.currentUser?.email || 'unknown',
      created_at: serverTimestamp(),
    })

    toast.add({ severity: 'success', summary: 'Topic reset', life: 3000 })
    preview.value = null
    selectedTopicId.value = null
    await loadClasses(props.schoolId)
  } catch (e) {
    error.value = e.userMessage || e.message || 'The reset failed partway through — re-run the preview to see the current state before retrying.'
  } finally {
    applying.value = false
  }
}

// Reload whenever the page-level school selector changes.
watch(() => props.schoolId, (id) => { if (id) loadClasses(id) }, { immediate: true })
</script>
