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
  Share2,
  Upload,
  Plus,
  Trash2,
  AlertCircle,
  Check
} from 'lucide-react';
import { GameState, Player, Branch, QuestionWinnerEntry, Question } from '../types';
import { getActiveQuestions } from '../utils/questionsHelper';
import { questionsData } from '../data/questions';
import {
  setQuestionIndex,
  restartTimer,
  toggleShowAnswer,
  resetGame,
  resetAllScores,
  seedDemoClashPlayers,
  updateQuestions
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

  // Question Manager Modal State
  const [isQuestionManagerOpen, setIsQuestionManagerOpen] = useState(false);
  const [qmTab, setQmTab] = useState<'upload' | 'add' | 'list'>('upload');
  const [jsonPaste, setJsonPaste] = useState('');
  const [qmError, setQmError] = useState<string | null>(null);
  const [qmSuccess, setQmSuccess] = useState<string | null>(null);

  // Add Single Question Form State
  const [newCat, setNewCat] = useState('Latest Tech News');
  const [newQText, setNewQText] = useState('');
  const [newOpt0, setNewOpt0] = useState('');
  const [newOpt1, setNewOpt1] = useState('');
  const [newOpt2, setNewOpt2] = useState('');
  const [newOpt3, setNewOpt3] = useState('');
  const [newCorrect, setNewCorrect] = useState<number>(0);
  const [newExpl, setNewExpl] = useState('');

  const activeQuestions = useMemo(() => getActiveQuestions(gameState.questions), [gameState.questions]);

  const currentQIndex = gameState.currentQuestionIndex;
  const isLobby = currentQIndex < 0;
  const isFinalScreen = currentQIndex >= activeQuestions.length;
  const currentQuestion = !isLobby && !isFinalScreen ? activeQuestions[currentQIndex] : null;

  const handleJsonUploadSubmit = (textToParse: string) => {
    try {
      setQmError(null);
      setQmSuccess(null);
      const parsed = JSON.parse(textToParse);
      if (!Array.isArray(parsed)) {
        throw new Error('JSON root must be an array of questions.');
      }
      const validated: Question[] = parsed.map((item: any, idx: number) => {
        if (!item.question || !Array.isArray(item.options) || item.options.length !== 4 || typeof item.correctIndex !== 'number') {
          throw new Error(`Question at index ${idx} is missing required fields (question, options [4 items], correctIndex [0-3]).`);
        }
        return {
          id: item.id || idx + 1,
          category: item.category || 'Latest Tech News',
          question: String(item.question),
          options: [String(item.options[0]), String(item.options[1]), String(item.options[2]), String(item.options[3])] as [string, string, string, string],
          correctIndex: Number(item.correctIndex),
          explanation: item.explanation ? String(item.explanation) : undefined
        };
      });

      updateQuestions(validated);
      setQmSuccess(`Successfully imported ${validated.length} questions into live game session!`);
      setJsonPaste('');
    } catch (err: any) {
      setQmError(err.message || 'Invalid JSON format.');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        handleJsonUploadSubmit(content);
      }
    };
    reader.readAsText(file);
  };

  const handleAddManualQuestion = (e: React.FormEvent) => {
    e.preventDefault();
    setQmError(null);
    setQmSuccess(null);
    if (!newQText.trim() || !newOpt0.trim() || !newOpt1.trim() || !newOpt2.trim() || !newOpt3.trim()) {
      setQmError('Please fill in the question text and all 4 options.');
      return;
    }
    const newQ: Question = {
      id: activeQuestions.length + 1,
      category: newCat as any,
      question: newQText.trim(),
      options: [newOpt0.trim(), newOpt1.trim(), newOpt2.trim(), newOpt3.trim()],
      correctIndex: Number(newCorrect),
      explanation: newExpl.trim() ? newExpl.trim() : undefined
    };

    const updated = [...activeQuestions, newQ];
    updateQuestions(updated);
    setQmSuccess(`Added question #${newQ.id} successfully!`);
    setNewQText('');
    setNewOpt0('');
    setNewOpt1('');
    setNewOpt2('');
    setNewOpt3('');
    setNewExpl('');
  };

  const handleDeleteQuestion = (id: number) => {
    const filtered = activeQuestions.filter((q) => q.id !== id).map((q, index) => ({ ...q, id: index + 1 }));
    updateQuestions(filtered);
  };

  const handleResetDefault = () => {
    if (window.confirm('Restore default question bank?')) {
      updateQuestions(questionsData);
    }
  };

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
    if (currentQIndex < activeQuestions.length) {
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
                      QUESTION {currentQIndex + 1} / {activeQuestions.length}
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
              disabled={currentQIndex >= activeQuestions.length}
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

            {currentQIndex < activeQuestions.length && (
              <button
                onClick={() => setQuestionIndex(activeQuestions.length)}
                className="px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 text-amber-300 font-mono text-xs font-semibold transition flex items-center gap-1 cursor-pointer"
              >
                <Trophy className="w-3.5 h-3.5" />
                Final Standings
              </button>
            )}
          </div>

          {/* Right: Reset Controls & Question Manager */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsQuestionManagerOpen(true)}
              className="px-3 py-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 text-cyan-300 font-mono text-xs font-semibold transition flex items-center gap-1.5 cursor-pointer"
            >
              <Database className="w-3.5 h-3.5" />
              Manage Questions ({activeQuestions.length})
            </button>

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

      {/* Question Manager Modal */}
      {isQuestionManagerOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/50">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-cyan-400" />
                <h3 className="text-lg font-bold font-display text-white">Quiz Question Bank Manager (Host Controls)</h3>
              </div>
              <button
                onClick={() => setIsQuestionManagerOpen(false)}
                className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-300 transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex border-b border-slate-800 bg-slate-950/30 px-6 gap-2 pt-3">
              <button
                onClick={() => setQmTab('upload')}
                className={`px-4 py-2.5 font-mono text-xs font-semibold rounded-t-xl transition cursor-pointer flex items-center gap-1.5 ${
                  qmTab === 'upload' ? 'bg-cyan-500/10 text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                Upload JSON / Paste
              </button>
              <button
                onClick={() => setQmTab('add')}
                className={`px-4 py-2.5 font-mono text-xs font-semibold rounded-t-xl transition cursor-pointer flex items-center gap-1.5 ${
                  qmTab === 'add' ? 'bg-cyan-500/10 text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                Add Single Question
              </button>
              <button
                onClick={() => setQmTab('list')}
                className={`px-4 py-2.5 font-mono text-xs font-semibold rounded-t-xl transition cursor-pointer flex items-center gap-1.5 ${
                  qmTab === 'list' ? 'bg-cyan-500/10 text-cyan-400 border-b-2 border-cyan-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                Active Questions ({activeQuestions.length})
              </button>
            </div>

            <div className="p-6 overflow-y-auto flex-1 space-y-4">
              {qmError && (
                <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-500/30 text-rose-300 font-mono text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {qmError}
                </div>
              )}
              {qmSuccess && (
                <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-500/30 text-emerald-300 font-mono text-xs flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0" />
                  {qmSuccess}
                </div>
              )}

              {qmTab === 'upload' && (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-sm font-bold text-white mb-1">1. Direct Upload JSON File</h4>
                    <p className="text-xs text-slate-400 mb-3">Select a .json file containing an array of questions from your device.</p>
                    <input
                      type="file"
                      accept=".json"
                      onChange={handleFileSelect}
                      className="block w-full text-xs text-slate-400 file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-mono file:font-bold file:bg-cyan-500 file:text-slate-950 hover:file:bg-cyan-400 file:cursor-pointer transition"
                    />
                  </div>

                  <div className="border-t border-slate-800 pt-5">
                    <h4 className="text-sm font-bold text-white mb-1">2. Paste JSON Array</h4>
                    <p className="text-xs text-slate-400 mb-3">Paste your question array JSON below and click Import.</p>
                    <textarea
                      rows={8}
                      value={jsonPaste}
                      onChange={(e) => setJsonPaste(e.target.value)}
                      placeholder={`[\n  {\n    "category": "Latest Tech News",\n    "question": "What is AI?",\n    "options": ["A", "B", "C", "D"],\n    "correctIndex": 0,\n    "explanation": "Explanation here..."\n  }\n]`}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                    />
                    <div className="flex justify-end mt-3">
                      <button
                        onClick={() => handleJsonUploadSubmit(jsonPaste)}
                        className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold transition cursor-pointer shadow-lg shadow-cyan-500/20"
                      >
                        Import & Sync JSON Questions
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {qmTab === 'add' && (
                <form onSubmit={handleAddManualQuestion} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-1">Category</label>
                      <input
                        type="text"
                        value={newCat}
                        onChange={(e) => setNewCat(e.target.value)}
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-1">Correct Answer Index (0-3)</label>
                      <select
                        value={newCorrect}
                        onChange={(e) => setNewCorrect(Number(e.target.value))}
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                      >
                        <option value={0}>Option 0 (A)</option>
                        <option value={1}>Option 1 (B)</option>
                        <option value={2}>Option 2 (C)</option>
                        <option value={3}>Option 3 (D)</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-1">Question Text</label>
                    <textarea
                      rows={2}
                      value={newQText}
                      onChange={(e) => setNewQText(e.target.value)}
                      required
                      placeholder="Enter question statement..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-1">Option A (Index 0)</label>
                      <input
                        type="text"
                        value={newOpt0}
                        onChange={(e) => setNewOpt0(e.target.value)}
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-1">Option B (Index 1)</label>
                      <input
                        type="text"
                        value={newOpt1}
                        onChange={(e) => setNewOpt1(e.target.value)}
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-1">Option C (Index 2)</label>
                      <input
                        type="text"
                        value={newOpt2}
                        onChange={(e) => setNewOpt2(e.target.value)}
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-mono text-slate-400 mb-1">Option D (Index 3)</label>
                      <input
                        type="text"
                        value={newOpt3}
                        onChange={(e) => setNewOpt3(e.target.value)}
                        required
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono text-slate-400 mb-1">Explanation (Optional)</label>
                    <input
                      type="text"
                      value={newExpl}
                      onChange={(e) => setNewExpl(e.target.value)}
                      placeholder="Why is this answer correct?"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 font-mono text-xs text-white focus:outline-none focus:border-cyan-500"
                    />
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      className="px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-mono text-xs font-bold transition cursor-pointer shadow-lg shadow-cyan-500/20 flex items-center gap-1.5"
                    >
                      <Plus className="w-4 h-4" />
                      Add Question to Pool
                    </button>
                  </div>
                </form>
              )}

              {qmTab === 'list' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-mono text-slate-400">
                      Total Active Questions: <span className="text-white font-bold">{activeQuestions.length}</span>
                    </div>
                    <button
                      onClick={handleResetDefault}
                      className="px-3 py-1.5 rounded-lg bg-rose-950/60 border border-rose-500/30 hover:bg-rose-900/80 text-rose-300 font-mono text-xs transition cursor-pointer"
                    >
                      Reset to Default Questions
                    </button>
                  </div>

                  <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-2">
                    {activeQuestions.map((q, idx) => (
                      <div key={q.id || idx} className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-mono uppercase bg-cyan-950 text-cyan-400 px-2 py-0.5 rounded border border-cyan-500/20">
                              {q.category}
                            </span>
                            <span className="text-[10px] font-mono text-slate-400">Q#{idx + 1}</span>
                          </div>
                          <div className="text-sm font-bold text-white mb-2">{q.question}</div>
                          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                            {q.options.map((opt, oIdx) => (
                              <div
                                key={oIdx}
                                className={`p-1.5 rounded border ${
                                  oIdx === q.correctIndex
                                    ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300 font-semibold'
                                    : 'bg-slate-900/50 border-slate-800 text-slate-400'
                                }`}
                              >
                                {String.fromCharCode(65 + oIdx)}: {opt}
                              </div>
                            ))}
                          </div>
                        </div>

                        <button
                          onClick={() => handleDeleteQuestion(q.id)}
                          className="p-2 rounded-lg bg-slate-900 hover:bg-rose-950/80 text-slate-400 hover:text-rose-400 transition cursor-pointer shrink-0"
                          title="Delete Question"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/50 flex justify-end">
              <button
                onClick={() => setIsQuestionManagerOpen(false)}
                className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs font-semibold transition cursor-pointer"
              >
                Close Manager
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
