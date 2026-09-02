import React from 'react';
import { Tv, Smartphone, Zap, Shield, Trophy, Flame } from 'lucide-react';
import { ViewRole } from '../types';

interface Props {
  onSelectRole: (role: ViewRole) => void;
  registeredPlayerCount: number;
  currentQuestionIndex: number;
}

export const RoleSwitcher: React.FC<Props> = ({
  onSelectRole,
  registeredPlayerCount,
  currentQuestionIndex
}) => {
  return (
    <div className="min-h-screen bg-[#0a0f1d] text-slate-100 flex flex-col items-center justify-center p-4 md:p-8 relative overflow-hidden">
      {/* Background Cyberpunk Grid Glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(6,182,212,0.12),transparent_60%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b08_1px,transparent_1px),linear-gradient(to_bottom,#1e293b08_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] pointer-events-none" />

      <div className="w-full max-w-4xl relative z-10">
        {/* Header Branding */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-xs uppercase tracking-widest mb-4">
            <Zap className="w-3.5 h-3.5 text-cyan-400 fill-cyan-400 animate-pulse" />
            Live Speed-Race Trivia Arena
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-white uppercase font-display">
            Fastest Finger <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-sky-300 to-amber-400">Tech Clash</span>
          </h1>

          <p className="mt-3 text-slate-400 text-sm md:text-base max-w-xl mx-auto">
            Inter-branch technical showdown: microsecond lockouts, live projector dashboard, and inter-department supremacy.
          </p>

          {/* Quick status pill */}
          <div className="flex items-center justify-center gap-4 mt-5 text-xs font-mono text-slate-300">
            <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-full">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span>{registeredPlayerCount} Combatants Joined</span>
            </div>
            <div className="flex items-center gap-1.5 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-full text-amber-300">
              <Flame className="w-3.5 h-3.5" />
              <span>{currentQuestionIndex < 0 ? 'Lobby Standing By' : currentQuestionIndex >= 16 ? 'Clash Concluded' : `Question ${currentQuestionIndex + 1} / 16`}</span>
            </div>
          </div>
        </div>

        {/* Role Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: Presenter / Big Screen */}
          <div
            id="role-presenter-card"
            className="group relative bg-slate-900/90 border-2 border-slate-800 hover:border-cyan-500/70 rounded-2xl p-6 md:p-8 transition-all duration-300 hover:shadow-[0_0_35px_rgba(6,182,212,0.2)] flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 group-hover:scale-110 transition-transform">
                  <Tv className="w-6 h-6" />
                </div>
                <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-slate-800 text-cyan-300 border border-cyan-500/20 uppercase">
                  Projector View
                </span>
              </div>

              <h2 className="text-2xl font-bold text-white mb-2 font-display group-hover:text-cyan-300 transition-colors">
                Presenter / Big Screen
              </h2>

              <p className="text-slate-400 text-xs md:text-sm leading-relaxed mb-6">
                Cyberpunk dark dashboard (#0f172a) optimized for large hall projectors. Includes live winner pop-up overlay, 15-second SVG ring timer, sub-leaderboards, and inter-branch rivalry analytics.
              </p>

              <div className="space-y-2 mb-8 text-xs text-slate-300 font-mono">
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Host broadcast controls (Next, Prev, Reset)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  <span>Microsecond speed race pop-up alert</span>
                </div>
                <div className="flex items-center gap-2">
                  <Trophy className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Branch rivalry metrics & confetti finale</span>
                </div>
              </div>
            </div>

            <button
              id="select-presenter-btn"
              onClick={() => onSelectRole('presenter_big_screen')}
              className="w-full py-3.5 px-6 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold font-mono tracking-wide uppercase transition-all shadow-lg shadow-cyan-500/25 flex items-center justify-center gap-2 cursor-pointer"
            >
              <Tv className="w-4 h-4" />
              Launch Presenter View
            </button>
          </div>

          {/* Card 2: Player / Mobile */}
          <div
            id="role-player-card"
            className="group relative bg-slate-900/90 border-2 border-slate-800 hover:border-amber-500/70 rounded-2xl p-6 md:p-8 transition-all duration-300 hover:shadow-[0_0_35px_rgba(245,158,11,0.2)] flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 group-hover:scale-110 transition-transform">
                  <Smartphone className="w-6 h-6" />
                </div>
                <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-slate-800 text-amber-300 border border-amber-500/20 uppercase">
                  Mobile View
                </span>
              </div>

              <h2 className="text-2xl font-bold text-white mb-2 font-display group-hover:text-amber-300 transition-colors">
                Player / Mobile Device
              </h2>

              <p className="text-slate-400 text-xs md:text-sm leading-relaxed mb-6">
                Speed-click answering console. Enter your name and branch (CSE, ECE, IT, ME, CE, Other) to contest live questions with real-time feedback and Web Audio synthesized chimes and buzzers.
              </p>

              <div className="space-y-2 mb-8 text-xs text-slate-300 font-mono">
                <div className="flex items-center gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  <span>Microsecond speed-race lock (+2 pts)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Flame className="w-3.5 h-3.5 text-rose-400" />
                  <span>Instant wrong answer lockout (0 pts)</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-sky-400" />
                  <span>Departmental branch honor scoreboard</span>
                </div>
              </div>
            </div>

            <button
              id="select-player-btn"
              onClick={() => onSelectRole('player_register')}
              className="w-full py-3.5 px-6 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold font-mono tracking-wide uppercase transition-all shadow-lg shadow-amber-500/25 flex items-center justify-center gap-2 cursor-pointer"
            >
              <Smartphone className="w-4 h-4" />
              Join as Live Player
            </button>
          </div>
        </div>

        {/* Footer Note */}
        <p className="text-center text-slate-500 text-xs mt-8 font-mono">
          Tip: You can test this on a single machine by opening Presenter in one tab and Player in another!
        </p>
      </div>
    </div>
  );
};
