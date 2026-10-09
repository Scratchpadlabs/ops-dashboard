// Run with `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentBounds, fitWithin, bytesToBase64, base64ToBytes, LOGO_MAX_SIDE } from '../src/utils/pamphletLogo.js'

// RGBA image, w × h, filled with `bg`, with `fg` drawn in the given rects.
function image(w, h, bg, rects = [], fg = [10, 20, 30, 255]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(bg, i * 4)
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data.set(fg, (y * w + x) * 4)
  return data
}

test('PL-01 trims transparent padding around the artwork', () => {
  assert.deepEqual(contentBounds(image(20, 10, [0, 0, 0, 0], [[3, 2, 8, 6]]), 20, 10), { x: 3, y: 2, width: 6, height: 5 })
})

test('PL-02 trims a white (JPG-style) background too, and near-white noise', () => {
  const data = image(20, 10, [255, 255, 255, 255], [[5, 1, 5, 1], [12, 8, 14, 8]])
  data.set([250, 250, 250, 255], (0 * 20 + 0) * 4)   // compression speck: ignored
  assert.deepEqual(contentBounds(data, 20, 10), { x: 5, y: 1, width: 10, height: 8 })
})

test('PL-03 a blank image has no bounds', () => {
  assert.equal(contentBounds(image(4, 4, [255, 255, 255, 255]), 4, 4), null)
  assert.equal(contentBounds(image(4, 4, [0, 0, 0, 0]), 4, 4), null)
})

test('PL-04 big logos scale down to the max side, small ones are never scaled up', () => {
  assert.deepEqual(fitWithin(4000, 1000), { width: LOGO_MAX_SIDE, height: LOGO_MAX_SIDE / 4 })
  assert.deepEqual(fitWithin(68, 68), { width: 68, height: 68 })
  assert.deepEqual(fitWithin(1000, 3000), { width: 267, height: LOGO_MAX_SIDE })
})

test('PL-05 base64 round-trips, including large buffers', () => {
  const bytes = new Uint8Array(200000).map((_, i) => (i * 31) % 256)
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes)
})
