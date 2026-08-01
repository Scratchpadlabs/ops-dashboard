/**
 * Client-side mirrors of the id helpers in
 * functions/school_reset/reset_rules.py.
 *
 * These exist so the New School wizard can suggest and pre-validate an id
 * without a round trip on every keystroke. The server is still the authority:
 * check_new_school re-runs validate_school_id and owns uniqueness, so a drift
 * between the two shows up as a rejected create, never as a bad write. Keep
 * the two in step when either changes.
 */

/** Suggest a Firestore-safe doc id from a school name. Suggestion only — the
 *  wizard lets it be overridden, because the id is also how humans refer to
 *  the school. Mirrors slugify_school_id(). */
export function slugifySchoolId(name) {
  const out = []
  for (const ch of String(name || '').trim()) {
    if (/[a-z0-9]/i.test(ch)) {
      out.push(ch)
    } else if (' -_'.includes(ch) && out.length && out[out.length - 1] !== '_') {
      out.push('_')
    }
  }
  return out.join('').replace(/^_+|_+$/g, '').slice(0, 64)
}

// Firestore doc ids cannot contain / and cannot be '.' or '..'; we also
// forbid whitespace so ids stay copy-pasteable into paths and URLs.
const INVALID_ID_CHARS = new Set(['/', '\\', ' ', '\t', '\n', '.', '#', '$', '[', ']'])

/** {ok, error} for a user-supplied doc id. Mirrors validate_school_id(). */
export function validateSchoolId(schoolId) {
  const sid = String(schoolId || '').trim()
  if (!sid) return { ok: false, error: 'School ID is required.' }
  if (sid.length > 64) return { ok: false, error: 'School ID must be 64 characters or fewer.' }
  const bad = [...new Set([...sid].filter(c => INVALID_ID_CHARS.has(c)))].sort()
  if (bad.length) {
    return { ok: false, error: `School ID cannot contain: ${bad.map(c => JSON.stringify(c)).join(', ')}` }
  }
  if (!/[a-z0-9]/i.test(sid[0])) {
    return { ok: false, error: 'School ID must start with a letter or number.' }
  }
  return { ok: true, error: null }
}

/**
 * Archive labels name the session being archived, e.g. "2025-26". Suggested
 * from today's date on the assumption of an April–March academic year, which
 * is what every school in this system runs. Purely a default; the reset
 * wizard's archive step lets it be typed over.
 */
export function suggestArchiveLabel(now = new Date()) {
  const y = now.getFullYear()
  // Before April we are still in the session that began the previous year.
  const start = now.getMonth() < 3 ? y - 1 : y
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}
