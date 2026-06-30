import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

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
