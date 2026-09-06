<template>
  <Teleport to="body">
    <div v-if="isAiAssistantOpen" class="ai-overlay" @click="close">
      <div class="ai-card" @click.stop @keydown.esc="close">
        <div class="ai-header">
          <div class="ai-header-title">
            <i class="pi pi-sparkles"></i>
            <span>AI Assistant</span>
          </div>
          <div class="ai-school-badge" :class="{ 'ai-school-badge--empty': !activeSchoolId }">
            <i class="pi pi-building" style="font-size:10px"></i>
            {{ activeSchoolId ? (activeSchoolName || activeSchoolId) : 'No school selected' }}
          </div>
          <button class="ai-close-btn" @click="close"><i class="pi pi-times"></i></button>
        </div>

        <p class="ai-disclaimer">
          Read-only — it never writes to Firestore. When it drafts something, you'll review
          and save it yourself on the existing page for that config.
        </p>

        <div ref="transcriptEl" class="ai-transcript">
          <div v-if="!messages.length" class="ai-empty">
            Ask about how the dashboard works, this school's config, or say
            "draft an import template for ..." to get a pre-filled form.
          </div>
          <div
            v-for="(m, i) in messages"
            :key="i"
            class="ai-msg"
            :class="m.role === 'user' ? 'ai-msg--user' : 'ai-msg--assistant'"
          >
            <div class="ai-msg-bubble">
              {{ m.content }}
              <div v-if="m.attachmentNames?.length" class="ai-msg-attachments">
                <span v-for="(n, ai) in m.attachmentNames" :key="ai" class="ai-attachment-tag"><i class="pi pi-paperclip"></i>{{ n }}</span>
              </div>
            </div>
            <button
              v-if="m.proposalKind"
              class="ai-apply-btn"
              @click="applyProposal(m)"
            >
              <i class="pi pi-external-link"></i> Open as draft in {{ registryLabel(m.proposalKind) }}
            </button>
          </div>
          <div v-if="loading" class="ai-msg ai-msg--assistant">
            <div class="ai-msg-bubble ai-msg-bubble--loading"><ProgressSpinner style="width:16px;height:16px" /></div>
          </div>
        </div>

        <div v-if="errorText" class="ai-error">{{ errorText }}</div>

        <div v-if="pendingAttachments.length" class="ai-pending-attachments">
          <div v-for="(a, i) in pendingAttachments" :key="i" class="ai-attachment-tag">
            <ProgressSpinner v-if="a.uploading" style="width:10px;height:10px" strokeWidth="8" />
            <i v-else-if="a.error" class="pi pi-exclamation-triangle" style="color:#dc2626"></i>
            <i v-else class="pi pi-paperclip"></i>
            {{ a.name }}
            <button type="button" @click="pendingAttachments.splice(i, 1)"><i class="pi pi-times"></i></button>
          </div>
        </div>

        <div class="ai-input-row">
          <input ref="fileInputEl" type="file" multiple class="hidden" :accept="ATTACHMENT_ACCEPT" @change="onFileSelected" />
          <button type="button" class="ai-attach-btn" :disabled="loading" @click="fileInputEl?.click()" v-tooltip.top="'Attach a file'">
            <i class="pi pi-paperclip"></i>
          </button>
          <input
            ref="inputEl"
            v-model="draft"
            type="text"
            placeholder="Ask a question, or 'draft an import template for ...'"
            class="ai-input"
            :disabled="loading"
            @keydown.enter="send"
          />
          <Button icon="pi pi-send" :loading="loading" :disabled="!draft.trim() || hasUploadingAttachment" @click="send" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ref as storageRef, uploadBytes } from 'firebase/storage'
import Button from 'primevue/button'
import ProgressSpinner from 'primevue/progressspinner'

import { isAiAssistantOpen } from '../composables/useAiAssistant.js'
import { activeSchoolId, activeSchoolName } from '../composables/useActiveSchool.js'
import { setPendingAiDraft } from '../composables/usePendingAiDraft.js'
import { aiAssistantRemote } from '../utils/api.js'
import { storage } from '../firebase/config'

// Same file types Import.vue accepts — this is a throwaway chat attachment,
// not an import job: it uploads straight to Storage (client SDK, gated only
// by the existing storage.rules "any authenticated user" rule) and creates
// NO Firestore doc, unlike Import.vue's uploadAndProcess which also writes a
// staging_imports job doc.
const ATTACHMENT_ACCEPT = '.xlsx,.xlsm,.xls,.csv,.tsv,.txt,.htm,.html,.docx,.pdf,.png,.jpg,.jpeg'

const router = useRouter()

// proposalKind -> where a drafted proposal of that kind gets pre-filled.
// Adding a new kind is an additive row here PLUS a matching onMounted
// pickup in that target view (see usePendingAiDraft.js) — never a new write
// path. Kinds not listed here still get plain-text help from the assistant
// (see functions/ai_assistant/main.py's PROPOSAL_INSTRUCTIONS fallback).
const REGISTRY = {
  import_template: { label: 'Import Templates', route: () => ({ name: 'import-templates' }) },
  subject_draft: { label: 'School Setup → Subjects', route: () => ({ name: 'school-setup', query: { aiDraftTab: 'subjects', aiDraftSchoolId: activeSchoolId.value || '' } }) },
  assessment_bulk: { label: 'School Setup → Assessments', route: () => ({ name: 'school-setup', query: { aiDraftTab: 'assessments', aiDraftSchoolId: activeSchoolId.value || '' } }) },
}

function registryLabel(kind) { return REGISTRY[kind]?.label || kind }

const messages = ref([])
const draft = ref('')
const loading = ref(false)
const errorText = ref('')
const inputEl = ref(null)
const transcriptEl = ref(null)
const fileInputEl = ref(null)

// Each entry: { name, uploading, error, path }. `path` is set once the
// direct-to-Storage upload finishes — that's what gets sent to the callable.
const pendingAttachments = ref([])
const hasUploadingAttachment = computed(() => pendingAttachments.value.some(a => a.uploading))

function close() { isAiAssistantOpen.value = false }

async function uploadAttachment(file) {
  const entry = { name: file.name, uploading: true, error: '', path: '' }
  pendingAttachments.value.push(entry)
  try {
    const randomId = (crypto.randomUUID?.() || String(Date.now() + Math.random())).replace(/-/g, '')
    const path = `ai_assistant_uploads/${activeSchoolId.value || 'none'}/${randomId}/${file.name}`
    await uploadBytes(storageRef(storage, path), file)
    entry.path = path
  } catch (e) {
    console.error('Could not upload attachment', e)
    entry.error = e.message || 'Upload failed'
  } finally {
    entry.uploading = false
  }
}

function onFileSelected(e) {
  Array.from(e.target.files || []).forEach(uploadAttachment)
  e.target.value = ''
}

async function scrollToBottom() {
  await nextTick()
  if (transcriptEl.value) transcriptEl.value.scrollTop = transcriptEl.value.scrollHeight
}

// Only role/content is ever sent to the callable — proposalKind/proposal are
// local UI state on the assistant's own turn, not part of the chat history.
function historyPayload() {
  return messages.value.map(m => ({ role: m.role, content: m.content }))
}

function detectProposalKind(text) {
  const t = text.toLowerCase()
  if (/import template/.test(t)) return 'import_template'
  if (/subject/.test(t) && /(draft|add|create)/.test(t)) return 'subject_draft'
  if (/assessment/.test(t) && /(draft|bulk|create|build)/.test(t)) return 'assessment_bulk'
  return null
}

async function send() {
  const text = draft.value.trim()
  if (!text || loading.value || hasUploadingAttachment.value) return
  draft.value = ''
  const attachments = pendingAttachments.value
    .filter(a => a.path && !a.error)
    .map(a => ({ path: a.path, name: a.name }))
  messages.value.push({ role: 'user', content: text, attachmentNames: attachments.map(a => a.name) })
  pendingAttachments.value = []
  await scrollToBottom()

  loading.value = true
  errorText.value = ''
  try {
    const proposalKind = detectProposalKind(text)
    const res = await aiAssistantRemote({
      schoolId: activeSchoolId.value,
      messages: historyPayload(),
      proposalKind,
      attachments,
    })
    if (res.type === 'proposal') {
      messages.value.push({
        role: 'assistant',
        content: `Drafted a ${registryLabel(res.proposalKind)} entry from our conversation.`,
        proposalKind: res.proposalKind,
        proposal: res.proposal,
      })
    } else {
      messages.value.push({ role: 'assistant', content: res.content })
    }
  } catch (e) {
    console.error(e)
    errorText.value = e.message || 'Something went wrong.'
  } finally {
    loading.value = false
    await scrollToBottom()
  }
}

function applyProposal(m) {
  const entry = REGISTRY[m.proposalKind]
  if (!entry) return
  setPendingAiDraft(m.proposalKind, m.proposal)
  close()
  router.push(entry.route())
}

watch(isAiAssistantOpen, async (val) => {
  if (val) {
    await nextTick()
    inputEl.value?.focus()
  }
})
</script>

<style scoped>
.ai-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  justify-content: flex-end;
  background: rgba(15, 23, 42, 0.35);
}

.ai-card {
  width: 420px;
  max-width: 100vw;
  height: 100vh;
  background: white;
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
}

.ai-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.ai-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}
.ai-school-badge {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: #334155;
  background: #f1f5f9;
  border-radius: 999px;
  padding: 4px 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ai-school-badge--empty { color: #94a3b8; }
.ai-close-btn {
  border: none;
  background: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 4px;
}
.ai-close-btn:hover { color: #334155; }

.ai-disclaimer {
  font-size: 11px;
  color: #94a3b8;
  padding: 8px 16px;
  border-bottom: 1px solid #f1f5f9;
  margin: 0;
  flex-shrink: 0;
}

.ai-transcript {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-empty {
  font-size: 13px;
  color: #94a3b8;
  text-align: center;
  padding: 32px 12px;
}

.ai-msg { display: flex; flex-direction: column; gap: 6px; }
.ai-msg--user { align-items: flex-end; }
.ai-msg--assistant { align-items: flex-start; }

.ai-msg-bubble {
  max-width: 88%;
  font-size: 13px;
  line-height: 1.45;
  padding: 8px 12px;
  border-radius: 12px;
  white-space: pre-wrap;
}
.ai-msg--user .ai-msg-bubble { background: #2563eb; color: white; }
.ai-msg--assistant .ai-msg-bubble { background: #f1f5f9; color: #0f172a; }
.ai-msg-bubble--loading { display: flex; align-items: center; }

.ai-apply-btn {
  font-size: 12px;
  font-weight: 600;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ai-apply-btn:hover { background: #dbeafe; }

.ai-error {
  font-size: 12px;
  color: #b91c1c;
  background: #fef2f2;
  padding: 8px 16px;
  flex-shrink: 0;
}

.ai-input-row {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.ai-input {
  flex: 1;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  outline: none;
}
.ai-input:focus { border-color: #93c5fd; }

.ai-attach-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: white;
  color: #64748b;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ai-attach-btn:hover { border-color: #93c5fd; color: #2563eb; }
.ai-attach-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.ai-pending-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 16px 10px;
}

.ai-attachment-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 500;
  color: #334155;
  background: #f1f5f9;
  border-radius: 999px;
  padding: 4px 8px;
}
.ai-attachment-tag button {
  border: none;
  background: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 0;
  display: flex;
}
.ai-attachment-tag button:hover { color: #dc2626; }

.ai-msg-attachments {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ai-msg--user .ai-msg-attachments .ai-attachment-tag { background: rgba(255,255,255,0.2); color: white; }
</style>
