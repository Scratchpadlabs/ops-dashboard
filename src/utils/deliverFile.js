/**
 * Hand a file built in the browser to the user, without the browser
 * blocking it.
 *
 * Chrome/Brave/Edge only let a page start a download on its own shortly after
 * a click (the page's "transient user activation", ~5 s). A download that
 * starts later — after loading seven classes' remarks, say, or building a
 * zip server-side — is held back as "Needs permission to download" once the
 * site has used its one free download. So:
 *
 *   - still within the click's window  -> download at once, as before
 *   - past it                          -> keep the file as `pendingFile`;
 *     the page shows a "Save" button, and that click downloads it
 *
 * Browsers without navigator.userActivation (older Safari/Firefox) don't
 * gate downloads this way, so they always get the direct download.
 */
import { ref } from 'vue'

/** { name, url, size } of a file waiting for a click, or null. */
export const pendingFile = ref(null)

function clickDownload(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked late: some browsers read the blob after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** @returns 'downloaded' or 'pending' (waiting for the Save click) */
export function deliverFile(blob, filename) {
  const url = URL.createObjectURL(blob)
  const activation = typeof navigator !== 'undefined' ? navigator.userActivation : null
  if (activation && !activation.isActive) {
    discardPending()
    pendingFile.value = { name: filename, url, size: blob.size }
    return 'pending'
  }
  clickDownload(url, filename)
  return 'downloaded'
}

/** A server-built report ({ filename, mime, content_base64 }) — the shape
 *  every report callable in utils/api.js returns. */
export function deliverReport({ filename, mime, content_base64 }) {
  const bytes = Uint8Array.from(atob(content_base64), c => c.charCodeAt(0))
  return deliverFile(new Blob([bytes], { type: mime }), filename)
}

/** Called from the Save button's own click, so the browser allows it. */
export function savePending() {
  const file = pendingFile.value
  if (!file) return
  pendingFile.value = null
  clickDownload(file.url, file.name)
}

export function discardPending() {
  if (pendingFile.value) URL.revokeObjectURL(pendingFile.value.url)
  pendingFile.value = null
}
