/**
 * Smart Remarks run progress — pure helpers for the progress panel.
 *
 * A job doc (schools/{id}/smart_remarks_jobs/{jobId}) counts remarks
 * (ticked student x category) when the deployed function is new enough
 * (totalRemarks/processedRemarks), and only students otherwise — both are
 * handled so the page works against either.
 */

export const RUN_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
}

const FINISHED = new Set([RUN_STATUS.DONE, RUN_STATUS.FAILED, RUN_STATUS.SKIPPED, RUN_STATUS.CANCELLED])
export const isFinished = status => FINISHED.has(status)

const toMillis = ts => (ts && typeof ts.toMillis === 'function' ? ts.toMillis() : (typeof ts === 'number' ? ts : null))

/** { done, total, unit, pct } for one job doc; pct is null while unknown. */
export function jobProgress(job) {
  if (!job) return { done: 0, total: 0, unit: 'remarks', pct: null }
  if (typeof job.totalRemarks === 'number') {
    const total = job.totalRemarks
    const done = Math.min(job.processedRemarks || 0, total)
    return { done, total, unit: 'remarks', pct: total ? Math.round(done / total * 100) : (job.status === 'done' ? 100 : 0) }
  }
  const total = job.totalStudents || 0
  const done = Math.min(job.processedStudents || 0, total)
  return { done, total, unit: 'students', pct: total ? Math.round(done / total * 100) : null }
}

/**
 * Whole-run progress across classes: each class counts equally; a running
 * class contributes its own fraction. Returns 0–100.
 */
export function overallProgress(items) {
  const counted = items.filter(i => i.status !== RUN_STATUS.SKIPPED)
  if (!counted.length) return 0
  let sum = 0
  for (const i of counted) {
    if (isFinished(i.status)) sum += 1
    else if (i.status === RUN_STATUS.RUNNING) sum += (jobProgress(i.job).pct || 0) / 100
  }
  return Math.min(100, Math.round(sum / counted.length * 100))
}

/** Milliseconds left for one job, from its own pace so far; null until measurable. */
export function etaMs(job, nowMs) {
  const started = toMillis(job?.startedAt)
  const { done, total } = jobProgress(job)
  if (started == null || !done || !total || done >= total) return null
  const elapsed = nowMs - started
  if (elapsed <= 0) return null
  return Math.round(elapsed / done * (total - done))
}

export function elapsedMs(item, nowMs) {
  const start = item.startedAtMs
  if (!start) return null
  return (item.finishedAtMs || nowMs) - start
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return ''
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return m ? `${m}m ${String(rest).padStart(2, '0')}s` : `${rest}s`
}

/**
 * Should a class be included in a multi-class run by default, and if not,
 * why. `scan` is generate_smart_remarks' scan_only payload.
 */
export function preflightVerdict(scan) {
  if (!scan) return { include: false, reason: 'Not checked' }
  if (!scan.band && !(scan.categories || []).length) return { include: false, reason: 'No remark band for this class stage' }
  if (!scan.sheetFound) return { include: false, reason: 'No remarks sheet — nothing ticked' }
  if (!scan.tickedStudents) {
    return { include: false, reason: scan.unmatchedTicks ? 'Ticks match no remark category' : 'Nothing ticked yet' }
  }
  return { include: true, reason: '' }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order of results. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
