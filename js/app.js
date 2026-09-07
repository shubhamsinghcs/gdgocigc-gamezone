/**
 * js/app.js
 * Real-Time Systems State Machine & Game Synchronization Engine
 * Powered by Firebase Firestore with Multi-Tab Broadcast fallback
 */

import {
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
  isFirebaseConnected,
  setFirebaseConnected,
  isPermissionError
} from './firebase-config.js';
import { questionsData, getActiveQuestions } from './questions.js';
import { playCorrectSound, playWrongSound, playWinnerFanfare } from './audio.js';
import { renderLeaderboardHTML, calculateBranchStats, sortPlayers } from './leaderboard.js';

// Compatibility shim for firebase.firestore.FieldValue.serverTimestamp() and window.db
if (typeof window !== 'undefined') {
  if (!window.firebase) window.firebase = {};
  if (!window.firebase.firestore) window.firebase.firestore = {};
  if (!window.firebase.firestore.FieldValue) window.firebase.firestore.FieldValue = {};
  window.firebase.firestore.FieldValue.serverTimestamp = () => serverTimestamp();

  if (db && !db.collection) {
    db.collection = function (colPath) {
      return {
        doc: function (docPath) {
          const docRef = doc(db, colPath, docPath);
          return {
            get: () => getDoc(docRef),
            set: (data, opts) => setDoc(docRef, data, opts),
            update: (data) => updateDoc(docRef, data),
            onSnapshot: (cb, errCb) => onSnapshot(docRef, cb, errCb),
            collection: (subCol) => db.collection(`${colPath}/${docPath}/${subCol}`)
          };
        }
      };
    };
  }
}

// ==========================================
// CONFIGURATION & CONSTANTS
// ==========================================
const HOST_AUTH_PASSWORD = 'ssr23!@';

let currentHostUid = 'host_master';
if (typeof window !== 'undefined') {
  let storedHostUid = sessionStorage.getItem('gdgoc_host_uid');
  if (!storedHostUid) {
    storedHostUid = 'host_' + Math.random().toString(36).substring(2, 9);
    sessionStorage.setItem('gdgoc_host_uid', storedHostUid);
  }
  currentHostUid = storedHostUid;
}

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

let showHostSessionSetupModal = false;
let hostSessionSetupError = '';

// Canonical Game State
let gameState = {
  status: 'LOBBY', // 'LOBBY' | 'QUESTION_ACTIVE' | 'LEADERBOARD' | 'FINISHED'
  currentQuestionIndex: 0,
  questionStartTime: Date.now(),
  timerDurationSec: 10,
  showAnswer: false,
  fastestWinner: null,
  questions: questionsData,
  roomPin: null, // Fully dynamic! No hardcoded PIN
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

// Check session for persisted dynamic game PIN and student profile
if (typeof window !== 'undefined') {
  try {
    // Security: Host authentication requires entering password on every entry/exit
    isHost = false;
    sessionStorage.removeItem('gdgoc_is_host');
    sessionStorage.removeItem('gdgoc_host_room_pin');
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
      const incoming = event.data.gameState;
      if (incoming) {
        handleStateTransition(incoming);
      }
    } else if (event.data.type === 'PLAYERS_UPDATE') {
      players = event.data.players || {};
      syncCurrentPlayerReference();
      const participants = Object.values(players);
      const counterEl = document.getElementById('connectedCount');
      if (counterEl) {
        counterEl.textContent = `${participants.length} Connected`;
      }
      const rightCounterEl = document.getElementById('rightConnectedCount');
      if (rightCounterEl) {
        rightCounterEl.textContent = `${participants.length} Connected`;
      }
      const badgeEl = document.getElementById('participantsBadge');
      if (badgeEl) {
        badgeEl.textContent = `${participants.length} In Lobby`;
      }
      renderParticipantListUI(participants);
    } else if (event.data.type === 'PLAYER_JOINED') {
      const incomingPin = String(event.data.gamePin || '').trim();
      if (!incomingPin || incomingPin === String(gameState.roomPin).trim()) {
        const p = event.data.player;
        if (p && p.id) {
          players[p.id] = p;
          syncCurrentPlayerReference();
          const participants = Object.values(players);
          renderParticipantListUI(participants);
          localStorage.setItem(`gdgoc_players_${gameState.roomPin}`, JSON.stringify(players));
          const counterEl = document.getElementById('connectedCount');
          if (counterEl) counterEl.textContent = `${participants.length} Connected`;
          const rightCounterEl = document.getElementById('rightConnectedCount');
          if (rightCounterEl) rightCounterEl.textContent = `${participants.length} Connected`;
        }
      }
    } else if (event.data.type === 'ROOM_CREATED' || event.data.type === 'ROOM_PIN_ANNOUNCE') {
      if (event.data.roomPin) {
        const newPin = String(event.data.roomPin).trim();
        gameState.roomPin = newPin;
        localStorage.setItem('gdgoc_active_room_pin', newPin);
        const pinInput = document.getElementById('input-game-pin');
        if (pinInput) {
          pinInput.value = newPin;
        }
        const badgePin = document.getElementById('active-pin-badge');
        if (badgePin) {
          badgePin.textContent = newPin;
        }
      }
    }
  };
}

// Resilient Cross-Tab and Multi-Window Synchronization
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (!event.key) return;
    if (event.key === 'gdgoc_game_state' || (gameState.roomPin && event.key === `gdgoc_room_${gameState.roomPin}`)) {
      if (event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          if (parsed && (parsed.status !== gameState.status || parsed.currentQuestionIndex !== gameState.currentQuestionIndex || parsed.updatedAt !== gameState.updatedAt)) {
            handleStateTransition(parsed);
          }
        } catch {}
      }
    } else if (event.key === 'gdgoc_active_room_pin') {
      if (event.newValue && !gameState.roomPin) {
        gameState.roomPin = event.newValue;
        listenToRoom(event.newValue);
      }
    } else if (event.key.startsWith('gdgoc_players')) {
      if (event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue);
          players = { ...players, ...parsed };
          syncCurrentPlayerReference();
          renderApp();
        } catch {}
      }
    }
  });

  // Fast polling heartbeat (every 250ms) to guarantee zero-lag multi-tab & iframe synchronization
  setInterval(() => {
    try {
      const activePin = gameState.roomPin || localStorage.getItem('gdgoc_active_room_pin');
      const rawRoom = activePin ? localStorage.getItem(`gdgoc_room_${activePin}`) : null;
      const rawGame = localStorage.getItem('gdgoc_game_state');
      const sourceStr = rawRoom || rawGame;
      if (sourceStr) {
        const parsed = JSON.parse(sourceStr);
        if (parsed && parsed.status) {
          const statusChanged = parsed.status !== gameState.status;
          const indexChanged = typeof parsed.currentQuestionIndex === 'number' && parsed.currentQuestionIndex !== gameState.currentQuestionIndex;
          const showAnswerChanged = Boolean(parsed.showAnswer) !== Boolean(gameState.showAnswer);
          const timeChanged = parsed.questionStartTime && parsed.status === 'QUESTION_ACTIVE' && (!gameState.questionStartTime || Math.abs(parseTimestamp(parsed.questionStartTime) - gameState.questionStartTime) > 1000);

          if (statusChanged || indexChanged || showAnswerChanged || timeChanged) {
            handleStateTransition(parsed);
          }
        }
      }

      // Also keep joined participants count synchronized in real-time
      if (activePin) {
        const rawPlayers = localStorage.getItem(`gdgoc_players_${activePin}`);
        if (rawPlayers) {
          const parsedP = JSON.parse(rawPlayers);
          if (parsedP && Object.keys(parsedP).length !== Object.keys(players).length) {
            players = { ...players, ...parsedP };
            syncCurrentPlayerReference();
            if (currentView === 'presenter_big_screen' || currentView === 'player_game') {
              renderApp();
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }, 250);
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

export function parseTimestamp(ts) {
  if (!ts) return Date.now();
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1000000);
  return Date.now();
}

// ==========================================
// FIRESTORE REAL-TIME SYNCHRONIZATION ENGINE
// ==========================================
let roomUnsubscribe = null;
let playersUnsubscribe = null;

export function showView(viewId) {
  const targetId = (viewId === 'viewWinner') ? 'viewFinished' : (viewId === 'viewWaiting' ? 'viewLobby' : viewId);
  const viewIds = ['viewLobby', 'viewQuestion', 'viewLeaderboard', 'viewFinished'];

  viewIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id === targetId) {
        el.classList.remove('hidden');
        el.style.display = '';
      } else {
        el.classList.add('hidden');
        el.style.display = 'none';
      }
    }
  });

  const waitingEl = document.getElementById('viewWaiting');
  if (waitingEl) {
    if (targetId === 'viewLobby') {
      waitingEl.classList.remove('hidden');
      waitingEl.style.display = '';
    }
  }

  const winnerEl = document.getElementById('viewWinner');
  if (winnerEl) {
    if (viewId === 'viewWinner' || viewId === 'viewFinished') {
      winnerEl.classList.remove('hidden');
      winnerEl.style.display = '';
    } else {
      winnerEl.classList.add('hidden');
      winnerEl.style.display = 'none';
    }
  }
}

export function renderActiveQuestion(question, questionStartTime) {
  if (!question) return;
  const qIndex = typeof gameState.currentQuestionIndex === 'number' ? gameState.currentQuestionIndex : (parseInt(gameState.currentQuestionIndex, 10) || 0);
  const activeQs = getActiveQuestions(gameState.questions);

  const startTime = parseTimestamp(questionStartTime || gameState.questionStartTime);
  gameState.questionStartTime = startTime;

  showView('viewQuestion');

  const questionView = document.getElementById('viewQuestion');
  if (questionView) {
    questionView.innerHTML = renderQuestionContentHTML(question, qIndex, activeQs.length);

    questionView.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-option-idx'), 10);
        handlePlayerSubmitAnswer(idx);
      });
    });
  }

  startLocalCountdown(startTime);
}

export function renderLeaderboard(data) {
  showView('viewLeaderboard');
  const lbContainer = document.getElementById('viewLeaderboard');
  if (lbContainer) {
    const activeQs = getActiveQuestions(gameState.questions);
    const qIndex = gameState.currentQuestionIndex || 0;
    const sortedPlayers = Object.values(players).sort((a, b) => (b.score || 0) - (a.score || 0));
    const myRank = currentPlayer ? sortedPlayers.findIndex(p => p.id === currentPlayer.id) + 1 : 0;
    const myPlayer = (currentPlayer && players[currentPlayer.id]) ? players[currentPlayer.id] : currentPlayer;

    lbContainer.innerHTML = `
      <div class="material-card rounded-3xl p-5 space-y-4 text-center">
        <div class="flex items-center justify-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping"></span>
          <span class="text-xs font-mono font-bold text-amber-300 uppercase tracking-widest">Question Complete • Advancing in 3s</span>
        </div>
        <div class="space-y-1">
          <h2 class="text-xl font-extrabold text-white font-display uppercase tracking-tight">Arena Standings</h2>
          <p class="text-xs text-slate-400 font-mono">Scores after Question ${qIndex + 1} of ${activeQs.length}</p>
        </div>
        ${myPlayer ? `
          <div class="p-3.5 rounded-2xl bg-cyan-950/40 border border-cyan-500/40 flex items-center justify-between font-mono text-xs">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-300 font-bold">Rank #${myRank || '-'}</span>
              <span class="font-bold text-white">${escapeHtml(myPlayer.name)}</span>
            </div>
            <span class="text-emerald-400 font-bold text-sm">${myPlayer.score || 0} pts</span>
          </div>
        ` : ''}
        <div class="space-y-1.5 text-left pt-1">
          <div class="flex items-center justify-between text-[11px] font-mono text-slate-400 pb-1 border-b border-slate-800">
            <span>Top 5 Combatants</span>
            <span>${sortedPlayers.length} Total</span>
          </div>
          ${renderLeaderboardHTML(players, 5, true)}
        </div>
      </div>
    `;
  }
  startLeaderboardCountdown();
}

export function renderParticipantListUI(participantsList) {
  const participants = Array.isArray(participantsList) ? participantsList : Object.values(participantsList || {});

  const countText = `${participants.length} Connected`;
  
  const countEl = document.getElementById('connectedCount');
  if (countEl) countEl.textContent = countText;

  const hostBadgeEl = document.getElementById('hostConnectedBadge');
  if (hostBadgeEl) hostBadgeEl.textContent = countText;

  const badgeEl = document.getElementById('participantsBadge');
  if (badgeEl) badgeEl.textContent = `${participants.length} In Lobby`;

  const rightCountEl = document.getElementById('rightConnectedCount');
  if (rightCountEl) rightCountEl.textContent = countText;

  const renderChips = (emptyText) => {
    if (participants.length === 0) {
      return `<div class="w-full text-center py-6 text-slate-500 font-mono text-xs italic">${emptyText}</div>`;
    }
    return participants.map((p, idx) => `
      <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#1E293B] border border-slate-700/60 text-slate-200 font-sans text-xs font-semibold shadow-sm animate-popIn">
        <span class="w-2 h-2 rounded-full bg-[#34A853] shrink-0"></span>
        <span class="text-white truncate max-w-[130px]">${escapeHtml(p.name || 'Anonymous')}</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded bg-[#4285F4]/10 text-[#4285F4] border border-[#4285F4]/20 font-mono">${escapeHtml(p.branch || 'CSE')}</span>
      </div>
    `).join('');
  };

  const listEl = document.getElementById('joinedParticipantsList');
  if (listEl) {
    listEl.innerHTML = renderChips(`Waiting for participants to enter PIN ${escapeHtml(gameState.roomPin || '----')}...`);
  }

  const hostGridEl = document.getElementById('hostPlayerGrid');
  if (hostGridEl) {
    hostGridEl.innerHTML = renderChips(`Waiting for participants to enter PIN ${escapeHtml(gameState.roomPin || '----')}...`);
  }

  const rightListEl = document.getElementById('rightJoinedParticipantsList');
  if (rightListEl) {
    if (participants.length === 0) {
      rightListEl.innerHTML = `
        <div class="text-center py-10 space-y-2 text-slate-500 font-mono text-xs">
          <p>Waiting for participants to enter PIN ${escapeHtml(gameState.roomPin || '----')}...</p>
        </div>
      `;
    } else {
      rightListEl.innerHTML = participants.map((p, idx) => `
        <div class="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between font-mono text-xs">
          <div class="flex items-center gap-2.5 truncate">
            <span class="w-5 h-5 rounded-md bg-slate-900 border border-slate-700 flex items-center justify-center text-[10px] text-slate-400 font-bold shrink-0">${idx + 1}</span>
            <span class="font-bold text-white truncate">${escapeHtml(p.name)}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-[#4285F4]/10 text-[#4285F4] border border-[#4285F4]/20">${escapeHtml(p.branch || 'CSE')}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0 ml-2">
            <span class="text-[#34A853] font-bold">${p.score || 0} pts</span>
            <span class="w-2 h-2 rounded-full bg-[#34A853]"></span>
          </div>
        </div>
      `).join('');
    }
  }
}

export function showError(msg) {
  const errBox = document.getElementById('join-error');
  if (errBox) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  } else {
    console.warn('[Validation Notice]:', msg);
  }
}

export function listenToJoinedParticipants(gamePin = gameState.roomPin) {
  const cleanPin = String(gamePin || '').trim();
  if (!cleanPin) return;

  if (playersUnsubscribe) {
    try { playersUnsubscribe(); } catch {}
    playersUnsubscribe = null;
  }

  const handleParticipants = (participants) => {
    const updatedPlayers = {};
    participants.forEach((p) => {
      const pId = p.id || p.userId || (p.name ? p.name.toLowerCase().replace(/\s+/g, '_') : `player_${Date.now()}`);
      updatedPlayers[pId] = { id: pId, ...p };
    });
    players = { ...players, ...updatedPlayers };
    syncCurrentPlayerReference();

    // 1. Update Host UI connected counter badge
    const counterEl = document.getElementById('connectedCount');
    if (counterEl) {
      counterEl.textContent = `${participants.length} Connected`;
    }
    const badgeEl = document.getElementById('participantsBadge');
    if (badgeEl) {
      badgeEl.textContent = `${participants.length} In Lobby`;
    }
    const rightCountEl = document.getElementById('rightConnectedCount');
    if (rightCountEl) {
      rightCountEl.textContent = `${participants.length} Connected`;
    }

    // 2. Render live participant tags/chips in the "Joined Participants" panel
    renderParticipantListUI(participants);

    localStorage.setItem(`gdgoc_players_${cleanPin}`, JSON.stringify(players));
    broadcastLocalState();
  };

  if (db && isFirebaseConnected && !isPermissionError()) {
    try {
      const partCol = collection(db, 'rooms', cleanPin, 'participants');
      playersUnsubscribe = onSnapshot(partCol, (snapshot) => {
        const participants = [];
        snapshot.forEach((docSnap) => {
          const pData = docSnap.data();
          participants.push({ id: docSnap.id, ...pData });
        });
        handleParticipants(participants);
      }, (error) => {
        console.warn("[Notice listening to participants - fallback to multi-tab sync]:", error?.message || error);
        if (error?.code === 'permission-denied' || String(error?.message || error).includes('permission')) {
          setFirebaseConnected(false);
          if (playersUnsubscribe) {
            try { playersUnsubscribe(); } catch {}
            playersUnsubscribe = null;
          }
        }
      });
    } catch (err) {
      console.warn("[Notice setting up participants listener]:", err?.message || err);
    }
  }

  const localPlayersStr = localStorage.getItem(`gdgoc_players_${cleanPin}`);
  if (localPlayersStr) {
    try {
      const localPlayers = JSON.parse(localPlayersStr);
      handleParticipants(Object.values(localPlayers));
    } catch {}
  }
}

let sseEventSource = null;
let serverPollInterval = null;

export function connectServerRoom(pin = gameState.roomPin) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin || cleanPin === '----') return;

  if (sseEventSource) {
    try { sseEventSource.close(); } catch {}
    sseEventSource = null;
  }

  try {
    sseEventSource = new EventSource(`/api/rooms/${cleanPin}/stream`);
    sseEventSource.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return;
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === 'INITIAL_SYNC' || payload.type === 'STATE_UPDATE' || payload.type === 'ROOM_RESET') {
          if (payload.gameState) {
            handleStateTransition({ ...payload.gameState, roomPin: cleanPin });
          }
          if (payload.players) {
            players = { ...players, ...payload.players };
            syncCurrentPlayerReference();
            renderParticipantListUI(Object.values(players));
          }
        } else if (payload.type === 'PLAYERS_UPDATE') {
          if (payload.players) {
            players = { ...players, ...payload.players };
            syncCurrentPlayerReference();
            renderParticipantListUI(Object.values(players));
          }
          if (payload.fastestWinner) {
            gameState.fastestWinner = payload.fastestWinner;
          }
        } else if (payload.type === 'PLAYER_JOINED') {
          if (payload.player) {
            players[payload.player.id] = payload.player;
            syncCurrentPlayerReference();
            renderParticipantListUI(Object.values(players));
          }
        }
      } catch {}
    };
    sseEventSource.onerror = () => {
      // Background fallback polling ensures uninterrupted synchronization
    };
  } catch {}

  // High-frequency 300ms server-sync polling fallback for rock-solid zero-loss updates
  if (serverPollInterval) clearInterval(serverPollInterval);
  serverPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/rooms/${cleanPin}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.gameState) {
          const parsed = data.gameState;
          const statusChanged = parsed.status !== gameState.status;
          const indexChanged = typeof parsed.currentQuestionIndex === 'number' && parsed.currentQuestionIndex !== gameState.currentQuestionIndex;
          const showAnswerChanged = Boolean(parsed.showAnswer) !== Boolean(gameState.showAnswer);
          const timeChanged = parsed.questionStartTime && parsed.status === 'QUESTION_ACTIVE' && (!gameState.questionStartTime || Math.abs(parsed.questionStartTime - gameState.questionStartTime) > 1000);

          if (statusChanged || indexChanged || showAnswerChanged || timeChanged) {
            handleStateTransition({ ...parsed, roomPin: cleanPin });
          }
        }
        if (data && data.players) {
          const incomingCount = Object.keys(data.players).length;
          const currentCount = Object.keys(players).length;
          if (incomingCount !== currentCount) {
            players = { ...players, ...data.players };
            syncCurrentPlayerReference();
            renderParticipantListUI(Object.values(players));
          }
        }
      }
    } catch {}
  }, 300);
}

export function listenToRoom(pin = gameState.roomPin) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return;
  gameState.roomPin = cleanPin;

  // 1. Connect real-time Server-Sent Events & Polling stream
  connectServerRoom(cleanPin);

  // Clean up existing room subscription
  if (roomUnsubscribe) {
    try { roomUnsubscribe(); } catch {}
    roomUnsubscribe = null;
  }

  const handleRoomSnapshot = (data) => {
    if (!data) return;
    handleStateTransition({ ...data, roomPin: cleanPin });
  };

  if (db && isFirebaseConnected && !isPermissionError()) {
    try {
      const roomRef = doc(db, 'rooms', cleanPin);
      roomUnsubscribe = onSnapshot(roomRef, (docSnap) => {
        if (!docSnap || !docSnap.exists()) return;
        const data = docSnap.data();
        handleRoomSnapshot(data);
      }, (error) => {
        console.warn("[Notice listening to room - fallback to server SSE sync]:", error?.message || error);
        if (error?.code === 'permission-denied' || String(error?.message || error).includes('permission')) {
          setFirebaseConnected(false);
          if (roomUnsubscribe) {
            try { roomUnsubscribe(); } catch {}
            roomUnsubscribe = null;
          }
        }
      });
    } catch (err) {
      console.warn("[Notice attaching room listener]:", err?.message || err);
    }
  }

  const localRoomStr = localStorage.getItem(`gdgoc_room_${cleanPin}`);
  if (localRoomStr) {
    try {
      const localData = JSON.parse(localRoomStr);
      handleRoomSnapshot(localData);
    } catch {}
  }
}

function initFirestoreSync() {
  if (gameState.roomPin) {
    listenToRoom(gameState.roomPin);
    if (isHost) {
      listenToJoinedParticipants(gameState.roomPin);
    }
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
// HOST DYNAMIC ROOM CREATION & TOAST PIPELINE
// ==========================================
export function generate4DigitPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function showToast(message = 'PIN Copied') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast-msg pointer-events-auto bg-slate-900/95 border border-blue-500/50 text-white font-mono text-xs px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2.5 backdrop-blur-md';
  toast.innerHTML = `
    <svg class="w-4 h-4 text-[#4285F4] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
    <span class="font-bold tracking-wide">${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-hiding');
    setTimeout(() => toast.remove(), 250);
  }, 2000);
}

export async function createRoom(enteredPin) {
  let pin = String(enteredPin || '').replace(/\D/g, '').trim();
  if (!pin || pin.length < 4 || pin.length > 6) {
    pin = generate4DigitPin();
  }

  const serverTs = (typeof window !== 'undefined' && window.firebase?.firestore?.FieldValue?.serverTimestamp)
    ? window.firebase.firestore.FieldValue.serverTimestamp()
    : serverTimestamp();

  const initialPayload = {
    gamePin: String(pin),
    status: 'LOBBY',
    createdAt: serverTs,
    currentQuestionIndex: 0,
    hostId: currentHostUid,
    timerDurationSec: 10,
    showAnswer: false,
    fastestWinner: null,
    questions: questionsData,
    updatedAt: Date.now()
  };

  gameState = {
    ...gameState,
    ...initialPayload,
    roomPin: pin
  };

  players = {};

  // Always update local cache & broadcast first to guarantee instant, resilient room creation
  localStorage.setItem(`gdgoc_room_${pin}`, JSON.stringify(initialPayload));
  localStorage.setItem('gdgoc_active_room_pin', pin);
  localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
  localStorage.setItem(`gdgoc_players_${pin}`, JSON.stringify(players));
  broadcastLocalState();
  if (broadcastChannel) {
    broadcastChannel.postMessage({ type: 'ROOM_CREATED', roomPin: pin, gameState });
  }

  if (db && isFirebaseConnected) {
    try {
      const roomRef = doc(db, 'rooms', pin);
      await setDoc(roomRef, initialPayload, { merge: true });
    } catch (err) {
      console.warn('[Firestore] Room initialization notice, using local broadcast sync:', err?.message || err);
      if (err?.code === 'permission-denied' || String(err?.message || err).includes('permissions')) {
        setFirebaseConnected(false);
      }
    }
  }

  if (typeof window !== 'undefined') {
    sessionStorage.setItem('gdgoc_host_room_pin', pin);
    sessionStorage.setItem('gdgoc_game_pin', pin);
    sessionStorage.setItem('activePin', pin);
  }

  // Authoritative server room initialization
  fetch(`/api/rooms/${pin}/create`, { method: 'POST' }).catch(() => {});

  listenToRoom(pin);
  listenToJoinedParticipants(pin);
  renderApp();
  return initialPayload;
}

// ==========================================
// PARTICIPANT ROOM VALIDATION & ATOMIC ENTRY
// ==========================================
export async function joinRoom(pin, studentData) {
  const cleanPin = String(pin || '').replace(/\D/g, '').trim();
  if (!cleanPin || cleanPin.length < 4 || cleanPin.length > 6) {
    showError("Please enter a valid 4-digit PIN Code.");
    return { success: false, error: "Please enter a valid 4-digit PIN Code." };
  }

  const studentName = String(studentData?.name || '').trim();
  const studentBranch = String(studentData?.branch || 'CSE').trim();
  if (!studentName || studentName.length < 2) {
    showError("Please enter a valid student name (at least 2 characters).");
    return { success: false, error: "Please enter a valid student name (at least 2 characters)." };
  }

  let roomData = null;
  let roomFound = false;

  // 1. Fetch game session by the provided PIN from server API
  try {
    const srvRes = await fetch(`/api/rooms/${cleanPin}`);
    if (srvRes.ok) {
      const srvData = await srvRes.json();
      if (srvData && srvData.gameState) {
        roomData = srvData.gameState;
        roomFound = true;
      }
    }
  } catch {}

  // 2. Fetch game session from Firestore if not retrieved yet
  if (!roomData && db && isFirebaseConnected && !isPermissionError()) {
    try {
      const roomRef = doc(db, 'rooms', cleanPin);
      const roomSnap = await getDoc(roomRef);
      if (roomSnap && roomSnap.exists()) {
        roomData = roomSnap.data();
        roomFound = true;
      }
    } catch (err) {
      console.warn('[Firestore] Notice fetching room:', err?.message || err);
      if (err?.code === 'permission-denied' || String(err?.message || err).includes('permissions')) {
        setFirebaseConnected(false);
      }
    }
  }

  // 3. Offline / Local fallback validation
  if (!roomData) {
    const localRoom = localStorage.getItem(`gdgoc_room_${cleanPin}`);
    const activePin = localStorage.getItem('gdgoc_active_room_pin') || sessionStorage.getItem('gdgoc_game_pin') || sessionStorage.getItem('activePin');
    const localGameState = localStorage.getItem('gdgoc_game_state');

    if (localRoom) {
      try {
        roomData = JSON.parse(localRoom);
        roomFound = true;
      } catch {}
    } else if (activePin === cleanPin && localGameState) {
      try {
        const parsed = JSON.parse(localGameState);
        if (String(parsed.roomPin || parsed.gamePin).trim() === cleanPin) {
          roomData = parsed;
          roomFound = true;
        }
      } catch {}
    } else if (String(gameState.roomPin).trim() === cleanPin && gameState.status) {
      roomData = gameState;
      roomFound = true;
    }
  }

  // 4. If room was not found in any source, reject with friendly error
  if (!roomFound || !roomData) {
    showError("Invalid Game PIN. Please enter the active 4-digit PIN displayed on the Host Screen.");
    return { success: false, error: "Invalid Game PIN. Please enter the active 4-digit PIN displayed on the Host Screen." };
  }

  // 4. If game was finished, reset to LOBBY for new entrants
  if (roomData.status === 'FINISHED') {
    roomData.status = 'LOBBY';
    roomData.currentQuestionIndex = 0;
  }

  // 5. Synchronize verified game session state
  gameState = {
    ...gameState,
    status: roomData.status || 'LOBBY',
    currentQuestionIndex: typeof roomData.currentQuestionIndex === 'number' ? roomData.currentQuestionIndex : (parseInt(roomData.currentQuestionIndex, 10) || 0),
    questionStartTime: parseTimestamp(roomData.questionStartTime),
    timerDurationSec: roomData.timerDurationSec || 10,
    showAnswer: Boolean(roomData.showAnswer),
    fastestWinner: roomData.fastestWinner || null,
    questions: roomData.questions || gameState.questions || questionsData,
    roomPin: cleanPin,
    updatedAt: roomData.updatedAt || Date.now()
  };

  // 6. Write participant payload
  const userId = studentName.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now();
  const serverTs = (typeof window !== 'undefined' && window.firebase?.firestore?.FieldValue?.serverTimestamp)
    ? window.firebase.firestore.FieldValue.serverTimestamp()
    : serverTimestamp();

  const participantData = {
    id: userId,
    name: studentName,
    branch: studentBranch,
    score: 0,
    answeredCount: 0,
    joinedAt: serverTs
  };

  const participantProfile = {
    ...participantData,
    answeredQuestions: {},
    totalTimeTakenMs: 0,
    fastestCount: 0,
    lastActive: Date.now()
  };

  currentPlayer = participantProfile;
  players[userId] = participantProfile;
  gameState.roomPin = cleanPin;

  // Write to Firestore subcollection: rooms/{cleanPin}/participants/{userId}
  if (db && isFirebaseConnected && !isPermissionError()) {
    try {
      const partDocRef = doc(db, 'rooms', cleanPin, 'participants', userId);
      await setDoc(partDocRef, participantData, { merge: true });
    } catch (err) {
      console.warn('[Firestore] Error saving participant:', err);
      if (err?.code === 'permission-denied' || String(err?.message || err).includes('permissions')) {
        setFirebaseConnected(false);
      }
    }
  }

  // Save to local storage & broadcast
  localStorage.setItem(`gdgoc_players_${cleanPin}`, JSON.stringify(players));
  localStorage.setItem('gdgoc_current_player', JSON.stringify(participantProfile));
  localStorage.setItem(`gdgoc_room_${cleanPin}`, JSON.stringify(gameState));
  localStorage.setItem('gdgoc_active_room_pin', cleanPin);
  localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
  broadcastLocalState();
  if (broadcastChannel) {
    broadcastChannel.postMessage({ type: 'PLAYER_JOINED', player: participantProfile, gamePin: cleanPin });
  }

  // Save to sessionStorage & attach snapshot listener
  if (typeof window !== 'undefined') {
    sessionStorage.setItem('activePin', cleanPin);
    sessionStorage.setItem('userId', userId);
    sessionStorage.setItem('gdgoc_game_pin', cleanPin);
    sessionStorage.setItem('gdgoc_user_id', userId);
    sessionStorage.setItem('gdgoc_user_name', studentName);
    sessionStorage.setItem('gdgoc_user_branch', studentBranch);
  }

  // Authoritative server player registration
  fetch(`/api/rooms/${cleanPin}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: userId, name: studentName, branch: studentBranch })
  }).catch(() => {});

  listenToRoom(cleanPin);

  return { success: true, player: participantProfile };
}

export async function validateAndJoinRoom(name, branch, enteredPin) {
  // Input Sanitation: strip non-numeric characters in real-time
  const cleanedPin = String(enteredPin || '').replace(/\D/g, '').trim();
  const trimmedName = String(name || '').trim();

  if (!trimmedName || trimmedName.length < 2) {
    showError('Please enter a valid student name (at least 2 characters).');
    return { success: false, error: 'Please enter a valid student name (at least 2 characters).' };
  }
  if (!cleanedPin || cleanedPin.length < 4 || cleanedPin.length > 6) {
    showError('Please enter a valid 4-digit PIN Code.');
    return { success: false, error: 'Please enter a valid 4-digit PIN Code.' };
  }

  return await joinRoom(cleanedPin, { name: trimmedName, branch: branch || 'CSE' });
}

// ==========================================
// HOST STATE TRANSITION WRITE (ATOMIC)
// ==========================================
export function launchQuestion(index = 0) {
  const gamePin = String(gameState.roomPin || '').trim();
  if (!gamePin) return;
  cleanupTimers();

  const serverTs = (typeof window !== 'undefined' && window.firebase?.firestore?.FieldValue?.serverTimestamp)
    ? window.firebase.firestore.FieldValue.serverTimestamp()
    : serverTimestamp();

  const roomPayload = {
    status: 'QUESTION_ACTIVE',
    currentQuestionIndex: index,
    questionStartTime: serverTs,
    showAnswer: false,
    fastestWinner: null,
    updatedAt: Date.now()
  };

  // Always update local state immediately to ensure instantaneous zero-lag response
  const localPayload = {
    ...roomPayload,
    questionStartTime: Date.now()
  };
  gameState = { ...gameState, ...localPayload };
  localStorage.setItem(`gdgoc_room_${gamePin}`, JSON.stringify(gameState));
  localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
  handleStateTransition(gameState);
  broadcastLocalState();

  // Authoritative real-time server push
  fetch(`/api/rooms/${gamePin}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'QUESTION_ACTIVE',
      currentQuestionIndex: index,
      questionStartTime: Date.now(),
      showAnswer: false,
      fastestWinner: null
    })
  }).catch(() => {});

  if (db && isFirebaseConnected) {
    const roomRef = doc(db, 'rooms', gamePin);
    setDoc(roomRef, roomPayload, { merge: true }).catch((err) => {
      console.warn('[Firestore] Notice during launchQuestion, operating with server SSE broadcast:', err?.message || err);
      if (err?.code === 'permission-denied' || String(err?.message || err).includes('permissions')) {
        setFirebaseConnected(false);
      }
    });
  }
}

// ==========================================
// DETERMINISTIC STATE MACHINE
// ==========================================
function handleStateTransition(incomingState) {
  if (!incomingState) return;

  cleanupTimers();

  const prevQuestionIndex = gameState.currentQuestionIndex;
  const isNewQuestion = incomingState.status === 'QUESTION_ACTIVE' && (incomingState.currentQuestionIndex !== prevQuestionIndex);

  let qStartTime = incomingState.questionStartTime;
  if (qStartTime) {
    qStartTime = parseTimestamp(qStartTime);
  } else {
    qStartTime = Date.now();
  }

  gameState = {
    ...gameState,
    ...incomingState,
    questionStartTime: qStartTime
  };

  if (typeof window !== 'undefined') {
    localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
    if (gameState.roomPin) {
      localStorage.setItem(`gdgoc_room_${gameState.roomPin}`, JSON.stringify(gameState));
    }
  }

  // Restore player profile if lost in memory
  if (!currentPlayer && typeof window !== 'undefined') {
    const savedP = localStorage.getItem('gdgoc_current_player');
    if (savedP) {
      try { currentPlayer = JSON.parse(savedP); } catch {}
    }
    if (!currentPlayer) {
      const savedName = sessionStorage.getItem('gdgoc_user_name');
      const savedBranch = sessionStorage.getItem('gdgoc_user_branch') || 'CSE';
      const savedId = sessionStorage.getItem('gdgoc_user_id') || sessionStorage.getItem('userId');
      if (savedName && savedId) {
        currentPlayer = players[savedId] || {
          id: savedId,
          name: savedName,
          branch: savedBranch,
          score: 0,
          answeredCount: 0,
          joinedAt: Date.now(),
          answeredQuestions: {},
          totalTimeTakenMs: 0,
          fastestCount: 0,
          lastActive: Date.now()
        };
      }
    }
  }

  // Zero-latency instant participant transition to active question view
  if (gameState.status === 'QUESTION_ACTIVE') {
    if (!isHost) {
      currentView = 'player_game';
    }
    renderApp();
    showView('viewQuestion');
    const qIndex = typeof gameState.currentQuestionIndex === 'number' ? gameState.currentQuestionIndex : (parseInt(gameState.currentQuestionIndex, 10) || 0);
    const activeQs = getActiveQuestions(gameState.questions);
    const targetQ = activeQs[qIndex] || questionsData[qIndex] || questionsData[0];
    if (targetQ) {
      renderActiveQuestion(targetQ, gameState.questionStartTime);
    } else {
      startLocalCountdown(gameState.questionStartTime);
    }
    return;
  }

  switch (gameState.status) {
    case 'LOBBY':
      if (!isHost && currentPlayer && currentView !== 'player_game') {
        currentView = 'player_game';
      }
      renderApp();
      showView('viewLobby');
      break;

    case 'LEADERBOARD':
      if (!isHost && currentPlayer && currentView !== 'player_game') {
        currentView = 'player_game';
      }
      renderApp();
      showView('viewLeaderboard');
      startLeaderboardCountdown();
      // Host client handles single 3-second auto-advance to next question
      if (isHost) {
        if (autoAdvanceTimeout) clearTimeout(autoAdvanceTimeout);
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
            launchQuestion(nextIndex);
          }
        }, 3000);
      }
      return;

    case 'FINISHED':
      if (!isHost && currentPlayer && currentView !== 'player_game') {
        currentView = 'player_game';
      }
      if (soundEnabled) playWinnerFanfare();
      renderApp();
      showView('viewFinished');
      return;
  }

  renderApp();
}

function startLeaderboardCountdown() {
  if (currentTimerInterval) {
    clearInterval(currentTimerInterval);
    currentTimerInterval = null;
  }
  const startTime = gameState.updatedAt || Date.now();
  currentTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = Math.max(0, Math.ceil(3 - elapsed));
    document.querySelectorAll('#leaderboard-auto-timer').forEach((el) => {
      el.textContent = `Advancing in ${remaining}s...`;
    });
    if (elapsed >= 3.0) {
      if (currentTimerInterval) {
        clearInterval(currentTimerInterval);
        currentTimerInterval = null;
      }
    }
  }, 100);
}

let autoLeaderboardTriggered = false;

function startLocalCountdown(startTime) {
  if (currentTimerInterval) {
    clearInterval(currentTimerInterval);
    currentTimerInterval = null;
  }

  const tick = () => {
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

    // Automatically lock all option buttons if time reaches 0 before the participant submits an answer
    if (remainingSec <= 0) {
      document.querySelectorAll('.option-btn:not([disabled])').forEach((btn) => {
        btn.setAttribute('disabled', 'true');
        btn.classList.add('opacity-50', 'cursor-not-allowed');
      });
      const timeoutNotice = document.getElementById('answer-timeout-notice');
      if (timeoutNotice && !currentPlayer?.answeredQuestions?.[gameState.currentQuestionIndex]) {
        timeoutNotice.classList.remove('hidden');
      }
      if (currentTimerInterval) {
        clearInterval(currentTimerInterval);
        currentTimerInterval = null;
      }

      // Host triggers transition to LEADERBOARD after round timeout
      if (isHost && gameState.status === 'QUESTION_ACTIVE' && !autoLeaderboardTriggered) {
        autoLeaderboardTriggered = true;
        setTimeout(() => {
          autoLeaderboardTriggered = false;
          if (gameState.status === 'QUESTION_ACTIVE') {
            updateRoomDoc({
              status: 'LEADERBOARD',
              currentQuestionIndex: gameState.currentQuestionIndex,
              showAnswer: false,
              updatedAt: Date.now()
            });
          }
        }, 1200);
      }
    }
  };

  tick();
  currentTimerInterval = setInterval(tick, 100);
}

// ==========================================
// FIRESTORE MUTATION WRAPPERS
// ==========================================
function updateRoomDoc(partialState) {
  const gamePin = gameState.roomPin;
  if (!gamePin) return;
  gameState = { ...gameState, ...partialState };

  // Always update local cache & broadcast
  localStorage.setItem(`gdgoc_room_${gamePin}`, JSON.stringify(gameState));
  localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
  broadcastLocalState();

  // Authoritative server state update
  fetch(`/api/rooms/${gamePin}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partialState)
  }).catch(() => {});

  if (db && isFirebaseConnected) {
    const roomRef = doc(db, 'rooms', gamePin);
    setDoc(roomRef, partialState, { merge: true }).catch((err) => {
      console.warn('[Firestore] updateRoomDoc notice:', err?.message || err);
      if (err?.code === 'permission-denied' || String(err?.message || err).includes('permissions')) {
        setFirebaseConnected(false);
      }
    });
  }
  handleStateTransition(gameState);
}

function savePlayerToDB(player) {
  const gamePin = gameState.roomPin;
  if (!gamePin) return;
  players[player.id] = player;
  syncCurrentPlayerReference();

  // Always update local cache & broadcast
  localStorage.setItem(`gdgoc_players_${gamePin}`, JSON.stringify(players));
  localStorage.setItem('gdgoc_players', JSON.stringify(players));
  broadcastLocalState();

  // Authoritative server sync
  fetch(`/api/rooms/${gamePin}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(player)
  }).catch(() => {});

  if (db && isFirebaseConnected) {
    // Primary path: rooms/{gamePin}/participants/{userId}
    const participantRef = doc(db, 'rooms', gamePin, 'participants', player.id);
    setDoc(participantRef, player, { merge: true }).catch((err) => {
      console.warn('[Firestore] savePlayer notice:', err?.message || err);
      if (err?.code === 'permission-denied' || String(err?.message || err).includes('permissions')) {
        setFirebaseConnected(false);
      }
    });
    // Mirror path: rooms/{gamePin}/players/{userId} for backwards compatibility
    const playerRef = doc(db, 'rooms', gamePin, 'players', player.id);
    setDoc(playerRef, player, { merge: true }).catch(() => {});
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
    if (!isHost) {
      currentView = 'landing';
      showHostLoginModal = true;
      hostLoginError = 'Host authentication required. Please enter password.';
      root.innerHTML = renderLandingHTML();
      bindLandingEvents();
      return;
    }
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
  const branches = [
    { code: 'CSE', label: 'Computer Science & Engineering (CSE)' },
    { code: 'IT', label: 'Information Technology (IT)' },
    { code: 'ECE', label: 'Electronics & Communication (ECE)' },
    { code: 'ME', label: 'Mechanical Engineering (ME)' },
    { code: 'CE', label: 'Civil Engineering (CE)' },
    { code: 'AIML', label: 'AI & Machine Learning (AIML)' },
    { code: 'Other', label: 'Other Department' }
  ];
  const playerCount = Object.keys(players).length;

  return `
    <div class="app-viewport bg-[#0B0F17] text-slate-100 flex flex-col justify-between p-3 sm:p-4 md:p-6 safe-pad relative overflow-x-hidden">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(66,133,244,0.1),transparent_60%)] pointer-events-none"></div>

      <!-- Top Navigation Bar -->
      <header class="flex items-center justify-between w-full max-w-5xl mx-auto relative z-10 pb-3 sm:pb-4 border-b border-slate-800/80 gap-2 sm:gap-4">
        <!-- Left Side: GDG Full Logo (Pure Inline Vector SVG) -->
        <div class="flex items-center flex-1 justify-start min-w-0">
          <div class="header-logo">
            <svg viewBox="0 0 960 260" xmlns="http://www.w3.org/2000/svg" style="width: 100%; height: auto; display: block;">
              <!-- GDG CODE BRACKETS (< >) -->
              <g id="gdg-brackets">
                <!-- LEFT BRACKET (<) -->
                <line x1="425" y1="75" x2="458" y2="108" stroke="#4285F4" stroke-width="28" stroke-linecap="round" />
                <line x1="425" y1="75" x2="458" y2="42" stroke="#EA4335" stroke-width="28" stroke-linecap="round" />

                <!-- RIGHT BRACKET (>) -->
                <line x1="535" y1="75" x2="502" y2="108" stroke="#FBBC05" stroke-width="28" stroke-linecap="round" />
                <line x1="535" y1="75" x2="502" y2="42" stroke="#34A853" stroke-width="28" stroke-linecap="round" />
              </g>

              <!-- PRIMARY TEXT: Google Developer Groups -->
              <text x="480" y="172" 
                    text-anchor="middle" 
                    fill="#FFFFFF" 
                    font-family="'Google Sans', -apple-system, BlinkMacSystemFont, sans-serif" 
                    font-size="48" 
                    font-weight="500" 
                    letter-spacing="-0.5px">
                Google Developer Groups
              </text>

              <!-- SECONDARY TEXT: On Campus · Indo Global College -->
              <text x="480" y="218" text-anchor="middle" font-family="'Google Sans', -apple-system, BlinkMacSystemFont, sans-serif" font-size="30" font-weight="400">
                <tspan fill="#4285F4">On Campus</tspan>
                <tspan fill="#4285F4" font-weight="bold"> · </tspan>
                <tspan fill="#FFFFFF">Indo Global College</tspan>
              </text>
            </svg>
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
            <span>${playerCount} Online</span>
          </div>
          <button id="btn-host-login" class="px-3 sm:px-4 py-2 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 hover:border-blue-500/50 text-slate-200 hover:text-white font-mono text-xs font-bold flex items-center gap-2 cursor-pointer transition shadow-sm whitespace-nowrap">
            <svg class="w-3.5 h-3.5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <span>Host Login</span>
          </button>
        </div>
      </header>

      <!-- Center Registration Card -->
      <main id="viewLogin" class="w-full max-w-sm sm:max-w-xl md:max-w-2xl mx-auto px-4 py-6 sm:py-8 my-auto relative z-10">
        <div class="material-card rounded-3xl p-6 sm:p-10 space-y-6 max-w-xl mx-auto">
          <div class="space-y-1.5 text-center sm:text-left">
            <h2 class="text-2xl sm:text-3xl font-extrabold text-white font-display tracking-tight">Participant Sign-In</h2>
            <p class="text-xs sm:text-sm text-slate-400 font-mono">Enter your details and the session PIN shared by the host</p>
          </div>

          <div id="reg-error" class="hidden p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs font-mono flex items-center gap-2"></div>

          <form id="form-landing-register" class="space-y-5">
            <div>
              <label for="input-player-name" class="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-2 font-semibold">STUDENT FULL NAME *</label>
              <input
                id="input-player-name"
                type="text"
                value="${nameVal}"
                placeholder="e.g. Rahul Sharma"
                maxlength="32"
                class="w-full bg-slate-950/90 border border-slate-700/90 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-sm text-white placeholder:text-slate-500 focus:outline-none font-mono transition"
                autocomplete="name"
                required
              />
            </div>

            <div>
              <label for="select-player-branch" class="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-2 font-semibold">DEPARTMENT / BRANCH *</label>
              <div class="relative">
                <select
                  id="select-player-branch"
                  class="w-full bg-slate-950/90 border border-slate-700/90 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-sm text-white focus:outline-none font-mono transition cursor-pointer appearance-none"
                >
                  ${branches.map(b => `<option value="${b.code}" ${b.code === branchVal ? 'selected' : ''}>${b.label}</option>`).join('')}
                </select>
                <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-400">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
              </div>
            </div>

            <div>
              <label for="input-game-pin" class="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-2 font-semibold">GAME PIN CODE *</label>
              <input
                id="input-game-pin"
                type="text"
                placeholder="Enter 4-digit PIN shared by host"
                value=""
                maxlength="6"
                inputmode="numeric"
                pattern="[0-9]*"
                class="w-full bg-slate-950/90 border border-slate-700/90 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-white placeholder:text-slate-500 focus:outline-none font-mono transition tracking-widest font-bold text-lg"
                autocomplete="off"
                required
              />
              <p class="text-[11px] text-slate-400 font-mono mt-1.5">Enter the PIN code displayed on the host screen to join this session.</p>
            </div>

            <button
              type="submit"
              id="btn-submit-register"
              class="w-full py-4 px-6 rounded-2xl bg-[#4285F4] hover:bg-[#3367D6] active:bg-[#2A56C6] disabled:bg-slate-800 disabled:text-slate-500 disabled:border-slate-700 text-white font-bold font-mono tracking-wider uppercase transition shadow-lg shadow-blue-500/25 disabled:shadow-none text-sm flex items-center justify-center gap-2 mt-3 cursor-pointer"
            >
              <span id="btn-submit-label">ENTER THE GAME ZONE</span>
              <svg id="btn-submit-icon" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
            </button>
          </form>
        </div>
      </main>

      <footer class="w-full max-w-5xl mx-auto py-3 border-t border-slate-800/80 text-center font-mono text-xs text-slate-400 relative z-10">
        Built by Google Developer Groups on Campus IGC Team for community with love.
      </footer>

      <!-- Rules Modal -->
      ${showRulesModal ? `
        <div id="modal-rules-backdrop" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div class="material-card rounded-3xl max-w-lg w-full p-5 sm:p-8 space-y-4 sm:space-y-5 border border-slate-700 relative animate-scale-up modal-content custom-scrollbar">
            <div class="flex items-center justify-between pb-3 border-b border-slate-800">
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full bg-[#4285F4]"></span>
                <h3 class="text-base sm:text-lg font-bold text-white font-display">Competition Rules</h3>
              </div>
              <button id="btn-close-rules" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white cursor-pointer">
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
        <div id="modal-host-backdrop" class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div class="material-card rounded-3xl max-w-md w-full p-6 sm:p-8 space-y-5 border border-slate-700/80 relative animate-scale-up modal-content custom-scrollbar">
            <div class="flex items-center justify-between pb-3 border-b border-slate-800">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                </div>
                <div>
                  <h3 class="text-base sm:text-lg font-bold text-white font-display">Host Authentication</h3>
                  <p class="text-[11px] text-slate-400 font-mono">Enter host password to access console</p>
                </div>
              </div>
              <button id="btn-close-host-login" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white cursor-pointer transition">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>

            ${hostLoginError ? `
              <div class="p-3 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs font-mono flex items-center gap-2">
                <svg class="w-4 h-4 shrink-0 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                <span>${escapeHtml(hostLoginError)}</span>
              </div>
            ` : ''}

            <form id="form-host-auth" class="space-y-4">
              <div>
                <label for="input-host-password" class="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-2 font-semibold">Host Password *</label>
                <input
                  id="input-host-password"
                  type="password"
                  placeholder="Enter administrator password"
                  class="w-full bg-slate-950/90 border border-slate-700/90 focus:border-[#4285F4] focus:ring-1 focus:ring-[#4285F4] rounded-xl px-4 py-3.5 text-sm text-white placeholder:text-slate-500 focus:outline-none font-mono transition"
                  autofocus
                  required
                />
              </div>

              <div class="flex items-center gap-2.5 pt-2">
                <button
                  type="button"
                  id="btn-cancel-host-login"
                  class="w-1/2 py-3.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-white font-mono text-xs font-bold cursor-pointer transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="w-1/2 py-3.5 rounded-xl bg-[#4285F4] hover:bg-[#3367D6] active:bg-[#2A56C6] text-white font-mono text-xs font-bold cursor-pointer transition shadow-lg shadow-blue-500/25"
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
    isHost = false;
    hostLoginError = '';
    showHostLoginModal = true;
    renderApp();
    setTimeout(() => {
      document.getElementById('input-host-password')?.focus();
    }, 50);
  });

  document.getElementById('btn-close-host-login')?.addEventListener('click', () => {
    showHostLoginModal = false;
    renderApp();
  });

  document.getElementById('btn-cancel-host-login')?.addEventListener('click', () => {
    showHostLoginModal = false;
    renderApp();
  });

  // Close host modal on backdrop click
  document.getElementById('modal-host-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-host-backdrop') {
      showHostLoginModal = false;
      renderApp();
    }
  });

  // Close rules modal on backdrop click
  document.getElementById('modal-rules-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-rules-backdrop') {
      showRulesModal = false;
      renderApp();
    }
  });

  document.getElementById('form-host-auth')?.addEventListener('submit', async (e) => {
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
      // Mint a brand new unique PIN code for this new host session
      const newSessionPin = generate4DigitPin();
      await createRoom(newSessionPin);
    } else {
      hostLoginError = 'Invalid host password. Access denied.';
      renderApp();
      setTimeout(() => {
        document.getElementById('input-host-password')?.focus();
      }, 50);
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

  // Real-Time Participant Validation & Input Sanitation
  const nameInput = document.getElementById('input-player-name');
  const branchSelect = document.getElementById('select-player-branch');
  const pinInput = document.getElementById('input-game-pin');
  const submitBtn = document.getElementById('btn-submit-register');
  const errBox = document.getElementById('reg-error');

  function updateSubmitBtnState() {
    if (!submitBtn || !nameInput || !pinInput) return;
    const nameVal = nameInput.value.trim();
    const pinVal = pinInput.value.replace(/\D/g, '').trim();
    const branchVal = branchSelect ? branchSelect.value.trim() : '';
    const isValid = nameVal.length >= 2 && pinVal.length >= 4 && pinVal.length <= 6 && branchVal.length > 0;
    if (isValid) {
      submitBtn.removeAttribute('disabled');
      submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      submitBtn.classList.add('cursor-pointer');
    } else {
      submitBtn.setAttribute('disabled', 'true');
      submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
      submitBtn.classList.remove('cursor-pointer');
    }
  }

  // Sanitize PIN in real-time (allow 4 to 6 digits)
  pinInput?.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
    updateSubmitBtnState();
    if (errBox) errBox.classList.add('hidden');
  });

  nameInput?.addEventListener('input', () => {
    updateSubmitBtnState();
    if (errBox) errBox.classList.add('hidden');
  });

  branchSelect?.addEventListener('change', () => {
    updateSubmitBtnState();
  });

  // Initial check
  updateSubmitBtnState();

  // Participant Form Submit -> Dynamic Firestore Room Validation
  document.getElementById('form-landing-register')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nameInput || !pinInput || !submitBtn) return;

    const trimmedName = nameInput.value.trim();
    const enteredPin = pinInput.value.replace(/\D/g, '').trim();
    const branchVal = branchSelect?.value || 'CSE';

    if (!trimmedName || trimmedName.length < 2) {
      if (errBox) {
        errBox.textContent = 'Please enter a valid student name (at least 2 characters).';
        errBox.classList.remove('hidden');
      }
      return;
    }

    if (!enteredPin || enteredPin.length < 4 || enteredPin.length > 6) {
      if (errBox) {
        errBox.textContent = 'Please enter the valid 4-digit PIN Code shared by the host.';
        errBox.classList.remove('hidden');
      }
      return;
    }

    // Set loading state on submit button
    const submitLabel = document.getElementById('btn-submit-label');
    const submitIcon = document.getElementById('btn-submit-icon');
    submitBtn.setAttribute('disabled', 'true');
    submitBtn.classList.add('opacity-75', 'cursor-not-allowed');
    if (submitLabel) {
      submitLabel.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></span> ENTERING ROOM...';
    }
    if (submitIcon) submitIcon.classList.add('hidden');

    try {
      const result = await validateAndJoinRoom(trimmedName, branchVal, enteredPin);
      if (!result.success) {
        if (errBox) {
          errBox.textContent = result.error || 'Please enter a valid PIN Code.';
          errBox.classList.remove('hidden');
        }
        submitBtn.removeAttribute('disabled');
        submitBtn.classList.remove('opacity-75', 'cursor-not-allowed');
        if (submitLabel) submitLabel.textContent = 'ENTER THE GAME ZONE';
        if (submitIcon) submitIcon.classList.remove('hidden');
        updateSubmitBtnState();
        return;
      }

      playCorrectSound();
      currentPlayer = result.player;
      showRulesModal = false;
      pendingPlayer = null;
      currentView = 'player_game';
      renderApp();
    } catch (err) {
      console.warn('Validation error notice:', err);
      if (errBox) {
        errBox.textContent = 'Connection error. Please try again.';
        errBox.classList.remove('hidden');
      }
      submitBtn.removeAttribute('disabled');
      submitBtn.classList.remove('opacity-75', 'cursor-not-allowed');
      if (submitLabel) submitLabel.textContent = 'ENTER THE GAME ZONE';
      if (submitIcon) submitIcon.classList.remove('hidden');
      updateSubmitBtnState();
    }
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
function renderQuestionContentHTML(currentQ, qIndex, totalQuestions) {
  if (!currentQ) return '';

  const safePlayer = currentPlayer || (typeof window !== 'undefined' && localStorage.getItem('gdgoc_current_player') ? JSON.parse(localStorage.getItem('gdgoc_current_player')) : null) || { id: 'anon', name: 'Participant', branch: 'CSE', score: 0, answeredQuestions: {} };
  const prevAnswer = safePlayer.answeredQuestions?.[qIndex];
  const isLocked = !!prevAnswer;
  const selectedIdx = prevAnswer ? prevAnswer.selectedIndex : null;
  const isCorrect = prevAnswer ? prevAnswer.isCorrect : null;
  const isFastestForCurrent = gameState.fastestWinner && gameState.fastestWinner.questionIndex === qIndex && gameState.fastestWinner.playerId === safePlayer.id;

  // Real-time answer counter
  const totalPlayers = Object.keys(players).length;
  const answeredCount = Object.values(players).filter(p => p.answeredQuestions && p.answeredQuestions[qIndex]).length;

  // Zero-Drift remaining time check
  const currentRemainingSec = getRemainingTimeSubseconds(gameState.questionStartTime);
  const isTimeExpired = currentRemainingSec <= 0;

  // Google Quad Badge Colors for Options A, B, C, D
  const optionQuadConfig = [
    { letter: 'A', color: '#EA4335', bg: 'bg-[#EA4335]/15', border: 'border-[#EA4335]/40', text: 'text-[#EA4335]' },
    { letter: 'B', color: '#4285F4', bg: 'bg-[#4285F4]/15', border: 'border-[#4285F4]/40', text: 'text-[#4285F4]' },
    { letter: 'C', color: '#FBBC05', bg: 'bg-[#FBBC05]/15', border: 'border-[#FBBC05]/40', text: 'text-[#FBBC05]' },
    { letter: 'D', color: '#34A853', bg: 'bg-[#34A853]/15', border: 'border-[#34A853]/40', text: 'text-[#34A853]' }
  ];

  return `
    <div class="flex items-center justify-between text-xs font-mono">
      <div class="flex items-center gap-2">
        <span class="px-2.5 py-1 rounded-lg bg-[#4285F4]/15 border border-[#4285F4]/30 text-[#4285F4] font-bold">Q${qIndex + 1} / ${totalQuestions}</span>
        <span id="questionCategory" class="px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300 font-medium">${escapeHtml(currentQ.category || 'Tech Clash')}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="px-2.5 py-1 rounded-lg bg-blue-500/15 border border-blue-500/40 text-blue-300 font-bold flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
          <span>${answeredCount} / ${totalPlayers} Answered</span>
        </span>
        <span class="text-[#34A853] font-bold bg-[#34A853]/10 border border-[#34A853]/30 px-2.5 py-1 rounded-lg">${safePlayer.score || 0} pts</span>
      </div>
    </div>

    <div class="material-card rounded-2xl p-3.5 space-y-2 border border-white/10 bg-[#131B2E]">
      <div class="flex justify-between items-center text-xs font-mono">
        <span class="text-slate-400 flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-[#4285F4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span class="text-slate-300 font-semibold">Synchronized 10s Timer</span>
        </span>
        <span id="seconds-left-display" class="text-[#4285F4] font-mono font-bold text-sm">${currentRemainingSec.toFixed(1)}s</span>
      </div>
      <div class="w-full h-2 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
        <div id="timer-progress-bar" class="h-full bg-gradient-to-r from-[#4285F4] via-[#FBBC05] to-[#34A853] transition-all duration-100" style="width: ${(currentRemainingSec / 10) * 100}%"></div>
      </div>
    </div>

    <div class="material-card rounded-3xl p-5 sm:p-6 space-y-4 border border-white/10 bg-[#131B2E]">
      <h2 id="questionTitle" class="text-base sm:text-lg md:text-xl font-bold text-white leading-snug font-display">${escapeHtml(currentQ.question)}</h2>

      <div class="grid grid-cols-1 gap-2.5 sm:gap-3">
        ${currentQ.options.map((opt, idx) => {
          const cfg = optionQuadConfig[idx] || { letter: ['A','B','C','D'][idx], color: '#4285F4', bg: 'bg-[#4285F4]/10', border: 'border-[#4285F4]/30', text: 'text-[#4285F4]' };
          const letter = cfg.letter;
          const cardId = `option-card-${letter.toLowerCase()}`;
          let btnClass = 'bg-[#0B0F17]/90 border-slate-700/80 hover:border-slate-500 text-slate-200 active:scale-[0.98] shadow-sm';
          const isChosen = selectedIdx === idx;

          if (isLocked) {
            if (isChosen) {
              btnClass = isCorrect ? 'bg-[#34A853]/25 border-[#34A853] text-emerald-100 shadow-[0_0_15px_rgba(52,168,83,0.35)] cursor-not-allowed font-semibold' : 'bg-[#EA4335]/25 border-[#EA4335] text-rose-100 shadow-[0_0_15px_rgba(234,67,53,0.35)] cursor-not-allowed font-semibold';
            } else if (gameState.showAnswer && idx === currentQ.correctIndex) {
              btnClass = 'bg-[#34A853]/15 border-[#34A853]/60 text-emerald-300 cursor-not-allowed';
            } else {
              btnClass = 'bg-[#0B0F17]/40 border-slate-900 text-slate-500 opacity-40 cursor-not-allowed';
            }
          } else if (isTimeExpired) {
            btnClass = 'bg-[#0B0F17]/40 border-slate-900 text-slate-500 opacity-40 cursor-not-allowed';
          }

          return `
            <button
              id="${cardId}"
              class="option-btn w-full p-4 rounded-2xl border text-left font-sans text-xs sm:text-sm flex items-center justify-between transition-all duration-150 ${btnClass}"
              data-option-idx="${idx}"
              data-option-key="${letter}"
              ${isLocked || isTimeExpired ? 'disabled' : ''}
            >
              <div class="flex items-center gap-3">
                <span class="w-7 h-7 rounded-xl ${cfg.bg} ${cfg.border} border ${cfg.text} flex items-center justify-center font-mono text-xs font-black shrink-0">${letter}</span>
                <span class="font-medium text-white">${escapeHtml(opt)}</span>
              </div>
              ${isLocked && isChosen ? `
                <span class="shrink-0 ml-2">
                  ${isCorrect ? `
                    <svg class="w-5 h-5 text-[#34A853]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                  ` : `
                    <svg class="w-5 h-5 text-[#EA4335]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                  `}
                </span>
              ` : ''}
            </button>
          `;
        }).join('')}
      </div>

      <div id="answer-timeout-notice" class="p-3 rounded-xl border border-[#EA4335]/40 bg-[#EA4335]/15 text-[#EA4335] text-xs font-mono text-center ${isTimeExpired && !isLocked ? '' : 'hidden'}">
        Time Expired! Answer locked.
      </div>

      ${isLocked ? `
        <div class="p-3 rounded-xl border text-xs font-mono text-center ${isCorrect ? 'bg-[#34A853]/15 border-[#34A853]/40 text-emerald-300' : 'bg-[#EA4335]/15 border-[#EA4335]/40 text-rose-300'}">
          <div class="font-bold flex items-center justify-center gap-1.5">
            ${isCorrect ? `
              <svg class="w-4 h-4 text-[#34A853]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
              <span>Answer Locked! Recorded in System</span>
            ` : `
              <svg class="w-4 h-4 text-[#EA4335]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
              <span>Incorrect Choice Locked</span>
            `}
          </div>
          <div class="text-[11px] opacity-80 mt-0.5">Reaction Time: <b>${(prevAnswer.deltaMs / 1000).toFixed(2)}s</b></div>
        </div>
      ` : ''}

      ${isFastestForCurrent ? `
        <div class="p-3 rounded-xl bg-[#FBBC05]/20 border border-[#FBBC05]/60 text-[#FBBC05] text-xs font-mono text-center flex items-center justify-center gap-2">
          <svg class="w-4 h-4 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
          <span>FASTEST FINGER BONUS AWARDED (+2 pts)!</span>
        </div>
      ` : ''}
    </div>
  `;
}

function renderPlayerGameHTML() {
  if (!currentPlayer) {
    const defaultId = 'player_' + Math.random().toString(36).substring(2, 9);
    currentPlayer = {
      id: defaultId,
      name: 'Combatant ' + Math.floor(Math.random() * 900 + 100),
      branch: 'CSE',
      score: 0,
      answeredCount: 0,
      joinedAt: Date.now(),
      answeredQuestions: {},
      totalTimeTakenMs: 0,
      fastestCount: 0,
      lastActive: Date.now()
    };
    players[defaultId] = currentPlayer;
    if (typeof window !== 'undefined') {
      localStorage.setItem('gdgoc_current_player', JSON.stringify(currentPlayer));
    }
  }

  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = typeof gameState.currentQuestionIndex === 'number' ? gameState.currentQuestionIndex : (parseInt(gameState.currentQuestionIndex, 10) || 0);
  const currentQ = activeQuestions[qIndex] || questionsData[qIndex] || questionsData[0];

  const isWaiting = gameState.status === 'LOBBY';
  const isQuestionActive = gameState.status === 'QUESTION_ACTIVE';
  const isLeaderboard = gameState.status === 'LEADERBOARD';
  const isFinished = gameState.status === 'FINISHED';

  // Leaderboard data calculation
  let leaderboardContent = '';
  if (isLeaderboard) {
    const sorted = sortPlayers(players);
    const myRankIndex = sorted.findIndex(p => p.id === currentPlayer.id);
    const myRankNum = myRankIndex >= 0 ? myRankIndex + 1 : null;
    let myRankBadge = '--';
    let myRankIcon = `
      <div class="w-10 h-10 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center text-slate-300">
        <svg class="w-5 h-5 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.45 1-1 1H7c-.55 0-1 .45-1 1v1c0 .55.45 1 1 1h10c.55 0 1-.45 1-1v-1c0-.55-.45-1-1-1h-2c-.55 0-1-.45-1-1v-2.34"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"></path></svg>
      </div>
    `;
    if (myRankNum === 1) {
      myRankBadge = '#1';
      myRankIcon = `
        <div class="w-10 h-10 rounded-xl bg-[#FBBC05]/20 border border-[#FBBC05]/50 flex items-center justify-center">
          <svg class="w-6 h-6 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.45 1-1 1H7c-.55 0-1 .45-1 1v1c0 .55.45 1 1 1h10c.55 0 1-.45 1-1v-1c0-.55-.45-1-1-1h-2c-.55 0-1-.45-1-1v-2.34"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"></path></svg>
        </div>
      `;
    } else if (myRankNum === 2) {
      myRankBadge = '#2';
      myRankIcon = `
        <div class="w-10 h-10 rounded-xl bg-[#4285F4]/20 border border-[#4285F4]/50 flex items-center justify-center">
          <svg class="w-6 h-6 text-[#4285F4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>
        </div>
      `;
    } else if (myRankNum === 3) {
      myRankBadge = '#3';
      myRankIcon = `
        <div class="w-10 h-10 rounded-xl bg-[#34A853]/20 border border-[#34A853]/50 flex items-center justify-center">
          <svg class="w-6 h-6 text-[#34A853]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>
        </div>
      `;
    } else if (myRankNum !== null) {
      myRankBadge = `#${myRankNum}`;
    }

    leaderboardContent = `
      <div class="material-card rounded-2xl p-4 border border-[#4285F4]/40 bg-[#161F30] text-center space-y-2">
        <div class="flex items-center justify-center gap-2">
          <span class="w-2.5 h-2.5 rounded-full bg-[#FBBC05] animate-ping"></span>
          <span id="leaderboard-auto-timer" class="text-xs font-mono font-bold text-[#FBBC05] uppercase tracking-wider">Advancing in 3s...</span>
        </div>
        <h2 class="text-xl font-bold text-white font-display">Intermittent Leaderboard</h2>
        <p class="text-xs text-slate-400 font-mono">Scores updated after Question ${qIndex + 1}</p>
      </div>

      <div class="material-card rounded-2xl p-4 flex items-center justify-between border border-cyan-500/30 bg-[#161F30] font-mono">
        <div>
          <span class="text-[10px] uppercase tracking-wider text-slate-400 block">Your Current Standing</span>
          <span class="text-base font-bold text-white">${escapeHtml(currentPlayer.name)}</span>
          <span class="text-xs text-slate-400 block font-sans">${escapeHtml(currentPlayer.branch)}</span>
        </div>
        <div class="flex items-center gap-3">
          ${myRankIcon}
          <div class="text-right">
            <span class="text-xl font-black text-cyan-400 block">${myRankBadge}</span>
            <span class="text-xs text-[#34A853] font-bold block">${currentPlayer.score || 0} pts</span>
          </div>
        </div>
      </div>

      <div class="material-card rounded-2xl p-4 space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider">Current Top 5 Participants</h3>
          <span class="text-[11px] font-mono text-cyan-400">${Object.keys(players).length} Total</span>
        </div>
        ${renderLeaderboardHTML(players, 5, false)}
      </div>
    `;
  }

  // Finished tournament data
  let finishedContent = '';
  if (isFinished) {
    const sorted = sortPlayers(players);
    const myRankIndex = sorted.findIndex(p => p.id === currentPlayer.id);
    const myRankBadge = myRankIndex >= 0 ? `#${myRankIndex + 1}` : '--';

    const top1 = sorted[0];
    const top2 = sorted[1];
    const top3 = sorted[2];

    finishedContent = `
      <div class="space-y-5">
        <div class="space-y-1 text-center">
          <span class="text-xs font-mono uppercase tracking-widest text-[#FBBC05] font-bold px-3 py-1 rounded-full bg-[#FBBC05]/10 border border-[#FBBC05]/30">Tournament Complete</span>
          <h2 class="text-2xl sm:text-3xl font-extrabold text-white font-display">Grand Finale Winner Podium</h2>
        </div>

        <!-- Winner Podium Grid -->
        <div class="grid grid-cols-3 gap-2 sm:gap-3 items-end pt-2 text-center font-mono">
          <!-- 2nd Place -->
          <div class="p-3 rounded-2xl bg-[#161F30] border border-[#4285F4]/40 space-y-1.5 order-1">
            <div class="w-8 h-8 mx-auto rounded-lg bg-[#4285F4]/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-[#4285F4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>
            </div>
            <span class="text-[10px] text-slate-300 font-bold block">2ND PLACE</span>
            <span class="text-xs sm:text-sm font-bold text-white block truncate">${top2 ? escapeHtml(top2.name) : '---'}</span>
            <span class="text-[10px] text-[#4285F4] block">${top2 ? escapeHtml(top2.branch) : ''}</span>
            <span class="text-xs font-extrabold text-[#34A853] block">${top2 ? (top2.score || 0) : 0} pts</span>
          </div>

          <!-- 1st Place (Champion) -->
          <div class="p-3.5 sm:p-4 rounded-2xl bg-[#161F30] border-2 border-[#FBBC05] space-y-2 order-2 transform -translate-y-2 shadow-[0_0_24px_rgba(251,188,5,0.25)]">
            <div class="w-10 h-10 mx-auto rounded-xl bg-[#FBBC05]/20 flex items-center justify-center">
              <svg class="w-6 h-6 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.45 1-1 1H7c-.55 0-1 .45-1 1v1c0 .55.45 1 1 1h10c.55 0 1-.45 1-1v-1c0-.55-.45-1-1-1h-2c-.55 0-1-.45-1-1v-2.34"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"></path></svg>
            </div>
            <span class="text-[10px] text-[#FBBC05] font-black tracking-wider block">CHAMPION</span>
            <span class="text-sm sm:text-base font-black text-amber-200 block truncate">${top1 ? escapeHtml(top1.name) : '---'}</span>
            <span class="text-[10px] text-[#FBBC05] block">${top1 ? escapeHtml(top1.branch) : ''}</span>
            <span class="text-sm font-black text-[#34A853] block">${top1 ? (top1.score || 0) : 0} pts</span>
          </div>

          <!-- 3rd Place -->
          <div class="p-3 rounded-2xl bg-[#161F30] border border-[#34A853]/40 space-y-1.5 order-3">
            <div class="w-8 h-8 mx-auto rounded-lg bg-[#34A853]/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-[#34A853]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>
            </div>
            <span class="text-[10px] text-slate-300 font-bold block">3RD PLACE</span>
            <span class="text-xs sm:text-sm font-bold text-white block truncate">${top3 ? escapeHtml(top3.name) : '---'}</span>
            <span class="text-[10px] text-[#34A853] block">${top3 ? escapeHtml(top3.branch) : ''}</span>
            <span class="text-xs font-extrabold text-[#34A853] block">${top3 ? (top3.score || 0) : 0} pts</span>
          </div>
        </div>

        <!-- Participant Personal Standing Card -->
        <div class="p-4 rounded-2xl bg-[#161F30] border border-slate-800 text-left space-y-2 font-mono text-xs">
          <div class="flex justify-between"><span class="text-slate-400">Your Final Rank:</span><span class="text-[#FBBC05] font-bold text-sm">${myRankBadge}</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Total Score:</span><span class="text-[#34A853] font-extrabold text-sm">${currentPlayer.score || 0} PTS</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Fastest Finger Awards:</span><span class="text-[#4285F4] font-bold">${currentPlayer.fastestCount || 0}</span></div>
        </div>

        <!-- Full Top 5 Standings -->
        <div class="text-left space-y-2 pt-2 border-t border-slate-800">
          <span class="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider block">Top 5 Final Standings</span>
          ${renderLeaderboardHTML(players, 5, false)}
        </div>
      </div>
    `;
  }

  return `
    <div class="app-viewport bg-[#070b14] text-slate-100 flex flex-col justify-between safe-pad relative select-none font-sans overflow-x-hidden">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <div class="w-full max-w-sm sm:max-w-xl md:max-w-3xl lg:max-w-4xl mx-auto px-4 sm:px-6 py-4 flex-1 flex flex-col justify-between">
        <header class="flex items-center justify-between py-2 border-b border-slate-800/80 mb-3">
          <div class="flex items-center gap-2">
            <button id="btn-player-roles" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition text-xs font-mono cursor-pointer">← Roles</button>
            <button id="btn-toggle-sound" class="p-1.5 rounded-lg border text-xs transition flex items-center justify-center cursor-pointer ${soundEnabled ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-slate-900 border-slate-800 text-slate-500'}">
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
            <button id="btn-edit-profile" class="h-8 w-8 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-slate-300 hover:text-white text-xs font-bold cursor-pointer">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
          </div>
        </header>

        <main class="flex-1 flex flex-col justify-center my-auto w-full">
          <!-- 1. Lobby Waiting Screen Overlay -->
          <div id="viewLobby" data-view="lobby" class="${isWaiting ? '' : 'hidden'}" style="${isWaiting ? '' : 'display: none;'}">
            <div id="viewWaiting" class="material-card rounded-3xl p-6 text-center space-y-5">
              <div class="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/30 text-blue-400 mx-auto flex items-center justify-center">
                <svg class="w-8 h-8 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="16"></circle>
                </svg>
              </div>
              <div class="space-y-1">
                <h2 class="text-xl font-bold text-white font-display">Waiting for Host to launch...</h2>
                <p class="text-xs text-slate-400 font-mono">Arena Lobby Active • Get ready for the speed clash!</p>
              </div>
              <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 text-left space-y-2.5 font-mono text-xs">
                <div class="flex justify-between"><span class="text-slate-400">Combatant:</span><span class="text-white font-bold">${escapeHtml(currentPlayer.name)}</span></div>
                <div class="flex justify-between"><span class="text-slate-400">Department:</span><span class="text-cyan-400 font-bold">${currentPlayer.branch}</span></div>
                <div class="flex justify-between border-t border-slate-800 pt-2"><span class="text-slate-400">Total Score:</span><span class="text-emerald-400 font-extrabold text-sm">${currentPlayer.score || 0} PTS</span></div>
              </div>
            </div>
          </div>

          <!-- 2. Active Question View -->
          <div id="viewQuestion" class="${isQuestionActive ? '' : 'hidden'} space-y-4" style="${isQuestionActive ? '' : 'display: none;'}">
            ${currentQ ? renderQuestionContentHTML(currentQ, qIndex, activeQuestions.length) : ''}
          </div>

          <!-- 3. Intermittent Leaderboard View -->
          <div id="viewLeaderboard" class="${isLeaderboard ? '' : 'hidden'} space-y-4" style="${isLeaderboard ? '' : 'display: none;'}">
            ${leaderboardContent}
          </div>

          <!-- 4. Grand Finale / Finished View -->
          <div id="viewFinished" class="${isFinished ? '' : 'hidden'} material-card rounded-3xl p-6 text-center space-y-5" style="${isFinished ? '' : 'display: none;'}">
            ${finishedContent}
          </div>
        </main>

        <footer class="py-2 border-t border-slate-800/80 text-center font-mono text-[11px] text-slate-500">
          GDGoC IGC Game Zone • Real-Time Participant Node
        </footer>
      </div>
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

  // Re-bind option cards for active question
  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-option-idx'), 10);
      handlePlayerSubmitAnswer(idx);
    });
  });

  // If question is active, ensure zero-drift timer is actively ticking
  if (gameState.status === 'QUESTION_ACTIVE') {
    startLocalCountdown(gameState.questionStartTime);
  }
}

function handlePlayerSubmitAnswer(optionIndex) {
  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = gameState.currentQuestionIndex;
  const currentQ = activeQuestions[qIndex];
  if (!currentQ || !currentPlayer || currentPlayer.answeredQuestions?.[qIndex]) return;

  // Zero-Drift check: instantly lock if remaining time === 0
  const remainingSec = getRemainingTimeSubseconds(gameState.questionStartTime);
  if (remainingSec <= 0) return;

  const isCorrect = optionIndex === currentQ.correctIndex;
  const deltaMs = Math.max(10, Date.now() - (gameState.questionStartTime || Date.now()));
  const optionLetter = ['A', 'B', 'C', 'D'][optionIndex];

  // 1. Immediately lock ALL option buttons in the DOM to prevent double submits
  document.querySelectorAll('.option-btn').forEach(btn => {
    btn.setAttribute('disabled', 'true');
    btn.classList.add('cursor-not-allowed', 'opacity-60');
    btn.classList.remove('hover:border-slate-600', 'active:scale-[0.98]');
  });

  // 2. Visually highlight the chosen option card
  const chosenBtn = document.getElementById(`option-card-${optionLetter.toLowerCase()}`);
  if (chosenBtn) {
    chosenBtn.classList.remove('opacity-60');
    if (isCorrect) {
      chosenBtn.className = 'option-btn w-full p-4 rounded-xl border text-left font-mono text-xs sm:text-sm flex items-center justify-between transition-all duration-150 bg-emerald-950/80 border-emerald-500 text-emerald-200 shadow-[0_0_15px_rgba(16,185,129,0.3)] cursor-not-allowed';
    } else {
      chosenBtn.className = 'option-btn w-full p-4 rounded-xl border text-left font-mono text-xs sm:text-sm flex items-center justify-between transition-all duration-150 bg-rose-950/80 border-rose-500 text-rose-200 shadow-[0_0_15px_rgba(244,63,94,0.3)] cursor-not-allowed';
    }
  }

  // 3. Submit response payload directly to Firestore under rooms/{gamePin}/responses/{userId}
  const gamePin = gameState.roomPin || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('gdgoc_game_pin') : null);
  if (!gamePin) {
    console.warn('Cannot submit response: no active gamePin.');
    return;
  }
  const serverTs = (typeof window !== 'undefined' && window.firebase?.firestore?.FieldValue?.serverTimestamp)
    ? window.firebase.firestore.FieldValue.serverTimestamp()
    : serverTimestamp();

  const responsePayload = {
    userId: currentPlayer.id,
    userName: currentPlayer.name,
    branch: currentPlayer.branch,
    questionIndex: qIndex,
    optionKey: optionLetter,
    selectedIndex: optionIndex,
    isCorrect,
    deltaMs,
    timestamp: serverTs
  };

  if (db && isFirebaseConnected) {
    const responseRef = doc(db, 'rooms', gamePin, 'responses', currentPlayer.id);
    setDoc(responseRef, responsePayload, { merge: true }).catch(err => {
      console.warn('[Firestore] response recording notice:', err?.message || err);
      if (err?.code === 'permission-denied' || String(err?.message || err).includes('permissions')) {
        setFirebaseConnected(false);
      }
    });
  }

  // Audio feedback
  if (soundEnabled) {
    if (isCorrect) playCorrectSound();
    else playWrongSound();
  }

  // 4. Scoring: Remaining Seconds × 5 Points
  let pointsEarned = isCorrect ? Math.max(1, Math.round(remainingSec * 5)) : 0;

  // Fastest finger bonus check
  if (isCorrect && (!gameState.fastestWinner || gameState.fastestWinner.questionIndex !== qIndex)) {
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

  // Authoritative server answer recording
  fetch(`/api/rooms/${gamePin}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerId: currentPlayer.id,
      questionIndex: qIndex,
      selectedIndex: optionIndex,
      deltaMs,
      isCorrect,
      correctIndex: currentQ.correctIndex
    })
  }).catch(() => {});

  savePlayerToDB(currentPlayer);
  renderApp();
}

/// ==========================================
// VIEW 4: PRESENTER BIG SCREEN & HOST CONTROLS
// ==========================================
function renderPresenterHTML() {
  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = gameState.currentQuestionIndex;
  const isLobby = gameState.status === 'LOBBY' || qIndex < 0;
  const isFinalScreen = gameState.status === 'FINISHED' || qIndex >= activeQuestions.length;
  const isLeaderboardScreen = gameState.status === 'LEADERBOARD';
  const currentQ = !isLobby && !isFinalScreen && !isLeaderboardScreen ? activeQuestions[qIndex] : null;
  const playerCount = Object.keys(players).length;
  const joinedPlayers = Object.values(players);
  const currentRemainingSec = getRemainingTimeSubseconds(gameState.questionStartTime);
  const answeredCount = currentQ ? Object.values(players).filter(p => p.answeredQuestions && p.answeredQuestions[qIndex]).length : 0;

  // Real-time Sync Status Indicator
  const syncStatusHtml = isFirebaseConnected
    ? `<span class="px-2.5 py-1 rounded-full bg-[#34A853]/15 border border-[#34A853]/30 text-[#34A853] text-[11px] font-semibold flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-[#34A853]"></span>Cloud Sync</span>`
    : `<span class="px-2.5 py-1 rounded-full bg-[#4285F4]/15 border border-[#4285F4]/30 text-[#4285F4] text-[11px] font-semibold flex items-center gap-1.5" title="Operating with high-speed multi-tab BroadcastChannel sync"><span class="w-1.5 h-1.5 rounded-full bg-[#4285F4]"></span>Local Fast Sync</span>`;

  // Hero Section: Auditorium PIN Banner
  const heroPinBannerHtml = `
    <div class="host-glass-card rounded-3xl relative overflow-hidden border border-white/10 bg-[#131B2E] shadow-2xl mb-6">
      <div class="h-1.5 w-full bg-gradient-to-r from-[#4285F4] via-[#EA4335] via-[#FBBC05] to-[#34A853]"></div>
      <div class="p-6 sm:p-8 flex flex-col md:flex-row items-center justify-between gap-6">
        <div class="text-center md:text-left space-y-1.5">
          <div class="flex items-center justify-center md:justify-start gap-2.5">
            <span class="text-xs uppercase tracking-widest text-slate-400 font-semibold">JOIN AT INDOGLOBAL QUIZ ARENA</span>
            ${syncStatusHtml}
          </div>
          <div class="flex items-center justify-center md:justify-start gap-4">
            <span class="text-xs uppercase text-slate-400 font-medium tracking-wider">GAME PIN:</span>
            <span class="font-mono text-5xl sm:text-6xl md:text-7xl font-bold tracking-[0.25em] text-white drop-shadow-[0_0_25px_rgba(66,133,244,0.35)]">${escapeHtml(gameState.roomPin || '----')}</span>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button id="btn-copy-pin" class="px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/15 border border-white/15 text-white text-xs font-semibold flex items-center gap-2 cursor-pointer transition-all duration-200 hover:scale-105 active:scale-95 shadow-sm">
            <svg class="w-4 h-4 text-[#4285F4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span id="btn-copy-pin-label">Copy PIN</span>
          </button>
          <button id="btn-new-pin" class="px-4 py-2.5 rounded-full bg-[#1D263B] hover:bg-slate-700 border border-white/10 text-slate-300 text-xs font-medium flex items-center gap-2 cursor-pointer transition active:scale-95 shadow-sm" title="Generate New PIN">
            <svg class="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
            <span>New PIN</span>
          </button>
        </div>
      </div>
    </div>
  `;

  let mainStageHtml = '';

  if (isLobby) {
    mainStageHtml = `
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <!-- Left Column: Live Player Wall -->
        <div class="lg:col-span-7 host-glass-card rounded-3xl p-6 sm:p-8 space-y-5 border border-white/10 bg-[#131B2E] shadow-2xl">
          <div class="flex items-center justify-between border-b border-white/10 pb-4">
            <div class="flex items-center gap-2.5">
              <span class="w-2.5 h-2.5 rounded-full bg-[#34A853] animate-pulse"></span>
              <h2 class="text-lg sm:text-xl font-bold text-white font-display tracking-tight uppercase">Joined Participants</h2>
            </div>
            <span id="hostConnectedBadge" class="px-3.5 py-1 rounded-full bg-[#34A853]/15 border border-[#34A853]/30 text-[#34A853] text-xs font-semibold">${playerCount} Connected</span>
          </div>

          <!-- Dynamic Player Wall Grid -->
          <div id="hostPlayerGrid" class="flex flex-wrap gap-2.5 min-h-[220px] p-4 rounded-2xl bg-[#0B0F17]/80 border border-white/5 items-start content-start max-h-[420px] overflow-y-auto custom-scrollbar">
            ${joinedPlayers.length === 0 ? `
              <div class="w-full text-center py-12 space-y-3">
                <svg class="w-10 h-10 text-slate-600 mx-auto animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                <p class="text-sm text-slate-400 font-sans">Waiting for participants to enter PIN <strong class="text-white font-mono font-bold">${escapeHtml(gameState.roomPin || '----')}</strong>...</p>
              </div>
            ` : joinedPlayers.map(p => `
              <div class="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-[#1D263B] border border-white/10 text-slate-200 font-sans text-xs font-medium shadow-sm hover:border-white/20 transition-all animate-popIn">
                <div class="w-6 h-6 rounded-full bg-[#4285F4]/20 border border-[#4285F4]/40 flex items-center justify-center text-[10px] font-bold text-[#4285F4]">
                  ${(p.name || 'A').charAt(0).toUpperCase()}
                </div>
                <span class="text-white truncate max-w-[120px] font-medium">${escapeHtml(p.name || 'Anonymous')}</span>
                <span class="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-slate-300 border border-white/10">${escapeHtml(p.branch || 'CSE')}</span>
              </div>
            `).join('')}
          </div>

          <div class="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-white/5">
            <span>Room PIN: <strong class="text-white font-mono">${escapeHtml(gameState.roomPin || '----')}</strong></span>
            <span>${activeQuestions.length} Questions in Deck</span>
          </div>
        </div>

        <!-- Right Column: Master Launch Deck -->
        <div class="lg:col-span-5 host-glass-card rounded-3xl p-6 sm:p-8 space-y-6 border border-white/10 bg-[#131B2E] shadow-2xl flex flex-col justify-between">
          <div class="space-y-3">
            <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#4285F4]/10 border border-[#4285F4]/30 text-[#4285F4] text-xs font-semibold uppercase tracking-wider">
              <span class="w-2 h-2 rounded-full bg-[#4285F4]"></span>
              <span>Auditorium Control Deck</span>
            </div>
            <h3 class="text-2xl font-bold text-white font-display">Ready to Start Session?</h3>
            <p class="text-sm text-slate-300 font-sans leading-relaxed">
              Once you start the quiz, Question 1 will simultaneously broadcast to all connected participant screens with zero latency.
            </p>
          </div>

          <div class="p-4 rounded-2xl bg-[#0B0F17]/80 border border-white/5 space-y-2.5 text-xs">
            <div class="flex justify-between text-slate-400">
              <span>Connected Players:</span>
              <span id="connectedCount" class="font-bold text-[#34A853]">${playerCount} Connected</span>
            </div>
            <div class="flex justify-between text-slate-400">
              <span>Question Pack:</span>
              <span class="font-bold text-white">${activeQuestions.length} Items</span>
            </div>
            <div class="flex justify-between text-slate-400">
              <span>Timer per Item:</span>
              <span class="font-mono font-bold text-[#FBBC05]">10.0 Seconds</span>
            </div>
          </div>

          <div class="space-y-3">
            <button
              id="btn-start-quiz"
              class="w-full py-4 sm:py-5 px-8 rounded-2xl bg-[#4285F4] hover:bg-[#3367D6] active:bg-[#2A56C6] text-white font-bold text-lg sm:text-xl tracking-wider uppercase transition-all duration-200 shadow-[0_0_30px_rgba(66,133,244,0.35)] hover:shadow-[0_0_40px_rgba(66,133,244,0.5)] transform hover:-translate-y-0.5 active:scale-[0.98] flex items-center justify-center gap-3 cursor-pointer"
            >
              <svg class="w-6 h-6 fill-current" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              <span>START QUIZ</span>
            </button>

            <button id="btn-reset-room" class="w-full py-2.5 rounded-xl text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 text-xs font-semibold uppercase tracking-wider transition cursor-pointer">
              Reset Session Room
            </button>
          </div>
        </div>
      </div>
    `;
  } else if (isLeaderboardScreen) {
    mainStageHtml = `
      <div id="viewLeaderboard" class="host-glass-card rounded-3xl p-6 sm:p-10 text-center space-y-6 shadow-2xl border border-white/10 bg-[#131B2E]">
        <div class="flex items-center justify-center gap-2.5">
          <span class="w-2.5 h-2.5 rounded-full bg-[#FBBC05] animate-ping"></span>
          <span id="leaderboard-auto-timer" class="text-xs font-mono font-bold text-[#FBBC05] uppercase tracking-widest">Advancing in 3s...</span>
        </div>
        <div class="space-y-1">
          <h2 class="text-2xl sm:text-4xl font-bold text-white font-display uppercase tracking-tight">Leaderboard Standings</h2>
          <p class="text-xs sm:text-sm text-slate-400 font-sans">Scores after Question ${qIndex + 1} of ${activeQuestions.length}</p>
        </div>
        <div class="max-w-2xl mx-auto space-y-2 text-left">
          <div class="flex items-center justify-between pb-2 border-b border-white/10 text-xs text-slate-400 font-medium">
            <span>Top 5 Participants</span>
            <span>${playerCount} Active</span>
          </div>
          ${renderLeaderboardHTML(players, 5, false)}
        </div>
        <div class="pt-2">
          <button id="btn-force-next-now" class="px-8 py-3.5 rounded-2xl bg-[#4285F4] hover:bg-[#3367D6] text-white font-semibold text-xs uppercase tracking-wider cursor-pointer transition shadow-lg shadow-[#4285F4]/30">
            Advance Immediately ➔
          </button>
        </div>
      </div>
    `;
  } else if (!isFinalScreen && currentQ) {
    // Google Quad Accent Colors with Subdued Borders and Distinct Badges
    const cardThemes = [
      { letter: 'A', borderAccent: 'border-l-4 border-l-[#EA4335]', badge: 'bg-[#EA4335]/20 text-[#EA4335] border border-[#EA4335]/40', icon: `<svg class="w-5 h-5 text-[#EA4335]" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 2 22 22 22"></polygon></svg>` },
      { letter: 'B', borderAccent: 'border-l-4 border-l-[#4285F4]', badge: 'bg-[#4285F4]/20 text-[#4285F4] border border-[#4285F4]/40', icon: `<svg class="w-5 h-5 text-[#4285F4]" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 22 12 12 22 2 12"></polygon></svg>` },
      { letter: 'C', borderAccent: 'border-l-4 border-l-[#FBBC05]', badge: 'bg-[#FBBC05]/20 text-[#FBBC05] border border-[#FBBC05]/40', icon: `<svg class="w-5 h-5 text-[#FBBC05]" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"></circle></svg>` },
      { letter: 'D', borderAccent: 'border-l-4 border-l-[#34A853]', badge: 'bg-[#34A853]/20 text-[#34A853] border border-[#34A853]/40', icon: `<svg class="w-5 h-5 text-[#34A853]" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"></rect></svg>` }
    ];

    mainStageHtml = `
      <div class="host-glass-card rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6 border border-white/10 bg-[#131B2E] relative overflow-hidden">
        <div class="h-1.5 w-full absolute top-0 left-0 bg-gradient-to-r from-[#4285F4] via-[#EA4335] via-[#FBBC05] to-[#34A853]"></div>

        <!-- Active Question Header & Meter -->
        <div class="flex items-center justify-between flex-wrap gap-4 pt-1">
          <div class="flex items-center gap-3">
            <span class="px-3.5 py-1.5 rounded-xl bg-white/5 border border-white/10 text-[#94A3B8] text-sm font-medium">Q ${String(qIndex + 1).padStart(2, '0')} / ${String(activeQuestions.length).padStart(2, '0')}</span>
            <span class="px-3.5 py-1.5 rounded-xl bg-[#FBBC05]/10 border border-[#FBBC05]/20 text-[#FBBC05] text-xs font-semibold uppercase tracking-wider">${escapeHtml(currentQ.category)}</span>
          </div>

          <div class="flex items-center gap-3 text-xs">
            <div class="flex items-center gap-2 px-3.5 py-2 rounded-full bg-[#1D263B] border border-white/10 text-slate-200 font-medium">
              <span class="w-2 h-2 rounded-full bg-[#34A853] animate-pulse"></span>
              <span><strong class="text-white">${answeredCount}</strong> / ${playerCount} Submitted</span>
            </div>
            <div class="flex items-center gap-2 bg-[#0B0F17]/90 border border-white/10 px-4 py-1.5 rounded-full">
              <svg class="w-4 h-4 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              <span id="seconds-left-display" class="text-lg sm:text-xl font-bold font-mono text-[#FBBC05]">${currentRemainingSec.toFixed(1)}s</span>
            </div>
          </div>
        </div>

        <!-- Timer Progress Bar -->
        <div class="w-full h-2 rounded-full bg-[#0B0F17] overflow-hidden border border-white/5">
          <div id="timer-progress-bar" class="h-full bg-gradient-to-r from-[#4285F4] via-[#FBBC05] to-[#EA4335] transition-all duration-100" style="width: ${(currentRemainingSec / 10) * 100}%"></div>
        </div>

        <!-- Question Text -->
        <h2 class="text-2xl sm:text-3xl font-bold text-white leading-relaxed font-sans py-2">${escapeHtml(currentQ.question)}</h2>

        <!-- 4 Option Cards in 2x2 Grid with Subtle Google Quad Accents -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          ${currentQ.options.map((opt, idx) => {
            const theme = cardThemes[idx] || cardThemes[0];
            const isCorrect = idx === currentQ.correctIndex;
            let cardClasses = `bg-[#131B2E]/80 border border-white/5 hover:border-white/20 hover:bg-[#1D263B] transition-all duration-200 rounded-2xl p-5 flex items-center justify-between gap-4 ${theme.borderAccent}`;
            if (gameState.showAnswer) {
              if (isCorrect) {
                cardClasses = `p-5 rounded-2xl border-2 border-[#34A853] bg-[#34A853]/20 text-white shadow-[0_0_30px_rgba(52,168,83,0.35)] ${theme.borderAccent}`;
              } else {
                cardClasses = `p-5 rounded-2xl border border-white/5 bg-[#0B0F17]/40 text-slate-500 opacity-40 ${theme.borderAccent}`;
              }
            }

            return `
              <div class="${cardClasses}">
                <div class="flex items-center gap-3.5 min-w-0">
                  <span class="w-9 h-9 rounded-xl ${theme.badge} flex items-center justify-center font-bold text-sm shrink-0 shadow-sm">${theme.letter}</span>
                  <div class="flex items-center gap-2.5 min-w-0">
                    <span class="shrink-0 opacity-80">${theme.icon}</span>
                    <span class="text-white text-base md:text-lg font-medium leading-normal break-words">${escapeHtml(opt)}</span>
                  </div>
                </div>
                ${gameState.showAnswer && isCorrect ? `
                  <span class="px-3 py-1 rounded-full bg-[#34A853] text-white text-xs font-semibold flex items-center gap-1.5 shadow-sm shrink-0">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    Correct
                  </span>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>

        <!-- Explanation if revealed -->
        ${gameState.showAnswer && currentQ.explanation ? `
          <div class="p-4 rounded-2xl bg-[#4285F4]/10 border border-[#4285F4]/30 text-sm text-slate-200 font-sans leading-relaxed">
            <span class="font-bold text-[#4285F4] block mb-1 uppercase tracking-wider text-xs">Host Explanation:</span>
            ${escapeHtml(currentQ.explanation)}
          </div>
        ` : ''}

        <!-- Action Control Dock (Bottom Toolbar) -->
        <div class="pt-5 border-t border-white/10 flex items-center justify-between flex-wrap gap-3">
          <div class="flex items-center gap-2.5 flex-wrap">
            <button id="btn-toggle-answer" class="px-5 py-2.5 rounded-xl border text-sm font-medium flex items-center gap-2 cursor-pointer transition-all ${gameState.showAnswer ? 'bg-[#FBBC05]/20 border-[#FBBC05]/50 text-[#FBBC05]' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
              <span>${gameState.showAnswer ? 'Hide Answer' : 'Reveal Answer'}</span>
            </button>
            <button id="btn-restart-timer" class="px-5 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium flex items-center gap-2 cursor-pointer transition-all">
              <svg class="w-4 h-4 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
              <span>Reset Timer</span>
            </button>
          </div>
          <div class="flex items-center gap-2.5">
            ${qIndex > 0 ? `<button id="btn-prev-q" class="px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium cursor-pointer transition-all">← Previous</button>` : ''}
            <button id="btn-next-q" class="px-6 py-2.5 rounded-xl bg-[#4285F4] hover:bg-[#3367D6] text-white font-semibold text-sm cursor-pointer transition-all shadow-lg shadow-[#4285F4]/25 active:scale-95 flex items-center gap-2">
              <span>Leaderboard</span>
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  } else {
    // Grand Finale Winner Podium
    const sorted = sortPlayers(players);
    const top1 = sorted[0];
    const top2 = sorted[1];
    const top3 = sorted[2];

    mainStageHtml = `
      <div class="host-glass-card rounded-3xl p-6 sm:p-10 text-center space-y-6 shadow-2xl border border-white/10 bg-[#131B2E]">
        <div class="space-y-1.5">
          <span class="text-xs uppercase tracking-widest text-[#FBBC05] font-semibold px-3.5 py-1 rounded-full bg-[#FBBC05]/10 border border-[#FBBC05]/30">Tournament Complete</span>
          <h1 class="text-3xl md:text-5xl font-extrabold text-white font-display uppercase tracking-tight">Grand Finale Winner Podium</h1>
          <p class="text-xs sm:text-sm text-slate-400 font-sans">${playerCount} Total Combatants</p>
        </div>

        <!-- Winner Podium Grid -->
        <div class="grid grid-cols-3 gap-3 sm:gap-4 max-w-2xl mx-auto items-end pt-4 text-center font-sans">
          <!-- 2nd Place -->
          <div class="p-4 rounded-2xl bg-[#0B0F17] border border-[#4285F4]/40 space-y-2 order-1">
            <div class="w-10 h-10 mx-auto rounded-xl bg-[#4285F4]/20 flex items-center justify-center">
              <svg class="w-6 h-6 text-[#4285F4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>
            </div>
            <span class="text-xs text-slate-300 font-semibold block">2ND PLACE</span>
            <span class="text-sm sm:text-base font-bold text-white block truncate">${top2 ? escapeHtml(top2.name) : '---'}</span>
            <span class="text-xs text-[#4285F4] block">${top2 ? escapeHtml(top2.branch) : ''}</span>
            <span class="text-sm font-bold text-[#34A853] block font-mono">${top2 ? (top2.score || 0) : 0} pts</span>
          </div>

          <!-- 1st Place (Champion) -->
          <div class="p-5 sm:p-6 rounded-2xl bg-[#0B0F17] border-2 border-[#FBBC05] space-y-2.5 order-2 transform -translate-y-4 shadow-[0_0_35px_rgba(251,188,5,0.3)]">
            <div class="w-12 h-12 mx-auto rounded-xl bg-[#FBBC05]/20 flex items-center justify-center">
              <svg class="w-8 h-8 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.45 1-1 1H7c-.55 0-1 .45-1 1v1c0 .55.45 1 1 1h10c.55 0 1-.45 1-1v-1c0-.55-.45-1-1-1h-2c-.55 0-1-.45-1-1v-2.34"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"></path></svg>
            </div>
            <span class="text-xs text-[#FBBC05] font-bold tracking-wider block">CHAMPION</span>
            <span class="text-base sm:text-lg font-bold text-amber-200 block truncate">${top1 ? escapeHtml(top1.name) : '---'}</span>
            <span class="text-xs text-[#FBBC05] block">${top1 ? escapeHtml(top1.branch) : ''}</span>
            <span class="text-base font-bold text-[#34A853] block font-mono">${top1 ? (top1.score || 0) : 0} pts</span>
          </div>

          <!-- 3rd Place -->
          <div class="p-4 rounded-2xl bg-[#0B0F17] border border-[#34A853]/40 space-y-2 order-3">
            <div class="w-10 h-10 mx-auto rounded-xl bg-[#34A853]/20 flex items-center justify-center">
              <svg class="w-6 h-6 text-[#34A853]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>
            </div>
            <span class="text-xs text-slate-300 font-semibold block">3RD PLACE</span>
            <span class="text-sm sm:text-base font-bold text-white block truncate">${top3 ? escapeHtml(top3.name) : '---'}</span>
            <span class="text-xs text-[#34A853] block">${top3 ? escapeHtml(top3.branch) : ''}</span>
            <span class="text-sm font-bold text-[#34A853] block font-mono">${top3 ? (top3.score || 0) : 0} pts</span>
          </div>
        </div>

        <!-- Top 5 List -->
        <div class="max-w-2xl mx-auto space-y-2 text-left pt-4 border-t border-white/10">
          <div class="flex items-center justify-between pb-1 text-xs text-slate-400 font-medium">
            <span>Top 5 Rankings</span>
            <span>Speed Tie-Breakers Applied</span>
          </div>
          ${renderLeaderboardHTML(players, 5, false)}
        </div>

        <div class="pt-2">
          <button id="btn-restart-tournament" class="px-8 py-3.5 rounded-2xl bg-[#4285F4] hover:bg-[#3367D6] text-white font-semibold text-sm cursor-pointer transition uppercase tracking-wider shadow-lg shadow-[#4285F4]/30">
            Restart Tournament
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="app-viewport bg-[#0B0F17] text-slate-100 flex flex-col justify-between p-3 sm:p-4 md:p-6 safe-pad relative select-none font-sans overflow-x-hidden">
      <!-- Top Sticky Header -->
      <header class="flex items-center justify-between pb-3 sm:pb-4 border-b border-white/10 mb-4 sm:mb-6 relative z-10 gap-3">
        <!-- Left: Inline GDGoC SVG Logo -->
        <div class="flex items-center gap-3">
          <svg class="w-8 h-8 shrink-0" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M22 14L8 32L22 50" stroke="#4285F4" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M42 14L56 32L42 50" stroke="#EA4335" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M35 12L25 52" stroke="#FBBC05" stroke-width="7" stroke-linecap="round"/>
          </svg>
          <div>
            <span class="font-bold text-sm sm:text-base text-white tracking-tight block">GDGoC Indo Global College</span>
            <span class="text-[10px] text-slate-400 uppercase tracking-wider block">Auditorium Host Console</span>
          </div>
        </div>

        <!-- Center: Single subtle LIVE HOST CONSOLE pill indicator -->
        <div class="hidden md:flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#4285F4]/10 border border-[#4285F4]/20 text-[#4285F4] text-xs font-semibold tracking-wider uppercase">
          <span class="w-2 h-2 rounded-full bg-[#4285F4] animate-pulse"></span>
          <span>LIVE HOST CONSOLE</span>
        </div>

        <!-- Right: Control Actions -->
        <div class="flex items-center gap-2">
          <button id="btn-open-qm" class="px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-slate-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition">
            <svg class="w-4 h-4 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
            <span class="hidden sm:inline">Questions</span> (${activeQuestions.length})
          </button>
          <button id="btn-presenter-sound" class="p-2.5 rounded-xl border flex items-center justify-center ${soundEnabled ? 'bg-[#FBBC05]/15 border-[#FBBC05]/40 text-[#FBBC05]' : 'bg-white/5 border-white/10 text-slate-500'} cursor-pointer transition" title="Toggle Stage Audio">
            ${soundEnabled ? `
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
            ` : `
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>
            `}
          </button>
          <button id="btn-presenter-roles" class="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-[#EA4335]/20 border border-white/10 hover:border-[#EA4335]/40 text-[#EA4335] text-xs font-medium flex items-center gap-1.5 cursor-pointer transition" title="Exit Host Screen (Password required to re-enter)">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
            <span class="hidden sm:inline">Exit Host Screen</span>
          </button>
        </div>
      </header>

      <!-- Main Stage Container -->
      <main class="flex-1 max-w-7xl mx-auto w-full relative z-10">
        ${heroPinBannerHtml}
        ${mainStageHtml}
      </main>

      <!-- Question Manager Vault Modal -->
      ${showQuestionManagerModal ? `
        <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div class="host-glass-card rounded-3xl max-w-2xl w-full p-5 sm:p-8 space-y-4 border border-white/15 bg-[#131B2E] relative animate-scale-up modal-content custom-scrollbar">
            <div class="flex items-center justify-between pb-3 border-b border-white/10">
              <div class="flex items-center gap-2">
                <svg class="w-5 h-5 text-[#FBBC05]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                <h3 class="text-base sm:text-lg font-bold text-white font-display">Tournament Question Vault</h3>
              </div>
              <button id="btn-close-qm" class="p-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white cursor-pointer">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            </div>
            <div class="max-h-[50dvh] overflow-y-auto custom-scrollbar space-y-3 text-xs">
              ${activeQuestions.map((q, idx) => `
                <div class="p-3.5 rounded-2xl border ${idx === qIndex ? 'border-[#4285F4]/50 bg-[#4285F4]/10' : 'border-white/5 bg-[#0B0F17]/60'} space-y-2">
                  <div class="flex items-center justify-between">
                    <span class="font-bold text-[#4285F4]">Q${idx + 1}: ${escapeHtml(q.category)}</span>
                    <div class="flex items-center gap-2">
                      <span class="text-[10px] text-slate-400 font-mono">Correct: [${['A','B','C','D'][q.correctIndex]}]</span>
                      <button class="btn-launch-vault-q px-3 py-1 rounded-lg bg-[#4285F4]/20 hover:bg-[#4285F4]/30 border border-[#4285F4]/40 text-white text-[10px] font-semibold cursor-pointer" data-q-idx="${idx}">Launch Question</button>
                    </div>
                  </div>
                  <p class="text-slate-200 font-sans">${escapeHtml(q.question)}</p>
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
  document.getElementById('btn-presenter-roles')?.addEventListener('click', async () => {
    isHost = false;
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('gdgoc_is_host');
      sessionStorage.removeItem('gdgoc_host_room_pin');
      localStorage.removeItem('gdgoc_is_host');
    }
    // Generate a fresh unique PIN for the next session so the previous session PIN is retired
    const nextPin = generate4DigitPin();
    gameState.roomPin = nextPin;
    if (typeof window !== 'undefined') {
      localStorage.setItem('gdgoc_active_room_pin', nextPin);
    }
    fetch(`/api/rooms/${nextPin}/create`, { method: 'POST' }).catch(() => {});

    currentView = 'landing';
    showHostLoginModal = false;
    showToast('Host screen exited. Session closed. Password required to re-enter.');
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

  document.getElementById('btn-new-pin')?.addEventListener('click', async () => {
    const newPin = generate4DigitPin();
    await createRoom(newPin);
    showToast(`New Room Initialized: PIN ${newPin}`);
    renderApp();
  });

  document.getElementById('btn-copy-pin')?.addEventListener('click', () => {
    const pin = gameState.roomPin;
    if (!pin) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(pin).then(() => {
        showToast('Game PIN copied to clipboard!');
        const copyLabel = document.getElementById('btn-copy-pin-label');
        if (copyLabel) {
          copyLabel.textContent = 'Copied!';
          setTimeout(() => {
            if (copyLabel) copyLabel.textContent = 'Copy PIN';
          }, 2000);
        }
      }).catch(() => {
        showToast(`Game PIN: ${pin}`);
      });
    } else {
      showToast(`Game PIN: ${pin}`);
    }
  });

  // Host Action 1: Start Game (Question 1)
  document.getElementById('btn-start-quiz')?.addEventListener('click', () => {
    launchQuestion(0);
  });
  document.getElementById('btn-launch-q1')?.addEventListener('click', () => {
    launchQuestion(0);
  });

  // Launch from Question Vault
  document.querySelectorAll('.btn-launch-vault-q').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-q-idx'), 10);
      showQuestionManagerModal = false;
      launchQuestion(idx);
    });
  });

  // Host Action 2: Next Question Flow -> Updates status to 'LEADERBOARD'
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
      launchQuestion(nextIndex);
    }
  });

  document.getElementById('btn-toggle-answer')?.addEventListener('click', () => {
    updateRoomDoc({ showAnswer: !gameState.showAnswer, updatedAt: Date.now() });
  });

  document.getElementById('btn-restart-timer')?.addEventListener('click', () => {
    const serverTs = (typeof window !== 'undefined' && window.firebase?.firestore?.FieldValue?.serverTimestamp)
      ? window.firebase.firestore.FieldValue.serverTimestamp()
      : serverTimestamp();
    updateRoomDoc({ questionStartTime: serverTs, updatedAt: Date.now() });
  });

  document.getElementById('btn-prev-q')?.addEventListener('click', () => {
    const prevIdx = Math.max(0, (gameState.currentQuestionIndex || 0) - 1);
    launchQuestion(prevIdx);
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
      roomPin: gameState.roomPin,
      updatedAt: Date.now()
    };
    updateRoomDoc(resetState);
  });
}

// ==========================================
// SYSTEM BOOTSTRAP & GLOBAL EXPOSURE
// ==========================================
if (typeof window !== 'undefined') {
  window.listenToRoom = listenToRoom;
  window.launchQuestion = launchQuestion;
  window.handleStateTransition = handleStateTransition;
}

async function initApp() {
  initFirestoreSync();
  try {
    const res = await fetch('/api/active-pin');
    if (res.ok) {
      const data = await res.json();
      if (data && data.activePin) {
        const active = String(data.activePin).trim();
        if (!gameState.roomPin || gameState.roomPin === '----') {
          gameState.roomPin = active;
        }
        listenToRoom(gameState.roomPin || active);
      }
    }
  } catch {}
  renderApp();
}

initApp();
