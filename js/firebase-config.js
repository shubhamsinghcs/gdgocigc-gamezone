/**
 * js/firebase-config.js
 * Firebase initialization & Firestore database reference
 * Uses environment variables (VITE_FIREBASE_*) with secure fallback
 */

import { initializeApp, getApps } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
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
let permissionErrorOccurred = false;

export function setFirebaseConnected(val) {
  isFirebaseConnected = Boolean(val);
  if (!val) {
    permissionErrorOccurred = true;
  }
}

export function isPermissionError() {
  return permissionErrorOccurred;
}

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
    // Provide compat wrapper for db.collection / doc / collection chaining
    if (db && !db.collection) {
      db.collection = function(colName) {
        return {
          doc: function(docId) {
            const cleanDocId = String(docId).trim();
            const docRef = doc(db, colName, cleanDocId);
            return {
              get: () => getDoc(docRef),
              set: (data, opts) => setDoc(docRef, data, opts || { merge: true }),
              update: (data) => updateDoc(docRef, data),
              onSnapshot: (cb, errCb) => onSnapshot(docRef, cb, errCb),
              collection: function(subColName) {
                const subColRef = collection(db, colName, cleanDocId, subColName);
                return {
                  doc: function(subDocId) {
                    const cleanSubDocId = String(subDocId).trim();
                    const subDocRef = doc(db, colName, cleanDocId, subColName, cleanSubDocId);
                    return {
                      get: () => getDoc(subDocRef),
                      set: (data, opts) => setDoc(subDocRef, data, opts || { merge: true }),
                      update: (data) => updateDoc(subDocRef, data),
                      onSnapshot: (cb, errCb) => onSnapshot(subDocRef, cb, errCb)
                    };
                  },
                  onSnapshot: (cb, errCb) => onSnapshot(subColRef, cb, errCb)
                };
              }
            };
          }
        };
      };
    }
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
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  serverTimestamp,
  isFirebaseConnected
};
