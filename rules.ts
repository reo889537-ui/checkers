/* Русские шашки — правила. Используется сервером и браузером.
   Клетки: 0 пусто, 1 белая простая, 3 белая дамка, 2 чёрная простая, 4 чёрная дамка.
   Индекс = r*8+c, r=0 сверху. Белые идут вверх (r-1), чёрные вниз (r+1). */

export type Cells = number[];
export type Move = { from: number; path: number[]; captured: number[]; promote?: boolean };

export const EMPTY = 0, W = 1, B = 2, WK = 3, BK = 4;
export const DIRS: [number, number][] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

export const inB = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;
export const colorOf = (p: number) => (p === W || p === WK ? 1 : p === B || p === BK ? 2 : 0);
export const isKing = (p: number) => p === WK || p === BK;
export const isMan = (p: number) => p === W || p === B;
export const idx = (r: number, c: number) => r * 8 + c;

export function initialCells(): Cells {
  const cells: Cells = new Array(64).fill(0);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) {
        if (r < 3) cells[r * 8 + c] = B;
        else if (r > 4) cells[r * 8 + c] = W;
      }
  return cells;
}

export const key = (cells: Cells) => cells.join("");
export function fromKey(s: string): Cells {
  const cells: Cells = new Array(64).fill(0);
  for (let i = 0; i < 64 && i < s.length; i++) cells[i] = s.charCodeAt(i) - 48;
  return cells;
}

export function promotesOn(piece: number, r: number) {
  if (piece === W) return r === 0;
  if (piece === B) return r === 7;
  return false;
}

function captureFrom(
  cells: Cells, from: number, piece: number, captured: number[],
  path: number[], out: Move[], promoted: boolean,
): boolean {
  const isK = isKing(piece) || promoted;
  const me = colorOf(piece);
  const r0 = from >> 3, c0 = from & 7;
  let any = false;

  for (const [dr, dc] of DIRS) {
    if (isK) {
      let r = r0 + dr, c = c0 + dc;
      while (inB(r, c) && cells[r * 8 + c] === EMPTY) { r += dr; c += dc; }
      if (!inB(r, c)) continue;
      const victim = r * 8 + c;
      const vp = cells[victim];
      if (vp === EMPTY || captured.indexOf(victim) >= 0) continue;
      if (colorOf(vp) === me) continue;
      let lr = r + dr, lc = c + dc;
      while (inB(lr, lc) && cells[lr * 8 + lc] === EMPTY) {
        const land = lr * 8 + lc;
        any = true;
        captured.push(victim); path.push(land);
        const nowKing = promoted || isKing(piece) || promotesOn(piece, lr);
        if (!captureFrom(cells, land, piece, captured, path, out, nowKing))
          out.push({ from, path: path.slice(), captured: captured.slice(), promote: nowKing && !isKing(piece) });
        path.pop(); captured.pop();
        lr += dr; lc += dc;
      }
    } else {
      const mr = r0 + dr, mc = c0 + dc, lr = r0 + 2 * dr, lc = c0 + 2 * dc;
      if (!inB(lr, lc)) continue;
      const victim = mr * 8 + mc, land = lr * 8 + lc;
      if (cells[victim] === EMPTY) continue;
      if (cells[land] !== EMPTY) continue;
      if (colorOf(cells[victim]) === me) continue;
      if (captured.indexOf(victim) >= 0) continue;
      any = true;
      captured.push(victim); path.push(land);
      const becameKing = promotesOn(piece, lr);
      if (!captureFrom(cells, land, piece, captured, path, out, becameKing))
        out.push({ from, path: path.slice(), captured: captured.slice(), promote: becameKing });
      path.pop(); captured.pop();
    }
  }
  return any;
}

export function captures(cells: Cells, turn: number): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 64; i++) {
    const p = cells[i];
    if (p === EMPTY || colorOf(p) !== turn) continue;
    captureFrom(cells, i, p, [], [], out, false);
  }
  return out;
}

export function quietMoves(cells: Cells, turn: number): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 64; i++) {
    const p = cells[i];
    if (p === EMPTY || colorOf(p) !== turn) continue;
    const r = i >> 3, c = i & 7;
    if (isKing(p)) {
      for (const [dr, dc] of DIRS) {
        let rr = r + dr, cc = c + dc;
        while (inB(rr, cc) && cells[rr * 8 + cc] === EMPTY) {
          out.push({ from: i, path: [rr * 8 + cc], captured: [], promote: false });
          rr += dr; cc += dc;
        }
      }
    } else {
      const dr = turn === 1 ? -1 : 1;
      for (const dc of [-1, 1]) {
        const rr = r + dr, cc = c + dc;
        if (!inB(rr, cc)) continue;
        if (cells[rr * 8 + cc] !== EMPTY) continue;
        out.push({ from: i, path: [rr * 8 + cc], captured: [], promote: promotesOn(p, rr) });
      }
    }
  }
  return out;
}

export function legalMoves(cells: Cells, turn: number): Move[] {
  const caps = captures(cells, turn);
  if (caps.length) return caps;
  return quietMoves(cells, turn);
}

export function applyMove(cells: Cells, move: Move): Cells {
  const next = cells.slice();
  const piece = next[move.from];
  next[move.from] = EMPTY;
  for (const sq of move.captured) next[sq] = EMPTY;
  let cur = piece;
  for (const sq of move.path) {
    const r = sq >> 3;
    if (isMan(cur) && promotesOn(cur, r)) cur = cur === W ? WK : BK;
  }
  next[move.path[move.path.length - 1]] = cur;
  return next;
}

export function outcome(cells: Cells, turn: number, quietPlies: number): number {
  const mine = cells.filter((p) => colorOf(p) === turn).length;
  const theirs = cells.filter((p) => colorOf(p) === turn % 2 + 1).length;
  if (theirs === 0) return turn;
  if (mine === 0) return turn % 2 + 1;
  if (legalMoves(cells, turn).length === 0) return turn % 2 + 1;
  if (quietPlies >= 60) return 3;
  return 0;
}

export function findMove(cells: Cells, turn: number, from: number, path: number[], captured: number[]): Move | null {
  const moves = legalMoves(cells, turn);
  for (const m of moves) {
    if (m.from !== from) continue;
    if (m.path.length !== path.length) continue;
    let ok = true;
    for (let i = 0; i < path.length; i++) if (m.path[i] !== path[i]) { ok = false; break; }
    if (!ok) continue;
    if (captured.length && captured.length !== m.captured.length) continue;
    return m;
  }
  return null;
}
