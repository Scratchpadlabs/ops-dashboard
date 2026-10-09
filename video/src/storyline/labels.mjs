/**
 * Turning a survey option label into something the video can say back to
 * the child: "a) 🚀 Flying" → { text: 'Flying', emoji: '🚀' } and
 * "Playing my favourite sport" → "Playing your favourite sport".
 */

const EMOJI_RUN = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|‍|️|\p{Emoji_Modifier})+/gu

export function splitEmoji(label) {
  let s = String(label ?? '').replace(/^\s*[a-z]\)\s*/i, '').trim()
  const emojis = s.match(EMOJI_RUN) || []
  const text = s.replace(EMOJI_RUN, ' ').replace(/\s{2,}/g, ' ').trim()
  return { text, emoji: emojis.join('').trim() }
}

// Order matters: multi-word forms before the bare pronoun.
const SECOND_PERSON = [
  [/\bI am\b/g, 'you are'], [/\bI'm\b/g, "you're"], [/\bI’m\b/g, 'you’re'],
  [/\bI will\b/g, 'you will'], [/\bI\b/g, 'you'],
  [/\bmyself\b/gi, 'yourself'], [/\bmine\b/gi, 'yours'],
  [/\bmy\b/gi, 'your'], [/\bme\b/gi, 'you'],
]

/** First person → second person, keeping the label's own capitalisation. */
export function toSecondPerson(text) {
  let s = String(text ?? '')
  for (const [re, to] of SECOND_PERSON) {
    s = s.replace(re, (m) => (m[0] === m[0].toUpperCase() && m[0] !== 'I' ? to[0].toUpperCase() + to.slice(1) : to))
  }
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** What the video shows for one chosen option. */
export function present(label) {
  const { text, emoji } = splitEmoji(label)
  return { text: toSecondPerson(text), emoji, raw: String(label ?? '') }
}

export const sameAnswer = (a, b) =>
  splitEmoji(a).text.toLowerCase().replace(/[^a-z0-9]+/g, '') ===
  splitEmoji(b).text.toLowerCase().replace(/[^a-z0-9]+/g, '')
