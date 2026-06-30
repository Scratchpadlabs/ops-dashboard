<template>
  <Teleport to="body">
    <Transition name="celebrate">
      <div v-if="isVisible" class="celebration-overlay" @click="isVisible = false">
        <!-- Confetti canvas -->
        <canvas ref="confettiCanvas" class="confetti-canvas"></canvas>

        <!-- Message card -->
        <div class="celebrate-card" @click.stop>
          <div class="celebrate-emoji">{{ celebrationEmoji }}</div>
          <div class="celebrate-title">Hell yeah!</div>
          <div class="celebrate-msg">{{ celebrationMessage }}</div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { useCelebration } from '../../composables/useCelebration'

const { isVisible, celebrationMessage, celebrationEmoji } = useCelebration()
const confettiCanvas = ref(null)
let animFrame = null
let particles = []

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777']

function createParticles() {
  particles = []
  const count = 120
  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * window.innerWidth,
      y: -10 - Math.random() * 100,
      w: 8 + Math.random() * 8,
      h: 4 + Math.random() * 4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      angle: Math.random() * 360,
      spin: (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 4,
      vy: 3 + Math.random() * 4,
      opacity: 1,
    })
  }
}

function drawConfetti() {
  const canvas = confettiCanvas.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  particles.forEach(p => {
    ctx.save()
    ctx.globalAlpha = p.opacity
    ctx.translate(p.x, p.y)
    ctx.rotate((p.angle * Math.PI) / 180)
    ctx.fillStyle = p.color
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
    ctx.restore()

    p.x += p.vx
    p.y += p.vy
    p.angle += p.spin
    p.vy += 0.08
    if (p.y > window.innerHeight * 0.7) p.opacity -= 0.02
  })

  particles = particles.filter(p => p.opacity > 0)
  if (particles.length > 0) animFrame = requestAnimationFrame(drawConfetti)
}

watch(isVisible, (val) => {
  if (val) {
    setTimeout(() => {
      createParticles()
      drawConfetti()
    }, 50)
  } else {
    cancelAnimationFrame(animFrame)
    particles = []
  }
})

onUnmounted(() => cancelAnimationFrame(animFrame))
</script>

<style scoped>
.celebration-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.35);
  backdrop-filter: blur(2px);
}

.confetti-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.celebrate-card {
  position: relative;
  z-index: 1;
  background: white;
  border-radius: 20px;
  padding: 40px 56px;
  text-align: center;
  box-shadow: 0 25px 60px rgba(0,0,0,0.25);
  animation: pop 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.celebrate-emoji {
  font-size: 56px;
  line-height: 1;
  margin-bottom: 12px;
}

.celebrate-title {
  font-size: 28px;
  font-weight: 700;
  color: #0f172a;
  margin-bottom: 8px;
}

.celebrate-msg {
  font-size: 16px;
  color: #64748b;
  font-weight: 500;
}

@keyframes pop {
  from { transform: scale(0.5); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}

.celebrate-enter-active { transition: opacity 0.2s; }
.celebrate-leave-active { transition: opacity 0.3s; }
.celebrate-enter-from, .celebrate-leave-to { opacity: 0; }
</style>
