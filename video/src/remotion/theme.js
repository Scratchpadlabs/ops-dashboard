// One theme per segment. Scenes read colours and fonts from here only, so a
// new template is mostly a new entry in this file.
const EMOJI = '"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"'

export const THEMES = {
  prep: {
    name: 'My Super Year',
    font: `"Baloo 2", ${EMOJI}, sans-serif`,
    music: 'music/sunny-steps.mp3',
    bg: ['#FFF4D6', '#FFE1E8', '#DDF4FF', '#E6FFE9'],
    blobs: ['#FFD23F', '#FF8FAB', '#5BC0EB', '#9BE564', '#B794F6'],
    ink: '#1F1B4D',
    soft: '#5B5784',
    card: '#FFFFFF',
    accent: '#FF6B35',
    accent2: '#2EC4B6',
    kickerBg: '#1F1B4D',
    kickerInk: '#FFD23F',
    bouncy: true,
  },
  mid: {
    name: 'My Year, My Story',
    font: `"Poppins", ${EMOJI}, sans-serif`,
    music: 'music/big-sky.mp3',
    bg: ['#17123B', '#1E1A5C', '#2A1B5C', '#0F2A4F'],
    blobs: ['#6D5DFC', '#FB7185', '#22D3EE', '#FBBF24'],
    ink: '#FFFFFF',
    soft: '#C7C2F5',
    card: 'rgba(255,255,255,0.10)',
    cardBorder: 'rgba(255,255,255,0.22)',
    accent: '#FBBF24',
    accent2: '#FB7185',
    kickerBg: 'rgba(251,191,36,0.16)',
    kickerInk: '#FBBF24',
    bouncy: false,
  },
}
