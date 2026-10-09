<template>
  <div ref="el" class="w-full rounded-xl overflow-hidden bg-slate-900" style="aspect-ratio: 9 / 16"></div>
</template>

<script setup>
/**
 * Live preview of a storyline: the real video template, played in the
 * browser by Remotion's Player. The template is React, so this mounts a
 * small React root inside the Vue tree — edits in the editor re-render it
 * immediately, frame-for-frame what the render service will produce.
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Player } from '@remotion/player'
import { YearWrap } from '../../../video/src/remotion/YearWrap.jsx'
import prepMusic from '../../../video/public/music/sunny-steps.mp3?url'
import midMusic from '../../../video/public/music/big-sky.mp3?url'

const props = defineProps({ storyline: { type: Object, required: true } })
const el = ref(null)
let root = null

function draw() {
  if (!root || !props.storyline?.scenes?.length) return
  root.render(React.createElement(Player, {
    component: YearWrap,
    inputProps: { storyline: props.storyline, musicSrc: { prep: prepMusic, mid: midMusic } },
    durationInFrames: Math.max(1, props.storyline.durationInFrames),
    compositionWidth: 1080,
    compositionHeight: 1920,
    fps: 30,
    controls: true,
    clickToPlay: true,
    style: { width: '100%', height: '100%' },
  }))
}

onMounted(() => { root = createRoot(el.value); draw() })
onBeforeUnmount(() => { root?.unmount(); root = null })
watch(() => props.storyline, draw, { deep: true })
</script>
