// Adds the 27 secondary-stage activities (from Secondary_activities_APP.md)
// to schools/Hillgreen_Highschool/activities.
//
// Doc shape matches the live example (schools/Hillgreen_Highschool/activities/*):
//   { id, name, activity_description, stage }
//
// Doc ID: `secondary_${slug(name)}` — stage-prefixed so the same activity
// name used at a different stage (if that ever happens) never collides.
//
// Idempotent: skips any activity whose doc id already exists, so re-running
// is safe.
//
// SAFETY: dry run by default. Pass --confirm to actually write.
//
// Usage:
//   node add_secondary_activities.mjs
//   node add_secondary_activities.mjs --confirm

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const CONFIRM = process.argv.includes('--confirm')
const SCHOOL_ID = 'Hillgreen_Highschool'
const STAGE = 'secondary'

const ACTIVITIES = [
  ['Structured Discussion', 'Learners discuss a question, topic, or situation in a planned manner. They share their ideas, listen to others, ask relevant questions, and respond thoughtfully to different viewpoints. This activity develops communication, listening, confidence, and the ability to build understanding through discussion.'],
  ['Classroom Observation-Based Writing', 'Learners observe a demonstration, visual, object, or short presentation shared in the classroom and write down key details based on guided prompts. Learners note features, patterns, or responses in their own words. This task supports close observation, strengthens concept connection, and builds the habit of noticing details and expressing them clearly. It encourages scientific thinking in a regular classroom setting.'],
  ['Compare and Evaluate', 'Learners examine two or more ideas, situations, processes, texts, or solutions using suitable points of comparison. They identify similarities and differences and consider the strengths, limitations, or suitability of each. This activity develops analysis, evaluation, and reasoned judgement.'],
  ['Mind Mapping', 'Learners create a visual web of ideas related to a central concept or topic taught. They use keywords, arrows, and branches to connect terms, thoughts, and sub-topics. This activity helps in organising information clearly and encourages idea generation, summarising, and better recall. It allows learners to show their understanding in a structured, visual way, making it easier to revise and connect key points.'],
  ['Flowchart / Cycle Drawing', 'Learners draw a simple flowchart or cycle to show the steps, stages, or sequence of a process. This helps in organising ideas clearly and understanding how one step connects to the next. The activity builds logical thinking, visual mapping, and structured presentation, encouraging learners to break down information into manageable parts and present it in a clean, easy-to-follow format.'],
  ['Chart / Poster Making', 'Learners design a chart or poster to present key points, concepts, or visuals related to a topic taught. They highlight main ideas, use headings and diagrams, and arrange content clearly and creatively. This activity supports summarising, visual expression, and strengthens understanding through layout, design, and flexible interpretation of the content.'],
  ['Brain Teaser Task / Puzzle / Riddle Solving', 'Learners solve a short, engaging brain teaser related to a recently taught concept. This task may include number patterns, coded clues, visual puzzles, or logical reasoning questions that require critical thinking and problem-solving. The activity encourages curiosity, strengthens mental agility, and helps learners apply classroom learning in playful, analytical ways.'],
  ['Peer Teaching', 'Learners explain a concept, process, method, or idea to a partner or group using their own understanding. They organise the explanation, use suitable examples or visuals where needed, and respond to questions from their peers. This activity strengthens conceptual understanding, communication, confidence, and collaborative learning.'],
  ['Role-Based Discussion', 'Learners take different roles in a given situation and discuss the issue from the perspective of their assigned role. They consider different needs, responsibilities, or viewpoints before responding to others. This activity develops perspective-taking, communication, empathy, and thoughtful decision-making.'],
  ['Concept in Context', 'Learners take a concept, principle, process, or idea learned in class and apply it to a familiar or real-life situation. They explain how the concept helps them understand the situation or solve a related problem. This activity helps learners recognise the practical relevance of classroom learning.'],
  ['Survey Activity', 'Learners prepare suitable questions and collect information from a selected group through a survey or another appropriate method. They organise the responses, identify important patterns or findings, and communicate what they have learned. This activity develops questioning, information gathering, data handling, and interpretation.'],
  ['Data Representation', 'Learners use given data to create simple bar graphs, pie charts, or similar visuals. They organise values, label parts clearly, and present the information in a structured, readable format. The task also includes interpreting patterns, comparisons, or conclusions from the chart. This activity supports data handling skills, visual thinking, and reinforces the ability to present and understand quantitative information through structured representation.'],
  ['Data Interpretation', 'Learners examine information presented through tables, graphs, charts, or other forms of data. They identify patterns, make comparisons, notice important changes, and use the information to draw meaningful conclusions. This activity strengthens the ability to understand data and use it as evidence rather than simply reading individual values.'],
  ['Digital Presentation Task', 'Learners create a simple slide-based presentation using digital tools to show their understanding of a recently taught topic. They insert short text, images, or charts to convey ideas clearly. This activity helps assess familiarity with basic software functions like adding slides, formatting content, and inserting visuals. It supports digital literacy, allowing learners to use technology meaningfully and independently.'],
  ['Problem-Solving Activity', 'Learners work on a problem that requires them to understand information, identify possible approaches, and arrive at a suitable solution. They explain the steps or reasoning used to reach their answer. This activity develops logical thinking, application, persistence, and independent problem-solving.'],
  ['Model Making', 'Learners create a model to represent a concept, structure, system, process, or idea. They plan the model, select suitable materials, and explain how the model represents their understanding. This activity develops creativity, planning, practical skills, and the ability to represent complex ideas visually.'],
  ['Debate', 'Learners present different viewpoints on a given statement or issue and support their position with suitable reasons, examples, or evidence. They listen to opposing views and respond appropriately while maintaining a clear line of reasoning. This activity develops argument building, communication, reasoning, and the ability to consider different perspectives.'],
  ['Creative Expression', 'Learners communicate their understanding of a topic through an original form such as artwork, writing, performance, model, visual design, or another suitable creative format. They make purposeful choices about how to represent their ideas and explain the connection between their creation and the topic. This activity encourages creativity, expression, interpretation, and deeper engagement with learning.'],
  ['Case Study', 'Learners examine a real or given situation and identify the main issue, relevant information, possible causes, and likely outcomes. They apply what they have learned to understand the situation and suggest or justify a suitable response. This activity develops analysis, application, reasoning, and decision-making.'],
  ['Research Activity', 'Learners explore a topic or question using books, reliable sources, observations, interviews, or other available information. They select relevant information, organise their findings, and present what they have understood in a clear manner. The activity encourages curiosity, independent learning, careful use of information, and the ability to develop understanding beyond the textbook.'],
  ['Article / Report Writing', 'Learners write a short article or report based on a topic, event, or theme recently covered. They organise their thoughts into a clear format, using relevant details and an appropriate tone. This activity builds creativity, sentence formation, and written communication skills. It encourages learners to connect ideas, apply vocabulary, and organise content in a purposeful and meaningful way.'],
  ['Decision-Making Activity', 'Learners examine a situation where a choice needs to be made and consider the available options and their possible outcomes. They make a decision and explain the reasons behind their choice. This activity develops judgement, reasoning, responsibility, and the ability to make informed choices.'],
  ['What-If Activity', 'Learners consider how changing one condition, decision, or part of a situation could affect what happens next. They predict possible outcomes and explain the reasons for their thinking. This activity develops flexible thinking, cause-and-effect understanding, and the ability to apply knowledge to unfamiliar situations.'],
  ['Error Analysis', 'Learners examine an incorrect answer, calculation, explanation, process, or solution and identify where the mistake has occurred. They explain why the error affects the outcome and suggest how the work can be corrected. This activity develops attention to detail, reasoning, and deeper understanding of concepts.'],
  ['Cause and Effect Mapping', 'Learners examine an event, issue, process, or problem and identify the factors that may cause it and the effects that may follow. They organise these relationships visually or in a structured format and explain the connections they identify. This activity develops analytical thinking and helps learners understand relationships between events and outcomes.'],
  ['Predict, Test and Explain', 'Learners make a prediction about what may happen in a given situation and then use observation, practical work, or available evidence to examine the outcome. They compare the result with their prediction and explain what they learned from it. This activity develops curiosity, observation, reasoning, and evidence-based thinking.'],
  ['Design Challenge', 'Learners identify a problem, need, or situation and develop different possible ways of addressing it. They select a suitable idea, plan how it could work, and consider how it could be improved. This activity encourages creativity, practical thinking, planning, and problem-solving.'],
  ['Community Study', 'Learners explore an issue, need, or situation in their community through observation, interaction, surveys, or available information. They connect what they discover with classroom learning and organise their findings into a suitable conclusion or presentation. This activity develops awareness, inquiry, social understanding, and real-world application.'],
]

function slug(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

if (!CONFIRM) {
  console.log('=== DRY RUN — nothing will be written. Pass --confirm to actually write. ===\n')
}

initializeApp({ credential: applicationDefault(), projectId: 'clarified-1501' })
const db = getFirestore()

async function main() {
  const activitiesRef = db.collection('schools').doc(SCHOOL_ID).collection('activities')
  let toCreate = 0, alreadyExists = 0

  for (let i = 0; i < ACTIVITIES.length; i++) {
    const [name, description] = ACTIVITIES[i]
    const order = i + 1
    const docId = `${STAGE}_${String(order).padStart(2, '0')}_${slug(name)}`
    const snap = await activitiesRef.doc(docId).get()
    if (snap.exists) {
      alreadyExists++
      console.log(`SKIP (already exists): ${docId}`)
      continue
    }
    toCreate++
    console.log(`${CONFIRM ? 'Creating' : '[DRY RUN] would create'}: ${docId} — "${name}"`)
    if (CONFIRM) {
      await activitiesRef.doc(docId).set({
        id: docId,
        name,
        activity_description: description,
        stage: STAGE,
        order,
        created_at: FieldValue.serverTimestamp(),
        created_by: 'add-secondary-activities-script',
      })
    }
  }

  console.log(`\n=== Totals ===`)
  console.log(`${CONFIRM ? 'Created' : 'Would create'}: ${toCreate}`)
  console.log(`Already existed (skipped): ${alreadyExists}`)
  if (!CONFIRM) console.log('\nDry run — nothing was written. Re-run with --confirm to apply.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
