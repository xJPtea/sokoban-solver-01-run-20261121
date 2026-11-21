// Sokoban solver: push-optimal, room by room.
//
// A level is a 1-wide hallway with 1-4 rooms off it (3-4 boxes each). A box
// pushed into the hallway can never come back, so every box stays in its own
// room and the level optimum is the sum of the rooms' optima. This program
// therefore splits the level into rooms, solves each room on its own with a
// breadth-first search over pushes (the first solved state found uses the
// fewest pushes), and stitches the rooms' move strings together, walking the
// player between doors through the hallway.
//
// Search state = sorted box squares + the player's reachable region (named by
// its lowest square). Two prunes, neither of which removes a solvable state:
// a box may only sit on a "live" square (one from which pulls from a goal can
// reach it), and a push that freezes a 2x2 block of walls/boxes with a box off
// its goal is dropped. The search is bounded by states expanded, never by the
// clock, so two runs write identical bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Per-room search budget; the generator keeps rooms solvable well inside it.
const ROOM_STATES = 250_000;
// Whole-level fallback budget, used only when the level splits oddly.
const LEVEL_STATES = 600_000;

const DIRS = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
] as const;

type Board = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

function parse(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares a box alone can be pushed from onto some goal: walk backwards from
// the goals, one pull at a time. Any box outside this set is dead forever.
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.wall.length);
  const queue = [...b.goals];
  for (const g of b.goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Lowest square the player reaches from `from` with `occ` in the way; also
// stamps the whole region into `seen` so a push test can ask "can the player
// stand on the square behind this box?" in O(1).
function regionLow(b: Board, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - b.w : k === 1 ? p + b.w : k === 2 ? p - 1 : p + 1;
      if (!b.wall[q] && !occ[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// True when the box just pushed to `t` is stuck inside a 2x2 block of walls
// and boxes while some box in the block sits off its goal.
function frozen(b: Board, occ: Uint8Array, goal: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + w;
    if (!(b.wall[a] || occ[a]) || !(b.wall[a + 1] || occ[a + 1]) || !(b.wall[c] || occ[c]) || !(b.wall[c + 1] || occ[c + 1])) continue;
    if ((occ[a] && !goal[a]) || (occ[a + 1] && !goal[a + 1]) || (occ[c] && !goal[c]) || (occ[c + 1] && !goal[c + 1])) return true;
  }
  return false;
}

// Shortest walk from `from` to `to` around walls and boxes, lower-case moves.
function walkTo(b: Board, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.wall.length).fill(-1);
  const how = new Array<string>(b.wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

// Push-optimal solution of one board: {pushes, moves} or null. BFS over
// pushes, so the first solved state dequeued is optimal.
function solvePush(b: Board, maxStates: number): { pushes: number; moves: string } | null {
  const size = b.wall.length;
  const goal = new Uint8Array(size);
  for (const g of b.goals) goal[g] = 1;
  const live = liveSquares(b);
  if (b.boxes.some((x) => !live[x])) return null;
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((x) => goal[x]);
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const x of boxes) k = k * size + x;
    return k;
  };
  const boxesList: number[][] = [b.boxes];
  const playerAt: number[] = [b.player];
  const parent: number[] = [-1];
  const index = new Map<number, number>();
  for (const x of b.boxes) occ[x] = 1;
  index.set(keyOf(b.boxes, regionLow(b, occ, b.player, seen, ++stamp, stack)), 0);
  for (const x of b.boxes) occ[x] = 0;
  let found = solved(b.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < boxesList.length; head++) {
    const boxes = boxesList[head]!;
    for (const x of boxes) occ[x] = 1;
    regionLow(b, occ, playerAt[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * b.w + dx;
        const t = box + d;
        if (seen[box - d] !== here || b.wall[t] || occ[t] || !live[t]) continue;
        occ[box] = 0;
        occ[t] = 1;
        let next: number[] | null = null;
        let key = -1;
        if (!frozen(b, occ, goal, t)) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, regionLow(b, occ, box, mark, ++stamp, stack));
        }
        occ[t] = 0;
        occ[box] = 1;
        if (next === null || index.has(key)) continue;
        if (boxesList.length >= maxStates) {
          for (const x of boxes) occ[x] = 0;
          return null;
        }
        index.set(key, boxesList.length);
        boxesList.push(next);
        playerAt.push(box);
        parent.push(head);
        if (solved(next)) {
          found = boxesList.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occ[x] = 0;
  }
  if (found < 0) return null;
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes;
  for (const s of path) {
    const nextBoxes = boxesList[s]!;
    const from = boxes.find((x) => !nextBoxes.includes(x))!;
    const to = nextBoxes.find((x) => !boxes.includes(x))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * b.w + dx === d)!;
    for (const x of boxes) occ[x] = 1;
    moves += walkTo(b, occ, player, from - d);
    for (const x of boxes) occ[x] = 0;
    moves += dir[2];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

// Split the level into rooms: cut the hallway row's dead floor (a box there
// reaches no goal), then each connected floor part holding boxes is a room.
// Null when the split does not fit (a box in the hallway, mismatched counts).
function roomsOf(b: Board): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.wall.length);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) if (!b.wall[i] && !live[i]) cut[i] = 1;
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < b.wall.length; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * b.w + dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const x of b.boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of b.goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

function solve(text: string): string {
  const level = parse(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const x of other.boxes) wall[x] = 1;
      }
      const sub: Board = { w: level.w, h: level.h, wall, goals: [...room.goals].sort((a, c) => a - c), boxes: [...room.boxes].sort((a, c) => a - c), player };
      const done = solvePush(sub, ROOM_STATES);
      if (done === null) {
        ok = false;
        break;
      }
      moves += done.moves;
      // Advance the player along the moves just made.
      for (const ch of done.moves) player += ch === 'u' ? -level.w : ch === 'd' ? level.w : ch === 'l' ? -1 : 1;
      // Solved room's boxes now sit on its goals: treat them as walls next round.
      room.boxes = room.goals.slice();
    }
    if (ok) return moves;
  }
  const whole = solvePush(level, LEVEL_STATES);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(IN).sort()) {
  const moves = solve(readFileSync(join(IN, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT, id), { recursive: true });
  writeFileSync(join(OUT, id, 'solution.txt'), `${moves}\n`);
}
