/**
 * The words the video says. Arrays are variants: each child gets one picked
 * deterministically from their id, so a class's videos don't all read the
 * same, and re-rendering a child never changes their wording.
 */

export function pick(options, seed = '') {
  if (!Array.isArray(options)) return options
  let h = 0
  for (const ch of String(seed)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return options[h % options.length]
}

const shared = {
  superpower: {
    kicker: 'IF YOU HAD ONE SUPERPOWER…',
    startLine: ['At the start of the year, you wished for', 'In the beginning, your superpower of choice was'],
    changedLine: ['By the end of the year, you’d rather have', 'Now? You’d pick'],
    sameLine: ['A whole year later, still the same choice. Some powers are forever!'],
    onlyLine: ['This year, the superpower you wished for was'],
  },
}

export const COPY = {
  mid: {
    title: 'My Year, My Story',
    dream: {
      kicker: 'THE DREAM',
      startLine: ['At the start of the year, you dreamed of becoming', 'When the year began, you wanted to be'],
      changedLine: ['As the year went on, your dream grew into', 'And by the end of the year, you’d set your sights on'],
      sameLine: ['And all year long, that dream never changed. That’s focus!', 'Twelve months later, the same dream, only stronger.'],
      onlyLine: ['This year, you dreamed of becoming'],
    },
    superpower: shared.superpower,
    freeTime: {
      kicker: 'YOUR HAPPY PLACE',
      startLine: ['At the start of the year, your free time was all about', 'In the first months, you loved'],
      changedLine: ['Lately, you can’t get enough of', 'Then a new favourite took over'],
      sameLine: ['Still your favourite thing in the world!'],
      onlyLine: ['Your favourite way to spend free time'],
    },
    outro: [
      'Keep dreaming big. The best chapters are still unwritten.',
      'What a year it has been. Here’s to an even bigger one!',
    ],
  },
  prep: {
    title: 'My Super Year',
    idol: {
      kicker: 'MY HERO',
      startLine: ['At the start of the year, your idol was', 'When the year began, your hero was'],
      changedLine: ['But as the year went on, you found a new hero', 'Then someone new inspired you'],
      sameLine: ['And all year long, they stayed your hero. True loyalty!'],
      onlyLine: ['This year, your hero was'],
    },
    dream: {
      kicker: 'WHEN I GROW UP…',
      startLine: ['At the start of the year, you wanted to be', 'You began the year dreaming of being'],
      changedLine: ['Now you’re dreaming of being', 'And now? You want to be'],
      sameLine: ['And you still do! A dream that big deserves to stay.'],
      onlyLine: ['When you grow up, you want to be'],
    },
    superpower: shared.superpower,
    food: { label: 'Favourite food' },
    sport: { label: 'Favourite sport' },
    festival: { label: 'Favourite festival' },
    outro: [
      'You had a super year. Get ready for an even better one!',
      'Keep shining, keep smiling, keep learning!',
    ],
  },
}

/** Used only when a key scene was unanswered in both rounds. */
export const FALLBACKS = {
  dream: {
    line: 'Your dream? The world can’t wait to find out.',
    answer: { text: 'Anything you set your mind to', emoji: '✨', raw: '' },
  },
}
