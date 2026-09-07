import express from 'express';
import path from 'path';
import http from 'http';
import { createServer as createViteServer } from 'vite';

interface Player {
  id: string;
  name: string;
  branch: string;
  score: number;
  answeredCount: number;
  joinedAt: number;
  answeredQuestions: Record<number, { selectedIndex: number; isCorrect: boolean; deltaMs: number; points: number }>;
  totalTimeTakenMs: number;
  fastestCount: number;
  lastActive: number;
}

interface RoomState {
  status: 'LOBBY' | 'QUESTION_ACTIVE' | 'LEADERBOARD' | 'FINISHED';
  currentQuestionIndex: number;
  questionStartTime: number;
  timerDurationSec: number;
  showAnswer: boolean;
  fastestWinner: { playerId: string; playerName: string; deltaMs: number; questionIndex: number } | null;
  roomPin: string;
  updatedAt: number;
}

interface Room {
  gameState: RoomState;
  players: Record<string, Player>;
  clients: Set<express.Response>;
}

const app = express();
const PORT = 3000;

app.use(express.json());

// In-Memory Real-Time State Stores
const rooms: Record<string, Room> = {};
let latestActivePin = '2026';

function getOrCreateRoom(pin: string): Room {
  const cleanPin = String(pin || '').trim();
  if (!rooms[cleanPin]) {
    rooms[cleanPin] = {
      gameState: {
        status: 'LOBBY',
        currentQuestionIndex: 0,
        questionStartTime: Date.now(),
        timerDurationSec: 10,
        showAnswer: false,
        fastestWinner: null,
        roomPin: cleanPin,
        updatedAt: Date.now()
      },
      players: {},
      clients: new Set()
    };
  }
  return rooms[cleanPin];
}

function broadcastToRoom(pin: string, payload: any) {
  const cleanPin = String(pin || '').trim();
  const room = rooms[cleanPin];
  if (!room) return;

  const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
  room.clients.forEach(res => {
    try {
      res.write(dataStr);
    } catch {
      room.clients.delete(res);
    }
  });
}

// -------------------------------------------------------------
// REST & SSE REAL-TIME API ROUTES (FIRST)
// -------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/active-pin', (req, res) => {
  res.json({ activePin: latestActivePin });
});

app.get('/api/rooms/:pin/check', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const exists = Boolean(rooms[pin]);
  res.json({ exists: true, active: true });
});

app.get('/api/rooms/:pin', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const room = getOrCreateRoom(pin);
  res.json({
    gameState: room.gameState,
    players: room.players
  });
});

app.post('/api/rooms/:pin/create', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  latestActivePin = pin;
  const room = getOrCreateRoom(pin);

  room.gameState = {
    status: 'LOBBY',
    currentQuestionIndex: 0,
    questionStartTime: Date.now(),
    timerDurationSec: 10,
    showAnswer: false,
    fastestWinner: null,
    roomPin: pin,
    updatedAt: Date.now()
  };
  room.players = {};

  broadcastToRoom(pin, {
    type: 'ROOM_RESET',
    gameState: room.gameState,
    players: room.players
  });

  res.json({ success: true, gameState: room.gameState, activePin: pin });
});

app.post('/api/rooms/:pin/join', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const { id, name, branch } = req.body;
  const room = getOrCreateRoom(pin);

  const studentName = String(name || '').trim();
  const studentBranch = String(branch || 'CSE').trim();
  const playerId = id || `${studentName.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`;

  const playerProfile: Player = {
    id: playerId,
    name: studentName,
    branch: studentBranch,
    score: 0,
    answeredCount: 0,
    joinedAt: Date.now(),
    answeredQuestions: {},
    totalTimeTakenMs: 0,
    fastestCount: 0,
    lastActive: Date.now()
  };

  room.players[playerId] = playerProfile;

  broadcastToRoom(pin, {
    type: 'PLAYER_JOINED',
    player: playerProfile,
    players: room.players,
    gamePin: pin
  });

  res.json({
    success: true,
    player: playerProfile,
    gameState: room.gameState
  });
});

app.post('/api/rooms/:pin/action', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const room = getOrCreateRoom(pin);
  const { status, currentQuestionIndex, questionStartTime, showAnswer, fastestWinner } = req.body;

  if (status) room.gameState.status = status;
  if (typeof currentQuestionIndex === 'number') room.gameState.currentQuestionIndex = currentQuestionIndex;
  if (questionStartTime) room.gameState.questionStartTime = questionStartTime;
  if (typeof showAnswer === 'boolean') room.gameState.showAnswer = showAnswer;
  if (fastestWinner !== undefined) room.gameState.fastestWinner = fastestWinner;
  room.gameState.updatedAt = Date.now();

  broadcastToRoom(pin, {
    type: 'STATE_UPDATE',
    gameState: room.gameState,
    players: room.players
  });

  res.json({ success: true, gameState: room.gameState });
});

app.post('/api/rooms/:pin/answer', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const room = getOrCreateRoom(pin);
  const { playerId, questionIndex, selectedIndex, deltaMs, isCorrect, correctIndex } = req.body;

  const player = room.players[playerId];
  if (!player) {
    return res.status(404).json({ error: 'Player not found in room' });
  }

  const qIdx = typeof questionIndex === 'number' ? questionIndex : 0;
  if (player.answeredQuestions && player.answeredQuestions[qIdx]) {
    return res.json({ success: true, alreadyAnswered: true, player });
  }

  const correct = Boolean(isCorrect);
  let pointsAwarded = 0;
  let isFastest = false;

  if (correct) {
    const elapsedSec = Math.min(10, Math.max(0, (deltaMs || 1000) / 1000));
    const remainingSec = Math.max(0, 10 - Math.floor(elapsedSec));
    pointsAwarded = remainingSec * 5;

    // Check if fastest finger winner for this question
    if (!room.gameState.fastestWinner || room.gameState.fastestWinner.questionIndex !== qIdx) {
      room.gameState.fastestWinner = {
        playerId: player.id,
        playerName: player.name,
        deltaMs: deltaMs || 1000,
        questionIndex: qIdx
      };
      pointsAwarded += 2;
      player.fastestCount = (player.fastestCount || 0) + 1;
      isFastest = true;
    }
  }

  player.score = (player.score || 0) + pointsAwarded;
  player.answeredCount = (player.answeredCount || 0) + 1;
  player.totalTimeTakenMs = (player.totalTimeTakenMs || 0) + (deltaMs || 0);
  player.lastActive = Date.now();
  if (!player.answeredQuestions) player.answeredQuestions = {};
  player.answeredQuestions[qIdx] = {
    selectedIndex,
    isCorrect: correct,
    deltaMs: deltaMs || 1000,
    points: pointsAwarded
  };

  broadcastToRoom(pin, {
    type: 'PLAYERS_UPDATE',
    players: room.players,
    fastestWinner: room.gameState.fastestWinner
  });

  res.json({
    success: true,
    player,
    isCorrect: correct,
    pointsAwarded,
    isFastest,
    gameState: room.gameState
  });
});

// SSE Real-Time Stream Route
app.get('/api/rooms/:pin/stream', (req, res) => {
  const pin = String(req.params.pin || '').trim();
  const room = getOrCreateRoom(pin);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  room.clients.add(res);

  // Send initial payload immediately
  res.write(`data: ${JSON.stringify({
    type: 'INITIAL_SYNC',
    gameState: room.gameState,
    players: room.players
  })}\n\n`);

  // Send heartbeat keepalive every 15 seconds
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepAliveInterval);
      room.clients.delete(res);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAliveInterval);
    room.clients.delete(res);
  });
});

// -------------------------------------------------------------
// VITE MIDDLEWARE & STATIC SERVING
// -------------------------------------------------------------
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GDGoC IGC Game Zone server listening on http://0.0.0.0:${PORT}`);
  });
}

start();
