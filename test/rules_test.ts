import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  applyMove, BK, B, EMPTY, WK, W, captures, colorOf, initialCells,
  isKing, legalMoves, outcome, quietMoves,
} from "../rules.ts";

const i = (r: number, c: number) => r * 8 + c;
function board(list: [number, number, number][]) {
  const cells = new Array(64).fill(0);
  for (const [r, c, v] of list) cells[i(r, c)] = v;
  return cells;
}

Deno.test("начальная позиция", () => {
  const cells = initialCells();
  assertEquals(cells.filter((p) => colorOf(p) === 1).length, 12);
  assertEquals(cells.filter((p) => colorOf(p) === 2).length, 12);
  assertEquals(legalMoves(cells, 1).length, 7);
  assert(legalMoves(cells, 1).every((m) => m.captured.length === 0));
});

Deno.test("дамка на последней линии рубит назад", () => {
  // белая дамка на верхней линии (0,0), чёрная шашка (1,1)
  let cells = board([[0, 0, WK], [1, 1, B]]);
  let moves = legalMoves(cells, 1);
  assert(moves.length > 0);
  assert(moves.every((m) => m.from === i(0, 0) && m.captured.length === 1));
  assert(moves.some((m) => m.path[0] === i(2, 2)));

  // дамка на своей последней линии (7,7) рубит вверх
  cells = board([[7, 7, WK], [6, 6, B]]);
  moves = legalMoves(cells, 1);
  assert(moves.some((m) => m.path[0] === i(5, 5)));

  // угол (0,7) — вниз-влево
  cells = board([[0, 7, WK], [1, 6, B]]);
  assert(legalMoves(cells, 1).some((m) => m.path[0] === i(2, 5)));

  // чёрная дамка на нижней линии рубит вверх
  cells = board([[7, 0, BK], [6, 1, W]]);
  assert(legalMoves(cells, 2).some((m) => m.path[0] === i(5, 2)));
});

Deno.test("взятие обязательно", () => {
  const cells = board([[5, 0, W], [4, 1, B], [7, 7, B]]);
  const moves = legalMoves(cells, 1);
  assertEquals(moves.length, 1);
  assertEquals(moves[0].captured.length, 1);
  // при наличии взятия тихие ходы запрещены — их не возвращает legalMoves
  assert(legalMoves(cells, 1).every((m) => m.captured.length > 0));
  assertEquals(quietMoves(initialCells(), 1).length, 7);
});

Deno.test("дамка летает, простая — на шаг", () => {
  assertEquals(legalMoves(board([[3, 3, WK]]), 1).length, 13);
  assertEquals(legalMoves(board([[3, 3, W]]), 1).length, 2);
});

Deno.test("превращение и бой с превращением", () => {
  const cells = board([[1, 0, W]]);
  const prom = legalMoves(cells, 1).find((m) => m.path[0] === i(0, 1))!;
  assert(prom.promote);
  assertEquals(applyMove(cells, prom)[i(0, 1)], WK);

  const cap = board([[2, 1, W], [1, 2, B]]);
  const mv = legalMoves(cap, 1)[0];
  assertEquals(applyMove(cap, mv)[i(0, 3)], WK);
});

Deno.test("турецкий удар: без повторных взятий", () => {
  const cells = board([[7, 0, WK], [6, 1, B], [5, 2, B], [4, 3, B]]);
  for (const m of legalMoves(cells, 1)) {
    assertEquals(new Set(m.captured).size, m.captured.length);
  }
});

Deno.test("окончание партии", () => {
  assertEquals(outcome(board([[7, 0, W], [7, 2, B]]), 2, 0), 1);
  assertEquals(outcome(board([[7, 0, W], [0, 1, B]]), 1, 60), 3);
});

Deno.test("фузз: 3000 случайных ходов без нарушений", () => {
  let cells = initialCells();
  let turn = 1;
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let step = 0; step < 3000; step++) {
    const ms = legalMoves(cells, turn);
    if (!ms.length) { cells = initialCells(); turn = 1; continue; }
    const m = ms[Math.floor(rnd() * ms.length)];
    for (const cap of m.captured) {
      assert(cap !== m.from);
      assert(!m.path.includes(cap));
    }
    assertEquals(new Set(m.captured).size, m.captured.length);
    cells = applyMove(cells, m);
    assertEquals(cells.length, 64);
    assert(cells.every((v) => v >= 0 && v <= 4));
    turn = turn === 1 ? 2 : 1;
  }
});
