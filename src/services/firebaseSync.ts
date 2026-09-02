import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  onValue,
  set,
  update,
  runTransaction,
  Database,
  Unsubscribe
} from 'firebase/database';
import { GameState, Player, FastestWinner, QuestionWinnerEntry, FirebaseConfig } from '../types';

export const DEFAULT_FIREBASE_CONFIG: FirebaseConfig = {
  apiKey: "AIzaSy_TECH_CLASH_DEMO_KEY_PLACEHOLDER",
  authDomain: "tech-clash-live.firebaseapp.com",
  databaseURL: "https://tech-clash-live-default-rtdb.firebaseio.com",
  projectId: "tech-clash-live",
  storageBucket: "tech-clash-live.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef123456"
};

const CONFIG_STORAGE_KEY = 'fastest_finger_firebase_config';
const LOCAL_GAME_KEY = 'fastest_finger_local_game_state';
const LOCAL_PLAYERS_KEY = 'fastest_finger_local_players';

// Channel for instant multi-window / multi-tab synchronization
const broadcast = typeof window !== 'undefined' && 'BroadcastChannel' in window
  ? new BroadcastChannel('fastest_finger_tech_clash_sync')
  : null;

let firebaseApp: FirebaseApp | null = null;
let rtdb: Database | null = null;
let isFirebaseConnected = false;

export function getSavedFirebaseConfig(): FirebaseConfig {
  if (typeof window === 'undefined') return DEFAULT_FIREBASE_CONFIG;
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // fallback
  }
  return DEFAULT_FIREBASE_CONFIG;
}

export function saveFirebaseConfig(config: FirebaseConfig): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  initFirebase(config);
}

export function isUsingCustomFirebaseConfig(): boolean {
  const current = getSavedFirebaseConfig();
  return current.apiKey !== DEFAULT_FIREBASE_CONFIG.apiKey && !current.apiKey.includes('PLACEHOLDER');
}

export function initFirebase(customConfig?: FirebaseConfig): { app: FirebaseApp | null; db: Database | null } {
  try {
    const cfg = customConfig || getSavedFirebaseConfig();
    const existing = getApps();
    if (existing.length > 0) {
      firebaseApp = existing[0];
    } else {
      firebaseApp = initializeApp(cfg);
    }
    
    // Only attempt RTDB if databaseURL is valid
    if (cfg.databaseURL && !cfg.databaseURL.includes('PLACEHOLDER')) {
      rtdb = getDatabase(firebaseApp);
      isFirebaseConnected = true;
    }
  } catch (err) {
    console.warn('[Firebase RTDB Init Warning - fallback active]:', err);
    isFirebaseConnected = false;
  }
  return { app: firebaseApp, db: rtdb };
}

// Initial initialization
initFirebase();

// Local store fallback state
function getInitialGameState(): GameState {
  if (typeof window === 'undefined') {
    return {
      currentQuestionIndex: -1,
      questionStartTime: Date.now(),
      isTimerActive: false,
      timerDurationSec: 15,
      showAnswer: false,
      fastestWinner: null,
      questionWinners: {}
    };
  }
  try {
    const saved = localStorage.getItem(LOCAL_GAME_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // ignore
  }
  return {
    currentQuestionIndex: -1,
    questionStartTime: Date.now(),
    isTimerActive: false,
    timerDurationSec: 15,
    showAnswer: false,
    fastestWinner: null,
    questionWinners: {}
  };
}

let localGameState: GameState = getInitialGameState();
let localPlayers: Record<string, Player> = (() => {
  if (typeof window === 'undefined') return {};
  try {
    const saved = localStorage.getItem(LOCAL_PLAYERS_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // ignore
  }
  return {};
})();

function saveLocalState() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOCAL_GAME_KEY, JSON.stringify(localGameState));
    localStorage.setItem(LOCAL_PLAYERS_KEY, JSON.stringify(localPlayers));
  } catch {
    // ignore
  }
}

// Subscriptions
const gameSubscribers: Set<(state: GameState) => void> = new Set();
const playersSubscribers: Set<(players: Record<string, Player>) => void> = new Set();

function notifyGameSubscribers() {
  gameSubscribers.forEach(cb => cb({ ...localGameState }));
  if (broadcast) {
    broadcast.postMessage({ type: 'GAME_STATE_UPDATE', state: localGameState });
  }
  saveLocalState();
}

function notifyPlayersSubscribers() {
  playersSubscribers.forEach(cb => cb({ ...localPlayers }));
  if (broadcast) {
    broadcast.postMessage({ type: 'PLAYERS_UPDATE', players: localPlayers });
  }
  saveLocalState();
}

// Broadcast message listener
if (broadcast) {
  broadcast.onmessage = (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'GAME_STATE_UPDATE' && data.state) {
      localGameState = data.state;
      gameSubscribers.forEach(cb => cb({ ...localGameState }));
    } else if (data.type === 'PLAYERS_UPDATE' && data.players) {
      localPlayers = data.players;
      playersSubscribers.forEach(cb => cb({ ...localPlayers }));
    }
  };
}

// Cross-tab storage event listener
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === LOCAL_GAME_KEY && e.newValue) {
      try {
        localGameState = JSON.parse(e.newValue);
        gameSubscribers.forEach(cb => cb({ ...localGameState }));
      } catch {}
    } else if (e.key === LOCAL_PLAYERS_KEY && e.newValue) {
      try {
        localPlayers = JSON.parse(e.newValue);
        playersSubscribers.forEach(cb => cb({ ...localPlayers }));
      } catch {}
    }
  });
}

/**
 * Listen to /game state
 */
export function listenToGameState(callback: (state: GameState) => void): Unsubscribe {
  gameSubscribers.add(callback);
  callback({ ...localGameState });

  let rtdbUnsub: Unsubscribe | null = null;
  if (rtdb) {
    try {
      const gameRef = ref(rtdb, 'game');
      rtdbUnsub = onValue(gameRef, (snapshot) => {
        const val = snapshot.val();
        if (val) {
          localGameState = {
            currentQuestionIndex: val.currentQuestionIndex ?? -1,
            questionStartTime: val.questionStartTime ?? Date.now(),
            isTimerActive: val.isTimerActive ?? false,
            timerDurationSec: val.timerDurationSec ?? 15,
            showAnswer: val.showAnswer ?? false,
            fastestWinner: val.fastestWinner ?? null,
            questionWinners: val.questionWinners ?? {}
          };
          callback({ ...localGameState });
        }
      });
    } catch (e) {
      console.warn('Firebase game listener failed, using local broadcast channel:', e);
    }
  }

  return () => {
    gameSubscribers.delete(callback);
    if (rtdbUnsub) rtdbUnsub();
  };
}

/**
 * Listen to /players list
 */
export function listenToPlayers(callback: (players: Record<string, Player>) => void): Unsubscribe {
  playersSubscribers.add(callback);
  callback({ ...localPlayers });

  let rtdbUnsub: Unsubscribe | null = null;
  if (rtdb) {
    try {
      const playersRef = ref(rtdb, 'players');
      rtdbUnsub = onValue(playersRef, (snapshot) => {
        const val = snapshot.val();
        if (val) {
          localPlayers = val;
          callback({ ...localPlayers });
        }
      });
    } catch (e) {
      console.warn('Firebase players listener failed, using local broadcast channel:', e);
    }
  }

  return () => {
    playersSubscribers.delete(callback);
    if (rtdbUnsub) rtdbUnsub();
  };
}

/**
 * Set current question index and reset round states
 */
export async function setQuestionIndex(index: number): Promise<void> {
  const now = Date.now();
  localGameState = {
    ...localGameState,
    currentQuestionIndex: index,
    questionStartTime: now,
    isTimerActive: index >= 0,
    showAnswer: false,
    fastestWinner: null
  };
  notifyGameSubscribers();

  if (rtdb) {
    try {
      const gameRef = ref(rtdb, 'game');
      await update(gameRef, {
        currentQuestionIndex: index,
        questionStartTime: now,
        isTimerActive: index >= 0,
        showAnswer: false,
        fastestWinner: null
      });
    } catch (err) {
      console.warn('Firebase RTDB setQuestionIndex:', err);
    }
  }
}

/**
 * Restart or toggle the 15-second timer
 */
export async function restartTimer(): Promise<void> {
  const now = Date.now();
  localGameState = {
    ...localGameState,
    questionStartTime: now,
    isTimerActive: true
  };
  notifyGameSubscribers();

  if (rtdb) {
    try {
      await update(ref(rtdb, 'game'), {
        questionStartTime: now,
        isTimerActive: true
      });
    } catch (err) {
      console.warn('Firebase RTDB restartTimer:', err);
    }
  }
}

/**
 * Toggle answer visibility for big screen
 */
export async function toggleShowAnswer(show: boolean): Promise<void> {
  localGameState = {
    ...localGameState,
    showAnswer: show
  };
  notifyGameSubscribers();

  if (rtdb) {
    try {
      await update(ref(rtdb, 'game'), { showAnswer: show });
    } catch (err) {
      console.warn('Firebase RTDB toggleShowAnswer:', err);
    }
  }
}

/**
 * Reset game back to Lobby (questionIndex = -1)
 */
export async function resetGame(): Promise<void> {
  localGameState = {
    currentQuestionIndex: -1,
    questionStartTime: Date.now(),
    isTimerActive: false,
    timerDurationSec: 15,
    showAnswer: false,
    fastestWinner: null,
    questionWinners: {}
  };
  notifyGameSubscribers();

  if (rtdb) {
    try {
      await set(ref(rtdb, 'game'), {
        currentQuestionIndex: -1,
        questionStartTime: Date.now(),
        isTimerActive: false,
        timerDurationSec: 15,
        showAnswer: false,
        fastestWinner: null,
        questionWinners: {}
      });
    } catch (err) {
      console.warn('Firebase RTDB resetGame:', err);
    }
  }
}

/**
 * Reset all player scores to 0
 */
export async function resetAllScores(): Promise<void> {
  const updated: Record<string, Player> = {};
  Object.keys(localPlayers).forEach(id => {
    updated[id] = {
      ...localPlayers[id],
      score: 0,
      answeredQuestions: {}
    };
  });
  localPlayers = updated;
  notifyPlayersSubscribers();

  localGameState = {
    ...localGameState,
    fastestWinner: null,
    questionWinners: {}
  };
  notifyGameSubscribers();

  if (rtdb) {
    try {
      await set(ref(rtdb, 'players'), updated);
      await update(ref(rtdb, 'game'), {
        fastestWinner: null,
        questionWinners: {}
      });
    } catch (err) {
      console.warn('Firebase RTDB resetAllScores:', err);
    }
  }
}

/**
 * Register or update active player under /players/{playerId}
 */
export async function registerPlayer(player: Player): Promise<void> {
  localPlayers = {
    ...localPlayers,
    [player.id]: {
      ...player,
      lastActive: Date.now(),
      isOnline: true
    }
  };
  notifyPlayersSubscribers();

  if (rtdb) {
    try {
      const playerRef = ref(rtdb, `players/${player.id}`);
      await set(playerRef, {
        ...player,
        lastActive: Date.now(),
        isOnline: true
      });
    } catch (err) {
      console.warn('Firebase RTDB registerPlayer:', err);
    }
  }
}

/**
 * Answer submission with atomic speed race lock
 */
export async function submitAnswer(
  player: Player,
  questionIndex: number,
  selectedIndex: number,
  isCorrect: boolean
): Promise<{ isFastest: boolean; deltaMs: number; scoreEarned: number }> {
  const now = Date.now();
  const deltaMs = Math.max(0, now - localGameState.questionStartTime);
  const scoreEarned = isCorrect ? 2 : 0;

  // 1. Update player record
  const updatedPlayer: Player = {
    ...player,
    score: (player.score || 0) + scoreEarned,
    lastActive: now,
    answeredQuestions: {
      ...(player.answeredQuestions || {}),
      [questionIndex]: {
        selectedIndex,
        isCorrect,
        timestamp: now,
        deltaMs
      }
    }
  };

  localPlayers[player.id] = updatedPlayer;
  notifyPlayersSubscribers();

  let isFastestWinner = false;

  // 2. Speed race check if answer is correct
  if (isCorrect) {
    const currentFastest = localGameState.fastestWinner;
    // If no fastest winner yet for this question
    if (!currentFastest || currentFastest.questionIndex !== questionIndex) {
      const winnerData: FastestWinner = {
        playerId: player.id,
        name: player.name,
        branch: player.branch,
        timestamp: now,
        deltaMs,
        questionIndex
      };
      localGameState.fastestWinner = winnerData;
      isFastestWinner = true;
    }

    // Add to sub-leaderboard entries for this question
    const existingList = localGameState.questionWinners[questionIndex] || [];
    const alreadyListed = existingList.some(e => e.playerId === player.id);
    if (!alreadyListed) {
      const updatedList = [
        ...existingList,
        {
          playerId: player.id,
          name: player.name,
          branch: player.branch,
          deltaMs,
          timestamp: now
        }
      ].sort((a, b) => a.deltaMs - b.deltaMs);

      localGameState.questionWinners = {
        ...localGameState.questionWinners,
        [questionIndex]: updatedList
      };
    }

    notifyGameSubscribers();
  }

  // 3. Execute with Firebase Realtime Database Transaction if connected
  if (rtdb) {
    try {
      // Update player
      await update(ref(rtdb, `players/${player.id}`), {
        score: updatedPlayer.score,
        lastActive: now,
        [`answeredQuestions/${questionIndex}`]: {
          selectedIndex,
          isCorrect,
          timestamp: now,
          deltaMs
        }
      });

      // Firebase Transaction for atomic speed lockout
      if (isCorrect) {
        const fastestWinnerRef = ref(rtdb, 'game/fastestWinner');
        await runTransaction(fastestWinnerRef, (currentData) => {
          if (currentData === null || currentData.questionIndex !== questionIndex) {
            return {
              playerId: player.id,
              name: player.name,
              branch: player.branch,
              timestamp: now,
              deltaMs,
              questionIndex
            };
          }
          return undefined; // abort if already claimed
        });

        // Record in sub-leaderboard on Firebase
        const subListRef = ref(rtdb, `game/questionWinners/${questionIndex}/${player.id}`);
        await set(subListRef, {
          playerId: player.id,
          name: player.name,
          branch: player.branch,
          deltaMs,
          timestamp: now
        });
      }
    } catch (err) {
      console.warn('Firebase transaction / submitAnswer error:', err);
    }
  }

  return { isFastest: isFastestWinner, deltaMs, scoreEarned };
}

/**
 * Seed simulated participants for instant projector testing
 */
export async function seedDemoClashPlayers(): Promise<void> {
  const sampleParticipants: Omit<Player, 'id'>[] = [
    { name: 'Aarav Sharma', branch: 'CSE', score: 18, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Priya Iyer', branch: 'ECE', score: 22, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Rohan Verma', branch: 'IT', score: 16, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Ananya Deshmukh', branch: 'CSE', score: 24, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Vikramaditya Nair', branch: 'ME', score: 14, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Sneha Patel', branch: 'CE', score: 12, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Kavya Reddy', branch: 'ECE', score: 20, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Tanmay Joshi', branch: 'IT', score: 18, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Aditya Gupta', branch: 'Other', score: 10, answeredQuestions: {}, lastActive: Date.now(), isOnline: true },
    { name: 'Ishita Bansal', branch: 'CSE', score: 26, answeredQuestions: {}, lastActive: Date.now(), isOnline: true }
  ];

  const populated: Record<string, Player> = {};
  sampleParticipants.forEach((p, idx) => {
    const id = `demo_player_${idx + 1}`;
    populated[id] = { ...p, id };
  });

  localPlayers = { ...localPlayers, ...populated };
  notifyPlayersSubscribers();

  if (rtdb) {
    try {
      await update(ref(rtdb, 'players'), populated);
    } catch (err) {
      console.warn('Firebase RTDB seed error:', err);
    }
  }
}
