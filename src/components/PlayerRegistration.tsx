import React, { useState } from 'react';
import { User, GraduationCap, Zap, ArrowRight, ArrowLeft, Volume2 } from 'lucide-react';
import { Branch, Player } from '../types';
import { registerPlayer } from '../services/firebaseSync';
import { playCorrectSound } from '../services/audio';

interface Props {
  onRegistered: (player: Player) => void;
  onBackToLanding: () => void;
  existingPlayer: Player | null;
}

const BRANCHES: { value: Branch; label: string; desc: string; color: string }[] = [
  { value: 'CSE', label: 'CSE', desc: 'Computer Science & Engineering', color: 'border-cyan-500/40 text-cyan-400' },
  { value: 'ECE', label: 'ECE', desc: 'Electronics & Communication', color: 'border-indigo-500/40 text-indigo-400' },
  { value: 'IT', label: 'IT', desc: 'Information Technology', color: 'border-emerald-500/40 text-emerald-400' },
  { value: 'ME', label: 'ME', desc: 'Mechanical Engineering', color: 'border-amber-500/40 text-amber-400' },
  { value: 'CE', label: 'CE', desc: 'Civil Engineering', color: 'border-rose-500/40 text-rose-400' },
  { value: 'Other', label: 'Other', desc: 'Inter-disciplinary / Other', color: 'border-purple-500/40 text-purple-400' }
];

export const PlayerRegistration: React.FC<Props> = ({
  onRegistered,
  onBackToLanding,
  existingPlayer
}) => {
  const [name, setName] = useState(existingPlayer?.name || '');
  const [branch, setBranch] = useState<Branch>(existingPlayer?.branch || 'CSE');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Please enter your player handle or name.');
      return;
    }
    if (trimmed.length < 2) {
      setError('Name must be at least 2 characters.');
      return;
    }

    setIsSubmitting(true);
    setError('');

    // Pre-warm audio on this user gesture
    playCorrectSound();

    const playerId = existingPlayer?.id || `player_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newPlayer: Player = {
      id: playerId,
      name: trimmed,
      branch,
      score: existingPlayer?.score || 0,
      answeredQuestions: existingPlayer?.answeredQuestions || {},
      lastActive: Date.now(),
      isOnline: true
    };

    try {
      await registerPlayer(newPlayer);
      if (typeof window !== 'undefined') {
        localStorage.setItem('fastest_finger_player_profile', JSON.stringify(newPlayer));
      }
      onRegistered(newPlayer);
    } catch (err) {
      console.error('Registration error:', err);
      // Still proceed with local session
      onRegistered(newPlayer);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1d] text-slate-100 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background Accent Gradients */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(245,158,11,0.1),transparent_60%)] pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Back Link */}
        <button
          id="back-to-landing-btn"
          onClick={onBackToLanding}
          className="flex items-center gap-1.5 text-xs font-mono text-slate-400 hover:text-cyan-400 mb-6 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Role Selector
        </button>

        {/* Registration Card */}
        <div className="bg-slate-900/95 border border-slate-800 shadow-[0_0_40px_rgba(0,0,0,0.5)] rounded-2xl p-6 sm:p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-400">
              <Zap className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-extrabold text-white font-display">Player Enlistment</h2>
              <p className="text-xs text-slate-400 font-mono">Register for the live speed lockout</p>
            </div>
          </div>

          {error && (
            <div className="mb-5 p-3 rounded-lg bg-rose-950/50 border border-rose-500/40 text-rose-300 text-xs font-mono">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Input 1: Player Name */}
            <div>
              <label htmlFor="player-name-input" className="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-amber-400" />
                Player Name / Handle
              </label>
              <input
                id="player-name-input"
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError('');
                }}
                placeholder="e.g. Alex Cipher, Neo_01"
                maxLength={24}
                className="w-full bg-slate-950 border border-slate-700 focus:border-amber-400 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-amber-400/50 transition font-mono"
                autoFocus
              />
            </div>

            {/* Input 2: Branch Dropdown */}
            <div>
              <label htmlFor="player-branch-select" className="block text-xs font-mono text-slate-300 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <GraduationCap className="w-3.5 h-3.5 text-cyan-400" />
                Department / Branch
              </label>
              <div className="relative">
                <select
                  id="player-branch-select"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value as Branch)}
                  className="w-full bg-slate-950 border border-slate-700 focus:border-cyan-400 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-cyan-400/50 transition font-mono appearance-none cursor-pointer"
                >
                  {BRANCHES.map((b) => (
                    <option key={b.value} value={b.value} className="bg-slate-900 text-white">
                      {b.label} — {b.desc}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-slate-400">
                  ▼
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5 font-mono">
                Your score contributes directly to the <span className="text-cyan-400 font-bold">{branch}</span> branch rivalry average!
              </p>
            </div>

            {/* Audio notice */}
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 text-[11px] text-slate-400 font-mono">
              <Volume2 className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Web Audio feedback is enabled for rapid correct chimes and soft buzzers.</span>
            </div>

            {/* Submit Button */}
            <button
              id="join-live-game-btn"
              type="submit"
              disabled={isSubmitting}
              className="w-full py-3.5 px-6 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold font-mono tracking-wider uppercase transition-all shadow-lg shadow-amber-500/25 flex items-center justify-center gap-2 cursor-pointer"
            >
              {isSubmitting ? (
                'Connecting to Arena...'
              ) : (
                <>
                  Join Live Game
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
