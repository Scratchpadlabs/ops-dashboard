// Adds one survey doc per secondary-stage activity to
// schools/Hillgreen_Highschool/surveys — CONFIRM this collection name is
// right before running (the reference screenshot was cropped above the
// breadcrumb, so this is inferred, not confirmed).
//
// Doc ID = the matching activity's doc ID (schools/.../activities/{id}),
// per the requirement: same doc id in both collections, one-to-one.
//
// Reuses the EXACT same 3-question block (options, questionText,
// summaryMap, tag — AWARENESS / SENSITIVITY / CREATIVITY) verbatim across
// every survey, since questionText and tags are the same for all surveys.
// Only `id`, `clazzId`, and `activity_description` vary per survey — the
// rest of the fields (name, desc, card_desc, card_image, isLiveInternal,
// parameter, peer_survey, responses, reward, segmentForInternalPurpose,
// thumbnail, type) are set to match the reference doc's defaults (null/
// empty), since nothing suggests they should differ per activity.
//
// Reads the activity list straight from Firestore (schools/Hillgreen_Highschool
// /activities, filtered to stage == 'secondary') rather than hardcoding it
// again, so it always matches whatever activities actually exist.
//
// SAFETY: dry run by default. Pass --confirm to actually write.
//
// Usage:
//   node add_secondary_surveys.mjs
//   node add_secondary_surveys.mjs --confirm

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const CONFIRM = process.argv.includes('--confirm')
const SCHOOL_ID = 'Hillgreen_Highschool'
const STAGE = 'secondary'
const SURVEYS_COLLECTION = 'surveys' // CONFIRM this matches the real collection name

// Verbatim from the reference survey doc — reused for every survey.
const QUESTIONS = [
  {
    options: ['Beginner (LOW)', 'Proficient (MEDIUM)', 'Advanced (HIGH)', 'Not Applicable'],
    questionText: 'To what extent did the learner stay attentive and follow instructions during the activity?',
    summaryMap: {
      'Advanced (HIGH)': 'The learner identifies patterns, outcomes, and key details independently and documents observations accurately in a structured manner.',
      'Beginner (LOW)': 'The learner observes the experiment carefully and writes simple notes about the steps and visible changes.',
      'Proficient (MEDIUM)': 'The learner records the sequence of the process and writes clear observations using correct scientific terms.',
    },
    tag: 'AWARENESS',
  },
  {
    options: ['Beginner (LOW)', 'Proficient (MEDIUM)', 'Advanced (HIGH)'],
    questionText: 'To what extent did the learner express their emotions clearly and respond with care towards people or situations?',
    summaryMap: {
      'Advanced (HIGH)': 'The learner demonstrates discipline in the lab, follows procedures carefully, and maintains steady attention throughout the activity.',
      'Beginner (LOW)': 'The learner follows safety rules with reminders and stays attentive for part of the observation activity.',
      'Proficient (MEDIUM)': 'The learner handles materials responsibly, listens to instructions, and remains focused while completing the observation task.',
    },
    tag: 'SENSITIVITY',
  },
  {
    options: ['Beginner (LOW)', 'Proficient (MEDIUM)', 'Advanced (HIGH)'],
    questionText: 'To what extent did the learner attempt to share original thoughts, try new approaches, or express ideas in a unique way?',
    summaryMap: {
      'Advanced (HIGH)': 'The learner presents detailed observations with thoughtful explanations, connects results to the concept, and expresses ideas confidently in own words.',
      'Beginner (LOW)': 'The learner writes brief observation sentences using basic descriptive words to explain what happened.',
      'Proficient (MEDIUM)': 'The learner organises observations logically and adds short explanations to describe causes or results clearly.',
    },
    tag: 'CREATIVITY',
  },
]

if (!CONFIRM) {
  console.log('=== DRY RUN — nothing will be written. Pass --confirm to actually write. ===\n')
}

initializeApp({ credential: applicationDefault(), projectId: 'clarified-1501' })
const db = getFirestore()

async function main() {
  const schoolRef = db.collection('schools').doc(SCHOOL_ID)
  const activitiesSnap = await schoolRef.collection('activities')
    .where('stage', '==', STAGE).get()

  if (activitiesSnap.empty) {
    console.log(`No activities found with stage == '${STAGE}'. Nothing to do.`)
    return
  }
  console.log(`Found ${activitiesSnap.size} '${STAGE}' activities.\n`)

  const surveysRef = schoolRef.collection(SURVEYS_COLLECTION)
  let toCreate = 0, alreadyExists = 0

  for (const activityDoc of activitiesSnap.docs) {
    const activityId = activityDoc.id
    const activityData = activityDoc.data()
    const existing = await surveysRef.doc(activityId).get()
    if (existing.exists) {
      alreadyExists++
      console.log(`SKIP (survey already exists): ${activityId}`)
      continue
    }
    toCreate++
    console.log(`${CONFIRM ? 'Creating' : '[DRY RUN] would create'}: surveys/${activityId} for activity "${activityData.name}"`)
    if (CONFIRM) {
      await surveysRef.doc(activityId).set({
        id: activityId,
        clazzId: activityId,
        activity_description: activityData.activity_description || '',
        card_desc: null,
        card_image: '',
        desc: null,
        isLiveInternal: null,
        name: null,
        parameter: null,
        peer_survey: '',
        questions: QUESTIONS,
        responses: '',
        reward: null,
        segmentForInternalPurpose: '',
        thumbnail: '',
        type: '',
      })
    }
  }

  console.log(`\n=== Totals ===`)
  console.log(`${CONFIRM ? 'Created' : 'Would create'}: ${toCreate}`)
  console.log(`Already existed (skipped): ${alreadyExists}`)
  if (!CONFIRM) console.log('\nDry run — nothing was written. Re-run with --confirm to apply.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
