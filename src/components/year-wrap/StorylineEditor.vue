<template>
  <div class="flex flex-col gap-3">
    <div v-if="storyline.warnings?.length" class="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
      <div class="font-semibold mb-1"><i class="pi pi-exclamation-triangle text-xs mr-1"></i>Filled in or skipped automatically</div>
      <ul class="list-disc pl-4 space-y-0.5">
        <li v-for="(w, i) in storyline.warnings" :key="i">{{ w }}</li>
      </ul>
    </div>

    <div v-for="(scene, si) in storyline.scenes" :key="si" class="border border-slate-200 rounded-lg bg-white">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
        <span class="text-xs font-bold text-slate-400 w-5">{{ si + 1 }}</span>
        <span class="text-sm font-semibold text-slate-800 truncate">{{ sceneTitle(scene) }}</span>
        <span v-if="scene.mode" class="px-2 py-0.5 rounded-full text-[11px] font-semibold"
          :class="scene.mode === 'changed' ? 'bg-violet-50 text-violet-700' : 'bg-sky-50 text-sky-700'">
          {{ scene.mode === 'changed' ? 'changed during the year' : 'same all year' }}
        </span>
        <span v-if="scene.fallback" class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700">fallback</span>
        <span class="ml-auto text-xs text-slate-400">{{ (scene.durationInFrames / 30).toFixed(1) }}s</span>
        <Button v-if="removable(scene)" icon="pi pi-trash" text rounded size="small" severity="secondary"
          v-tooltip.left="'Remove this scene'" @click="removeScene(si)" />
      </div>
      <div class="p-3 grid gap-2">
        <div v-for="f in fieldsOf(scene)" :key="f.path.join('.')" class="flex items-center gap-2">
          <label class="text-xs text-slate-500 w-36 shrink-0">{{ f.label }}</label>
          <InputText :modelValue="f.value" class="flex-1 !text-sm !py-1.5"
            :class="f.key === 'emoji' ? '!w-20 !flex-none' : ''"
            @update:modelValue="(v) => setField(si, f.path, v)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * Every line of a storyline as plain text fields. Edits are emitted as a new
 * storyline object; nothing structural (scene types, timing) is editable,
 * only the words, emojis and which optional scenes appear.
 */
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'

const props = defineProps({ storyline: { type: Object, required: true } })
const emit = defineEmits(['update:storyline'])

const LABELS = {
  kicker: 'Heading', title: 'Title', line: 'Line', startLine: 'Start-of-year line', endLine: 'End-of-year line',
  name: 'Name', next: 'Next-year line', label: 'Label', quote: 'Quote', schoolName: 'School', classLabel: 'Class',
  academicYear: 'Year', text: 'Text', emoji: 'Emoji',
  start: 'Start answer', end: 'End answer', answer: 'Answer', goal: 'Goal', was: 'Earlier goal', why: 'Why',
  items: 'Item', steps: 'Step',
}
const SKIP = new Set(['type', 'role', 'mode', 'durationInFrames', 'raw', 'fallback'])
const TYPE_TITLES = {
  intro: 'Intro', evolution: 'Start vs end of year', single: 'Statement', list: 'List', goal: 'Goal',
  pair: 'Two answers', favourites: 'Favourite things', quote: 'Quote', funFact: 'Fun fact', outro: 'Outro',
}

const sceneTitle = (s) => `${TYPE_TITLES[s.type] || s.type}${s.kicker ? ` · ${s.kicker}` : ''}`
const removable = (s) => s.type !== 'intro' && s.type !== 'outro' && props.storyline.scenes.length > 2

function fieldsOf(scene) {
  const out = []
  const walk = (obj, path, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (SKIP.has(k) || v === null || v === undefined) continue
      const p = [...path, k]
      if (typeof v === 'string') {
        out.push({ path: p, key: k, value: v, label: prefix ? `${prefix} · ${LABELS[k] || k}` : (LABELS[k] || k) })
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => walk(item, [...p, i], `${LABELS[k] || k} ${i + 1}`))
      } else if (typeof v === 'object') {
        walk(v, p, prefix ? `${prefix} · ${LABELS[k] || k}` : (LABELS[k] || k))
      }
    }
  }
  walk(scene, [], '')
  return out
}

function setField(si, path, value) {
  const next = JSON.parse(JSON.stringify(props.storyline))
  let obj = next.scenes[si]
  for (const k of path.slice(0, -1)) obj = obj[k]
  obj[path.at(-1)] = value
  emit('update:storyline', next)
}

function removeScene(si) {
  const next = JSON.parse(JSON.stringify(props.storyline))
  next.scenes.splice(si, 1)
  next.durationInFrames = next.scenes.reduce((n, s) => n + s.durationInFrames, 0)
  emit('update:storyline', next)
}
</script>
