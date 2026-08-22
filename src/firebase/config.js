import { initializeApp } from 'firebase/app'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getStorage, connectStorageEmulator } from 'firebase/storage'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

const firebaseConfig = {
  apiKey: "AIzaSyC3q60cBqtvOytXP4O3iK99OeOlh7MgvTw",
  authDomain: "clarified-1501.firebaseapp.com",
  projectId: "clarified-1501",
  storageBucket: "clarified-1501.appspot.com",
  messagingSenderId: "270192308039",
  appId: "1:270192308039:web:4b17aeaa4065808e976662"
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const storage = getStorage(app)
export const auth = getAuth(app)
// Deployed region for our Cloud Functions — must match, or httpsCallable
// targets us-central1 by default and the request never reaches the function
// (which surfaces to the browser as a CORS error, same symptom as a missing
// Access-Control-Allow-Origin header).
export const functions = getFunctions(app, 'asia-south1')

// ── Local emulators ─────────────────────────────────────────────────────────
// Opt-in only, via `VITE_USE_EMULATORS=1 npm run dev` (see npm run dev:emulate).
// Vite statically replaces import.meta.env at build time, so a production build
// without the variable drops this branch entirely — a deployed bundle can never
// point at localhost. Guarded on DEV as well so it cannot be switched on in a
// build that is served to anyone.
if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === '1') {
  const host = import.meta.env.VITE_EMULATOR_HOST || '127.0.0.1'
  connectFirestoreEmulator(db, host, 8080)
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true })
  connectStorageEmulator(storage, host, 9199)
  connectFunctionsEmulator(functions, host, 5001)
  console.info(`[firebase] using local emulators on ${host}`)
}
