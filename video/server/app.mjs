/**
 * HTTP surface of the year-wrap service. Plain node:http — four JSON POST
 * routes don't need a framework.
 *
 *   POST /roster   {schoolId}                         students + AAM surveys + who responded
 *   POST /answers  {schoolId, studentIds}             full responses + saved edits/video state
 *   POST /status   {schoolId, studentIds?}            video state only (polled while rendering)
 *   POST /save     {schoolId, studentId, storyline}   save an edited storyline (null = reset)
 *   POST /render   {schoolId, academicYear, items}    queue [{studentId, storyline}]
 *   POST /cancel   {schoolId}                         drop this school's queued renders
 *   GET  /healthz
 *
 * Every POST needs `Authorization: Bearer <Firebase ID token>` from an ops
 * admin. The allowlist mirrors src/config/opsAdmins.js and
 * functions/shared/ops_admins.py — keep the three in step.
 */
import { answers, checkId, httpError, roster, saveEdit, videoDocs } from './data.mjs'

export const OPS_ADMIN_EMAILS = ['sid@ops.clarified.in', 'angel@ops.clarified.in']

export function createHandler({ db, queue, verifyIdToken, now, allowedOrigins = [] }) {
  async function requireOpsAdmin(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (!m) throw httpError(401, 'Sign in required')
    let token
    try { token = await verifyIdToken(m[1]) } catch { throw httpError(401, 'Invalid or expired sign-in') }
    const email = String(token?.email || '').trim().toLowerCase()
    if (!OPS_ADMIN_EMAILS.includes(email)) throw httpError(403, 'Not authorized for this operation')
    return email
  }

  const routes = {
    '/roster': ({ schoolId }) => roster(db, schoolId),
    '/answers': ({ schoolId, studentIds }) => answers(db, schoolId, studentIds),
    '/status': async ({ schoolId, studentIds }) => ({ videos: await videoDocs(db, schoolId, studentIds || null), queue: queue.state() }),
    '/save': async ({ schoolId, studentId, storyline }, email) => {
      await saveEdit(db, schoolId, studentId, storyline ?? null, email, now())
      return { ok: true }
    },
    '/render': ({ schoolId, academicYear, items }, email) => queue.enqueue({ schoolId, academicYear, items, email }),
    '/cancel': ({ schoolId }) => queue.cancel(schoolId),
  }

  return async function handle(req, res) {
    const origin = req.headers.origin
    if (origin && (!allowedOrigins.length || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Max-Age', '3600')
    }
    if (req.method === 'OPTIONS') return send(res, 204)
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, queue: queue.state() })

    const route = routes[req.url?.split('?')[0]]
    if (req.method !== 'POST' || !route) return send(res, 404, { error: 'Not found' })
    try {
      const email = await requireOpsAdmin(req)
      const body = await readJson(req)
      checkId(body.schoolId, 'schoolId')
      send(res, 200, await route(body, email))
    } catch (e) {
      if (!e.status) console.error(req.url, e)
      send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' })
    }
  }
}

function send(res, status, body) {
  res.statusCode = status
  if (body === undefined) return res.end()
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readJson(req, limit = 30_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(httpError(413, 'Request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { reject(httpError(400, 'Body is not JSON')) }
    })
    req.on('error', reject)
  })
}
