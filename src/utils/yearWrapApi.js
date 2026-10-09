/**
 * Client for the year-wrap render service (video/server, on Cloud Run).
 *
 * Not a Firebase callable like the rest of api.js: rendering needs Chromium,
 * so the service is a Node container. It authenticates the same way, though:
 * the caller's Firebase ID token, checked against the ops-admin allowlist.
 *
 * VITE_YEAR_WRAP_URL is the service's base URL (see video/README.md).
 */
import { auth } from '../firebase/config'

export const YEAR_WRAP_URL = String(import.meta.env.VITE_YEAR_WRAP_URL || '').replace(/\/+$/, '')

async function post(path, body) {
  if (!YEAR_WRAP_URL) throw new Error('The year-wrap render service is not configured (VITE_YEAR_WRAP_URL).')
  const token = await auth.currentUser?.getIdToken()
  if (!token) throw new Error('Sign in again to continue.')
  let res
  try {
    res = await fetch(`${YEAR_WRAP_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Could not reach the year-wrap render service.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Year-wrap service error (${res.status})`)
  return data
}

export const yearWrapRoster = ({ schoolId }) => post('/roster', { schoolId })
export const yearWrapAnswers = ({ schoolId, studentIds }) => post('/answers', { schoolId, studentIds })
export const yearWrapStatus = ({ schoolId, studentIds }) => post('/status', { schoolId, studentIds })
export const yearWrapSave = ({ schoolId, studentId, storyline }) => post('/save', { schoolId, studentId, storyline })
export const yearWrapRender = ({ schoolId, academicYear, items }) => post('/render', { schoolId, academicYear, items })
export const yearWrapCancel = ({ schoolId }) => post('/cancel', { schoolId })
