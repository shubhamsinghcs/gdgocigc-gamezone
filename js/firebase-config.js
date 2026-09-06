/**
 * js/firebase-config.js
 * Firebase initialization & Firestore database reference
 * Uses environment variables (VITE_FIREBASE_*) with secure fallback
 */

import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  serverTimestamp
} from 'firebase/firestore';

// Environment variable extraction (Vite import.meta.env support)
const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};

// Base configuration reading strictly from environment variables (no hardcoded keys)
export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || "",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: env.VITE_FIREBASE_APP_ID || "",
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || ""
};

let app = null;
let db = null;
let isFirebaseConnected = false;

// Only attempt initialization if environment variables are provided
if (firebaseConfig.apiKey && firebaseConfig.projectId) {
  try {
    const existingApps = getApps();
    if (existingApps.length > 0) {
      app = existingApps[0];
    } else {
      app = initializeApp(firebaseConfig);
    }
    db = getFirestore(app);
    isFirebaseConnected = true;
  } catch (error) {
    console.warn('[Firebase Firestore Init Warning - falling back to multi-tab sync]:', error);
    isFirebaseConnected = false;
  }
} else {
  // When no environment variables are defined (e.g. fresh clone from GitHub),
  // gracefully fall back to multi-tab BroadcastChannel & LocalStorage sync
  isFirebaseConnected = false;
}

export {
  app,
  db,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  serverTimestamp,
  isFirebaseConnected
};
