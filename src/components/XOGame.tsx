import { useState, useEffect } from "react";

type Cell = "X" | "O" | null;
type Board = Cell[];
type Mark = "X" | "O";

const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const WIN_LINE_COORDS: Record<string, { x1: number; y1: number; x2: number; y2: number }> = {
  "0,1,2": { x1: 30,  y1: 50,  x2: 270, y2: 50  },
  "3,4,5": { x1: 30,  y1: 150, x2: 270, y2: 150 },
  "6,7,8": { x1: 30,  y1: 250, x2: 270, y2: 250 },
  "0,3,6": { x1: 50,  y1: 30,  x2: 50,  y2: 270 },
  "1,4,7": { x1: 150, y1: 30,  x2: 150, y2: 270 },
  "2,5,8": { x1: 250, y1: 30,  x2: 250, y2: 270 },
  "0,4,8": { x1: 30,  y1: 30,  x2: 270, y2: 270 },
  "2,4,6": { x1: 270, y1: 30,  x2: 30,  y2: 270 },
};

const WIN_LINE_LENGTH: Record<string, number> = {
  "0,1,2": 240, "3,4,5": 240, "6,7,8": 240,
  "0,3,6": 240, "1,4,7": 240, "2,5,8": 240,
  "0,4,8": 340, "2,4,6": 340,
};

const LINE_COLOR = "color-mix(in oklch, var(--muted-foreground) 35%, transparent)";

function getWinner(board: Board): { winner: Cell; line: number[] } | null {
  for (const line of WINNING_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line };
    }
  }
  return null;
}

function isDraw(board: Board): boolean {
  return board.every(Boolean) && !getWinner(board);
}

function minimax(
  board: Board,
  depth: number,
  isMaximizing: boolean,
  alpha: number,
  beta: number,
  aiMark: Mark,
): number {
  const result = getWinner(board);
  if (result) return result.winner === aiMark ? 10 - depth : depth - 10;
  if (isDraw(board)) return 0;

  const playerMark: Mark = aiMark === "O" ? "X" : "O";

  if (isMaximizing) {
    let best = -Infinity;
    for (let i = 0; i < 9; i++) {
      if (!board[i]) {
        board[i] = aiMark;
        best = Math.max(best, minimax(board, depth + 1, false, alpha, beta, aiMark));
        board[i] = null;
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
    }
    return best;
  } else {
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      if (!board[i]) {
        board[i] = playerMark;
        best = Math.min(best, minimax(board, depth + 1, true, alpha, beta, aiMark));
        board[i] = null;
        beta = Math.min(beta, best);
        if (beta <= alpha) break;
      }
    }
    return best;
  }
}

const MOVE_ORDER = [4, 0, 2, 6, 8, 1, 3, 5, 7];

function getBestMove(board: Board, aiMark: Mark): number {
  let bestVal = -Infinity;
  const bestMoves: number[] = [];
  for (const i of MOVE_ORDER) {
    if (!board[i]) {
      board[i] = aiMark;
      const val = minimax(board, 0, false, -Infinity, Infinity, aiMark);
      board[i] = null;
      if (val > bestVal) {
        bestVal = val;
        bestMoves.length = 0;
        bestMoves.push(i);
      } else if (val === bestVal) {
        bestMoves.push(i);
      }
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

function MarkSvg({ mark, size = 44, color }: { mark: Mark; size?: number; color: string }) {
  if (mark === "X") {
    const p = size * 0.23;
    const q = size - p;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
        <line x1={p} y1={p} x2={q} y2={q} stroke={color} strokeWidth="3.5" strokeLinecap="round" />
        <line x1={q} y1={p} x2={p} y2={q} stroke={color} strokeWidth="3.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <circle cx={size / 2} cy={size / 2} r={size * 0.295} stroke={color} strokeWidth="3.5" />
    </svg>
  );
}

function ScoreColumn({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

export default function XOGame() {
  const [picking, setPicking] = useState(true);
  const [playerMark, setPlayerMark] = useState<Mark>("X");
  const [board, setBoard] = useState<Board>(Array(9).fill(null));
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [score, setScore] = useState({ player: 0, ai: 0, draws: 0 });
  const [gameOver, setGameOver] = useState(false);
  const [resultText, setResultText] = useState("");
  const [winLine, setWinLine] = useState<number[] | null>(null);
  const [thinking, setThinking] = useState(false);

  const aiMark: Mark = playerMark === "X" ? "O" : "X";

  function startGame(mark: Mark) {
    setPlayerMark(mark);
    setBoard(Array(9).fill(null));
    setGameOver(false);
    setWinLine(null);
    setResultText("");
    setThinking(false);
    // X always goes first
    setIsPlayerTurn(mark === "X");
    setPicking(false);
  }

  useEffect(() => {
    if (picking) return;
    if (!isPlayerTurn && !gameOver) {
      setThinking(true);
      const timer = setTimeout(() => {
        const newBoard = [...board];
        const move = getBestMove(newBoard, aiMark);
        if (move !== -1) {
          newBoard[move] = aiMark;
          setBoard(newBoard);
          const result = getWinner(newBoard);
          if (result) {
            setWinLine(result.line);
            setResultText("AI wins");
            setScore((s) => ({ ...s, ai: s.ai + 1 }));
            setGameOver(true);
          } else if (isDraw(newBoard)) {
            setResultText("Draw");
            setScore((s) => ({ ...s, draws: s.draws + 1 }));
            setGameOver(true);
          } else {
            setIsPlayerTurn(true);
          }
        }
        setThinking(false);
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [isPlayerTurn, gameOver, board, picking, aiMark]);

  function handleClick(index: number) {
    if (board[index] || !isPlayerTurn || gameOver || thinking) return;
    const newBoard = [...board];
    newBoard[index] = playerMark;
    setBoard(newBoard);
    const result = getWinner(newBoard);
    if (result) {
      setWinLine(result.line);
      setResultText("You win!");
      setScore((s) => ({ ...s, player: s.player + 1 }));
      setGameOver(true);
      return;
    }
    if (isDraw(newBoard)) {
      setResultText("Draw");
      setScore((s) => ({ ...s, draws: s.draws + 1 }));
      setGameOver(true);
      return;
    }
    setIsPlayerTurn(false);
  }

  const statusText = thinking
    ? "AI thinking…"
    : gameOver
      ? resultText
      : isPlayerTurn
        ? "Your move"
        : "AI move";

  const winLineKey = winLine?.join(",");
  const winCoords = winLineKey ? WIN_LINE_COORDS[winLineKey] : null;
  const winLen = winLineKey ? WIN_LINE_LENGTH[winLineKey] : 0;

  if (picking) {
    return (
      <div className="flex flex-col items-center gap-8 w-full">
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-muted-foreground">Choose your mark</p>
          <p className="text-xs text-muted-foreground/60">X always goes first</p>
        </div>
        <div className="flex gap-4 w-full">
          {(["X", "O"] as Mark[]).map((mark) => (
            <button
              key={mark}
              onClick={() => startGame(mark)}
              className="flex-1 flex flex-col items-center justify-center gap-3 py-8 rounded-xl border border-border bg-card transition-all duration-150 hover:bg-accent/40 hover:border-foreground/30 active:scale-95 cursor-pointer"
            >
              <MarkSvg
                mark={mark}
                size={52}
                color={mark === "X" ? "var(--foreground)" : "var(--muted-foreground)"}
              />
              <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                {mark === "X" ? "Play first" : "Play second"}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">

      {/* Score card */}
      <div className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-6 py-3">
        <ScoreColumn label="You" value={score.player} />
        <ScoreColumn label="Draw" value={score.draws} muted />
        <ScoreColumn label="AI" value={score.ai} />
      </div>

      {/* Turn indicator */}
      <div className="flex items-center gap-2" style={{ height: 24 }}>
        <span
          className={[
            "w-1.5 h-1.5 rounded-full bg-foreground",
            (thinking || (!isPlayerTurn && !gameOver)) ? "xo-dot-pulse" : "",
          ].join(" ")}
        />
        <span className="text-sm font-medium text-muted-foreground tracking-wide">
          {statusText}
        </span>
      </div>

      {/* Board */}
      <div
        className="relative w-full overflow-hidden rounded-xl"
        style={{ aspectRatio: "1 / 1", border: `1.5px solid ${LINE_COLOR}` }}
      >
        {/* Grid lines */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute" style={{ left: "33.33%", top: 0, width: 1.5, height: "100%", backgroundColor: LINE_COLOR }} />
          <div className="absolute" style={{ left: "66.66%", top: 0, width: 1.5, height: "100%", backgroundColor: LINE_COLOR }} />
          <div className="absolute" style={{ top: "33.33%", left: 0, width: "100%", height: 1.5, backgroundColor: LINE_COLOR }} />
          <div className="absolute" style={{ top: "66.66%", left: 0, width: "100%", height: 1.5, backgroundColor: LINE_COLOR }} />
        </div>

        {/* Cells */}
        {board.map((cell, i) => {
          const row = Math.floor(i / 3);
          const col = i % 3;
          const isWinCell = winLine?.includes(i);
          return (
            <button
              key={i}
              onClick={() => handleClick(i)}
              disabled={!!cell || !isPlayerTurn || gameOver || thinking}
              className={[
                "absolute flex items-center justify-center transition-colors duration-100",
                isWinCell ? "bg-accent/50" : "bg-transparent",
                !cell && isPlayerTurn && !gameOver && !thinking
                  ? "hover:bg-accent/25 cursor-pointer active:bg-accent/40"
                  : "cursor-default",
              ].join(" ")}
              style={{ top: `${row * 33.33}%`, left: `${col * 33.33}%`, width: "33.33%", height: "33.33%" }}
            >
              {cell && (
                <span key={`${i}-${cell}`} className="xo-mark">
                  <MarkSvg
                    mark={cell as Mark}
                    color={cell === playerMark ? "var(--foreground)" : "var(--muted-foreground)"}
                  />
                </span>
              )}
            </button>
          );
        })}

        {/* SVG win line */}
        {winCoords && (
          <svg className="absolute inset-0 pointer-events-none" width="100%" height="100%" viewBox="0 0 300 300">
            <line
              x1={winCoords.x1} y1={winCoords.y1}
              x2={winCoords.x2} y2={winCoords.y2}
              stroke="var(--foreground)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={winLen}
              strokeDashoffset={winLen}
              style={{ animation: "xo-strike 0.4s cubic-bezier(0.22, 1, 0.36, 1) forwards" }}
            />
          </svg>
        )}

        {/* Game over overlay */}
        {gameOver && (
          <div
            className="xo-overlay absolute inset-0 flex flex-col items-center justify-center gap-5"
            style={{ backgroundColor: "color-mix(in oklch, var(--background) 78%, transparent)", backdropFilter: "blur(10px)" }}
          >
            <p className="xo-result text-2xl font-semibold tracking-tight">{resultText}</p>
            <button
              onClick={() => setPicking(true)}
              className="xo-result rounded-xl border border-border bg-background px-6 py-2.5 text-sm font-medium transition-colors hover:bg-accent hover:text-foreground"
              style={{ animationDelay: "0.18s" }}
            >
              Play again
            </button>
          </div>
        )}
      </div>

    </div>
  );
}
