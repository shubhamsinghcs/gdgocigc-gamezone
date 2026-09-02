import React, { useState, useEffect } from 'react';
import { ViewRole, GameState, Player } from './types';
import { RoleSwitcher } from './components/RoleSwitcher';
import { PlayerRegistration } from './components/PlayerRegistration';
import { PlayerView } from './components/PlayerView';
import { PresenterView } from './components/PresenterView';
import { FirebaseConfigModal } from './components/FirebaseConfigModal';
import { listenToGameState, listenToPlayers, registerPlayer } from './services/firebaseSync';

export default function App() {
  const [currentView, setCurrentView] = useState<ViewRole>('landing');
  const [isFirebaseModalOpen, setIsFirebaseModalOpen] = useState(false);

  // Synced state across clients
  const [gameState, setGameState] = useState<GameState>({
    currentQuestionIndex: -1,
    questionStartTime: Date.now(),
    isTimerActive: false,
    timerDurationSec: 15,
    showAnswer: false,
    fastestWinner: null,
    questionWinners: {}
  });

  const [players, setPlayers] = useState<Record<string, Player>>({});
  const [currentPlayer, setCurrentPlayer] = useState<Player | null>(null);

  // Restore saved player profile on load
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('fastest_finger_player_profile');
        if (saved) {
          const parsed: Player = JSON.parse(saved);
          setCurrentPlayer(parsed);
        }
      } catch {
        // ignore
      }
    }
  }, []);

  // Listen to realtime game state updates
  useEffect(() => {
    const unsubGame = listenToGameState((state) => {
      setGameState(state);
    });
    const unsubPlayers = listenToPlayers((allPlayers) => {
      setPlayers(allPlayers);
    });

    return () => {
      unsubGame();
      unsubPlayers();
    };
  }, []);

  // Keep currentPlayer score synchronized with players dictionary
  useEffect(() => {
    if (currentPlayer && players[currentPlayer.id]) {
      setCurrentPlayer(players[currentPlayer.id]);
    }
  }, [players, currentPlayer?.id]);

  // Handle player registration
  const handlePlayerRegistered = (player: Player) => {
    setCurrentPlayer(player);
    setCurrentView('player_game');
  };

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 font-sans selection:bg-cyan-500 selection:text-slate-950">
      {/* View 1: Landing Screen */}
      {currentView === 'landing' && (
        <RoleSwitcher
          onSelectRole={(role) => {
            if (role === 'player_register' && currentPlayer) {
              setCurrentView('player_game');
            } else {
              setCurrentView(role);
            }
          }}
          registeredPlayerCount={Object.keys(players).length}
          currentQuestionIndex={gameState.currentQuestionIndex}
        />
      )}

      {/* View 2: Player Registration Form */}
      {currentView === 'player_register' && (
        <PlayerRegistration
          onRegistered={handlePlayerRegistered}
          onBackToLanding={() => setCurrentView('landing')}
          existingPlayer={currentPlayer}
        />
      )}

      {/* View 3: Player Game Console */}
      {currentView === 'player_game' && currentPlayer && (
        <PlayerView
          player={currentPlayer}
          gameState={gameState}
          onSwitchRole={() => setCurrentView('landing')}
          onUpdateProfile={() => setCurrentView('player_register')}
        />
      )}

      {/* View 4: Presenter Big Screen Cyberpunk Dashboard (#0f172a) */}
      {currentView === 'presenter_big_screen' && (
        <PresenterView
          gameState={gameState}
          players={players}
          onSwitchRole={() => setCurrentView('landing')}
          onOpenFirebaseConfig={() => setIsFirebaseModalOpen(true)}
        />
      )}

      {/* Firebase Settings Modal */}
      <FirebaseConfigModal
        isOpen={isFirebaseModalOpen}
        onClose={() => setIsFirebaseModalOpen(false)}
      />
    </div>
  );
}
