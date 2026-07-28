import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getAuth } from 'firebase/auth'
import { getFunctions } from 'firebase/functions'

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
