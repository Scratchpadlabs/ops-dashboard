/**
 * Step-completion captions for the setup wizards.
 *
 * HARD RULE, enforced by this module's shape rather than by reviewer memory:
 * there is NO caption pool for any destructive or failure surface. The Reset
 * wizard's archive, preview, confirm and execute steps, and every error
 * message anywhere, are absent from CAPTIONS entirely — so captionFor()
 * returns '' for them and there is nothing for a future edit to accidentally
 * make jokey. Humour resumes only on the post-reset success screen.
 *
 * Style: one short line, encouraging, never sarcastic about the user, never
 * mocking a school by name.
 */

const CAPTIONS = {
  // ── New School wizard ────────────────────────────────────────────────────
  'new.create': [
    'School created. It exists now, officially and everything.',
    'Doc id claimed. No duplicates were harmed.',
    'And so it begins.',
  ],
  'new.details': [
    'Details saved. Someone will thank you at audit time.',
    'Address, board, contact — the boring bits, done properly.',
    'Paperwork: handled.',
  ],
  'new.structure': [
    'Class list locked in. The spreadsheet gods are pleased.',
    'Grades and sections mapped. No stray students in limbo.',
    'Structure sorted. It even sorts in the right order.',
  ],
  'new.subjects': [
    'Subjects sorted. Even the co-scholastic ones.',
    'Scholastic and co-scholastic, filed correctly the first time.',
    'The knowledge base earned its keep.',
  ],
  'new.academics': [
    'Terms set. Time is now officially your friend.',
    'Scales, months, remarks — the machinery is running.',
    'Assessment scaffolding up.',
  ],
  'new.people': [
    "Teachers loaded. They don't know it yet.",
    'Roster in. Every name in the right class.',
    'People added. The school just got a lot less theoretical.',
  ],
  'new.surveys': [
    'Surveys assigned. Inboxes await.',
    'The questions are out there.',
    'Surveys queued up and ready.',
  ],
  'new.review': [
    'Setup complete. Go and have a cup of tea.',
    "That's a whole school, configured properly.",
    'Done — and nothing left half-finished.',
  ],

  // ── Reset wizard: ONLY the two non-destructive early steps and the
  //    post-reset screen. Archive / choose / roster / preview / execute are
  //    deliberately absent. Do not add them.
  'reset.select': [
    "Right, let's have a look at where this school stands.",
  ],
  'reset.postcheck': [
    'New year, clean slate. The hard part is behind you.',
    'Reset complete and verified. Onwards.',
    'Fresh roster, fresh start.',
  ],
}

/**
 * Steps where copy must stay plain and precise, whatever else changes.
 * captionFor() refuses these explicitly as well as by omission, so the rule
 * survives someone adding a pool by mistake.
 */
export const NO_LEVITY_STEPS = new Set([
  'reset.archive', 'reset.choose', 'reset.roster', 'reset.preview', 'reset.execute',
])

/**
 * A caption for a completed step, or '' when the step must stay serious.
 * Random from a small pool so repeated runs don't read like a script.
 */
export function captionFor(stepKey) {
  if (NO_LEVITY_STEPS.has(stepKey)) return ''
  const pool = CAPTIONS[stepKey]
  if (!pool || !pool.length) return ''
  return pool[Math.floor(Math.random() * pool.length)]
}

export function hasCaption(stepKey) {
  return !NO_LEVITY_STEPS.has(stepKey) && !!(CAPTIONS[stepKey] || []).length
}
