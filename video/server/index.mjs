/**
 * Year-wrap render service — Cloud Run entry point. See README "Deploying".
 *
 * Env: PORT, STORAGE_BUCKET (default clarified-1501.appspot.com),
 *      ALLOWED_ORIGINS (comma list; empty = any origin — auth is the bearer
 *      token, not cookies), BUNDLE_DIR, REMOTION_BROWSER.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { createHandler } from './app.mjs'
import { createQueue } from './jobs.mjs'
import { renderStoryline } from './render.mjs'

const BUCKET = process.env.STORAGE_BUCKET || 'clarified-1501.appspot.com'
initializeApp({ credential: applicationDefault(), storageBucket: BUCKET })
const db = getFirestore()
const bucket = getStorage().bucket()

// A download token in the object metadata is what makes a Firebase Storage
// URL work without signing; the dashboard plays and zips straight from it.
async function upload(dest, localPath, contentType) {
  const token = randomUUID()
  await bucket.upload(localPath, {
    destination: dest,
    metadata: { contentType, cacheControl: 'private, max-age=300', metadata: { firebaseStorageDownloadTokens: token } },
  })
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(dest)}?alt=media&token=${token}`
}

const queue = createQueue({
  db, upload,
  now: () => Timestamp.now(),
  render: renderStoryline,
  cleanup: (out) => out?.dir && rmSync(out.dir, { recursive: true, force: true }),
})

const handler = createHandler({
  db, queue, now: () => Timestamp.now(),
  verifyIdToken: (t) => getAuth().verifyIdToken(t),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
})

const port = Number(process.env.PORT || 8080)
http.createServer(handler).listen(port, () => console.log(`year-wrap service on :${port}`))
