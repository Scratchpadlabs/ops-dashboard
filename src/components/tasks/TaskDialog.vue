<template>
  <Dialog
    :visible="visible"
    @update:visible="v => emit('update:visible', v)"
    modal
    :style="{ width: '580px' }"
    :header="isEdit ? 'Edit Task' : 'New Task'"
  >
    <div class="space-y-4 pt-2">
      <div>
        <label class="form-label">Title *</label>
        <InputText v-model="form.title" class="w-full" placeholder="e.g. Follow up with Greenwood School" />
      </div>

      <div>
        <label class="form-label">Description</label>
        <Textarea v-model="form.description" class="w-full" rows="3" autoResize placeholder="Add more detail..." />
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="form-label">Status</label>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="s in STATUSES" :key="s.value" type="button"
              @click="form.status = s.value"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all"
              :class="form.status === s.value ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            >{{ s.label }}</button>
          </div>
        </div>
        <div>
          <label class="form-label">Priority</label>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="p in PRIORITIES" :key="p.value" type="button"
              @click="form.priority = p.value"
              class="px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5"
              :class="form.priority === p.value ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            >
              <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="priorityDotClass(p.value)"></span>
              {{ p.label }}
            </button>
          </div>
        </div>
      </div>

      <div>
        <label class="form-label">Assignee</label>
        <div class="flex flex-wrap gap-1.5">
          <button
            type="button" @click="form.assignee = null"
            class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all"
            :class="!form.assignee ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
          >Unassigned</button>
          <button
            v-for="a in ASSIGNEES" :key="a" type="button"
            @click="form.assignee = a"
            class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all flex items-center gap-1.5"
            :class="form.assignee === a ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
          >
            <span class="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0" :class="assigneeChipClass(a)">{{ a[0] }}</span>
            {{ a }}
          </button>
        </div>
      </div>

      <div>
        <label class="form-label">Due Date</label>
        <DatePicker v-model="form.dueDateObj" class="w-full" dateFormat="d M yy" showIcon showButtonBar placeholder="No due date" />
      </div>

      <div>
        <label class="form-label">Tags</label>
        <div v-if="form.tags.length" class="flex flex-wrap gap-1.5 mb-2">
          <span
            v-for="(t, i) in form.tags" :key="t"
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600"
          >
            {{ t }}
            <button type="button" @click="form.tags.splice(i, 1)" class="text-slate-400 hover:text-red-500">
              <i class="pi pi-times text-[9px]"></i>
            </button>
          </span>
        </div>
        <InputText v-model="tagInput" class="w-full text-sm" placeholder="Type a tag and press Enter" @keyup.enter="addTag()" />
        <div v-if="tagSuggestions.length" class="flex flex-wrap gap-1.5 mt-1.5">
          <button
            v-for="t in tagSuggestions" :key="t" type="button"
            @click="addTag(t)"
            class="px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors"
          >+ {{ t }}</button>
        </div>
      </div>

      <div>
        <label class="form-label">Links</label>
        <div v-if="form.links.length" class="space-y-2 mb-2">
          <div v-for="(link, i) in form.links" :key="i" class="flex gap-2 items-center">
            <InputText v-model="link.label" placeholder="Label" class="text-sm" style="width: 35%" />
            <InputText v-model="link.url" placeholder="https://..." class="text-sm flex-1" />
            <Button icon="pi pi-times" text rounded size="small" @click="form.links.splice(i, 1)" />
          </div>
        </div>
        <Button label="+ Add Link" text size="small" @click="form.links.push({ label: '', url: '' })" />
      </div>

      <div>
        <label class="form-label">School</label>
        <SchoolSearchSelect v-model="form.school_name" :schools="allSchools" placeholder="Link to a school (optional)" @select="onSchoolSelect" />
      </div>

      <!-- Comments (edit mode only) -->
      <div v-if="isEdit">
        <label class="form-label">Comments</label>
        <div v-if="!form.comments.length" class="text-xs text-slate-300 py-1">No comments yet</div>
        <div v-else class="space-y-2 mb-2 max-h-40 overflow-y-auto">
          <div v-for="c in form.comments" :key="c.id" class="bg-slate-50 rounded-lg p-2.5">
            <div class="flex items-center justify-between mb-0.5">
              <span class="text-xs font-semibold text-slate-700">{{ c.by }}</span>
              <span class="text-[10px] text-slate-400">{{ commentTime(c.at) }}</span>
            </div>
            <p class="text-sm text-slate-700 leading-snug">{{ c.text }}</p>
          </div>
        </div>
        <div class="flex gap-2">
          <InputText v-model="newComment" class="flex-1 text-sm" placeholder="Add a comment..." @keyup.enter="addComment" />
          <Button icon="pi pi-send" size="small" :loading="commentSaving" :disabled="!newComment.trim()" @click="addComment" />
        </div>
      </div>

      <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
    </div>

    <template #footer>
      <div class="flex items-center justify-between w-full">
        <Button v-if="isEdit" label="Delete" text severity="danger" @click="confirmDelete" />
        <div v-else></div>
        <div class="flex gap-2">
          <Button label="Cancel" text @click="close" />
          <Button :label="isEdit ? 'Save' : 'Create Task'" :loading="saving" @click="save" />
        </div>
      </div>
    </template>
  </Dialog>
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { auth } from '../../firebase/config'
import { opsCollection, opsDoc } from '../../firebase/collections.js'
import { addDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useCelebration } from '../../composables/useCelebration'
import {
  STATUSES, PRIORITIES, ASSIGNEES,
  priorityDotClass, assigneeChipClass, displayNameFromEmail, timeAgo,
} from '../../composables/useTasks.js'
import SchoolSearchSelect from '../shared/SchoolSearchSelect.vue'

import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import DatePicker from 'primevue/datepicker'

const props = defineProps({
  visible: { type: Boolean, default: false },
  task: { type: Object, default: null },
  existingTags: { type: Array, default: () => [] },
  allSchools: { type: Array, default: () => [] },
  presetSchool: { type: Object, default: null },
})
const emit = defineEmits(['update:visible', 'saved', 'deleted'])

const confirm = useConfirm()
const toast = useToast()
const { celebrate } = useCelebration()

const isEdit = computed(() => !!(props.task && props.task.id))

function blankForm() {
  return {
    title: '', description: '', status: 'todo', priority: 'medium', assignee: null,
    tags: [], links: [], school_id: null, school_name: '', dueDateObj: null, comments: [],
  }
}

const form = reactive(blankForm())
const tagInput = ref('')
const newComment = ref('')
const formError = ref('')
const saving = ref(false)
const commentSaving = ref(false)

watch(() => props.visible, (v) => {
  if (!v) return
  formError.value = ''
  tagInput.value = ''
  newComment.value = ''
  if (props.task) {
    Object.assign(form, {
      title: props.task.title || '',
      description: props.task.description || '',
      status: props.task.status || 'todo',
      priority: props.task.priority || 'medium',
      assignee: props.task.assignee || null,
      tags: [...(props.task.tags || [])],
      links: (props.task.links || []).map(l => ({ ...l })),
      school_id: props.task.school_id || null,
      school_name: props.task.school_name || '',
      dueDateObj: props.task.due_date ? new Date(props.task.due_date + 'T00:00:00') : null,
      comments: [...(props.task.comments || [])],
    })
  } else {
    Object.assign(form, blankForm())
    if (props.presetSchool) {
      form.school_id = props.presetSchool.id
      form.school_name = props.presetSchool.name
    }
  }
})

const tagSuggestions = computed(() => {
  const q = tagInput.value.trim().toLowerCase()
  return props.existingTags
    .filter(t => !form.tags.includes(t))
    .filter(t => !q || t.toLowerCase().includes(q))
    .slice(0, 8)
})

function addTag(tagArg) {
  const t = (typeof tagArg === 'string' ? tagArg : tagInput.value).trim()
  tagInput.value = ''
  if (!t || form.tags.includes(t)) return
  form.tags.push(t)
}

function onSchoolSelect(s) {
  form.school_id = s.id || null
  form.school_name = s.name
}

function commentTime(at) {
  const d = at ? new Date(at) : null
  return d ? timeAgo(d) : ''
}

async function addComment() {
  const text = newComment.value.trim()
  if (!text || !props.task?.id) return
  const comment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    text,
    by: displayNameFromEmail(auth.currentUser?.email),
    at: new Date().toISOString(),
  }
  const updated = [...form.comments, comment]
  commentSaving.value = true
  try {
    await updateDoc(opsDoc('tasks', props.task.id), {
      comments: updated,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    form.comments = updated
    newComment.value = ''
    emit('saved')
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not add comment', life: 3000 })
  } finally {
    commentSaving.value = false
  }
}

function formatISODate(d) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function close() {
  emit('update:visible', false)
}

async function save() {
  if (!form.title.trim()) { formError.value = 'Title is required'; return }
  formError.value = ''
  saving.value = true
  try {
    const wasNotDone = !props.task || props.task.status !== 'done'
    const becomingDone = form.status === 'done'
    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      status: form.status,
      priority: form.priority,
      assignee: form.assignee || null,
      tags: form.tags,
      links: form.links.filter(l => l.label.trim() || l.url.trim()).map(l => ({ label: l.label.trim(), url: l.url.trim() })),
      school_id: form.school_id || null,
      school_name: form.school_name?.trim() || null,
      due_date: form.dueDateObj ? formatISODate(form.dueDateObj) : null,
      comments: form.comments,
      completed_at: becomingDone ? (wasNotDone ? serverTimestamp() : (props.task?.completed_at ?? serverTimestamp())) : null,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    }

    if (isEdit.value) {
      await updateDoc(opsDoc('tasks', props.task.id), payload)
    } else {
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      await addDoc(opsCollection('tasks'), payload)
    }

    if (becomingDone && wasNotDone) celebrate('Task crushed ✅', '✅', 'task')
    toast.add({ severity: 'success', summary: isEdit.value ? 'Task updated' : 'Task created', life: 2000 })
    emit('saved')
    close()
  } catch (e) {
    formError.value = 'Could not save. Try again.'
  } finally {
    saving.value = false
  }
}

function confirmDelete() {
  confirm.require({
    message: `Delete task "${form.title}"?`,
    header: 'Delete Task',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Delete', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('tasks', props.task.id))
        toast.add({ severity: 'info', summary: 'Task deleted', life: 2000 })
        emit('deleted')
        close()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    }
  })
}
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500;
  color: #64748b; margin-bottom: 4px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
</style>
