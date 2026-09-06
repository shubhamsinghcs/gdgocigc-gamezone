/**
 * js/app.js
 * Main state machine, DOM event handlers, view router
 */

import { rtdb, ref, onValue, set, isFirebaseConnected } from './firebase-config.js';
import { questionsData, getActiveQuestions } from './questions.js';
import { playCorrectSound, playWrongSound, playWinnerFanfare } from './audio.js';
import { renderLeaderboardHTML, calculateBranchStats } from './leaderboard.js';

// Application State
let currentView = 'landing'; // 'landing' | 'player_register' | 'player_game' | 'presenter_big_screen'
let currentPlayer = null;
let gameState = {
  currentQuestionIndex: -1,
  questionStartTime: Date.now(),
  isTimerActive: false,
  timerDurationSec: 15,
  showAnswer: false,
  fastestWinner: null,
  questions: questionsData,
  roomPin: '4829'
};
let players = {};
let soundEnabled = true;

// Channel for multi-tab fallback sync when Firebase RTDB isn't connected
const broadcastChannel = typeof window !== 'undefined' ? new BroadcastChannel('gdgoc_game_zone_sync') : null;

if (broadcastChannel) {
  broadcastChannel.onmessage = (event) => {
    if (event.data) {
      if (event.data.type === 'STATE_UPDATE') {
        gameState = event.data.gameState;
        renderApp();
      }
      if (event.data.type === 'PLAYERS_UPDATE') {
        players = event.data.players;
        renderApp();
      }
    }
  };
}

function broadcastLocalState() {
  if (broadcastChannel) {
    broadcastChannel.postMessage({ type: 'STATE_UPDATE', gameState });
    broadcastChannel.postMessage({ type: 'PLAYERS_UPDATE', players });
  }
}

// Firebase Listeners
function initFirebaseListeners() {
  if (!rtdb) {
    // Load local storage fallback
    loadLocalFallbackState();
    return;
  }

  try {
    const gameRef = ref(rtdb, 'game_state');
    onValue(gameRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        gameState = data;
        renderApp();
      }
    });

    const playersRef = ref(rtdb, 'players');
    onValue(playersRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        players = data;
        renderApp();
      }
    });
  } catch (err) {
    console.warn('Firebase listen error, using local fallback:', err);
    loadLocalFallbackState();
  }
}

function loadLocalFallbackState() {
  try {
    const savedGame = localStorage.getItem('gdgoc_game_state');
    if (savedGame) gameState = JSON.parse(savedGame);
    const savedPlayers = localStorage.getItem('gdgoc_players');
    if (savedPlayers) players = JSON.parse(savedPlayers);
  } catch {
    // ignore
  }
  renderApp();
}

function saveStateToDB(newGameState) {
  gameState = newGameState;
  if (rtdb) {
    set(ref(rtdb, 'game_state'), gameState).catch(() => {});
  } else {
    localStorage.setItem('gdgoc_game_state', JSON.stringify(gameState));
    broadcastLocalState();
  }
  renderApp();
}

function savePlayerToDB(player) {
  players[player.id] = player;
  if (rtdb) {
    set(ref(rtdb, `players/${player.id}`), player).catch(() => {});
  } else {
    localStorage.setItem('gdgoc_players', JSON.stringify(players));
    broadcastLocalState();
  }
  renderApp();
}

// Timer Loop
setInterval(() => {
  if (gameState.isTimerActive && gameState.currentQuestionIndex >= 0) {
    // update timer display if in active views
    const timerEl = document.getElementById('seconds-left-display');
    const barEl = document.getElementById('timer-progress-bar');
    if (timerEl && barEl) {
      const activeQs = getActiveQuestions(gameState.questions);
      if (gameState.currentQuestionIndex < activeQs.length) {
        const elapsed = (Date.now() - gameState.questionStartTime) / 1000;
        const remaining = Math.max(0, 15 - elapsed);
        timerEl.textContent = remaining.toFixed(1) + 's';
        const pct = Math.min(100, Math.max(0, (remaining / 15) * 100));
        barEl.style.width = pct + '%';
        if (remaining <= 4) {
          timerEl.className = 'text-sm font-extrabold text-rose-400 animate-pulse';
          barEl.className = 'h-full transition-all duration-100 bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.6)]';
        } else {
          timerEl.className = 'text-sm font-extrabold text-cyan-400';
          barEl.className = 'h-full transition-all duration-100 bg-gradient-to-r from-cyan-500 to-amber-400';
        }
      }
    }
  }
}, 100);

// Router & Rendering Engine
function renderApp() {
  const root = document.getElementById('app-root');
  if (!root) return;

  // Restore current player from localStorage if not loaded
  if (!currentPlayer && typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem('gdgoc_current_player');
      if (saved) currentPlayer = JSON.parse(saved);
    } catch {
      // ignore
    }
  }

  // Keep currentPlayer synchronized with players map
  if (currentPlayer && players[currentPlayer.id]) {
    currentPlayer = players[currentPlayer.id];
  }

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
  const playerCount = Object.keys(players).length;
  return `
    <div class="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <div class="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(66,133,244,0.12),transparent_60%)] pointer-events-none"></div>

      <div class="w-full max-w-xl text-center space-y-8 relative z-10 my-auto">
        <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 font-mono text-xs uppercase tracking-widest font-bold">
          <span>⚡ GDGoC IGC Speed Arena</span>
        </div>

        <div class="space-y-3">
          <h1 class="text-4xl sm:text-6xl font-black text-white font-display tracking-tight">
            Game Zone <span class="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-red-400 to-yellow-400">Clash</span>
          </h1>
          <p class="text-sm sm:text-base text-slate-400 max-w-md mx-auto font-mono">
            Fastest Finger First • 15s Round Countdown • Microsecond Speed Bonus • Live Firestore Sync
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md mx-auto pt-2">
          <button
            id="btn-role-player"
            class="p-6 rounded-2xl material-card hover:border-blue-500/50 transition flex flex-col items-center text-center space-y-3 group cursor-pointer"
          >
            <div class="w-14 h-14 rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 group-hover:scale-110 transition">
              🎮
            </div>
            <div>
              <h3 class="text-lg font-bold text-white">Join as Player</h3>
              <p class="text-xs text-slate-400 mt-1">Answer questions fast & rack up branch points</p>
            </div>
            <span class="text-xs font-mono text-emerald-400 bg-emerald-950/40 border border-emerald-500/30 px-3 py-1 rounded-full">
              ${playerCount} Combatants Online
            </span>
          </button>

          <button
            id="btn-role-presenter"
            class="p-6 rounded-2xl material-card hover:border-yellow-500/50 transition flex flex-col items-center text-center space-y-3 group cursor-pointer"
          >
            <div class="w-14 h-14 rounded-2xl bg-yellow-500/15 border border-yellow-500/30 flex items-center justify-center text-yellow-400 group-hover:scale-110 transition">
              🖥️
            </div>
            <div>
              <h3 class="text-lg font-bold text-white">Big Screen Presenter</h3>
              <p class="text-xs text-slate-400 mt-1">Host live showdown & manage questions</p>
            </div>
            <span class="text-xs font-mono text-cyan-400 bg-cyan-950/40 border border-cyan-500/30 px-3 py-1 rounded-full">
              Full Host Mode
            </span>
          </button>
        </div>

        <div class="pt-4 text-xs font-mono text-slate-500">
          Powered by Google Developer Groups on Campus • Web Audio API & ES6 Modules
        </div>
      </div>
    </div>
  `;
}

function bindLandingEvents() {
  document.getElementById('btn-role-player')?.addEventListener('click', () => {
    if (currentPlayer) {
      currentView = 'player_game';
    } else {
      currentView = 'player_register';
    }
    renderApp();
  });

  document.getElementById('btn-role-presenter')?.addEventListener('click', () => {
    currentView = 'presenter_big_screen';
    renderApp();
  });
}

// ==========================================
// VIEW 2: PLAYER REGISTRATION
// ==========================================
function renderPlayerRegisterHTML() {
  const nameVal = currentPlayer?.name || '';
  const branchVal = currentPlayer?.branch || 'CSE';
  const branches = ['CSE', 'ECE', 'IT', 'ME', 'CE', 'Other'];

  return `
    <div class="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col items-center justify-center p-4 relative">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <div class="w-full max-w-md relative z-10">
        <button id="btn-back-landing" class="flex items-center gap-1.5 text-xs font-mono text-slate-400 hover:text-blue-400 mb-6 transition">
          ← Back to Role Selector
        </button>

        <div class="material-card rounded-2xl p-6 sm:p-8 space-y-6">
          <div class="flex items-center gap-3">
            <div class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400 font-bold">⚡</div>
            <div>
              <h2 class="text-2xl font-extrabold text-white font-display">Player Enlistment</h2>
              <p class="text-xs text-slate-400 font-mono">Register for the live speed lockout</p>
            </div>
          </div>

          <div id="reg-error" class="hidden p-3 rounded-lg bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs font-mono"></div>

          <form id="form-register" class="space-y-4">
            <div>
              <label class="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-1.5">Player Name / Handle</label>
              <input
                id="input-player-name"
                type="text"
                value="${nameVal}"
                placeholder="e.g. Alex Cipher, Neo_01"
                maxlength="24"
                class="w-full bg-slate-950 border border-slate-700 focus:border-amber-400 rounded-xl px-4 py-3 text-sm text-white focus:outline-none font-mono"
                autocomplete="off"
                autofocus
              />
            </div>

            <div>
              <label class="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-1.5">Department / Branch</label>
              <select
                id="select-player-branch"
                class="w-full bg-slate-950 border border-slate-700 focus:border-cyan-400 rounded-xl px-4 py-3 text-sm text-white focus:outline-none font-mono cursor-pointer"
              >
                ${branches.map(b => `<option value="${b}" ${branchVal === b ? 'selected' : ''}>${b}</option>`).join('')}
              </select>
            </div>

            <div>
              <label class="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-1.5">Game PIN (Shared by Host)</label>
              <input
                id="input-game-pin"
                type="text"
                placeholder="e.g. 4829"
                maxlength="6"
                class="w-full bg-slate-950 border border-slate-700 focus:border-amber-400 rounded-xl px-4 py-3 text-sm text-white focus:outline-none font-mono tracking-widest text-center text-lg font-bold"
                autocomplete="off"
              />
            </div>

            <button
              type="submit"
              class="w-full py-3.5 px-6 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold font-mono tracking-wider uppercase transition shadow-lg shadow-amber-500/20 cursor-pointer"
            >
              Join Live Game Arena ➔
            </button>
          </form>
        </div>
      </div>
    </div>
  `;
}

function bindPlayerRegisterEvents() {
  document.getElementById('btn-back-landing')?.addEventListener('click', () => {
    currentView = 'landing';
    renderApp();
  });

  document.getElementById('form-register')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('input-player-name');
    const branchSelect = document.getElementById('select-player-branch');
    const pinInput = document.getElementById('input-game-pin');
    const errBox = document.getElementById('reg-error');

    const trimmed = nameInput.value.trim();
    if (!trimmed || trimmed.length < 2) {
      errBox.textContent = 'Please enter a valid handle (at least 2 characters).';
      errBox.classList.remove('hidden');
      return;
    }

    const enteredPin = pinInput?.value?.trim() || '';
    if (enteredPin !== gameState.roomPin) {
      errBox.textContent = 'Invalid Game PIN. Please ask the host for the correct active PIN code.';
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

    currentPlayer = newPlayer;
    if (typeof window !== 'undefined') {
      localStorage.setItem('gdgoc_current_player', JSON.stringify(newPlayer));
    }

    savePlayerToDB(newPlayer);
    currentView = 'player_game';
    renderApp();
  });
}

// ==========================================
// VIEW 3: PLAYER GAME CONSOLE
// ==========================================
function renderPlayerGameHTML() {
  if (!currentPlayer) {
    currentView = 'player_register';
    return renderPlayerRegisterHTML();
  }

  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = gameState.currentQuestionIndex;
  const currentQ = qIndex >= 0 && qIndex < activeQuestions.length ? activeQuestions[qIndex] : null;

  let questionHtml = '';
  if (qIndex < 0 || !currentQ) {
    questionHtml = `
      <div class="material-card rounded-3xl p-6 text-center space-y-4">
        <div class="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 mx-auto flex items-center justify-center animate-pulse text-2xl">⚡</div>
        <h2 class="text-xl font-bold text-white font-display">Arena Lobby Active</h2>
        <p class="text-xs text-slate-400 font-mono">Get ready! The host will launch the next question shortly.</p>
        <div class="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 text-left space-y-2 font-mono text-xs">
          <div class="flex justify-between"><span class="text-slate-400">Combatant:</span><span class="text-white font-bold">${escapeHtml(currentPlayer.name)}</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Department:</span><span class="text-cyan-400 font-bold">${currentPlayer.branch}</span></div>
          <div class="flex justify-between border-t border-slate-800 pt-2"><span class="text-slate-400">Total Score:</span><span class="text-emerald-400 font-extrabold text-sm">${currentPlayer.score || 0} PTS</span></div>
        </div>
      </div>
    `;
  } else {
    const prevAnswer = currentPlayer.answeredQuestions?.[qIndex];
    const isLocked = !!prevAnswer;
    const selectedIdx = prevAnswer ? prevAnswer.selectedIndex : null;
    const isCorrect = prevAnswer ? prevAnswer.isCorrect : null;
    const isFastestForCurrent = gameState.fastestWinner && gameState.fastestWinner.questionIndex === qIndex && gameState.fastestWinner.playerId === currentPlayer.id;

    questionHtml = `
      <div class="space-y-4">
        <div class="flex items-center justify-between text-xs font-mono">
          <span class="px-2.5 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-bold">Q${qIndex + 1} / ${activeQuestions.length}</span>
          <span class="text-emerald-400 font-bold bg-emerald-950/30 border border-emerald-500/30 px-2.5 py-1 rounded-lg">${currentPlayer.score || 0} pts</span>
        </div>

        <div class="material-card rounded-2xl p-3 space-y-1.5">
          <div class="flex justify-between items-center text-xs font-mono">
            <span class="text-slate-400">⏱️ Speed Timer</span>
            <span id="seconds-left-display" class="text-cyan-400 font-bold">15.0s</span>
          </div>
          <div class="w-full h-2 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
            <div id="timer-progress-bar" class="h-full bg-gradient-to-r from-cyan-500 to-amber-400 w-full transition-all duration-100"></div>
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
              }
              const letter = ['A', 'B', 'C', 'D'][idx];
              return `
                <button
                  class="option-btn w-full p-4 rounded-xl border text-left font-mono text-xs sm:text-sm flex items-center justify-between ${btnClass}"
                  data-option-idx="${idx}"
                  ${isLocked ? 'disabled' : ''}
                >
                  <div class="flex items-center gap-3">
                    <span class="w-6 h-6 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-xs font-bold shrink-0">${letter}</span>
                    <span class="font-sans font-medium">${escapeHtml(opt)}</span>
                  </div>
                  ${isLocked && isChosen ? `<span>${isCorrect ? '✅' : '❌'}</span>` : ''}
                </button>
              `;
            }).join('')}
          </div>

          ${isLocked ? `
            <div class="p-3 rounded-xl border text-xs font-mono text-center ${isCorrect ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300' : 'bg-rose-950/40 border-rose-500/50 text-rose-300'}">
              <div class="font-bold">✨ ${isCorrect ? 'Correct Lock!' : 'Incorrect Answer'}</div>
              <div class="text-[11px] opacity-80 mt-0.5">Reaction Time: <b>${(prevAnswer.deltaMs / 1000).toFixed(2)}s</b></div>
            </div>
          ` : ''}

          ${isFastestForCurrent ? `
            <div class="p-3 rounded-xl bg-amber-500/20 border border-amber-500/60 text-amber-300 text-xs font-mono text-center animate-pulse">
              ⚡ FASTEST FINGER BONUS AWARDED (+2 pts)!
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  return `
    <div class="min-h-screen bg-[#070b14] text-slate-100 flex flex-col justify-between p-4 max-w-lg mx-auto relative select-none">
      <div class="google-quad-bar absolute top-0 left-0"></div>
      <header class="flex items-center justify-between py-2 border-b border-slate-800/80 mb-3">
        <div class="flex items-center gap-2">
          <button id="btn-player-roles" class="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition text-xs font-mono">← Roles</button>
          <button id="btn-toggle-sound" class="p-1.5 rounded-lg border text-xs transition ${soundEnabled ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-slate-900 border-slate-800 text-slate-500'}">🔊</button>
        </div>
        <div class="flex items-center gap-2">
          <div class="text-right">
            <span class="text-[11px] text-slate-400 font-mono block truncate max-w-[110px]">${escapeHtml(currentPlayer.name)}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-mono border border-cyan-500/30">${currentPlayer.branch}</span>
          </div>
          <button id="btn-edit-profile" class="h-8 w-8 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-slate-300 hover:text-white text-xs font-bold">✎</button>
        </div>
      </header>

      <main class="flex-1 flex flex-col justify-center my-auto w-full">
        ${questionHtml}
      </main>

      <footer class="py-2 border-t border-slate-800/80 text-center font-mono text-[11px] text-slate-500">
        GDGoC IGC Speed Arena • Live Client Connected
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
    currentView = 'player_register';
    renderApp();
  });

  // Bind option buttons if question active
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

  const isCorrect = optionIndex === currentQ.correctIndex;
  const deltaMs = Date.now() - gameState.questionStartTime;

  if (soundEnabled) {
    if (isCorrect) playCorrectSound();
    else playWrongSound();
  }

  let pointsEarned = isCorrect ? 10 : 0;
  let isFastest = false;

  // Fastest finger bonus check
  if (isCorrect && (!gameState.fastestWinner || gameState.fastestWinner.questionIndex !== qIndex)) {
    isFastest = true;
    pointsEarned += 2; // +2 bonus
    gameState.fastestWinner = {
      questionIndex: qIndex,
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      branch: currentPlayer.branch,
      timeTakenMs: deltaMs
    };
    currentPlayer.fastestCount = (currentPlayer.fastestCount || 0) + 1;
    if (soundEnabled) playWinnerFanfare();
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

  savePlayerToDB(currentPlayer);
  if (isFastest) {
    saveStateToDB(gameState);
  }
  renderApp();
}

// ==========================================
// VIEW 4: PRESENTER BIG SCREEN
// ==========================================
function renderPresenterHTML() {
  const activeQuestions = getActiveQuestions(gameState.questions);
  const qIndex = gameState.currentQuestionIndex;
  const isLobby = qIndex < 0;
  const isFinalScreen = qIndex >= activeQuestions.length;
  const currentQ = !isLobby && !isFinalScreen ? activeQuestions[qIndex] : null;

  let mainStageHtml = '';

  if (isLobby) {
    mainStageHtml = `
      <div class="material-card rounded-3xl p-8 md:p-12 text-center space-y-6 relative overflow-hidden">
        <div class="w-20 h-20 rounded-3xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 mx-auto flex items-center justify-center shadow-lg shadow-cyan-500/20 animate-pulse text-3xl">⚡</div>
        <div class="space-y-2">
          <span class="text-xs font-mono uppercase tracking-widest text-cyan-400 font-bold px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20">Ready to Launch</span>
          <h1 class="text-3xl md:text-5xl font-extrabold text-white font-display uppercase tracking-tight">Fastest Finger Tech Clash</h1>
          <p class="text-sm md:text-base text-slate-400 max-w-lg mx-auto">${activeQuestions.length} Questions Loaded • 15 Seconds per Speed Round</p>
        </div>
        <div class="flex flex-wrap items-center justify-center gap-3 pt-4">
          <button id="btn-launch-q1" class="px-8 py-4 rounded-2xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold font-mono text-base uppercase tracking-wider shadow-lg shadow-cyan-500/30 flex items-center gap-2 cursor-pointer">▶ Launch Question 1</button>
          <button id="btn-seed-demo" class="px-6 py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-mono text-sm font-bold">👥 Seed Demo Combatants</button>
        </div>
      </div>
    `;
  } else if (!isFinalScreen && currentQ) {
    mainStageHtml = `
      <div class="material-card rounded-3xl p-6 md:p-8 shadow-2xl space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="px-3 py-1.5 rounded-xl bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-sm font-bold">Q${qIndex + 1} / ${activeQuestions.length}</span>
            <span class="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 font-mono text-xs font-semibold">${escapeHtml(currentQ.category)}</span>
          </div>
          <div class="flex items-center gap-2 bg-slate-950 border border-slate-800 px-4 py-2 rounded-xl font-mono">
            <span>⏱️</span>
            <span id="seconds-left-display" class="text-sm font-extrabold text-cyan-400">15.0s</span>
          </div>
        </div>

        <div class="w-full h-2.5 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
          <div id="timer-progress-bar" class="h-full bg-gradient-to-r from-cyan-500 to-amber-400 w-full transition-all duration-100"></div>
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
            <button id="btn-toggle-answer" class="px-4 py-2.5 rounded-xl border font-mono text-xs font-bold ${gameState.showAnswer ? 'bg-amber-500/20 border-amber-500/50 text-amber-300' : 'bg-slate-800 border-slate-700 text-slate-300'}">
              ${gameState.showAnswer ? '👁️ Hide Answer' : '👁️ Reveal Answer'}
            </button>
            <button id="btn-restart-timer" class="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-300 font-mono text-xs font-bold">🔄 Reset 15s Timer</button>
          </div>
          <div class="flex items-center gap-2">
            ${qIndex > 0 ? `<button id="btn-prev-q" class="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 font-mono text-xs font-bold">← Previous</button>` : ''}
            <button id="btn-next-q" class="px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-extrabold cursor-pointer">${qIndex >= activeQuestions.length - 1 ? 'Finish Tournament ➔' : 'Next Question ➔'}</button>
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
        <button id="btn-restart-tournament" class="px-8 py-3.5 rounded-xl bg-cyan-500 text-slate-950 font-mono font-bold text-sm">Restart Q1</button>
      </div>
    `;
  }

  const branchStats = calculateBranchStats(players);
  const pinCardHtml = `
    <div class="material-card rounded-2xl p-4 flex items-center justify-between bg-gradient-to-r from-blue-950/40 via-purple-950/40 to-slate-950 border border-blue-500/30 mb-6">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-blue-500/20 border border-blue-500/40 flex items-center justify-center text-blue-400 font-bold">🔑</div>
        <div>
          <span class="text-[10px] font-mono uppercase tracking-wider text-slate-400 block">Active Game Room PIN (Share with Players)</span>
          <span class="text-2xl font-black font-mono text-cyan-400 tracking-widest">${gameState.roomPin || '4829'}</span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="btn-copy-pin" class="px-3 py-2 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/40 text-blue-300 font-mono text-xs font-bold flex items-center gap-1.5 cursor-pointer">📋 Copy PIN</button>
        <button id="btn-regen-pin" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-mono text-xs font-bold cursor-pointer">🔄 New PIN</button>
      </div>
    </div>
  `;

  const fastestBanner = gameState.fastestWinner && !isLobby && !isFinalScreen ? `
    <div class="bg-amber-500/15 border-2 border-amber-500/70 rounded-2xl p-4 flex items-center justify-between shadow-[0_0_30px_rgba(245,158,11,0.25)] animate-pulse-yellow mb-6">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400 text-xl font-bold">⚡</div>
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
          <button id="btn-presenter-roles" class="px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 hover:text-white text-xs font-mono flex items-center gap-1.5">← Role Switcher</button>
          <span class="px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-xs uppercase font-bold">Presenter Big Screen</span>
        </div>
        <div class="flex items-center gap-2">
          <button id="btn-open-qm" class="px-3 py-2 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono text-xs flex items-center gap-1.5">📂 Manage Questions (${activeQuestions.length})</button>
          <button id="btn-presenter-sound" class="p-2 rounded-xl border ${soundEnabled ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' : 'bg-slate-900 border-slate-800 text-slate-500'}">🔊</button>
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
              <button id="btn-reset-scores" class="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-slate-300 font-mono text-xs font-bold">Reset Scores</button>
              <button id="btn-reset-room" class="w-full py-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 font-mono text-xs font-bold">Reset Room</button>
            </div>
          </div>
        </div>
      </main>
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

  document.getElementById('btn-copy-pin')?.addEventListener('click', () => {
    navigator.clipboard.writeText(gameState.roomPin || '4829');
    alert('Game PIN ' + (gameState.roomPin || '4829') + ' copied to clipboard!');
  });

  document.getElementById('btn-regen-pin')?.addEventListener('click', () => {
    const newPin = Math.floor(1000 + Math.random() * 9000).toString();
    saveStateToDB({ ...gameState, roomPin: newPin });
  });

  document.getElementById('btn-launch-q1')?.addEventListener('click', () => {
    saveStateToDB({
      ...gameState,
      currentQuestionIndex: 0,
      questionStartTime: Date.now(),
      isTimerActive: true,
      showAnswer: false,
      fastestWinner: null
    });
  });

  document.getElementById('btn-seed-demo')?.addEventListener('click', () => {
    const demo = {
      'p_1': { id: 'p_1', name: 'Aarav CSE', branch: 'CSE', score: 32, answeredCount: 4, totalTimeTakenMs: 12000, fastestCount: 2 },
      'p_2': { id: 'p_2', name: 'Priya ECE', branch: 'ECE', score: 28, answeredCount: 4, totalTimeTakenMs: 14500, fastestCount: 1 },
      'p_3': { id: 'p_3', name: 'Rohan IT', branch: 'IT', score: 24, answeredCount: 4, totalTimeTakenMs: 16000, fastestCount: 0 }
    };
    players = demo;
    if (!rtdb) {
      localStorage.setItem('gdgoc_players', JSON.stringify(players));
      broadcastLocalState();
    } else {
      set(ref(rtdb, 'players'), players);
    }
    renderApp();
  });

  document.getElementById('btn-toggle-answer')?.addEventListener('click', () => {
    saveStateToDB({ ...gameState, showAnswer: !gameState.showAnswer });
  });

  document.getElementById('btn-restart-timer')?.addEventListener('click', () => {
    saveStateToDB({ ...gameState, questionStartTime: Date.now(), isTimerActive: true });
  });

  document.getElementById('btn-next-q')?.addEventListener('click', () => {
    const activeQs = getActiveQuestions(gameState.questions);
    const nextIdx = gameState.currentQuestionIndex + 1;
    saveStateToDB({
      ...gameState,
      currentQuestionIndex: nextIdx,
      questionStartTime: Date.now(),
      isTimerActive: nextIdx < activeQs.length,
      showAnswer: false,
      fastestWinner: null
    });
  });

  document.getElementById('btn-prev-q')?.addEventListener('click', () => {
    const prevIdx = Math.max(0, gameState.currentQuestionIndex - 1);
    saveStateToDB({
      ...gameState,
      currentQuestionIndex: prevIdx,
      questionStartTime: Date.now(),
      isTimerActive: true,
      showAnswer: false,
      fastestWinner: null
    });
  });

  document.getElementById('btn-restart-tournament')?.addEventListener('click', () => {
    saveStateToDB({ ...gameState, currentQuestionIndex: 0, questionStartTime: Date.now(), isTimerActive: true, showAnswer: false, fastestWinner: null });
  });

  document.getElementById('btn-reset-scores')?.addEventListener('click', () => {
    Object.keys(players).forEach(id => {
      players[id].score = 0;
      players[id].answeredQuestions = {};
      players[id].answeredCount = 0;
      players[id].totalTimeTakenMs = 0;
      players[id].fastestCount = 0;
    });
    if (rtdb) set(ref(rtdb, 'players'), players);
    else {
      localStorage.setItem('gdgoc_players', JSON.stringify(players));
      broadcastLocalState();
    }
    renderApp();
  });

  document.getElementById('btn-reset-room')?.addEventListener('click', () => {
    players = {};
    gameState = { currentQuestionIndex: -1, questionStartTime: Date.now(), isTimerActive: false, timerDurationSec: 15, showAnswer: false, fastestWinner: null, questions: questionsData };
    if (rtdb) {
      set(ref(rtdb, 'players'), null);
      set(ref(rtdb, 'game_state'), gameState);
    } else {
      localStorage.removeItem('gdgoc_players');
      localStorage.removeItem('gdgoc_game_state');
      broadcastLocalState();
    }
    renderApp();
  });
}

// Initial boot
initFirebaseListeners();
renderApp();
