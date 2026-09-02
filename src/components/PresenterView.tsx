import React, { useState, useEffect, useMemo, useRef } from 'react';
import confetti from 'canvas-confetti';
import {
  Zap,
  Trophy,
  Users,
  RotateCcw,
  ChevronRight,
  ChevronLeft,
  Eye,
  EyeOff,
  Flame,
  Clock,
  Sparkles,
  Database,
  BarChart3,
  Award,
  ArrowLeft,
  Volume2,
  VolumeX,
  Play,
  Share2
} from 'lucide-react';
import { GameState, Player, Branch, QuestionWinnerEntry } from '../types';
import { questionsData } from '../data/questions';
import {
  setQuestionIndex,
  restartTimer,
  toggleShowAnswer,
  resetGame,
  resetAllScores,
  seedDemoClashPlayers
} from '../services/firebaseSync';
import { playCorrectSound, playWinnerFanfare } from '../services/audio';

interface Props {
  gameState: GameState;
  players: Record<string, Player>;
  onSwitchRole: () => void;
  onOpenFirebaseConfig: () => void;
}

export const PresenterView: React.FC<Props> = ({
  gameState,
  players,
  onSwitchRole,
  onOpenFirebaseConfig
}) => {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState<number>(15);
  const prevWinnerRef = useRef<string | null>(null);

  const currentQIndex = gameState.currentQuestionIndex;
  const isLobby = currentQIndex < 0;
  const isFinalScreen = currentQIndex >= questionsData.length;
  const currentQuestion = !isLobby && !isFinalScreen ? questionsData[currentQIndex] : null;

  // 15-second SVG countdown ring synchronized with questionStartTime
  useEffect(() => {
    if (!gameState.isTimerActive || isLobby || isFinalScreen) {
      setSecondsLeft(0);
      return;
    }

    const checkTimer = () => {
      const elapsed = (Date.now() - gameState.questionStartTime) / 1000;
      const rem = Math.max(0, 15 - elapsed);
      setSecondsLeft(rem);
    };

    checkTimer();
    const interval = setInterval(checkTimer, 100);
    return () => clearInterval(interval);
  }, [gameState.questionStartTime, gameState.isTimerActive, isLobby, isFinalScreen]);

  // Audio and confetti celebration when a new fastest winner is registered
  useEffect(() => {
    const winner = gameState.fastestWinner;
    if (winner && winner.questionIndex === currentQIndex) {
      const winnerKey = `${winner.questionIndex}-${winner.playerId}`;
      if (prevWinnerRef.current !== winnerKey) {
        prevWinnerRef.current = winnerKey;
        if (soundEnabled) {
          playWinnerFanfare();
        }
        // Small confetti burst for speed winner
        try {
          confetti({
            particleCount: 50,
            spread: 60,
            origin: { y: 0.15 },
            colors: ['#06b6d4', '#f59e0b', '#10b981', '#ffffff']
          });
        } catch {
          // ignore
        }
      }
    }
  }, [gameState.fastestWinner, currentQIndex, soundEnabled]);

  // Massive confetti fireworks on Final Standings Screen
  useEffect(() => {
    if (isFinalScreen) {
      const fireCelebration = () => {
        try {
          const duration = 3.5 * 1000;
          const end = Date.now() + duration;

          const interval: ReturnType<typeof setInterval> = setInterval(() => {
            if (Date.now() > end) {
              return clearInterval(interval);
            }
            confetti({
              startVelocity: 30,
              spread: 360,
              ticks: 60,
              origin: { x: Math.random(), y: Math.random() * 0.5 }
            });
          }, 250);
        } catch {
          // ignore
        }
      };
      fireCelebration();
    }
  }, [isFinalScreen]);

  // Top 10 Players sorted descending by score
  const sortedPlayers = useMemo(() => {
    const list = Object.values(players) as Player[];
    return list.sort((a, b) => (b.score || 0) - (a.score || 0));
  }, [players]);

  const top10Players = useMemo(() => sortedPlayers.slice(0, 10), [sortedPlayers]);

  // Branch Rivalry Analytics: Calculate Average Score per Branch
  const branchAnalytics = useMemo(() => {
    const allBranches: Branch[] = ['CSE', 'ECE', 'IT', 'ME', 'CE', 'Other'];
    const branchMap: Record<Branch, { totalScore: number; count: number }> = {
      CSE: { totalScore: 0, count: 0 },
      ECE: { totalScore: 0, count: 0 },
      IT: { totalScore: 0, count: 0 },
      ME: { totalScore: 0, count: 0 },
      CE: { totalScore: 0, count: 0 },
      Other: { totalScore: 0, count: 0 }
    };

    (Object.values(players) as Player[]).forEach((p) => {
      const b = p.branch || 'Other';
      if (branchMap[b]) {
        branchMap[b].totalScore += p.score || 0;
        branchMap[b].count += 1;
      }
    });

    const list = allBranches.map((branch) => {
      const data = branchMap[branch];
      const avg = data.count > 0 ? Number((data.totalScore / data.count).toFixed(1)) : 0;
      return {
        branch,
        avgScore: avg,
        totalScore: data.totalScore,
        count: data.count
      };
    });

    // Find current leader branch (with at least 1 player)
    const activeBranches = list.filter((b) => b.count > 0);
    const leadingBranch = activeBranches.length > 0
      ? activeBranches.reduce((prev, curr) => (curr.avgScore > prev.avgScore ? curr : prev), activeBranches[0])
      : null;

    return { list, leadingBranch };
  }, [players]);

  // Current Question Top 3 Sub-Leaderboard
  const currentSubLeaderboard = useMemo((): QuestionWinnerEntry[] => {
    if (isLobby || isFinalScreen) return [];
    const entries = gameState.questionWinners?.[currentQIndex] || [];
    return entries.slice(0, 3);
  }, [gameState.questionWinners, currentQIndex, isLobby, isFinalScreen]);

  // Host Controls Handlers
  const handlePrevQuestion = async () => {
    if (currentQIndex > 0) {
      await setQuestionIndex(currentQIndex - 1);
    } else if (currentQIndex === 0) {
      await setQuestionIndex(-1); // back to lobby
    }
  };

  const handleNextQuestion = async () => {
    if (currentQIndex < questionsData.length) {
      await setQuestionIndex(currentQIndex + 1);
    }
  };

  const handleRestartTimer = async () => {
    await restartTimer();
  };

  const handleToggleAnswer = async () => {
    await toggleShowAnswer(!gameState.showAnswer);
  };

  const handleResetGame = async () => {
    if (window.confirm('Reset game back to the Lobby? Player scores will be preserved.')) {
      await resetGame();
    }
  };

  const handleResetAllScores = async () => {
    if (window.confirm('Reset ALL player scores to 0 and restart from Question 1?')) {
      await resetAllScores();
      await setQuestionIndex(0);
    }
  };

  const handleSeedDemo = async () => {
    await seedDemoClashPlayers();
  };

  const timerPct = Math.min(100, Math.max(0, (secondsLeft / 15) * 100));

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100 flex flex-col justify-between p-4 md:p-6 select-none font-sans relative overflow-x-hidden">
      {/* Background Cyberpunk Ambient Glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-80 bg-gradient-to-b from-cyan-500/10 via-transparent to-transparent pointer-events-none blur-3xl" />

      {/* TOP PERSISTENT SECTION: Glowing Live Winner Overlay & Sub-Leaderboard */}
      <div className="w-full max-w-7xl mx-auto mb-4 relative z-20">
        {/* Fastest Finger Live Winner Glowing Pop-Up Banner */}
        {gameState.fastestWinner && gameState.fastestWinner.questionIndex === currentQIndex ? (
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-amber-500/20 via-cyan-500/20 to-amber-500/20 border-2 border-amber-400 p-4 shadow-[0_0_40px_rgba(245,158,11,0.4)] animate-in fade-in slide-in-from-top-4 duration-300">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-amber-400 text-slate-950 flex items-center justify-center font-extrabold shadow-lg animate-pulse">
                  <Zap className="w-7 h-7 fill-slate-950" />
                </div>
                <div>
                  <div className="text-xs font-mono text-amber-300 tracking-widest uppercase flex items-center gap-1.5 font-bold">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    Microsecond Speed Lock Triggered
                  </div>
                  <h2 className="text-xl sm:text-2xl md:text-3xl font-black font-display text-white tracking-wide">
                    ⚡ FASTEST CORRECT ANSWER: <span className="text-amber-300">{gameState.fastestWinner.name.toUpperCase()}</span> ({gameState.fastestWinner.branch})
                  </h2>
                </div>
              </div>

              <div className="px-4 py-2 rounded-xl bg-slate-900/90 border border-amber-400/50 text-amber-300 font-mono text-sm sm:text-base font-bold shadow-inner">
                ⏱️ Reaction Time: <span className="text-white">{(gameState.fastestWinner.deltaMs / 1000).toFixed(2)}s</span>
              </div>
            </div>

            {/* Sub-Leaderboard: Top 3 Fastest Clickers for the Current Question */}
            {currentSubLeaderboard.length > 0 && (
              <div className="mt-3 pt-3 border-t border-amber-500/30 flex flex-wrap items-center justify-center sm:justify-start gap-3 text-xs font-mono">
                <span className="text-amber-200/80 font-bold uppercase tracking-wider flex items-center gap-1">
                  <Award className="w-3.5 h-3.5 text-amber-400" />
                  Top Speed Clickers:
                </span>
                {currentSubLeaderboard.map((entry, idx) => (
                  <div
                    key={entry.playerId}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-900/80 border border-slate-700 text-slate-200"
                  >
                    <span className="text-amber-400 font-bold">
                      {idx === 0 ? '🥇 #1' : idx === 1 ? '🥈 #2' : '🥉 #3'}
                    </span>
                    <span className="text-white font-semibold">{entry.name}</span>
                    <span className="text-cyan-400">({entry.branch})</span>
                    <span className="text-slate-400">{(entry.deltaMs / 1000).toFixed(2)}s</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Idle Question Banner */
          <div className="flex items-center justify-between bg-slate-900/80 border border-slate-800 rounded-2xl px-5 py-3 text-xs font-mono text-slate-300">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
              <span className="font-bold text-cyan-300 uppercase tracking-wider">
                Fastest Finger Arena • Projector Master Dashboard
              </span>
            </div>
            <div className="flex items-center gap-4 text-slate-400">
              <span>Host Node: Live Sync Active</span>
              <span className="text-emerald-400 font-bold">
                {Object.keys(players).length} Players Connected
              </span>
            </div>
          </div>
        )}
      </div>

      {/* MIDDLE MAIN CONTENT: Projector Grid */}
      <div className="w-full max-w-7xl mx-auto flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 my-2">
        {/* Left 8 Columns: Main Display Area (Lobby / Question Arena / Final Podium) */}
        <div className="lg:col-span-8 flex flex-col justify-between">
          {/* View 1: Lobby Screen */}
          {isLobby && (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 bg-slate-900/60 border border-slate-800 rounded-3xl backdrop-blur-sm">
              <div className="w-20 h-20 rounded-2xl bg-cyan-500/10 border-2 border-cyan-400/40 text-cyan-400 flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(6,182,212,0.25)]">
                <Zap className="w-10 h-10 fill-cyan-400" />
              </div>

              <span className="px-3.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-mono uppercase tracking-widest mb-3">
                Live Broadcast Ready
              </span>

              <h1 className="text-4xl md:text-5xl font-extrabold text-white uppercase font-display tracking-tight mb-4">
                Fastest Finger <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-amber-400">Tech Clash</span>
              </h1>

              <p className="text-slate-400 text-base max-w-lg mb-8 leading-relaxed">
                Connect your mobile devices. Select your engineering department. When the timer starts, the microsecond-fastest correct answer takes the speed crown!
              </p>

              <div className="flex flex-wrap items-center justify-center gap-4">
                <button
                  id="host-start-clash-btn"
                  onClick={() => setQuestionIndex(0)}
                  className="px-8 py-4 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-extrabold font-mono text-base uppercase tracking-wider shadow-lg shadow-cyan-500/30 transition cursor-pointer flex items-center gap-2"
                >
                  <Play className="w-5 h-5 fill-slate-950" />
                  Commence Question 1
                </button>

                {Object.keys(players).length === 0 && (
                  <button
                    onClick={handleSeedDemo}
                    className="px-5 py-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono transition border border-slate-700 cursor-pointer"
                  >
                    + Seed 10 Test Players
                  </button>
                )}
              </div>
            </div>
          )}

          {/* View 2: Active Question Arena */}
          {!isLobby && !isFinalScreen && currentQuestion && (
            <div className="h-full flex flex-col justify-between bg-slate-900/60 border border-slate-800 rounded-3xl p-6 md:p-8 backdrop-blur-sm relative">
              {/* Question Header & 15s Countdown SVG Ring */}
              <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-mono uppercase tracking-widest text-cyan-400 bg-cyan-950/70 border border-cyan-500/30 px-3 py-1 rounded-full font-bold">
                      {currentQuestion.category}
                    </span>
                    <span className="text-xs font-mono text-slate-400 font-bold">
                      QUESTION {currentQIndex + 1} / {questionsData.length}
                    </span>
                  </div>

                  <h2 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-white leading-tight font-display">
                    {currentQuestion.question}
                  </h2>
                </div>

                {/* 15-Second SVG Ring Countdown Timer */}
                <div className="relative w-20 h-20 md:w-24 md:h-24 shrink-0 flex items-center justify-center">
                  <svg className="w-20 h-20 md:w-24 md:h-24 -rotate-90" viewBox="0 0 36 36">
                    <path
                      className="text-slate-800"
                      strokeWidth="3.2"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                    <path
                      className={`transition-all duration-100 ${
                        secondsLeft <= 3
                          ? 'text-rose-500 drop-shadow-[0_0_12px_rgba(244,63,94,0.7)]'
                          : secondsLeft <= 7
                          ? 'text-amber-400 drop-shadow-[0_0_10px_rgba(251,191,36,0.6)]'
                          : 'text-cyan-400 drop-shadow-[0_0_10px_rgba(6,182,212,0.6)]'
                      }`}
                      strokeDasharray={`${timerPct}, 100`}
                      strokeLinecap="round"
                      strokeWidth="3.2"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                  </svg>
                  <div className="absolute flex flex-col items-center justify-center">
                    <span className="text-2xl md:text-3xl font-extrabold font-mono text-white">
                      {Math.ceil(secondsLeft)}
                    </span>
                    <span className="text-[9px] font-mono uppercase text-slate-400">sec</span>
                  </div>
                </div>
              </div>

              {/* 4 Large High-Contrast Answer Option Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-auto">
                {currentQuestion.options.map((optionText, idx) => {
                  const label = String.fromCharCode(65 + idx); // A, B, C, D
                  const isCorrect = idx === currentQuestion.correctIndex;
                  const isRevealed = gameState.showAnswer;

                  let cardStyle = 'bg-slate-950/80 border-slate-700/80 text-white';
                  let badgeStyle = 'bg-slate-800 text-cyan-300 border-slate-700';

                  if (isRevealed && isCorrect) {
                    cardStyle = 'bg-emerald-950/80 border-2 border-emerald-400 text-emerald-100 shadow-[0_0_35px_rgba(16,185,129,0.4)] scale-[1.02]';
                    badgeStyle = 'bg-emerald-500 text-slate-950 font-black border-emerald-400';
                  } else if (isRevealed && !isCorrect) {
                    cardStyle = 'bg-slate-950/40 border-slate-800/60 text-slate-500 opacity-60';
                    badgeStyle = 'bg-slate-900 text-slate-600 border-slate-800';
                  }

                  return (
                    <div
                      key={idx}
                      className={`p-4 md:p-5 rounded-2xl border transition-all duration-300 flex items-center gap-4 ${cardStyle}`}
                    >
                      <span className={`w-10 h-10 rounded-xl border text-base font-mono font-extrabold flex items-center justify-center shrink-0 ${badgeStyle}`}>
                        {label}
                      </span>
                      <div className="text-base sm:text-lg font-semibold leading-snug">
                        {optionText}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Explanation Dropdown / Note when answer is revealed */}
              {gameState.showAnswer && currentQuestion.explanation && (
                <div className="mt-4 p-4 rounded-xl bg-emerald-950/50 border border-emerald-500/30 text-emerald-200 text-xs sm:text-sm font-mono flex items-start gap-2">
                  <span className="font-bold text-emerald-400 shrink-0">💡 TECH FACT:</span>
                  <span>{currentQuestion.explanation}</span>
                </div>
              )}
            </div>
          )}

          {/* View 3: Final Standings Screen (Phase 5) */}
          {isFinalScreen && (
            <div className="h-full flex flex-col justify-between bg-slate-900/80 border-2 border-amber-400/40 rounded-3xl p-6 md:p-8 backdrop-blur-sm shadow-[0_0_50px_rgba(245,158,11,0.2)]">
              <div className="text-center mb-6">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono text-xs uppercase tracking-widest mb-3">
                  <Trophy className="w-4 h-4 text-amber-400 fill-amber-400" />
                  Tech Clash Concluded • Final Standings
                </div>
                <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-white uppercase font-display">
                  Championship Podium
                </h1>
              </div>

              {/* Top 3 Podium Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                {/* 2nd Place */}
                {sortedPlayers[1] && (
                  <div className="p-5 rounded-2xl bg-slate-900 border border-slate-700 flex flex-col items-center justify-center text-center order-2 md:order-1">
                    <span className="text-2xl mb-1">🥈</span>
                    <span className="text-xs font-mono text-slate-400 uppercase font-bold">2nd Place</span>
                    <h3 className="text-lg font-bold text-white font-display mt-1">{sortedPlayers[1].name}</h3>
                    <span className="text-xs font-mono text-cyan-400">{sortedPlayers[1].branch} Unit</span>
                    <div className="text-2xl font-extrabold text-slate-200 font-mono mt-2">
                      {sortedPlayers[1].score || 0} pts
                    </div>
                  </div>
                )}

                {/* 1st Place Champion */}
                {sortedPlayers[0] && (
                  <div className="p-6 rounded-2xl bg-gradient-to-b from-amber-500/20 to-slate-900 border-2 border-amber-400 flex flex-col items-center justify-center text-center order-1 md:order-2 shadow-[0_0_30px_rgba(245,158,11,0.3)]">
                    <span className="text-4xl mb-1">👑</span>
                    <span className="text-xs font-mono text-amber-300 uppercase font-extrabold tracking-wider">Fastest Tech Champion</span>
                    <h3 className="text-2xl font-black text-white font-display mt-1">{sortedPlayers[0].name}</h3>
                    <span className="text-xs font-mono text-amber-400 font-bold">{sortedPlayers[0].branch} Unit</span>
                    <div className="text-4xl font-extrabold text-amber-300 font-mono mt-2">
                      {sortedPlayers[0].score || 0} PTS
                    </div>
                  </div>
                )}

                {/* 3rd Place */}
                {sortedPlayers[2] && (
                  <div className="p-5 rounded-2xl bg-slate-900 border border-slate-700 flex flex-col items-center justify-center text-center order-3">
                    <span className="text-2xl mb-1">🥉</span>
                    <span className="text-xs font-mono text-amber-600 uppercase font-bold">3rd Place</span>
                    <h3 className="text-lg font-bold text-white font-display mt-1">{sortedPlayers[2].name}</h3>
                    <span className="text-xs font-mono text-cyan-400">{sortedPlayers[2].branch} Unit</span>
                    <div className="text-2xl font-extrabold text-slate-200 font-mono mt-2">
                      {sortedPlayers[2].score || 0} pts
                    </div>
                  </div>
                )}
              </div>

              {/* Branch Champion Spotlight */}
              {branchAnalytics.leadingBranch && (
                <div className="p-4 rounded-xl bg-cyan-950/60 border border-cyan-500/40 text-center flex flex-col sm:flex-row items-center justify-center gap-3">
                  <Trophy className="w-6 h-6 text-amber-400 shrink-0" />
                  <span className="text-sm font-mono text-cyan-200">
                    Inter-Department Champion: <strong className="text-white text-base">{branchAnalytics.leadingBranch.branch}</strong> with an outstanding average of <strong className="text-amber-400 text-base">{branchAnalytics.leadingBranch.avgScore} pts</strong>!
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right 4 Columns: Branch Rivalry Analytics & Overall Top 10 Leaderboard */}
        <div className="lg:col-span-4 flex flex-col gap-5">
          {/* Branch Rivalry Analytics Panel */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-cyan-300 font-mono text-xs uppercase tracking-wider font-bold">
                <BarChart3 className="w-4 h-4 text-cyan-400" />
                Branch Rivalry Analytics
              </div>
              {branchAnalytics.leadingBranch && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300">
                  Lead: {branchAnalytics.leadingBranch.branch}
                </span>
              )}
            </div>

            <p className="text-[11px] text-slate-400 mb-3 font-mono">
              Real-time departmental averages fueling the engineering clash:
            </p>

            <div className="space-y-2 font-mono">
              {branchAnalytics.list.map((b) => (
                <div
                  key={b.branch}
                  className="flex items-center justify-between p-2 rounded-lg bg-slate-950/60 border border-slate-800/80 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-10 font-extrabold text-white">{b.branch}</span>
                    <span className="text-[10px] text-slate-400">({b.count} combatants)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 text-[11px]">Avg:</span>
                    <span className="font-extrabold text-cyan-300 text-sm">
                      {b.avgScore} pts
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Top 10 Live Leaderboard */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-lg flex-1 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-amber-300 font-mono text-xs uppercase tracking-wider font-bold">
                <Trophy className="w-4 h-4 text-amber-400" />
                Live Standings (Top 10)
              </div>
              <span className="text-[10px] font-mono text-slate-400">
                {Object.keys(players).length} Total
              </span>
            </div>

            <div className="space-y-1.5 flex-1 overflow-y-auto max-h-[340px] pr-1 font-mono text-xs">
              {top10Players.length === 0 ? (
                <div className="text-center py-8 text-slate-500 text-xs">
                  No combatants recorded yet.
                </div>
              ) : (
                top10Players.map((player, idx) => (
                  <div
                    key={player.id}
                    className={`flex items-center justify-between p-2 rounded-lg border transition ${
                      idx === 0
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                        : idx === 1
                        ? 'bg-slate-800/60 border-slate-700 text-slate-200'
                        : idx === 2
                        ? 'bg-slate-800/40 border-slate-700 text-slate-300'
                        : 'bg-slate-950/40 border-slate-800/60 text-slate-400'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="w-5 text-center font-bold text-slate-400">
                        #{idx + 1}
                      </span>
                      <span className="font-semibold text-white truncate max-w-[110px]">
                        {player.name}
                      </span>
                      <span className="text-[10px] text-cyan-400 font-mono">
                        [{player.branch}]
                      </span>
                    </div>
                    <span className="font-extrabold text-amber-300 shrink-0">
                      {player.score || 0} pts
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM PERSISTENT HOST BROADCAST PANEL (Visible only in Presenter mode) */}
      <div className="w-full max-w-7xl mx-auto mt-4 pt-3 border-t border-slate-800 relative z-30">
        <div className="bg-slate-900/95 border border-cyan-500/30 rounded-2xl p-3 shadow-2xl flex flex-wrap items-center justify-between gap-3">
          {/* Left: Role Navigation & Settings */}
          <div className="flex items-center gap-2">
            <button
              onClick={onSwitchRole}
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition text-xs font-mono flex items-center gap-1.5"
              title="Return to Role Selector"
            >
              <ArrowLeft className="w-4 h-4" />
              Role Switcher
            </button>

            <button
              id="open-firebase-config-btn"
              onClick={onOpenFirebaseConfig}
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-400 transition text-xs font-mono flex items-center gap-1.5"
              title="Firebase Settings"
            >
              <Database className="w-4 h-4" />
              Firebase
            </button>

            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`p-2 rounded-xl border text-xs font-mono transition flex items-center gap-1.5 ${
                soundEnabled
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : 'bg-slate-800 border-slate-700 text-slate-500'
              }`}
              title="Toggle Audio Feedback"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              Audio
            </button>
          </div>

          {/* Center: Primary Host Broadcast Actions */}
          <div className="flex items-center gap-2">
            <button
              id="host-prev-question-btn"
              onClick={handlePrevQuestion}
              disabled={currentQIndex < 0}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-mono text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              Previous Question
            </button>

            <button
              id="host-next-question-btn"
              onClick={handleNextQuestion}
              disabled={currentQIndex >= questionsData.length}
              className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 font-mono text-xs font-bold transition flex items-center gap-1 cursor-pointer shadow-lg shadow-cyan-500/20"
            >
              Next Question
              <ChevronRight className="w-4 h-4" />
            </button>

            {!isLobby && !isFinalScreen && (
              <>
                <button
                  id="host-restart-timer-btn"
                  onClick={handleRestartTimer}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 font-mono text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
                  title="Restart 15-second countdown"
                >
                  <Clock className="w-3.5 h-3.5" />
                  15s Timer
                </button>

                <button
                  id="host-toggle-answer-btn"
                  onClick={handleToggleAnswer}
                  className={`px-3 py-2 rounded-xl font-mono text-xs font-semibold transition flex items-center gap-1 cursor-pointer ${
                    gameState.showAnswer
                      ? 'bg-emerald-500 text-slate-950'
                      : 'bg-slate-800 hover:bg-slate-700 text-emerald-400'
                  }`}
                >
                  {gameState.showAnswer ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  {gameState.showAnswer ? 'Hide Answer' : 'Reveal Answer'}
                </button>
              </>
            )}

            {currentQIndex < questionsData.length && (
              <button
                onClick={() => setQuestionIndex(questionsData.length)}
                className="px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 text-amber-300 font-mono text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
              >
                <Trophy className="w-3.5 h-3.5" />
                Final Standings
              </button>
            )}
          </div>

          {/* Right: Reset Controls */}
          <div className="flex items-center gap-2">
            <button
              id="host-reset-game-btn"
              onClick={handleResetGame}
              className="px-3 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 font-mono text-xs transition flex items-center gap-1 cursor-pointer"
              title="Reset to Lobby"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Game
            </button>

            <button
              id="host-reset-scores-btn"
              onClick={handleResetAllScores}
              className="px-3 py-2 rounded-xl bg-rose-950/60 border border-rose-500/30 hover:bg-rose-900/80 text-rose-300 font-mono text-xs transition flex items-center gap-1 cursor-pointer"
              title="Zero out all player scores"
            >
              Reset All Scores
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
