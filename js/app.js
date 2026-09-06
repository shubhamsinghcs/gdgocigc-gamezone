/**
 * js/app.js
 * Real-Time Systems State Machine & Game Synchronization Engine
 * Powered by Firebase Firestore with Multi-Tab Broadcast fallback
 */

import {
  db,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  isFirebaseConnected
} from './firebase-config.js';
import { questionsData, getActiveQuestions } from './questions.js';
import { playCorrectSound, playWrongSound, playWinnerFanfare } from './audio.js';
import { renderLeaderboardHTML, calculateBranchStats, sortPlayers } from './leaderboard.js';

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const DEFAULT_ROOM_PIN = '4829';
const HOST_AUTH_PASSWORD = 'ssr23!@';
const ROOM_DOC_ID = `room_${DEFAULT_ROOM_PIN}`;

// Helper: Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// CORE STATE ENGINE
// ==========================================
let currentView = 'landing'; // 'landing' | 'player_register' | 'player_game' | 'presenter_big_screen'
let isHost = false;
let currentPlayer = null;
let pendingPlayer = null;
let soundEnabled = true;
let showRulesModal = false;
let showHostLoginModal = false;
let hostLoginError = '';
let showQuestionManagerModal = false;

// Canonical Game State
let gameState = {
  status: 'LOBBY', // 'LOBBY' | 'QUESTION_ACTIVE' | 'LEADERBOARD' | 'FINISHED'
  currentQuestionIndex: -1,
  questionStartTime: Date.now(),
  timerDurationSec: 10,
  showAnswer: false,
  fastestWinner: null,
  questions: questionsData,
  roomPin: DEFAULT_ROOM_PIN,
  updatedAt: Date.now()
};

let players = {};

// Timer tracking references to prevent race conditions
let currentTimerInterval = null;
let autoAdvanceTimeout = null;

function cleanupTimers() {
  if (currentTimerInterval) {
    clearInterval(currentTimerInterval);
    currentTimerInterval = null;
  }
  if (autoAdvanceTimeout) {
    clearTimeout(autoAdvanceTimeout);
    autoAdvanceTimeout = null;
  }
}

// Check session for persisted host authentication
if (typeof window !== 'undefined') {
  try {
    if (sessionStorage.getItem('gdgoc_is_host') === 'true') {
      isHost = true;
    }
    const savedPlayer = localStorage.getItem('gdgoc_current_player');
    if (savedPlayer) {
      currentPlayer = JSON.parse(savedPlayer);
    }
  } catch {
    // ignore
  }
}

// ==========================================
// MULTI-TAB BROADCAST CHANNEL FALLBACK
// ==========================================
const broadcastChannel = typeof window !== 'undefined' ? new BroadcastChannel('gdgoc_igc_game_zone_channel') : null;

if (broadcastChannel) {
  broadcastChannel.onmessage = (event) => {
    if (!event.data) return;
    if (event.data.type === 'STATE_UPDATE') {
      handleStateTransition(event.data.gameState);
    } else if (event.data.type === 'PLAYERS_UPDATE') {
      players = event.data.players;
      syncCurrentPlayerReference();
      renderApp();
    }
  };
}

function broadcastLocalState() {
  if (broadcastChannel) {
    broadcastChannel.postMessage({ type: 'STATE_UPDATE', gameState });
    broadcastChannel.postMessage({ type: 'PLAYERS_UPDATE', players });
  }
}

// ==========================================
// ZERO-DRIFT SYNCHRONIZED TIMER HELPER
// ==========================================
/**
 * Mathematical Zero-Drift Clock:
 * Remaining Time = max(0, 10 - floor((Date.now() - questionStartTime) / 1000))
 */
export function getRemainingTimeSeconds(questionStartTime) {
  if (!questionStartTime) return 10;
  const elapsedSeconds = Math.floor((Date.now() - questionStartTime) / 1000);
  return Math.max(0, 10 - elapsedSeconds);
}

export function getRemainingTimeSubseconds(questionStartTime) {
  if (!questionStartTime) return 10.0;
  const elapsed = (Date.now() - questionStartTime) / 1000;
  return Math.max(0, 10 - elapsed);
}

// ==========================================
// FIRESTORE REAL-TIME SYNCHRONIZATION
// ==========================================
let roomUnsubscribe = null;
let playersUnsubscribe = null;

function initFirestoreSync() {
  if (!db || !isFirebaseConnected) {
    console.info('[Sync Info] Operating with high-speed multi-tab BroadcastChannel sync engine.');
    loadLocalCachedState();
    return;
  }

  try {
    const roomRef = doc(db, 'game_rooms', ROOM_DOC_ID);

    // 1. Listen for room state updates
    roomUnsubscribe = onSnapshot(roomRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        handleStateTransition(data);
      } else {
        // Bootstrap initial room document if it does not exist yet
        setDoc(roomRef, gameState).catch((err) => {
          console.warn('Initial room bootstrap warning:', err);
        });
      }
    }, (err) => {
      console.warn('Firestore room snapshot error, using local fallback:', err);
      loadLocalCachedState();
    });

    // 2. Listen for player participants collection
    const playersCol = collection(db, 'game_rooms', ROOM_DOC_ID, 'players');
    playersUnsubscribe = onSnapshot(playersCol, (snapshot) => {
      const updatedPlayers = {};
      snapshot.forEach((pDoc) => {
        updatedPlayers[pDoc.id] = pDoc.data();
      });
      players = updatedPlayers;
      syncCurrentPlayerReference();
      renderApp();
    }, (err) => {
      console.warn('Firestore players snapshot error:', err);
    });

  } catch (err) {
    console.warn('[Firestore Setup Notice]:', err);
    loadLocalCachedState();
  }
}

function loadLocalCachedState() {
  try {
    const savedGame = localStorage.getItem('gdgoc_game_state');
    if (savedGame) gameState = JSON.parse(savedGame);
    const savedPlayers = localStorage.getItem('gdgoc_players');
    if (savedPlayers) players = JSON.parse(savedPlayers);
  } catch {
    // ignore
  }
  syncCurrentPlayerReference();
  renderApp();
}

function syncCurrentPlayerReference() {
  if (currentPlayer && players[currentPlayer.id]) {
    currentPlayer = players[currentPlayer.id];
    if (typeof window !== 'undefined') {
      localStorage.setItem('gdgoc_current_player', JSON.stringify(currentPlayer));
    }
  }
}

// ==========================================
// DETERMINISTIC STATE MACHINE
// ==========================================
function handleStateTransition(incomingState) {
  if (!incomingState) return;

  cleanupTimers();
  gameState = { ...gameState, ...incomingState };

  if (typeof window !== 'undefined') {
    localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
  }

  switch (gameState.status) {
    case 'LOBBY':
      // Participants in game view see the lobby waiting screen
      break;

    case 'QUESTION_ACTIVE':
      startLocalCountdown(gameState.questionStartTime);
      break;

    case 'LEADERBOARD':
      // Step C: Host client handles single 3-second auto-advance to next question
      if (isHost) {
        autoAdvanceTimeout = setTimeout(() => {
          const activeQs = getActiveQuestions(gameState.questions);
          const nextIndex = (gameState.currentQuestionIndex || 0) + 1;

          if (nextIndex >= activeQs.length) {
            updateRoomDoc({
              status: 'FINISHED',
              currentQuestionIndex: nextIndex,
              updatedAt: Date.now()
            });
          } else {
            updateRoomDoc({
              status: 'QUESTION_ACTIVE',
              currentQuestionIndex: nextIndex,
              questionStartTime: Date.now(),
              showAnswer: false,
              fastestWinner: null,
              updatedAt: Date.now()
            });
          }
        }, 3000);
      }
      break;

    case 'FINISHED':
      if (soundEnabled) playWinnerFanfare();
      break;
  }

  renderApp();
}

function startLocalCountdown(startTime) {
  currentTimerInterval = setInterval(() => {
    const remainingSec = getRemainingTimeSubseconds(startTime);
    const timerDisplay = document.getElementById('seconds-left-display');
    const progressBar = document.getElementById('timer-progress-bar');
    const autoBadge = document.getElementById('leaderboard-auto-timer');

    if (timerDisplay) {
      timerDisplay.textContent = remainingSec.toFixed(1) + 's';
      if (remainingSec <= 3.0) {
        timerDisplay.className = 'text-sm font-extrabold text-rose-400 animate-pulse';
      } else {
        timerDisplay.className = 'text-sm font-extrabold text-cyan-400';
      }
    }

    if (progressBar) {
      const pct = Math.min(100, Math.max(0, (remainingSec / 10) * 100));
      progressBar.style.width = pct + '%';
      if (remainingSec <= 3.0) {
        progressBar.className = 'h-full transition-all duration-100 bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.6)]';
      } else {
        progressBar.className = 'h-full transition-all duration-100 bg-gradient-to-r from-cyan-500 to-amber-400';
      }
    }

    if (autoBadge) {
      const secs = Math.max(0, Math.ceil(3 - (Date.now() - (gameState.updatedAt || Date.now())) / 1000));
      autoBadge.textContent = `Advancing in ${secs}s...`;
    }

    // Lock option buttons immediately upon timer expiration
    if (remainingSec <= 0) {
      document.querySelectorAll('.option-btn:not([disabled])').forEach((btn) => {
        btn.setAttribute('disabled', 'true');
        btn.classList.add('opacity-50', 'cursor-not-allowed');
      });
      if (currentTimerInterval) {
        clearInterval(currentTimerInterval);
        currentTimerInterval = null;
      }
    }
  }, 100);
}

// ==========================================
// FIRESTORE MUTATION WRAPPERS
// ==========================================
function updateRoomDoc(partialState) {
  gameState = { ...gameState, ...partialState };
  if (db && isFirebaseConnected) {
    const roomRef = doc(db, 'game_rooms', ROOM_DOC_ID);
    setDoc(roomRef, gameState, { merge: true }).catch((err) => {
      console.warn('Firestore update error:', err);
    });
  } else {
    localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
    broadcastLocalState();
  }
  handleStateTransition(gameState);
}

function savePlayerToDB(player) {
  players[player.id] = player;
  syncCurrentPlayerReference();
  if (db && isFirebaseConnected) {
    const playerRef = doc(db, 'game_rooms', ROOM_DOC_ID, 'players', player.id);
    setDoc(playerRef, player, { merge: true }).catch((err) => {
      console.warn('Firestore player save error:', err);
    });
  } else {
    localStorage.setItem('gdgoc_players', JSON.stringify(players));
    broadcastLocalState();
  }
}

// ==========================================
// ROUTER & VIEW RENDERER
// ==========================================
function renderApp() {
  const root = document.getElementById('app-root');
  if (!root) return;

  if (currentView === 'landing') {
    root.innerHTML = renderLandingHTML();
    bindLandingEvents();
  } else if (currentView === 'player_register') {
    root.innerHTML = renderPlayerRegisterHTML();
    bindPlayerRegisterEvents();
  } else if (currentView === 'player_game') {
    root.innerHTML = renderPlayerGameHTML();
    bindPlayerGameEvents();
  } else if (currentView === 'presenter_big_screen') {
    root.innerHTML = renderPresenterHTML();
    bindPresenterEvents();
  }
}

// ==========================================
// VIEW 1: LANDING SCREEN
// ==========================================
function renderLandingHTML() {
  const nameVal = currentPlayer?.name || '';
  const branchVal = currentPlayer?.branch || 'CSE';
  const branches = ['CSE', 'ECE', 'IT', 'ME', 'CE', 'Other'];
  const playerCount = Object.keys(players).length;

  return `
    <div class="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col justify-between p-4 md:p-6 relative overflow-hidden">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(66,133,244,0.1),transparent_60%)] pointer-events-none"></div>

      <!-- Top Navigation Bar -->
      <header class="flex items-center justify-between w-full max-w-5xl mx-auto relative z-10 pb-4 border-b border-slate-800/80 gap-2 sm:gap-4">
        <!-- Left Side: GDG Full Logo -->
        <div class="flex items-center flex-1 justify-start min-w-0">
          <div class="h-9 sm:h-12 w-auto max-w-[170px] sm:max-w-[260px] flex items-center">
            <img src="./gdg_clean.svg" alt="Google Developer Groups On Campus · Indo Global College" class="w-full h-full object-contain object-left" />
          </div>
        </div>

        <!-- Middle: Game Zone in Google Brand Colours -->
        <div class="flex items-center justify-center shrink-0 px-2 sm:px-4">
          <h1 class="font-display font-black text-xl sm:text-2xl md:text-3xl tracking-tight select-none flex items-center drop-shadow-[0_2px_12px_rgba(66,133,244,0.3)]">
            <span class="text-[#4285F4]">G</span><span class="text-[#EA4335]">a</span><span class="text-[#FBBC05]">m</span><span class="text-[#34A853]">e</span>
            <span class="inline-block w-1.5 sm:w-2.5"></span>
            <span class="text-[#4285F4]">Z</span><span class="text-[#EA4335]">o</span><span class="text-[#FBBC05]">n</span><span class="text-[#34A853]">e</span>
          </h1>
        </div>

        <!-- Right Side: Online Counter & Host Login -->
        <div class="flex items-center gap-2 sm:gap-3 flex-1 justify-end">
          <div class="hidden md:flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-full bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 whitespace-nowrap">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>${playerCount} Online Folks</span>
          </div>
          <button id="btn-host-login" class="px-3 sm:px-3.5 py-1.5 sm:py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 hover:text-white font-mono text-xs font-bold flex items-center gap-1.5 sm:gap-2 cursor-pointer transition whitespace-nowrap">
            <svg class="w-3.5 h-3.5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <span>Host Login</span>
          </button>
        </div>
      </header>

      <!-- Center Registration Card -->
      <main class="w-full max-w-xl mx-auto my-auto py-8 relative z-10">
        <div class="material-card rounded-3xl p-6 sm:p-10 space-y-6">
          <div class="space-y-1.5">
            <h2 class="text-2xl sm:text-3xl font-extrabold text-white font-display tracking-tight">Sign-In</h2>
            <p class="text-xs sm:text-sm text-slate-400 font-mono">Enter your name and Code</p>
          </div>

          <div id="reg-error" class="hidden p-3.5 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs font-mono flex items-center gap-2"></div>

          <form id="form-landing-register" class="space-y-5">
            <div>
              <label for="input-player-name" class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-2 font-semibold">STUDENT FULL NAME *</label>
              <input
                id="input-player-name"
                type="text"
                value="${nameVal}"
                placeholder="e.g. Rahul Sharma"
                maxlength="28"
                class="w-full bg-slate-950/80 border border-slate-700 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-sm text-white focus:outline-none font-mono transition"
                autocomplete="name"
                required
              />
            </div>

            <div>
              <label for="select-player-branch" class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-2 font-semibold">BRANCH *</label>
              <select
                id="select-player-branch"
                class="w-full bg-slate-950/80 border border-slate-700 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-sm text-white focus:outline-none font-mono transition cursor-pointer"
              >
                ${branches.map(b => `<option value="${b}" ${b === branchVal ? 'selected' : ''}>${b}</option>`).join('')}
              </select>
            </div>

            <div>
              <label for="input-game-pin" class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-2 font-semibold">GAME PIN CODE *</label>
              <input
                id="input-game-pin"
                type="text"
                placeholder="Ask host for PIN (e.g. ${gameState.roomPin || DEFAULT_ROOM_PIN})"
                value="${gameState.roomPin || DEFAULT_ROOM_PIN}"
                maxlength="6"
                class="w-full bg-slate-950/80 border border-slate-700 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-sm text-white focus:outline-none font-mono transition tracking-widest font-bold"
                autocomplete="off"
                required
              />
            </div>

            <button
              type="submit"
              id="btn-submit-register"
              class="w-full py-4 px-6 rounded-2xl bg-[#4285F4] hover:bg-[#3367D6] active:bg-[#2A56C6] text-white font-bold font-mono tracking-wider uppercase transition shadow-lg shadow-blue-500/25 cursor-pointer text-sm flex items-center justify-center gap-2 mt-2"
            >
              <span>ENTER SPEED ARENA</span>
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
            </button>
          </form>
        </div>
      </main>

      <footer class="w-full max-w-5xl mx-auto py-3 border-t border-slate-800/80 text-center font-mono text-xs text-slate-400 relative z-10">
        Built by Google Developer Groups on Campus IGC Team for community with love.
      </footer>

      <!-- Rules Modal -->
      ${showRulesModal ? `
        <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="material-card rounded-3xl max-w-lg w-full p-6 sm:p-8 space-y-5 border border-slate-700 relative animate-scale-up">
            <div class="flex items-center justify-between pb-3 border-b border-slate-800">
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full bg-[#4285F4]"></span>
                <h3 class="text-lg font-bold text-white font-display">Competition Rules</h3>
              </div>
              <button id="btn-close-rules" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            <div class="space-y-3.5 text-xs text-slate-300 font-mono leading-relaxed">
              <div class="flex items-start gap-2.5">
                <span class="text-cyan-400 mt-0.5 shrink-0">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                </span>
                <div><strong class="text-white">10-Second Speed Clash:</strong> Each round has a strict synchronized 10.0-second countdown timer. Lock in your choice before the timer expires.</div>
              </div>
              <div class="flex items-start gap-2.5">
                <span class="text-emerald-400 mt-0.5 shrink-0">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>
                </span>
                <div><strong class="text-emerald-400">Dynamic Points:</strong> Earn <span class="text-emerald-300 font-bold">Remaining Seconds × 5 Points</span> for every correct answer. Faster answers = higher score!</div>
              </div>
              <div class="flex items-start gap-2.5">
                <span class="text-amber-400 mt-0.5 shrink-0">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                </span>
                <div><strong class="text-amber-300">Fastest Finger Bonus:</strong> The absolute first correct combatant receives <span class="text-amber-400 font-bold">+2 Bonus Points</span> and special fanfare.</div>
              </div>
              <div class="flex items-start gap-2.5">
                <span class="text-purple-400 mt-0.5 shrink-0">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.45 1-1 1H7v2h10v-2h-2c-.55 0-1-.45-1-1v-2.34c0-.98.54-1.89 1.4-2.36l1.6-.87C17.67 11.05 18 10.05 18 9V4H6v5c0 1.05.33 2.05 1 2.43l1.6.87c.86.47 1.4 1.38 1.4 2.36z"></path></svg>
                </span>
                <div><strong class="text-white">Intermittent Leaderboard:</strong> 3-second rapid standings showcase after every question to keep the clash electric!</div>
              </div>
            </div>

            <button
              id="btn-accept-rules"
              class="w-full py-4 px-6 rounded-2xl bg-[#4285F4] hover:bg-[#3367D6] active:bg-[#2A56C6] text-white font-bold font-mono tracking-wider uppercase transition shadow-lg shadow-blue-500/25 cursor-pointer text-sm flex items-center justify-center gap-2"
            >
              <span>Read the Rules & Continue to Game</span>
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
            </button>
          </div>
        </div>
      ` : ''}

      <!-- Host Login Authentication Modal -->
      ${showHostLoginModal ? `
        <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="material-card rounded-3xl max-w-md w-full p-6 sm:p-8 space-y-5 border border-slate-700 relative animate-scale-up">
            <div class="flex items-center justify-between pb-3 border-b border-slate-800">
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full bg-blue-400"></span>
                <h3 class="text-lg font-bold text-white font-display">Host Authentication</h3>
              </div>
              <button id="btn-close-host-login" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            ${hostLoginError ? `
              <div class="p-3 rounded-xl bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs font-mono">
                ${escapeHtml(hostLoginError)}
              </div>
            ` : ''}

            <form id="form-host-auth" class="space-y-4">
              <div>
                <label for="input-host-password" class="block text-xs font-mono text-slate-400 uppercase tracking-wider mb-2 font-semibold">Enter Host Password *</label>
                <input
                  id="input-host-password"
                  type="password"
                  placeholder="Enter administrator password"
                  class="w-full bg-slate-950/80 border border-slate-700 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-sm text-white focus:outline-none font-mono transition"
                  autofocus
                  required
                />
              </div>

              <div class="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  id="btn-cancel-host-login"
                  class="w-1/2 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 font-mono text-xs font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="w-1/2 py-3 rounded-xl bg-[#4285F4] hover:bg-[#3367D6] text-white font-mono text-xs font-bold cursor-pointer shadow-lg shadow-blue-500/25"
                >
                  Verify & Enter
                </button>
              </div>
            </form>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function bindLandingEvents() {
  document.getElementById('btn-host-login')?.addEventListener('click', () => {
    if (isHost) {
      currentView = 'presenter_big_screen';
      renderApp();
    } else {
      hostLoginError = '';
      showHostLoginModal = true;
      renderApp();
    }
  });

  document.getElementById('btn-close-host-login')?.addEventListener('click', () => {
    showHostLoginModal = false;
    renderApp();
  });

  document.getElementById('btn-cancel-host-login')?.addEventListener('click', () => {
    showHostLoginModal = false;
    renderApp();
  });

  document.getElementById('form-host-auth')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwdInput = document.getElementById('input-host-password');
    const entered = pwdInput?.value || '';

    // Verify Host Authentication: ssr23!@
    if (entered === HOST_AUTH_PASSWORD) {
      isHost = true;
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('gdgoc_is_host', 'true');
      }
      showHostLoginModal = false;
      currentView = 'presenter_big_screen';
      renderApp();
    } else {
      hostLoginError = 'Invalid host password. Access denied.';
      renderApp();
    }
  });

  document.getElementById('btn-accept-rules')?.addEventListener('click', () => {
    if (pendingPlayer) {
      currentPlayer = pendingPlayer;
      if (typeof window !== 'undefined') {
        localStorage.setItem('gdgoc_current_player', JSON.stringify(currentPlayer));
      }
      savePlayerToDB(currentPlayer);
    }
    showRulesModal = false;
    pendingPlayer = null;
    currentView = 'player_game';
    renderApp();
  });

  document.getElementById('btn-close-rules')?.addEventListener('click', () => {
    showRulesModal = false;
    renderApp();
  });

  document.getElementById('form-landing-register')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('input-player-name');
    const branchSelect = document.getElementById('select-player-branch');
    const pinInput = document.getElementById('input-game-pin');
    const errBox = document.getElementById('reg-error');

    const trimmed = nameInput.value.trim();
    if (!trimmed || trimmed.length < 2) {
      errBox.textContent = 'Please enter a valid student name (at least 2 characters).';
      errBox.classList.remove('hidden');
      return;
    }

    const enteredPin = pinInput?.value?.trim() || '';
    if (enteredPin !== (gameState.roomPin || DEFAULT_ROOM_PIN)) {
      errBox.textContent = `Invalid Game PIN code. Please ask the host for the correct PIN.`;
      errBox.classList.remove('hidden');
      return;
    }

    playCorrectSound();

    const playerId = currentPlayer?.id || `player_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newPlayer = {
      id: playerId,
      name: trimmed,
      branch: branchSelect.value,
      score: currentPlayer?.score || 0,
      answeredQuestions: currentPlayer?.answeredQuestions || {},
      answeredCount: currentPlayer?.answeredCount || 0,
      totalTimeTakenMs: currentPlayer?.totalTimeTakenMs || 0,
      fastestCount: currentPlayer?.fastestCount || 0,
      lastActive: Date.now()
    };

    pendingPlayer = newPlayer;
    showRulesModal = true;
    renderApp();
  });
}

// ==========================================
// VIEW 2: PLAYER REGISTRATION FALLBACK
// ==========================================
function renderPlayerRegisterHTML() {
  currentView = 'landing';
  return renderLandingHTML();
}

function bindPlayerRegisterEvents() {
  bindLandingEvents();
}

// ==========================================
// VIEW 3: PLAYER GAME CONSOLE & PARTICIPANT STATE MACHINE
// ==========================================
function renderPlayerGameHTML() {
  if (!currentPlayer) {
    currentView = 'landing';
    return renderLandingHTML();
  }

  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = gameState.currentQuestionIndex;
  const currentQ = qIndex >= 0 && qIndex < activeQuestions.length ? activeQuestions[qIndex] : null;

  let mainContent = '';

  // STATE A: LOBBY
  if (gameState.status === 'LOBBY' || qIndex < 0 || !currentQ) {
    mainContent = `
      <div class="material-card rounded-3xl p-6 text-center space-y-5">
        <div class="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/30 text-blue-400 mx-auto flex items-center justify-center">
          <svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
        </div>
        <div class="space-y-1">
          <h2 class="text-xl font-bold text-white font-display">Arena Lobby Active</h2>
          <p class="text-xs text-slate-400 font-mono">Get ready! The host will launch the speed clash shortly.</p>
        </div>
        <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 text-left space-y-2.5 font-mono text-xs">
          <div class="flex justify-between"><span class="text-slate-400">Combatant:</span><span class="text-white font-bold">${escapeHtml(currentPlayer.name)}</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Department:</span><span class="text-cyan-400 font-bold">${currentPlayer.branch}</span></div>
          <div class="flex justify-between border-t border-slate-800 pt-2"><span class="text-slate-400">Total Score:</span><span class="text-emerald-400 font-extrabold text-sm">${currentPlayer.score || 0} PTS</span></div>
        </div>
      </div>
    `;
  }
  // STATE B: INTERMITTENT LEADERBOARD (3-SECOND RAPID SHOWCASE)
  else if (gameState.status === 'LEADERBOARD') {
    const sorted = sortPlayers(players);
    const myRankIndex = sorted.findIndex(p => p.id === currentPlayer.id);
    const myRankBadge = myRankIndex >= 0 ? `#${myRankIndex + 1}` : '--';

    mainContent = `
      <div class="space-y-4">
        <div class="material-card rounded-2xl p-4 bg-gradient-to-r from-blue-950/50 to-purple-950/50 border border-blue-500/40 text-center space-y-2">
          <div class="flex items-center justify-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping"></span>
            <span id="leaderboard-auto-timer" class="text-xs font-mono font-bold text-amber-300 uppercase tracking-wider">Advancing in 3s...</span>
          </div>
          <h2 class="text-xl font-bold text-white font-display">Intermittent Leaderboard</h2>
          <p class="text-xs text-slate-400 font-mono">Scores updated after Question ${qIndex + 1}</p>
        </div>

        <div class="material-card rounded-2xl p-4 flex items-center justify-between border border-cyan-500/30 bg-cyan-950/20 font-mono">
          <div>
            <span class="text-[10px] uppercase tracking-wider text-slate-400 block">Your Current Standing</span>
            <span class="text-base font-bold text-white">${escapeHtml(currentPlayer.name)}</span>
          </div>
          <div class="text-right">
            <span class="text-xl font-black text-cyan-400">${myRankBadge}</span>
            <span class="text-xs text-emerald-400 font-bold block">${currentPlayer.score || 0} pts</span>
          </div>
        </div>

        <div class="material-card rounded-2xl p-4 space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar">
          <h3 class="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider mb-2">Live Top Combatants</h3>
          ${renderLeaderboardHTML(players)}
        </div>
      </div>
    `;
  }
  // STATE C: TOURNAMENT FINISHED
  else if (gameState.status === 'FINISHED') {
    const sorted = sortPlayers(players);
    const myRankIndex = sorted.findIndex(p => p.id === currentPlayer.id);
    const myRankBadge = myRankIndex >= 0 ? `#${myRankIndex + 1}` : '--';

    mainContent = `
      <div class="material-card rounded-3xl p-6 text-center space-y-5">
        <div class="w-20 h-20 rounded-3xl bg-amber-500/20 border-2 border-amber-500 text-amber-400 mx-auto flex items-center justify-center text-4xl">🏆</div>
        <div class="space-y-1">
          <span class="text-xs font-mono uppercase tracking-widest text-amber-400 font-bold px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30">Tournament Complete</span>
          <h2 class="text-2xl font-extrabold text-white font-display">Grand Finale!</h2>
        </div>
        <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 text-left space-y-2 font-mono text-xs">
          <div class="flex justify-between"><span class="text-slate-400">Your Final Rank:</span><span class="text-amber-400 font-bold text-sm">${myRankBadge}</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Total Score:</span><span class="text-emerald-400 font-extrabold text-sm">${currentPlayer.score || 0} PTS</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Fastest Finger Awards:</span><span class="text-cyan-400 font-bold">${currentPlayer.fastestCount || 0}</span></div>
        </div>
      </div>
    `;
  }
  // STATE D: QUESTION ACTIVE
  else {
    const prevAnswer = currentPlayer.answeredQuestions?.[qIndex];
    const isLocked = !!prevAnswer;
    const selectedIdx = prevAnswer ? prevAnswer.selectedIndex : null;
    const isCorrect = prevAnswer ? prevAnswer.isCorrect : null;
    const isFastestForCurrent = gameState.fastestWinner && gameState.fastestWinner.questionIndex === qIndex && gameState.fastestWinner.playerId === currentPlayer.id;

    // Zero-Drift remaining time check
    const currentRemainingSec = getRemainingTimeSubseconds(gameState.questionStartTime);
    const isTimeExpired = currentRemainingSec <= 0;

    mainContent = `
      <div class="space-y-4">
        <div class="flex items-center justify-between text-xs font-mono">
          <span class="px-2.5 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-bold">Q${qIndex + 1} / ${activeQuestions.length}</span>
          <span class="text-emerald-400 font-bold bg-emerald-950/30 border border-emerald-500/30 px-2.5 py-1 rounded-lg">${currentPlayer.score || 0} pts</span>
        </div>

        <div class="material-card rounded-2xl p-3 space-y-1.5">
          <div class="flex justify-between items-center text-xs font-mono">
            <span class="text-slate-400 flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              <span>Synchronized 10s Timer</span>
            </span>
            <span id="seconds-left-display" class="text-cyan-400 font-bold">${currentRemainingSec.toFixed(1)}s</span>
          </div>
          <div class="w-full h-2 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
            <div id="timer-progress-bar" class="h-full bg-gradient-to-r from-cyan-500 to-amber-400 transition-all duration-100" style="width: ${(currentRemainingSec / 10) * 100}%"></div>
          </div>
        </div>

        <div class="material-card rounded-3xl p-5 space-y-4">
          <h2 class="text-base sm:text-lg font-bold text-white leading-snug font-display">${escapeHtml(currentQ.question)}</h2>

          <div class="grid grid-cols-1 gap-2.5">
            ${currentQ.options.map((opt, idx) => {
              let btnClass = 'bg-slate-950 border-slate-800 hover:border-slate-600 text-slate-200';
              const isChosen = selectedIdx === idx;
              if (isLocked) {
                if (isChosen) {
                  btnClass = isCorrect ? 'bg-emerald-950/80 border-emerald-500 text-emerald-200 shadow-[0_0_15px_rgba(16,185,129,0.3)]' : 'bg-rose-950/80 border-rose-500 text-rose-200 shadow-[0_0_15px_rgba(244,63,94,0.3)]';
                } else if (gameState.showAnswer && idx === currentQ.correctIndex) {
                  btnClass = 'bg-emerald-950/40 border-emerald-500/60 text-emerald-300';
                } else {
                  btnClass = 'bg-slate-950/50 border-slate-900 text-slate-500 opacity-60';
                }
              } else if (isTimeExpired) {
                btnClass = 'bg-slate-950/50 border-slate-900 text-slate-500 opacity-50 cursor-not-allowed';
              }
              const letter = ['A', 'B', 'C', 'D'][idx];
              return `
                <button
                  class="option-btn w-full p-4 rounded-xl border text-left font-mono text-xs sm:text-sm flex items-center justify-between ${btnClass}"
                  data-option-idx="${idx}"
                  ${isLocked || isTimeExpired ? 'disabled' : ''}
                >
                  <div class="flex items-center gap-3">
                    <span class="w-6 h-6 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-xs font-bold shrink-0">${letter}</span>
                    <span class="font-sans font-medium">${escapeHtml(opt)}</span>
                  </div>
                  ${isLocked && isChosen ? `
                    <span>
                      ${isCorrect ? `
                        <svg class="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                      ` : `
                        <svg class="w-5 h-5 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                      `}
                    </span>
                  ` : ''}
                </button>
              `;
            }).join('')}
          </div>

          ${isLocked ? `
            <div class="p-3 rounded-xl border text-xs font-mono text-center ${isCorrect ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300' : 'bg-rose-950/40 border-rose-500/50 text-rose-300'}">
              <div class="font-bold flex items-center justify-center gap-1.5">
                ${isCorrect ? `
                  <svg class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                  <span>Answer Locked!</span>
                ` : `
                  <svg class="w-4 h-4 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                  <span>Incorrect Answer</span>
                `}
              </div>
              <div class="text-[11px] opacity-80 mt-0.5">Reaction Time: <b>${(prevAnswer.deltaMs / 1000).toFixed(2)}s</b></div>
            </div>
          ` : isTimeExpired ? `
            <div class="p-3 rounded-xl border border-rose-500/40 bg-rose-950/30 text-rose-300 text-xs font-mono text-center">
              Time Expired! Waiting for next question...
            </div>
          ` : ''}

          ${isFastestForCurrent ? `
            <div class="p-3 rounded-xl bg-amber-500/20 border border-amber-500/60 text-amber-300 text-xs font-mono text-center flex items-center justify-center gap-2">
              <svg class="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
              <span>FASTEST FINGER BONUS AWARDED (+2 pts)!</span>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  return `
    <div class="min-h-screen bg-[#070b14] text-slate-100 flex flex-col justify-between p-4 max-w-lg mx-auto relative select-none font-sans">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <header class="flex items-center justify-between py-2 border-b border-slate-800/80 mb-3">
        <div class="flex items-center gap-2">
          <button id="btn-player-roles" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition text-xs font-mono">← Roles</button>
          <button id="btn-toggle-sound" class="p-1.5 rounded-lg border text-xs transition flex items-center justify-center ${soundEnabled ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-slate-900 border-slate-800 text-slate-500'}">
            ${soundEnabled ? `
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
            ` : `
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>
            `}
          </button>
        </div>
        <div class="flex items-center gap-2">
          <div class="text-right">
            <span class="text-[11px] text-slate-400 font-mono block truncate max-w-[110px]">${escapeHtml(currentPlayer.name)}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-mono border border-cyan-500/30">${currentPlayer.branch}</span>
          </div>
          <button id="btn-edit-profile" class="h-8 w-8 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-slate-300 hover:text-white text-xs font-bold">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
        </div>
      </header>

      <main class="flex-1 flex flex-col justify-center my-auto w-full">
        ${mainContent}
      </main>

      <footer class="py-2 border-t border-slate-800/80 text-center font-mono text-[11px] text-slate-500">
        GDGoC IGC Game Zone • Real-Time Participant Node
      </footer>
    </div>
  `;
}

function bindPlayerGameEvents() {
  document.getElementById('btn-player-roles')?.addEventListener('click', () => {
    currentView = 'landing';
    renderApp();
  });

  document.getElementById('btn-toggle-sound')?.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    renderApp();
  });

  document.getElementById('btn-edit-profile')?.addEventListener('click', () => {
    currentView = 'landing';
    renderApp();
  });

  // Bind option buttons for active speed clash
  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-option-idx'), 10);
      handlePlayerSubmitAnswer(idx);
    });
  });
}

function handlePlayerSubmitAnswer(optionIndex) {
  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = gameState.currentQuestionIndex;
  const currentQ = activeQuestions[qIndex];
  if (!currentQ || currentPlayer.answeredQuestions?.[qIndex]) return;

  // Zero-Drift check: instantly lock if remaining time === 0
  const remainingSec = getRemainingTimeSubseconds(gameState.questionStartTime);
  if (remainingSec <= 0) return;

  const isCorrect = optionIndex === currentQ.correctIndex;
  const deltaMs = Math.max(10, Date.now() - gameState.questionStartTime);

  if (soundEnabled) {
    if (isCorrect) playCorrectSound();
    else playWrongSound();
  }

  // Scoring: Remaining Seconds × 5 Points
  let pointsEarned = isCorrect ? Math.max(1, Math.round(remainingSec * 5)) : 0;
  let isFastest = false;

  // Fastest finger bonus check
  if (isCorrect && (!gameState.fastestWinner || gameState.fastestWinner.questionIndex !== qIndex)) {
    isFastest = true;
    pointsEarned += 2; // +2 bonus
    const newWinner = {
      questionIndex: qIndex,
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      branch: currentPlayer.branch,
      timeTakenMs: deltaMs
    };
    gameState.fastestWinner = newWinner;
    currentPlayer.fastestCount = (currentPlayer.fastestCount || 0) + 1;
    if (soundEnabled) playWinnerFanfare();
    updateRoomDoc({ fastestWinner: newWinner });
  }

  if (!currentPlayer.answeredQuestions) currentPlayer.answeredQuestions = {};
  currentPlayer.answeredQuestions[qIndex] = {
    selectedIndex: optionIndex,
    isCorrect,
    deltaMs
  };

  currentPlayer.score = (currentPlayer.score || 0) + pointsEarned;
  currentPlayer.answeredCount = (currentPlayer.answeredCount || 0) + 1;
  currentPlayer.totalTimeTakenMs = (currentPlayer.totalTimeTakenMs || 0) + deltaMs;
  currentPlayer.lastActive = Date.now();

  savePlayerToDB(currentPlayer);
  renderApp();
}

// ==========================================
// VIEW 4: PRESENTER BIG SCREEN & HOST CONTROLS
// ==========================================
function renderPresenterHTML() {
  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = gameState.currentQuestionIndex;
  const isLobby = gameState.status === 'LOBBY' || qIndex < 0;
  const isFinalScreen = gameState.status === 'FINISHED' || qIndex >= activeQuestions.length;
  const isLeaderboardScreen = gameState.status === 'LEADERBOARD';
  const currentQ = !isLobby && !isFinalScreen && !isLeaderboardScreen ? activeQuestions[qIndex] : null;

  let mainStageHtml = '';

  if (isLobby) {
    mainStageHtml = `
      <div class="material-card rounded-3xl p-8 md:p-12 text-center space-y-6 relative overflow-hidden">
        <div class="w-20 h-20 rounded-3xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 mx-auto flex items-center justify-center shadow-lg shadow-cyan-500/20">
          <svg class="w-10 h-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        </div>
        <div class="space-y-2">
          <span class="text-xs font-mono uppercase tracking-widest text-cyan-400 font-bold px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20">Ready to Launch</span>
          <h1 class="text-3xl md:text-5xl font-extrabold text-white font-display uppercase tracking-tight">Fastest Finger Tech Clash</h1>
          <p class="text-sm md:text-base text-slate-400 max-w-lg mx-auto">${activeQuestions.length} Questions Loaded • 10 Seconds per Speed Round</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-3 pt-4">
          <button id="btn-launch-q1" class="px-8 py-4 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold font-mono text-base uppercase tracking-wider shadow-lg shadow-cyan-500/30 flex items-center gap-2 cursor-pointer">
            <svg class="w-5 h-5 fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            <span>Start Game</span>
          </button>
          <button id="btn-seed-demo" class="px-6 py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-mono text-sm font-bold flex items-center gap-2 cursor-pointer">
            <svg class="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
            <span>Seed Demo Combatants</span>
          </button>
        </div>
      </div>
    `;
  } else if (isLeaderboardScreen) {
    mainStageHtml = `
      <div class="material-card rounded-3xl p-8 md:p-12 text-center space-y-6 shadow-2xl border-2 border-cyan-500/40 bg-gradient-to-b from-cyan-950/20 to-slate-950">
        <div class="flex items-center justify-center gap-3">
          <span class="w-3 h-3 rounded-full bg-cyan-400 animate-ping"></span>
          <span id="leaderboard-auto-timer" class="text-sm font-mono font-bold text-cyan-300 uppercase tracking-widest">Auto-Advancing in 3s...</span>
        </div>
        <div class="space-y-2">
          <h2 class="text-3xl md:text-5xl font-extrabold text-white font-display uppercase tracking-tight">Leaderboard Standings</h2>
          <p class="text-sm text-slate-400 font-mono">Scores after Question ${qIndex + 1} of ${activeQuestions.length}</p>
        </div>
        <div class="max-w-2xl mx-auto space-y-2 text-left">
          ${renderLeaderboardHTML(players)}
        </div>
        <div class="pt-4">
          <button id="btn-force-next-now" class="px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono font-bold text-xs uppercase cursor-pointer">
            Advance Immediately ➔
          </button>
        </div>
      </div>
    `;
  } else if (!isFinalScreen && currentQ) {
    const currentRemainingSec = getRemainingTimeSubseconds(gameState.questionStartTime);

    mainStageHtml = `
      <div class="material-card rounded-3xl p-6 md:p-8 shadow-2xl space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="px-3 py-1.5 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-sm font-bold">Q${qIndex + 1} / ${activeQuestions.length}</span>
            <span class="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 font-mono text-xs font-semibold">${escapeHtml(currentQ.category)}</span>
          </div>
          <div class="flex items-center gap-2 bg-slate-950 border border-slate-800 px-4 py-2 rounded-xl font-mono">
            <svg class="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            <span id="seconds-left-display" class="text-sm font-extrabold text-cyan-400">${currentRemainingSec.toFixed(1)}s</span>
          </div>
        </div>

        <div class="w-full h-2.5 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
          <div id="timer-progress-bar" class="h-full bg-gradient-to-r from-cyan-500 to-amber-400 transition-all duration-100" style="width: ${(currentRemainingSec / 10) * 100}%"></div>
        </div>

        <h2 class="text-xl md:text-3xl font-bold text-white leading-snug font-display">${escapeHtml(currentQ.question)}</h2>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          ${currentQ.options.map((opt, idx) => {
            let optStyle = 'bg-slate-950/80 border-slate-800 text-slate-200';
            const isCorrect = idx === currentQ.correctIndex;
            if (gameState.showAnswer) {
              if (isCorrect) optStyle = 'bg-emerald-950/80 border-emerald-500 text-emerald-200 shadow-[0_0_20px_rgba(16,185,129,0.3)]';
              else optStyle = 'bg-slate-950/40 border-slate-900 text-slate-500 opacity-50';
            }
            const letter = ['A', 'B', 'C', 'D'][idx];
            return `
              <div class="p-4 rounded-2xl border font-mono text-sm flex items-center justify-between ${optStyle}">
                <div class="flex items-center gap-3">
                  <span class="w-7 h-7 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center font-bold text-xs shrink-0">${letter}</span>
                  <span class="font-sans font-medium text-base">${escapeHtml(opt)}</span>
                </div>
                ${gameState.showAnswer && isCorrect ? `<span class="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold font-mono">Correct</span>` : ''}
              </div>
            `;
          }).join('')}
        </div>

        ${gameState.showAnswer && currentQ.explanation ? `
          <div class="p-4 rounded-2xl bg-cyan-950/30 border border-cyan-500/40 text-xs md:text-sm text-cyan-200 font-mono leading-relaxed">
            <span class="font-bold text-cyan-400 block mb-1 uppercase tracking-wider">Host Explanation:</span>
            ${escapeHtml(currentQ.explanation)}
          </div>
        ` : ''}

        <div class="pt-4 border-t border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <button id="btn-toggle-answer" class="px-4 py-2.5 rounded-xl border font-mono text-xs font-bold flex items-center gap-1.5 ${gameState.showAnswer ? 'bg-amber-500/20 border-amber-500/50 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-300'}">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              <span>${gameState.showAnswer ? 'Hide Answer' : 'Reveal Answer'}</span>
            </button>
            <button id="btn-restart-timer" class="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-300 font-mono text-xs font-bold flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
              <span>Reset 10s Timer</span>
            </button>
          </div>
          <div class="flex items-center gap-2">
            ${qIndex > 0 ? `<button id="btn-prev-q" class="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 font-mono text-xs font-bold">← Previous</button>` : ''}
            <button id="btn-next-q" class="px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-extrabold cursor-pointer">Next Question ➔</button>
          </div>
        </div>
      </div>
    `;
  } else {
    mainStageHtml = `
      <div class="material-card rounded-3xl p-8 md:p-12 text-center space-y-6 shadow-2xl">
        <div class="w-24 h-24 rounded-3xl bg-amber-500/15 border-2 border-amber-500 text-amber-400 mx-auto flex items-center justify-center text-4xl animate-bounce">🏆</div>
        <div class="space-y-2">
          <span class="text-xs font-mono uppercase tracking-widest text-amber-400 font-bold px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30">Grand Finale Complete</span>
          <h1 class="text-3xl md:text-5xl font-extrabold text-white font-display uppercase">Tournament Concluded!</h1>
        </div>
        <button id="btn-restart-tournament" class="px-8 py-3.5 rounded-xl bg-cyan-500 text-slate-950 font-mono font-bold text-sm cursor-pointer">Restart Tournament</button>
      </div>
    `;
  }

  const branchStats = calculateBranchStats(players);
  const pinCardHtml = `
    <div class="material-card rounded-2xl p-4 flex items-center justify-between bg-gradient-to-r from-blue-950/40 via-purple-950/40 to-slate-950 border border-blue-500/30 mb-6">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-1.5 1.5L16 7m-1.5 1.5L13 10m-1.5 1.5L10 13m-1.5 1.5L7 16m-1.5 1.5L4 19m-1.5 1.5L1 22"></path><circle cx="15.5" cy="8.5" r="5.5"></circle></svg>
        </div>
        <div>
          <span class="text-[10px] font-mono uppercase tracking-wider text-slate-400 block">Active Game Room PIN (Share with Players)</span>
          <span class="text-2xl font-black font-mono text-cyan-400 tracking-widest">${gameState.roomPin || DEFAULT_ROOM_PIN}</span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="btn-copy-pin" class="px-3 py-2 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/40 text-blue-300 font-mono text-xs font-bold flex items-center gap-1.5 cursor-pointer">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <span>Copy PIN</span>
        </button>
        <button id="btn-regen-pin" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-mono text-xs font-bold flex items-center gap-1.5 cursor-pointer">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
          <span>New PIN</span>
        </button>
      </div>
    </div>
  `;

  const fastestBanner = gameState.fastestWinner && !isLobby && !isFinalScreen ? `
    <div class="bg-amber-500/15 border-2 border-amber-500/70 rounded-2xl p-4 flex items-center justify-between shadow-[0_0_30px_rgba(245,158,11,0.25)] animate-pulse-yellow mb-6">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400">
          <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        </div>
        <div>
          <span class="text-[10px] font-mono uppercase tracking-widest text-amber-300/80 block font-bold">Fastest Finger Winner (+2 Bonus Points)</span>
          <span class="text-base font-extrabold text-white font-display">${escapeHtml(gameState.fastestWinner.playerName)} <span class="text-cyan-400 text-xs font-mono">(${gameState.fastestWinner.branch})</span></span>
        </div>
      </div>
      <div class="text-right font-mono">
        <span class="text-lg font-black text-amber-400">${(gameState.fastestWinner.timeTakenMs / 1000).toFixed(2)}s</span>
        <span class="text-[10px] text-slate-400 block uppercase">Lock-in Speed</span>
      </div>
    </div>
  ` : '';

  return `
    <div class="min-h-screen bg-[#070b14] text-slate-100 flex flex-col justify-between p-4 md:p-6 relative select-none font-sans">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <header class="flex items-center justify-between pb-4 border-b border-slate-800/80 mb-6 relative z-10">
        <div class="flex items-center gap-3">
          <button id="btn-presenter-roles" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-xs font-mono flex items-center gap-1.5">← Participant Screen</button>
          <span class="px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-xs uppercase font-bold">Host Live Console</span>
        </div>
        <div class="flex items-center gap-2">
          <button id="btn-open-qm" class="px-3 py-2 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono text-xs flex items-center gap-1.5 cursor-pointer">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span>Questions (${activeQuestions.length})</span>
          </button>
          <button id="btn-presenter-sound" class="p-2 rounded-xl border flex items-center justify-center ${soundEnabled ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-slate-900 border-slate-800 text-slate-500'}">
            ${soundEnabled ? `
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
            ` : `
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>
            `}
          </button>
        </div>
      </header>

      <main class="flex-1 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-6 relative z-10">
        <div class="lg:col-span-8 space-y-6">
          ${pinCardHtml}
          ${fastestBanner}
          ${mainStageHtml}

          <div class="material-card rounded-3xl p-6 shadow-xl space-y-4">
            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 class="text-base font-bold text-white font-display">Departmental Branch Rivalry</h3>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              ${branchStats.map(stat => `
                <div class="p-4 rounded-2xl border border-cyan-500/30 bg-cyan-950/20 space-y-1 font-mono">
                  <div class="flex justify-between"><span class="font-bold text-cyan-300">${stat.branch}</span><span class="text-xs text-slate-400">${stat.count} joined</span></div>
                  <div class="text-2xl font-black text-white">${stat.avgScore} <span class="text-xs text-slate-400">avg</span></div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="lg:col-span-4 space-y-6">
          <div class="material-card rounded-3xl p-6 shadow-2xl space-y-4">
            <div class="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 class="text-lg font-bold text-white font-display">Live Standings</h3>
              <span class="px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-mono text-[11px] font-bold">${Object.keys(players).length} Active</span>
            </div>
            <div class="space-y-2 max-h-[460px] overflow-y-auto custom-scrollbar p-1">
              ${renderLeaderboardHTML(players)}
            </div>
            <div class="pt-3 border-t border-slate-800 flex items-center gap-2">
              <button id="btn-reset-scores" class="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 font-mono text-xs font-bold cursor-pointer">Reset Scores</button>
              <button id="btn-reset-room" class="w-full py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 font-mono text-xs font-bold cursor-pointer">Reset Room</button>
            </div>
          </div>
        </div>
      </main>

      <!-- Question Manager Modal -->
      ${showQuestionManagerModal ? `
        <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="material-card rounded-3xl max-w-2xl w-full p-6 sm:p-8 space-y-4 border border-slate-700 relative animate-scale-up">
            <div class="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 class="text-lg font-bold text-white font-display">Tournament Question Vault</h3>
              <button id="btn-close-qm" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            <div class="max-h-[380px] overflow-y-auto custom-scrollbar space-y-3 font-mono text-xs">
              ${activeQuestions.map((q, idx) => `
                <div class="p-3.5 rounded-xl border ${idx === qIndex ? 'border-cyan-500/50 bg-cyan-950/20' : 'border-slate-800 bg-slate-950/50'} space-y-1">
                  <div class="flex items-center justify-between">
                    <span class="font-bold text-cyan-400">Q${idx + 1}: ${escapeHtml(q.category)}</span>
                    <span class="text-[10px] text-slate-400">Correct: [${['A','B','C','D'][q.correctIndex]}]</span>
                  </div>
                  <p class="text-slate-200">${escapeHtml(q.question)}</p>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function bindPresenterEvents() {
  document.getElementById('btn-presenter-roles')?.addEventListener('click', () => {
    currentView = 'landing';
    renderApp();
  });

  document.getElementById('btn-presenter-sound')?.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    renderApp();
  });

  document.getElementById('btn-open-qm')?.addEventListener('click', () => {
    showQuestionManagerModal = true;
    renderApp();
  });

  document.getElementById('btn-close-qm')?.addEventListener('click', () => {
    showQuestionManagerModal = false;
    renderApp();
  });

  document.getElementById('btn-copy-pin')?.addEventListener('click', () => {
    const pin = gameState.roomPin || DEFAULT_ROOM_PIN;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(pin);
    }
  });

  document.getElementById('btn-regen-pin')?.addEventListener('click', () => {
    const newPin = Math.floor(1000 + Math.random() * 9000).toString();
    updateRoomDoc({ roomPin: newPin, updatedAt: Date.now() });
  });

  // Host Action 1: Start Game (Question 1)
  document.getElementById('btn-launch-q1')?.addEventListener('click', () => {
    updateRoomDoc({
      status: 'QUESTION_ACTIVE',
      currentQuestionIndex: 0,
      questionStartTime: Date.now(),
      showAnswer: false,
      fastestWinner: null,
      updatedAt: Date.now()
    });
  });

  // Host Action 2: Next Question Flow
  // Step A: Host clicks "Next Question" -> Room status updates to 'LEADERBOARD'
  document.getElementById('btn-next-q')?.addEventListener('click', () => {
    const currentIdx = gameState.currentQuestionIndex || 0;
    updateRoomDoc({
      status: 'LEADERBOARD',
      currentQuestionIndex: currentIdx,
      showAnswer: false,
      updatedAt: Date.now()
    });
  });

  // Host Action: Force immediate advance without waiting for 3s auto-advance
  document.getElementById('btn-force-next-now')?.addEventListener('click', () => {
    cleanupTimers();
    const activeQs = getActiveQuestions(gameState.questions);
    const nextIndex = (gameState.currentQuestionIndex || 0) + 1;
    if (nextIndex >= activeQs.length) {
      updateRoomDoc({
        status: 'FINISHED',
        currentQuestionIndex: nextIndex,
        updatedAt: Date.now()
      });
    } else {
      updateRoomDoc({
        status: 'QUESTION_ACTIVE',
        currentQuestionIndex: nextIndex,
        questionStartTime: Date.now(),
        showAnswer: false,
        fastestWinner: null,
        updatedAt: Date.now()
      });
    }
  });

  document.getElementById('btn-seed-demo')?.addEventListener('click', () => {
    const demo = {
      'p_1': { id: 'p_1', name: 'Aarav Sharma', branch: 'CSE', score: 32, answeredCount: 4, totalTimeTakenMs: 12000, fastestCount: 2, lastActive: Date.now() },
      'p_2': { id: 'p_2', name: 'Priya Verma', branch: 'ECE', score: 28, answeredCount: 4, totalTimeTakenMs: 14500, fastestCount: 1, lastActive: Date.now() },
      'p_3': { id: 'p_3', name: 'Rohan Gupta', branch: 'IT', score: 24, answeredCount: 4, totalTimeTakenMs: 16000, fastestCount: 0, lastActive: Date.now() }
    };
    Object.values(demo).forEach(p => savePlayerToDB(p));
  });

  document.getElementById('btn-toggle-answer')?.addEventListener('click', () => {
    updateRoomDoc({ showAnswer: !gameState.showAnswer, updatedAt: Date.now() });
  });

  document.getElementById('btn-restart-timer')?.addEventListener('click', () => {
    updateRoomDoc({ questionStartTime: Date.now(), updatedAt: Date.now() });
  });

  document.getElementById('btn-prev-q')?.addEventListener('click', () => {
    const prevIdx = Math.max(0, (gameState.currentQuestionIndex || 0) - 1);
    updateRoomDoc({
      status: 'QUESTION_ACTIVE',
      currentQuestionIndex: prevIdx,
      questionStartTime: Date.now(),
      showAnswer: false,
      fastestWinner: null,
      updatedAt: Date.now()
    });
  });

  document.getElementById('btn-restart-tournament')?.addEventListener('click', () => {
    updateRoomDoc({
      status: 'LOBBY',
      currentQuestionIndex: -1,
      questionStartTime: Date.now(),
      showAnswer: false,
      fastestWinner: null,
      updatedAt: Date.now()
    });
  });

  document.getElementById('btn-reset-scores')?.addEventListener('click', () => {
    Object.keys(players).forEach(id => {
      const p = {
        ...players[id],
        score: 0,
        answeredQuestions: {},
        answeredCount: 0,
        totalTimeTakenMs: 0,
        fastestCount: 0
      };
      savePlayerToDB(p);
    });
  });

  document.getElementById('btn-reset-room')?.addEventListener('click', () => {
    players = {};
    const resetState = {
      status: 'LOBBY',
      currentQuestionIndex: -1,
      questionStartTime: Date.now(),
      timerDurationSec: 10,
      showAnswer: false,
      fastestWinner: null,
      questions: questionsData,
      roomPin: DEFAULT_ROOM_PIN,
      updatedAt: Date.now()
    };
    updateRoomDoc(resetState);
  });
}

// ==========================================
// SYSTEM BOOTSTRAP
// ==========================================
initFirestoreSync();
renderApp();
