import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { WORDS } from "./words.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(join(__dirname, "public")));

const httpServer = createServer(app);
const io = new Server(httpServer);

// ── Хранилище комнат (в памяти — для «примитивного» мультиплеера этого хватает) ──
// rooms[code] = { game, players: Map<socketId, {name, team, role}> }
const rooms = new Map();

const TEAMS = ["red", "blue"];

// ── Генерация новой партии ──
function newGame() {
  const shuffledWords = shuffle([...WORDS]).slice(0, 25);
  const starting = TEAMS[Math.floor(Math.random() * 2)];
  const other = starting === "red" ? "blue" : "red";

  // 9 у ходящего первым, 8 у второго, 1 убийца, 7 нейтральных = 25
  const key = [
    ...Array(9).fill(starting),
    ...Array(8).fill(other),
    ...Array(1).fill("assassin"),
    ...Array(7).fill("neutral"),
  ];
  shuffle(key);

  return {
    words: shuffledWords,
    key, // секрет: 'red' | 'blue' | 'neutral' | 'assassin'
    revealed: Array(25).fill(null), // null пока закрыта, иначе цвет из key
    startingTeam: starting,
    turn: starting,
    phase: "clue", // 'clue' → капитан даёт подсказку; 'guess' → игроки отгадывают; 'over'
    clue: null, // { word, number }
    guessesLeft: 0,
    winner: null,
    marks: {}, // { cardIndex: [имена игроков, которые кликнули] }
    log: [],
  };
}

function remaining(game, team) {
  let n = 0;
  for (let i = 0; i < 25; i++) {
    if (game.key[i] === team && game.revealed[i] === null) n++;
  }
  return n;
}

// ── Что видит клиент ──
// Публичное состояние — БЕЗ ключа. Ключ уходит только капитанам отдельным событием.
function publicState(room) {
  const g = room.game;
  return {
    words: g.words,
    revealed: g.revealed, // открытые карты видны всем в своём цвете
    startingTeam: g.startingTeam,
    turn: g.turn,
    phase: g.phase,
    clue: g.clue,
    guessesLeft: g.guessesLeft,
    winner: g.winner,
    marks: g.marks,
    log: g.log.slice(-8),
    remaining: { red: remaining(g, "red"), blue: remaining(g, "blue") },
    players: [...room.players.values()].map((p) => ({
      name: p.name,
      team: p.team,
      role: p.role,
    })),
  };
}

// Рассылаем состояние: всем — публичное, капитанам дополнительно — ключ.
function broadcast(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("state", publicState(room));
  for (const [sid, p] of room.players) {
    if (p.role === "captain") io.to(sid).emit("key", room.game.key);
  }
}

function log(room, msg) {
  room.game.log.push(msg);
}

function endTurn(room) {
  const g = room.game;
  g.turn = g.turn === "red" ? "blue" : "red";
  g.phase = "clue";
  g.clue = null;
  g.guessesLeft = 0;
  g.marks = {};
}

function checkWin(room) {
  const g = room.game;
  if (remaining(g, "red") === 0) g.winner = "red";
  if (remaining(g, "blue") === 0) g.winner = "blue";
  if (g.winner) g.phase = "over";
}

// ── Сокеты ──
io.on("connection", (socket) => {
  let code = null;

  socket.on("join", ({ room: r, name }) => {
    code = String(r || "").trim().toUpperCase() || "MAIN";
    name = String(name || "Игрок").trim().slice(0, 20) || "Игрок";

    if (!rooms.has(code)) rooms.set(code, { game: newGame(), players: new Map() });
    const room = rooms.get(code);

    socket.join(code);
    room.players.set(socket.id, { name, team: null, role: null });
    broadcast(code);
  });

  socket.on("setRole", ({ team, role }) => {
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (!TEAMS.includes(team)) return;
    if (!["captain", "guesser"].includes(role)) return;
    p.team = team;
    p.role = role;
    broadcast(code);
  });

  // Капитан даёт подсказку
  socket.on("clue", ({ word, number }) => {
    const room = rooms.get(code);
    if (!room) return;
    const g = room.game;
    const p = room.players.get(socket.id);
    if (!p || p.role !== "captain" || p.team !== g.turn) return;
    if (g.phase !== "clue" || g.winner) return;

    word = String(word || "").trim().slice(0, 30);
    number = Math.max(0, Math.min(9, parseInt(number, 10) || 0));
    if (!word) return;

    g.clue = { word, number };
    g.phase = "guess";
    g.guessesLeft = number + 1; // от 1 до k+1 попыток
    g.marks = {};
    log(room, `Капитан ${g.turn === "red" ? "красных" : "синих"}: «${word}» ${number}`);
    broadcast(code);
  });

  // Одиночный клик — пометка (все видят, о чём думает игрок)
  socket.on("mark", ({ index }) => {
    const room = rooms.get(code);
    if (!room) return;
    const g = room.game;
    const p = room.players.get(socket.id);
    if (!p || p.role !== "guesser" || p.team !== g.turn) return;
    if (g.phase !== "guess" || g.revealed[index] !== null) return;

    const list = g.marks[index] || [];
    const i = list.indexOf(p.name);
    if (i === -1) list.push(p.name);
    else list.splice(i, 1);
    if (list.length) g.marks[index] = list;
    else delete g.marks[index];
    broadcast(code);
  });

  // Двойной клик / подтверждение — открыть карту
  socket.on("guess", ({ index }) => {
    const room = rooms.get(code);
    if (!room) return;
    const g = room.game;
    const p = room.players.get(socket.id);
    if (!p || p.role !== "guesser" || p.team !== g.turn) return;
    if (g.phase !== "guess" || g.winner) return;
    if (index < 0 || index > 24 || g.revealed[index] !== null) return;

    const color = g.key[index];
    g.revealed[index] = color;
    delete g.marks[index];
    const word = g.words[index];

    if (color === "assassin") {
      // Команда, открывшая убийцу, немедленно проигрывает
      g.winner = g.turn === "red" ? "blue" : "red";
      g.phase = "over";
      log(room, `💀 ${word} — убийца! Побеждают ${g.winner === "red" ? "красные" : "синие"}`);
    } else if (color === g.turn) {
      // Своя карта — можно продолжать
      log(room, `✅ ${word} — угадано`);
      g.guessesLeft--;
      checkWin(room);
      if (!g.winner && g.guessesLeft <= 0) {
        log(room, "Попытки кончились — ход переходит");
        endTurn(room);
      }
    } else {
      // Чужая или нейтральная — ход сразу переходит
      log(room, `❌ ${word} — не ваша карта, ход переходит`);
      checkWin(room);
      if (!g.winner) endTurn(room);
    }
    broadcast(code);
  });

  // Досрочно завершить ход
  socket.on("pass", () => {
    const room = rooms.get(code);
    if (!room) return;
    const g = room.game;
    const p = room.players.get(socket.id);
    if (!p || p.role !== "guesser" || p.team !== g.turn) return;
    if (g.phase !== "guess" || g.winner) return;
    log(room, `Команда ${g.turn === "red" ? "красных" : "синих"} завершила ход`);
    endTurn(room);
    broadcast(code);
  });

  // Новая партия (сохраняет игроков и их роли)
  socket.on("restart", () => {
    const room = rooms.get(code);
    if (!room) return;
    room.game = newGame();
    log(room, "Новая партия");
    broadcast(code);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(code);
    else broadcast(code);
  });
});

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Codenames на http://localhost:${PORT}`));
