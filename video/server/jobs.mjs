/**
 * The render queue. One video at a time per instance — a render already uses
 * every core — with each student's state in
 * schools/{schoolId}/year_wrap_videos/{studentId}, which is what the
 * dashboard polls:
 *
 *   queued → rendering (progress 0..1) → done (videoUrl, thumbUrl) | failed (error)
 *
 * The queue is in memory. If the instance dies, its queued docs stay
 * "queued"; the dashboard shows them as stale after STALE_MS and lets ops
 * re-render, which simply re-queues.
 */
import { VIDEOS, checkId, checkStoryline } from './data.mjs'

export const STALE_MS = 30 * 60 * 1000

/**
 * deps: { db, now(), render(storyline, onProgress) → {video, thumb} (local paths),
 *         upload(storagePath, localPath, contentType) → url, cleanup?(renderOutput) }
 */
export function createQueue(deps) {
  const pending = []
  let running = null

  const ref = (schoolId, studentId) => deps.db.collection('schools').doc(schoolId).collection(VIDEOS).doc(studentId)

  async function enqueue({ schoolId, academicYear, items, email }) {
    if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Nothing to render'), { status: 400 })
    if (items.length > 300) throw Object.assign(new Error('At most 300 videos per request'), { status: 400 })
    const jobs = items.map(({ studentId, storyline }) => {
      checkId(studentId, 'studentId')
      return { schoolId, academicYear: academicYear || storyline?.academicYear || '', studentId, storyline: checkStoryline(storyline) }
    })
    const batch = deps.db.batch()
    for (const j of jobs) {
      // Drop any older queued copy of the same student so a re-click doesn't render twice.
      const dup = pending.findIndex((p) => p.schoolId === j.schoolId && p.studentId === j.studentId)
      if (dup >= 0) pending.splice(dup, 1)
      batch.set(ref(j.schoolId, j.studentId), {
        status: 'queued', progress: 0, error: null, requestedBy: email, queuedAt: deps.now(),
        studentName: j.storyline.student?.name || '', className: j.storyline.student?.className || '',
        segment: j.storyline.segment, warnings: j.storyline.warnings || [],
        renderedStoryline: j.storyline,
      }, { merge: true })
    }
    await batch.commit()
    pending.push(...jobs)
    kick()
    return { queued: jobs.length, ahead: pending.length - jobs.length + (running ? 1 : 0) }
  }

  async function cancel(schoolId) {
    const dropped = []
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].schoolId === schoolId) dropped.push(...pending.splice(i, 1))
    }
    if (dropped.length) {
      const batch = deps.db.batch()
      for (const j of dropped) batch.set(ref(j.schoolId, j.studentId), { status: 'cancelled', progress: 0 }, { merge: true })
      await batch.commit()
    }
    return { cancelled: dropped.length }
  }

  function kick() {
    if (running || !pending.length) return
    running = pending.shift()
    run(running).finally(() => { running = null; kick() })
  }

  async function run(job) {
    const r = ref(job.schoolId, job.studentId)
    let out = null
    try {
      await r.set({ status: 'rendering', progress: 0, startedAt: deps.now() }, { merge: true })
      let last = 0
      out = await deps.render(job.storyline, (p) => {
        if (p - last < 0.1) return // a Firestore write per frame would be thousands
        last = p
        r.set({ progress: Math.round(p * 100) / 100 }, { merge: true }).catch(() => {})
      })
      const base = `year_wrap/${job.schoolId}/${(job.academicYear || 'unknown').replace(/[^\w-]+/g, '-')}/${job.studentId}`
      const [videoUrl, thumbUrl] = await Promise.all([
        deps.upload(`${base}.mp4`, out.video, 'video/mp4'),
        out.thumb ? deps.upload(`${base}.jpg`, out.thumb, 'image/jpeg') : null,
      ])
      await r.set({ status: 'done', progress: 1, videoUrl, thumbUrl, storagePath: `${base}.mp4`, renderedAt: deps.now(), error: null }, { merge: true })
    } catch (e) {
      console.error(`render failed ${job.schoolId}/${job.studentId}`, e)
      await r.set({ status: 'failed', error: String(e?.message || e).slice(0, 500) }, { merge: true }).catch(() => {})
    } finally {
      await deps.cleanup?.(out)
    }
  }

  const state = () => ({ running: running ? `${running.schoolId}/${running.studentId}` : null, pending: pending.length })
  return { enqueue, cancel, state }
}
