#!/usr/bin/env node
/**
 * End-to-end check of the four School Setup repairs, driven through the real
 * app against the local emulators.
 *
 *   npm run emulators      # terminal 1
 *   npm run seed:emulator  # terminal 2
 *   npm run dev:emulate    # terminal 3
 *   node e2e/school-setup-repairs.mjs
 *
 * Every assertion is read back out of Firestore after the UI has done the
 * work, not off the screen — the screen showing "Saved" is not evidence that
 * the right document was written.
 */
import { chromium } from 'playwright'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
initializeApp({ projectId: 'clarified-1501' })
const db = getFirestore()
const school = db.collection('schools').doc('Hillgreen_Highschool')

const OUT = process.env.OUT || '/tmp'
const BASE = 'http://127.0.0.1:5173'

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}
const docs = async (name) => (await school.collection(name).get()).docs.map(d => ({ id: d.id, ...d.data() }))

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
page.on('pageerror', e => { failures++; console.log('  [pageerror]', String(e).slice(0, 300)) })

const shot = n => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true })
// PrimeVue renders dialogs/toasts into portals; match on the accessible text.
const btn = t => page.locator(`button:has-text("${t}")`).first()
const clickBtn = async (t) => { await btn(t).click() }
/**
 * Accept the ConfirmDialog. Targeted by its own class rather than by button
 * text: the dialog underneath usually has a button with the same verb, and it
 * is still in the DOM behind the confirm's modal mask.
 */
async function acceptConfirm(label) {
  const dlg = page.locator('.p-confirmdialog')
  await dlg.waitFor({ state: 'visible', timeout: 15000 })
  await dlg.locator(`button:has-text("${label}")`).last().click()
  await dlg.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {})
}
/** Wait until no modal mask is left covering the page. */
const maskGone = () => page.locator('.p-dialog-mask').last()
  .waitFor({ state: 'detached', timeout: 20000 }).catch(() => {})

async function openTab(name) {
  await page.locator(`a:has-text("${name}"), .p-tab:has-text("${name}"), [role="tab"]:has-text("${name}")`).first().click()
  await page.waitForTimeout(1500)
}

// ── Sign in ─────────────────────────────────────────────────────────────────
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.locator('input').first().fill('sid')
await page.locator('input[type="password"]').fill('emulator-password')
await clickBtn('Sign In')
await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 20000 })
console.log('signed in →', page.url())

await page.goto(`${BASE}/school-setup`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

// School Setup is behind a step-up re-auth prompt.
if (await page.locator('text=Confirm your password to continue').count()) {
  await page.locator('input[type="password"]').last().fill('emulator-password')
  await clickBtn('Continue')
  await page.waitForTimeout(4000)
  console.log('step-up auth cleared')
}

// Pick the seeded school in the header select.
await page.locator('.p-select, .p-dropdown').first().click()
await page.waitForTimeout(600)
await page.locator('li:has-text("Hillgreen")').first().click()
await page.waitForTimeout(3000)
await shot('10-school-setup')

console.log('\n── 1. Move co-scholastic out of subjects ─────────────────────')
await openTab('Subjects')
await shot('11-subjects-before')

const before = await docs('subjects')
check('seed has 6 co-scholastic records filed as subjects per grade',
  before.filter(s => ['Conc', 'Dict', 'Linguistic', 'CLB', 'KRT', 'V_Edu'].includes(s.name)).length === 18)
check('...and 4 of the 6 are stored with a blank area',
  before.filter(s => ['Conc', 'Dict', 'Linguistic', 'CLB'].includes(s.name)).every(s => !s.area))

const banner = page.locator('text=/Co-Scholastic record\\(s\\) are filed as subjects/')
check('the misfiled banner is shown', await banner.count() > 0)
if (await banner.count()) console.log('       banner:', (await banner.first().innerText()).trim())

await clickBtn('Move to Co-Scholastic')
await page.waitForTimeout(1200)
await shot('12-move-dialog')
const dialogText = await page.locator('.p-dialog').first().innerText()
console.log('       dialog preview:\n' + dialogText.split('\n').filter(Boolean).slice(0, 14).map(l => '         ' + l).join('\n'))

check('per-grade copies are shown as merging into one activity',
  /merged into one/.test(dialogText), dialogText.match(/merged into one[^\n]*/)?.[0])

await page.locator('.p-dialog button:has-text("Move 18")').last().click()
await acceptConfirm('Move')
await page.waitForTimeout(5000)
await maskGone()
await shot('13-after-move')

const afterSubjects = await docs('subjects')
const activities = await docs('co_scholastic_activities')
check('EVERY grade copy is gone from subjects, not just the first',
  !afterSubjects.some(s => ['KRT', 'V_Edu'].includes(s.name)),
  afterSubjects.filter(s => ['KRT', 'V_Edu'].includes(s.name)).map(s => s.id))
// Term-wide: three grade copies of one name collapse into ONE activity.
// All six names — the two tagged Co-Scholastic AND the four stored blank that
// the knowledge base now recognises — collapse to one activity each.
check('3 grade copies of 6 names became exactly 6 activities',
  activities.length === 6, activities.map(a => a.id))
check('no co-scholastic record is left in subjects',
  !afterSubjects.some(s => ['Conc', 'Dict', 'Linguistic', 'CLB', 'KRT', 'V_Edu'].includes(s.name)),
  afterSubjects.filter(s => ['Conc', 'Dict', 'Linguistic', 'CLB', 'KRT', 'V_Edu'].includes(s.name)).map(s => s.id))
check('only the scholastic subjects remain', afterSubjects.length === 18, afterSubjects.length)
if (activities.length) {
  const a = activities[0]
  check('an activity has the co-scholastic schema', ['name', 'termId', 'order', 'entryType', 'maxMarks', 'conversionType']
    .every(k => a[k] !== undefined), a)
  check('...and records where it came from', !!a.migrated_from_subject_id, a.migrated_from_subject_id)
}

console.log('\n── 2. Fill the empty class subject lists ─────────────────────')
await openTab('Classes & Teachers')
await page.waitForTimeout(1500)
await shot('20-classes-before')

const classesBefore = await docs('classes')
check('seed classes all start with subjects: []',
  classesBefore.every(c => (c.subjects || []).length === 0))
const fillBanner = page.locator('text=/section\\(s\\) have an empty subject list/')
check('the empty-subject-list banner is shown', await fillBanner.count() > 0)
if (await fillBanner.count()) console.log('       banner:', (await fillBanner.first().innerText()).trim())

await clickBtn('Fill subject lists')
await page.waitForTimeout(1200)
await shot('21-fill-confirm')
await acceptConfirm('Fill')
await page.waitForTimeout(5000)
await maskGone()
await shot('22-classes-after')

const classesAfter = await docs('classes')
const sample = classesAfter.find(c => c.id === 'III_A')
check('every class now has exactly its 6 scholastic subjects',
  classesAfter.every(c => (c.subjects || []).length === 6),
  classesAfter.map(c => [c.id, (c.subjects || []).length]))
check('no co-scholastic record was attached to a class',
  !classesAfter.some(c => (c.subjects || []).some(s => /KRT|V_Edu|Conc|Dict|Linguistic|CLB/.test(s.subjectId))),
  classesAfter[0]?.subjects.map(s => s.subjectId))
if (sample) {
  const entry = sample.subjects[0]
  check('an entry has the reference shape',
    ['subjectId', 'teacherId', 'isCompleted', 'completedAt', 'topics'].every(k => k in entry), Object.keys(entry))
  const topics = entry.topics.map(t => `${t.id}|${t.topic}`)
  console.log('       topics:', topics.join('  '))
  check('topic labels match the live SAMARTH doc',
    entry.topics.map(t => t.topic).join(',') === 'Term 1 Activity,Term 2 Activity,Optional Activity',
    entry.topics.map(t => t.topic))
  check('topic ids match', entry.topics.map(t => t.id).join(',') ===
    `${entry.subjectId}_Term1,${entry.subjectId}_Term2,${entry.subjectId}_Optional`)
  check('no absentList is seeded', entry.topics.every(t => !('absentList' in t)))
}

console.log('\n── 3. Repair the existing assessments ────────────────────────')
await openTab('Assessments')
await page.waitForTimeout(1500)
// Choose Term 1 in the tab's own term select. Scoped to the visible panel:
// PrimeVue mounts every tab panel, so a bare '.p-select' matches hidden ones
// belonging to other tabs.
await page.locator('[id$="tabpanel_assessments"] .p-select:visible').first().click()
await page.waitForTimeout(800)
await page.locator('li:has-text("Term 1")').first().click()
await page.waitForTimeout(2500)
await shot('30-assessments-before')

const asBefore = await docs('assessments')
check('seed has the mangled 804040 marks', asBefore.filter(a => a.maxMarks === 804040).length === 6)
check('seed assessments are named after their subject',
  asBefore.some(a => a.name === 'English' && a.subjectId.endsWith('_English')))

const repairBanner = page.locator('text=/assessment\\(s\\) in this term need repair/')
check('the repair banner is shown', await repairBanner.count() > 0)
if (await repairBanner.count()) console.log('       banner:', (await repairBanner.first().innerText()).trim())

await clickBtn('Review repairs')
await page.waitForTimeout(1500)
await shot('31-repair-dialog')
const repairText = await page.locator('.p-dialog').first().innerText()
console.log('       dialog:\n' + repairText.split('\n').filter(Boolean).slice(0, 26).map(l => '         ' + l).join('\n'))
check('the dialog explains the 804040 reading', /804040/.test(repairText) && /80 is the likely original/.test(repairText))
check('the subject-named assessments are called out', /the same as its subject/.test(repairText))
check('the unrecoverable 803030 is flagged without a guess',
  /803030/.test(repairText) && /review threshold/.test(repairText))

await page.locator('.p-dialog button:has-text("Apply to")').click()
await page.waitForTimeout(1200)
await shot('32-repair-confirm')
await acceptConfirm('Apply')
await page.waitForTimeout(5000)
await maskGone()
await shot('33-assessments-after')

const asAfter = await docs('assessments')
const eng = asAfter.find(a => a.id === 'III_English_term1_English')
console.log('       III_English_term1_English →', JSON.stringify(eng))
check('the mangled mark was corrected to 80', eng?.maxMarks === 80, eng?.maxMarks)
check('conversionType was written', eng?.conversionType === 'none')
check('conversionFactor was written', eng?.conversionFactor === null)
check('the blueprint junk fields were removed',
  ['maxWrittenRaw', 'syllabusCovered', 'dateStart', 'duration'].every(k => eng?.[k] === undefined),
  Object.keys(eng || {}))
check('the name was NOT changed automatically', eng?.name === 'English')
const evs = asAfter.find(a => a.id === 'III_EVS_term1_unit_1')
check('the unrecoverable mark was left for a human', evs?.maxMarks === 803030, evs?.maxMarks)
check('...but its missing conversion fields were still written', evs?.conversionType === 'none')
check('no assessment still carries a 6-digit mark it could read back',
  !asAfter.some(a => a.maxMarks === 804040), asAfter.filter(a => a.maxMarks === 804040).map(a => a.id))

console.log('\n── 4. students_schema, ID first ──────────────────────────────')
await openTab('Overview')
await page.waitForTimeout(3000)
await shot('40-overview')
const overview = await page.locator('body').innerText()
check('the missing students_schema is reported', /students_schema is missing/.test(overview))

// Scoped to the Overview panel — every tab panel is mounted, so a bare
// button match can land on a hidden one in another tab.
const ov = page.locator('[id$="tabpanel_overview"]')
await ov.locator('button:has-text("Create"), button:has-text("Rebuild")').first().click()
await page.waitForTimeout(1200)
await shot('41-schema-confirm')
await acceptConfirm('Rebuild')
await page.waitForTimeout(5000)
await maskGone()
await shot('42-overview-after')

const schema = (await school.collection('config').doc('students_schema').get()).data()
const cols = schema?.columns || []
console.log('       columns:', cols.map(c => c.key).join(', '))
check('config/students_schema now exists', !!schema)
check('ID is the first column', cols[0]?.key === 'id', cols[0])
check('order is 1..n', cols.every((c, i) => c.order === i + 1))
check('the class column carries the live class list',
  (cols.find(c => c.key === 'currentClassId')?.options || []).length === 6,
  cols.find(c => c.key === 'currentClassId')?.options)
for (const k of ['rollNo', 'fatherName', 'motherMobile', 'dateOfAdmission']) {
  check(`"${k}" — a field the import now writes — has a column`, cols.some(c => c.key === k))
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL E2E CHECKS PASSED')
await browser.close()
process.exit(failures ? 1 : 0)
