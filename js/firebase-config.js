/**
 * js/firebase-config.js
 * Firebase initialization & Firestore / Realtime DB references
 */

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getDatabase,
  ref,
  onValue,
  set
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

export const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAyI12myuSpTKxQcKUqwA99uWvI1VR2ODs",
  authDomain: "gdgocigc-gamezone.firebaseapp.com",
  databaseURL: "https://gdgocigc-gamezone-default-rtdb.firebaseio.com",
  projectId: "gdgocigc-gamezone",
  storageBucket: "gdgocigc-gamezone.firebasestorage.app",
  messagingSenderId: "483943536670",
  appId: "1:483943536670:web:00d84096fe02088b88360f",
  measurementId: "G-8VE8CPW7PV"
};

const CONFIG_STORAGE_KEY = 'fastest_finger_firebase_config';

export function getSavedFirebaseConfig() {
  if (typeof window === 'undefined') return DEFAULT_FIREBASE_CONFIG;
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback
  }
  return DEFAULT_FIREBASE_CONFIG;
}

export function saveFirebaseConfig(config) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  initFirebase(config);
}

let firebaseApp = null;
let rtdb = null;
let isFirebaseConnected = false;

export function initFirebase(customConfig) {
  try {
    const cfg = customConfig || getSavedFirebaseConfig();
    if (cfg.projectId && !cfg.databaseURL) {
      cfg.databaseURL = `https://${cfg.projectId}-default-rtdb.firebaseio.com`;
    }
    const existing = getApps();
    if (existing.length > 0) {
      firebaseApp = existing[0];
    } else {
      firebaseApp = initializeApp(cfg);
    }
    
    if (cfg.databaseURL && !cfg.databaseURL.includes('PLACEHOLDER')) {
      rtdb = getDatabase(firebaseApp, cfg.databaseURL);
      isFirebaseConnected = true;
    }
  } catch (err) {
    console.warn('[Firebase Init Warning - fallback active]:', err);
    isFirebaseConnected = false;
  }
  return { app: firebaseApp, db: rtdb, isConnected: () => isFirebaseConnected };
}

// Initialize on load
initFirebase();

export { rtdb, ref, onValue, set, isFirebaseConnected };
