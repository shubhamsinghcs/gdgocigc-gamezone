export type Branch = 'CSE' | 'ECE' | 'IT' | 'ME' | 'CE' | 'Other';

export interface Question {
  id: number;
  category: 'Latest Tech News' | 'Emoji Language IDs' | 'Tech Basics' | 'AI & Drone Tech';
  question: string;
  options: [string, string, string, string];
  correctIndex: number;
  explanation?: string;
}

export interface PlayerAnswer {
  selectedIndex: number;
  isCorrect: boolean;
  timestamp: number;
  deltaMs: number; // response time from question start
}

export interface Player {
  id: string;
  name: string;
  branch: Branch;
  score: number;
  answeredQuestions: Record<number, PlayerAnswer>;
  lastActive: number;
  isOnline: boolean;
}

export interface FastestWinner {
  playerId: string;
  name: string;
  branch: Branch;
  timestamp: number;
  deltaMs: number;
  questionIndex: number;
}

export interface QuestionWinnerEntry {
  playerId: string;
  name: string;
  branch: Branch;
  deltaMs: number;
  timestamp: number;
}

export interface GameState {
  currentQuestionIndex: number; // -1 for lobby/intro, 0-15 for questions, 16 for final podium
  questionStartTime: number;
  isTimerActive: boolean;
  timerDurationSec: number;
  showAnswer: boolean;
  fastestWinner: FastestWinner | null;
  questionWinners: Record<number, QuestionWinnerEntry[]>;
}

export type ViewRole = 'landing' | 'player_register' | 'player_game' | 'presenter_big_screen';

export interface FirebaseConfig {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}
