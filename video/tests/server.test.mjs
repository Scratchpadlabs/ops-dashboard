import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHandler } from '../server/app.mjs'
import { createQueue } from '../server/jobs.mjs'
import { checkStoryline, isInactive, slimSurvey } from '../server/data.mjs'
import { buildStoryline } from '../src/storyline/buildStoryline.mjs'
import { SAMPLES } from '../fixtures/sample-students.mjs'

// ── a Firestore fake: just the surface server/ uses ────────────────────────
function fakeDb() {
  const docs = new Map()
  const docRef = (path) => ({
    id: path.split('/').at(-1), path,
    collection: (name) => colRef(`${path}/${name}`),
    async get() { return snap(path) },
    async set(data, opts) { docs.set(path, opts?.merge ? { ...(docs.get(path) || {}), ...data } : { ...data }) },
  })
  const colRef = (path) => ({
    doc: (id) => docRef(`${path}/${id}`),
    async get() {
      const d = [...docs.keys()].filter((k) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
      return { docs: d.map(snap) }
    },
  })
  const snap = (path) => ({ id: path.split('/').at(-1), exists: docs.has(path), data: () => docs.get(path), get: (f) => docs.get(path)?.[f] })
  return {
    docs,
    collection: (name) => colRef(name),
    doc: (path) => docRef(path),
    async getAll(...refs) { return refs.map((r) => snap(r.path)) },
    batch() {
      const ops = []
      return { set: (r, d, o) => ops.push(() => r.set(d, o)), async commit() { for (const op of ops) await op() } }
    },
  }
}

const story = () => buildStoryline(SAMPLES.ananya)
const VIDEO = (s, id) => `schools/${s}/year_wrap_videos/${id}`
const tick = () => new Promise((r) => setTimeout(r, 5))

function setup({ render } = {}) {
  const db = fakeDb()
  const uploads = []
  const cleaned = []
  const queue = createQueue({
    db, now: () => 'NOW',
    render: render || (async (_s, onProgress) => { onProgress(0.5); onProgress(1); return { video: '/tmp/v.mp4', thumb: '/tmp/t.jpg', dir: '/tmp' } }),
    upload: async (dest) => { uploads.push(dest); return `https://files/${dest}` },
    cleanup: (out) => cleaned.push(out),
  })
  const tokens = { good: { email: 'Sid@ops.clarified.in' }, outsider: { email: 'someone@gmail.com' } }
  const handler = createHandler({
    db, queue, now: () => 'NOW',
    verifyIdToken: async (t) => { if (!tokens[t]) throw new Error('bad'); return tokens[t] },
  })
  return { db, queue, uploads, cleaned, handler }
}

async function call(handler, path, body, token = 'good', method = 'POST') {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, r))
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: 'https://ops.example' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: res.status === 204 ? null : await res.json(), cors: res.headers.get('access-control-allow-origin') }
  } finally { server.close() }
}

test('auth: no token → 401, non-admin → 403, admin (any case) → 200', async () => {
  const { handler } = setup()
  assert.equal((await call(handler, '/status', { schoolId: 'S' }, null)).status, 401)
  assert.equal((await call(handler, '/status', { schoolId: 'S' }, 'forged')).status, 401)
  assert.equal((await call(handler, '/status', { schoolId: 'S' }, 'outsider')).status, 403)
  const ok = await call(handler, '/status', { schoolId: 'S' })
  assert.equal(ok.status, 200)
  assert.equal(ok.cors, 'https://ops.example')
})

test('bad input is a 400, never a crash', async () => {
  const { handler } = setup()
  assert.equal((await call(handler, '/render', {})).status, 400)
  assert.equal((await call(handler, '/render', { schoolId: 'a/b', items: [] })).status, 400)
  assert.equal((await call(handler, '/render', { schoolId: 'S', items: [] })).status, 400)
  const bad = await call(handler, '/render', { schoolId: 'S', items: [{ studentId: 'x', storyline: { segment: 'mid', scenes: [] } }] })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /no scenes/)
  for (const studentId of ['a/b', '..', '', 5]) {
    assert.equal((await call(handler, '/save', { schoolId: 'S', studentId, storyline: null })).status, 400, `save ${studentId}`)
    assert.equal((await call(handler, '/render', { schoolId: 'S', items: [{ studentId, storyline: story() }] })).status, 400, `render ${studentId}`)
  }
  assert.equal((await call(handler, '/answers', { schoolId: 'S', studentIds: ['ok', 'x/y'] })).status, 400)
  assert.equal((await call(handler, '/nope', { schoolId: 'S' })).status, 404)
  assert.equal((await call(handler, '/healthz', null, null, 'GET')).status, 200)
})

test('render: queued → rendering → done, with urls, progress and cleanup', async () => {
  const { handler, db, uploads, cleaned } = setup()
  const r = await call(handler, '/render', { schoolId: 'S', academicYear: '2025-26', items: [{ studentId: 'stu1', storyline: story() }] })
  assert.equal(r.status, 200)
  assert.equal(r.body.queued, 1)
  for (let i = 0; i < 20 && db.docs.get(VIDEO('S', 'stu1'))?.status !== 'done'; i++) await tick()
  const doc = db.docs.get(VIDEO('S', 'stu1'))
  assert.equal(doc.status, 'done')
  assert.equal(doc.progress, 1)
  assert.equal(doc.videoUrl, 'https://files/year_wrap/S/2025-26/stu1.mp4')
  assert.equal(doc.thumbUrl, 'https://files/year_wrap/S/2025-26/stu1.jpg')
  assert.equal(doc.requestedBy, 'sid@ops.clarified.in')
  assert.equal(doc.studentName, 'ANANYA IYER')
  assert.deepEqual(uploads.sort(), ['year_wrap/S/2025-26/stu1.jpg', 'year_wrap/S/2025-26/stu1.mp4'])
  assert.equal(cleaned.length, 1)
  const status = await call(handler, '/status', { schoolId: 'S', studentIds: ['stu1', 'missing'] })
  assert.equal(status.body.videos.stu1.status, 'done')
  assert.ok(db.docs.get(VIDEO('S', 'stu1')).renderedStoryline, 'rendered storyline kept for audit')
  assert.ok(!('renderedStoryline' in status.body.videos.stu1), 'but not sent on polls')
  assert.ok(!('missing' in status.body.videos))
})

test('a failed render is recorded and the queue moves on', async () => {
  let n = 0
  const { handler, db } = setup({ render: async () => { if (n++ === 0) throw new Error('chromium crashed'); return { video: 'v', thumb: null } } })
  await call(handler, '/render', { schoolId: 'S', items: [{ studentId: 'a', storyline: story() }, { studentId: 'b', storyline: story() }] })
  for (let i = 0; i < 20 && db.docs.get(VIDEO('S', 'b'))?.status !== 'done'; i++) await tick()
  assert.equal(db.docs.get(VIDEO('S', 'a')).status, 'failed')
  assert.match(db.docs.get(VIDEO('S', 'a')).error, /chromium crashed/)
  assert.equal(db.docs.get(VIDEO('S', 'b')).status, 'done')
  assert.equal(db.docs.get(VIDEO('S', 'b')).thumbUrl, null)
})

test('cancel drops only that school\'s queued renders', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const { handler, db, queue } = setup({ render: async () => { await gate; return { video: 'v' } } })
  await call(handler, '/render', { schoolId: 'S', items: ['a', 'b', 'c'].map((studentId) => ({ studentId, storyline: story() })) })
  await call(handler, '/render', { schoolId: 'T', items: [{ studentId: 'z', storyline: story() }] })
  const c = await call(handler, '/cancel', { schoolId: 'S' })
  assert.equal(c.body.cancelled, 2, 'a is already rendering; b and c are dropped')
  assert.equal(db.docs.get(VIDEO('S', 'b')).status, 'cancelled')
  assert.equal(db.docs.get(VIDEO('T', 'z')).status, 'queued')
  assert.equal(queue.state().pending, 1)
  release()
})

test('save stores an edit, null resets it; answers returns it', async () => {
  const { handler, db } = setup()
  const s = story()
  s.scenes[1].start.text = 'Paediatrician'
  assert.equal((await call(handler, '/save', { schoolId: 'S', studentId: 'stu1', storyline: s })).status, 200)
  assert.equal(db.docs.get(VIDEO('S', 'stu1')).storyline.scenes[1].start.text, 'Paediatrician')
  const a = await call(handler, '/answers', { schoolId: 'S', studentIds: ['stu1'] })
  assert.equal(a.body.videos.stu1.storyline.scenes[1].start.text, 'Paediatrician')
  await call(handler, '/save', { schoolId: 'S', studentId: 'stu1', storyline: null })
  assert.equal(db.docs.get(VIDEO('S', 'stu1')).edited, false)
  const b = await call(handler, '/answers', { schoolId: 'S', studentIds: ['stu1'] })
  assert.equal(b.body.videos.stu1.storyline, undefined, 'reset edit is not served back')
})

test('checkStoryline recomputes duration from scenes', () => {
  const s = story()
  const checked = checkStoryline({ ...s, durationInFrames: 1 })
  assert.equal(checked.durationInFrames, s.scenes.reduce((n, x) => n + x.durationInFrames, 0))
  assert.throws(() => checkStoryline({ ...s, segment: 'foundation' }), /segment/)
})

test('slimSurvey keeps English labels and string ids', () => {
  const s = slimSurvey('AAM1-mid', { questions: [{ id: 5, type: 'scq', questionText: { en: ' Q? ', hi: 'x' }, answers: [{ id: 201, label: { en: 'Yes', hi: 'हाँ' }, value: 1 }] }] })
  assert.deepEqual(s, { id: 'AAM1-mid', startAt: null, expiresAt: null, questions: [{ id: '5', type: 'scq', questionText: 'Q?', answers: [{ id: '201', label: 'Yes' }] }] })
})

test('slimSurvey turns Firestore timestamps into millis', () => {
  const s = slimSurvey('X', { startAt: { toMillis: () => 123 }, questions: [] })
  assert.equal(s.startAt, 123)
  assert.equal(s.expiresAt, null)
})

test('isInactive mirrors survey_rules.py', () => {
  assert.ok(isInactive({ isActive: false }))
  assert.ok(isInactive({ status: 'TC Issued' }))
  assert.ok(!isInactive({}))
})
