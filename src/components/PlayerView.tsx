import React, { useState, useEffect } from 'react';
import { Zap, Shield, Award, AlertCircle, CheckCircle2, XCircle, Clock, ArrowLeft, Flame, Volume2, VolumeX } from 'lucide-react';
import { Player, GameState, Branch } from '../types';
import { questionsData } from '../data/questions';
import { submitAnswer } from '../services/firebaseSync';
import { playCorrectSound, playWrongSound, playWinnerFanfare } from '../services/audio';

interface Props {
  player: Player;
  gameState: GameState;
  onSwitchRole: () => void;
  onUpdateProfile: () => void;
}

export const PlayerView: React.FC<Props> = ({
  player,
  gameState,
  onSwitchRole,
  onUpdateProfile
}) => {
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [isAnswerLocked, setIsAnswerLocked] = useState(false);
  const [isCorrectAnswer, setIsCorrectAnswer] = useState<boolean | null>(null);
  const [responseTimeMs, setResponseTimeMs] = useState<number | null>(null);
  const [isFastestForCurrent, setIsFastestForCurrent] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const currentQIndex = gameState.currentQuestionIndex;
  const currentQuestion = currentQIndex >= 0 && currentQIndex < questionsData.length
    ? questionsData[currentQIndex]
    : null;

  // 15-second timer calculation synchronized with questionStartTime
  const [secondsLeft, setSecondsLeft] = useState<number>(15);

  useEffect(() => {
    if (!gameState.isTimerActive || currentQIndex < 0 || currentQIndex >= questionsData.length) {
      setSecondsLeft(0);
      return;
    }

    const updateTimer = () => {
      const elapsed = (Date.now() - gameState.questionStartTime) / 1000;
      const remaining = Math.max(0, 15 - elapsed);
      setSecondsLeft(remaining);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 100);
    return () => clearInterval(interval);
  }, [gameState.questionStartTime, gameState.isTimerActive, currentQIndex]);

  // Reset local answer state whenever question changes
  useEffect(() => {
    if (currentQIndex < 0 || currentQIndex >= questionsData.length) {
      setSelectedOption(null);
      setIsAnswerLocked(false);
      setIsCorrectAnswer(null);
      setResponseTimeMs(null);
      setIsFastestForCurrent(false);
      return;
    }

    // Check if player has already answered this question in their record
    const prevAnswer = player.answeredQuestions?.[currentQIndex];
    if (prevAnswer) {
      setSelectedOption(prevAnswer.selectedIndex);
      setIsAnswerLocked(true);
      setIsCorrectAnswer(prevAnswer.isCorrect);
      setResponseTimeMs(prevAnswer.deltaMs);
    } else {
      setSelectedOption(null);
      setIsAnswerLocked(false);
      setIsCorrectAnswer(null);
      setResponseTimeMs(null);
      setIsFastestForCurrent(false);
    }
  }, [currentQIndex, player]);

  // Monitor if this player was marked as fastestWinner on the game state
  useEffect(() => {
    if (
      gameState.fastestWinner &&
      gameState.fastestWinner.questionIndex === currentQIndex &&
      gameState.fastestWinner.playerId === player.id
    ) {
      setIsFastestForCurrent(true);
      if (soundEnabled) {
        playWinnerFanfare();
      }
    }
  }, [gameState.fastestWinner, currentQIndex, player.id, soundEnabled]);

  // Handle player tapping an answer
  const handleSelectOption = async (optionIndex: number) => {
    if (isAnswerLocked || !currentQuestion || currentQIndex < 0) return;

    const isCorrect = optionIndex === currentQuestion.correctIndex;
    setSelectedOption(optionIndex);
    setIsAnswerLocked(true);
    setIsCorrectAnswer(isCorrect);

    // Audio Feedback
    if (soundEnabled) {
      if (isCorrect) {
        playCorrectSound();
      } else {
        playWrongSound();
      }
    }

    // Submit with microsecond speed-lock race logic
    try {
      const result = await submitAnswer(player, currentQIndex, optionIndex, isCorrect);
      setResponseTimeMs(result.deltaMs);
      if (result.isFastest) {
        setIsFastestForCurrent(true);
        if (soundEnabled) {
          playWinnerFanfare();
        }
      }
    } catch (err) {
      console.error('Failed to submit answer:', err);
    }
  };

  const timerPct = Math.min(100, Math.max(0, (secondsLeft / 15) * 100));

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 flex flex-col justify-between p-4 max-w-lg mx-auto relative select-none">
      {/* Top Mobile Bar */}
      <header className="flex items-center justify-between py-2 border-b border-slate-800/80 mb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onSwitchRole}
            className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white transition text-xs flex items-center gap-1 font-mono"
            title="Switch View"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Roles
          </button>

          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-1.5 rounded-lg border text-xs transition ${
              soundEnabled
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}
            title="Toggle Sound"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Player Profile Summary */}
        <div className="flex items-center gap-2">
          <button
            onClick={onUpdateProfile}
            className="text-right group cursor-pointer"
          >
            <div className="text-xs font-bold text-white font-mono flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              {player.name}
            </div>
            <div className="text-[10px] font-mono text-cyan-400 group-hover:underline">
              {player.branch} Unit
            </div>
          </button>

          {/* Live Score Pill */}
          <div className="px-2.5 py-1 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono text-xs font-extrabold flex items-center gap-1">
            <Zap className="w-3 h-3 text-amber-400 fill-amber-400" />
            {player.score || 0} pts
          </div>
        </div>
      </header>

      {/* Main Content Area: Waiting Lobby vs Active Question vs Concluded */}
      {currentQIndex < 0 ? (
        /* 1. Waiting for Presenter */
        <div className="my-auto text-center py-12 px-4">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 mx-auto flex items-center justify-center mb-5 animate-pulse">
            <Clock className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold font-display text-white mb-2">
            Lobby Standing By
          </h2>
          <p className="text-sm text-slate-400 max-w-xs mx-auto mb-6">
            The Host will start Question 1 on the main projector screen shortly. Keep your fingers primed for the microsecond speed lock!
          </p>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 text-xs font-mono text-left space-y-2 text-slate-300">
            <div className="text-amber-400 font-bold mb-1 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Speed Lock Rules:
            </div>
            <div>• Correct tap: <span className="text-emerald-400 font-bold">+2 Points</span></div>
            <div>• First microsecond tap: <span className="text-amber-400 font-bold">Fastest Finger Glory</span></div>
            <div>• Incorrect tap: <span className="text-rose-400 font-bold">Locked Out (0 pts)</span></div>
          </div>
        </div>
      ) : currentQIndex >= questionsData.length ? (
        /* 2. Clash Concluded / Final Standings */
        <div className="my-auto text-center py-10 px-4">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 mx-auto flex items-center justify-center mb-5">
            <Award className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold font-display text-white mb-2">
            Clash Concluded!
          </h2>
          <p className="text-sm text-slate-400 mb-6">
            Look up at the presenter big screen for the Branch Championship trophy and podium winners!
          </p>
          <div className="bg-slate-900 border border-amber-500/30 rounded-2xl p-6 text-center">
            <div className="text-xs font-mono text-slate-400 uppercase">Your Final Score</div>
            <div className="text-4xl font-extrabold text-amber-400 font-display my-2">
              {player.score || 0} PTS
            </div>
            <div className="text-xs font-mono text-cyan-300">
              Department: {player.branch}
            </div>
          </div>
        </div>
      ) : currentQuestion ? (
        /* 3. Active Question Arena */
        <div className="flex-1 flex flex-col justify-between py-2">
          {/* Question Header & 15s Ring Timer */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 bg-cyan-950/60 border border-cyan-500/20 px-2.5 py-0.5 rounded-full">
                {currentQuestion.category}
              </span>

              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-slate-400">
                  Q{currentQIndex + 1} of {questionsData.length}
                </span>

                {/* SVG 15-second Ring Countdown */}
                <div className="relative w-8 h-8 flex items-center justify-center">
                  <svg className="w-8 h-8 -rotate-90" viewBox="0 0 36 36">
                    <path
                      className="text-slate-800"
                      strokeWidth="3.5"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                    <path
                      className={`transition-all duration-100 ${
                        secondsLeft <= 3 ? 'text-rose-500' : secondsLeft <= 7 ? 'text-amber-400' : 'text-cyan-400'
                      }`}
                      strokeDasharray={`${timerPct}, 100`}
                      strokeLinecap="round"
                      strokeWidth="3.5"
                      stroke="currentColor"
                      fill="none"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    />
                  </svg>
                  <span className="absolute text-[10px] font-mono font-bold text-white">
                    {Math.ceil(secondsLeft)}
                  </span>
                </div>
              </div>
            </div>

            {/* Question Text */}
            <h3 className="text-base sm:text-lg font-semibold text-white leading-snug mb-4 font-sans">
              {currentQuestion.question}
            </h3>
          </div>

          {/* Fastest Winner Alert Banner (if someone claimed it) */}
          {gameState.fastestWinner && gameState.fastestWinner.questionIndex === currentQIndex && (
            <div className={`mb-3 p-2.5 rounded-xl border flex items-center justify-between text-xs font-mono transition-all animate-bounce ${
              isFastestForCurrent
                ? 'bg-amber-500/20 border-amber-400 text-amber-200 shadow-[0_0_15px_rgba(245,158,11,0.3)]'
                : 'bg-slate-900 border-cyan-500/40 text-cyan-300'
            }`}>
              <div className="flex items-center gap-1.5 font-bold">
                <Zap className="w-4 h-4 text-amber-400 fill-amber-400" />
                {isFastestForCurrent
                  ? '⚡ YOU ARE THE FASTEST FINGER!'
                  : `⚡ Fastest: ${gameState.fastestWinner.name} (${gameState.fastestWinner.branch})`}
              </div>
              <span className="text-[10px] text-slate-300">
                {(gameState.fastestWinner.deltaMs / 1000).toFixed(2)}s
              </span>
            </div>
          )}

          {/* 4 Options Grid */}
          <div className="grid grid-cols-1 gap-2.5 my-auto">
            {currentQuestion.options.map((optionText, idx) => {
              const label = String.fromCharCode(65 + idx); // A, B, C, D
              const isSelected = selectedOption === idx;
              const isRevealedAnswer = gameState.showAnswer && idx === currentQuestion.correctIndex;

              let btnStyle = 'bg-slate-900/90 border-slate-800 text-slate-200 hover:border-cyan-500/60 hover:bg-slate-800/80';
              let badgeStyle = 'bg-slate-800 text-cyan-400 border-slate-700';

              if (isSelected) {
                if (isCorrectAnswer === true) {
                  btnStyle = 'bg-emerald-950/70 border-emerald-500 text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.3)]';
                  badgeStyle = 'bg-emerald-500 text-slate-950 border-emerald-400 font-bold';
                } else if (isCorrectAnswer === false) {
                  btnStyle = 'bg-rose-950/70 border-rose-500 text-rose-200 shadow-[0_0_20px_rgba(239,68,68,0.3)]';
                  badgeStyle = 'bg-rose-500 text-slate-950 border-rose-400 font-bold';
                }
              } else if (isRevealedAnswer) {
                btnStyle = 'bg-emerald-950/50 border-emerald-500/80 text-emerald-200';
                badgeStyle = 'bg-emerald-500 text-slate-950';
              }

              return (
                <button
                  key={idx}
                  id={`player-option-${label.toLowerCase()}`}
                  disabled={isAnswerLocked}
                  onClick={() => handleSelectOption(idx)}
                  className={`w-full text-left p-3.5 rounded-xl border transition-all duration-200 flex items-center gap-3 active:scale-[0.98] ${btnStyle} ${
                    isAnswerLocked ? 'cursor-not-allowed' : 'cursor-pointer'
                  }`}
                >
                  <span className={`w-7 h-7 rounded-lg border text-xs font-mono font-bold flex items-center justify-center shrink-0 ${badgeStyle}`}>
                    {label}
                  </span>
                  <span className="text-sm font-medium leading-tight flex-1">
                    {optionText}
                  </span>
                  {isSelected && isCorrectAnswer === true && (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  )}
                  {isSelected && isCorrectAnswer === false && (
                    <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Submission Feedback Pill */}
          <div className="mt-3">
            {isAnswerLocked && (
              <div
                className={`p-3 rounded-xl border text-xs font-mono text-center transition-all ${
                  isCorrectAnswer === true
                    ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                    : 'bg-rose-950/60 border-rose-500/40 text-rose-300'
                }`}
              >
                {isCorrectAnswer === true ? (
                  <div className="flex items-center justify-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>
                      Correct! +2 points earned {responseTimeMs ? `(${ (responseTimeMs / 1000).toFixed(2) }s)` : ''}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2">
                    <XCircle className="w-4 h-4 text-rose-400" />
                    <span className="font-bold">Wrong Answer (0 pts) — Locked</span>
                  </div>
                )}
              </div>
            )}

            {!isAnswerLocked && (
              <p className="text-[11px] text-center text-slate-400 font-mono">
                ⚡ Tap your answer as fast as possible to win the speed race!
              </p>
            )}
          </div>
        </div>
      ) : null}

      {/* Persistent Bottom Bar */}
      <footer className="pt-2 border-t border-slate-800/80 text-[10px] font-mono text-slate-400 flex items-center justify-between">
        <span>Fastest Finger Tech Clash</span>
        <span>Branch: <strong className="text-cyan-400">{player.branch}</strong></span>
      </footer>
    </div>
  );
};
