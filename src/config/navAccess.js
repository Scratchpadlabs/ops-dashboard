/**
 * Per-person navigation access.
 *
 * Distinct from opsAdmins.js, which answers "is this person an ops admin" and
 * gates whole capabilities. This answers "should THIS person see this page",
 * which is a preference about one individual rather than a role.
 *
 * Hiding a nav item is not access control. It is applied in the router as well
 * as the sidebar so the page cannot be reached by typing the URL, but anyone
 * signed in can still read the underlying Firestore data — firestore.rules is
 * what actually protects it. Use this to keep a page out of someone's way, not
 * to keep information from them.
 */

/** email (lowercase) -> route paths that person should not see. */
export const HIDDEN_NAV_BY_EMAIL = {
  // Ruchika does not work with expenses. She is not an ops admin, so School
  // Setup, Import and Surveys are already hidden from her by role — this is the
  // one page that needed hiding for her specifically.
  'ruchika@ops.clarified.in': ['/expenses'],
}

function normalize(email) {
  return String(email || '').trim().toLowerCase()
}

/** Paths hidden from this person. Unknown or signed-out gets an empty list. */
export function hiddenPathsFor(email) {
  return HIDDEN_NAV_BY_EMAIL[normalize(email)] || []
}

export function isPathHiddenFor(email, path) {
  return hiddenPathsFor(email).includes(path)
}
