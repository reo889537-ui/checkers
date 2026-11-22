/* Шашки — сервер. REST API + сайт + раздача Windows-клиента.
   Исправления относительно прежней версии:
   • дамка рубит и ходит назад в любую сторону (проверка хода на сервере);
   • партия заканчивается победой соперника, если игрок не выходит на связь 30 секунд
     (опрос идёт long-poll'ом, поэтому лишних запросов не добавляется). */

import {
  applyMove, colorOf, findMove, fromKey, initialCells, key as cellsKey,
  legalMoves, outcome, type Cells, type Move,
} from "./rules.ts";

const FORFEIT_MS = Number(Deno.env.get("FORFEIT_MS") ?? 30000);
const WAIT_MS = 25000;      // длительность long-poll
const TICK_MS = 1000;       // внутренний шаг ожидания изменений
const QUEUE_TTL_MS = 60000;

type Seat = { name: string; clientId: string; lastSeen: number };
type SerializedMove = { from: [number, number]; path: [number, number][]; captured: [number, number][] };
type Game = {
  code: string;
  status: "waiting" | "playing" | "finished";
  turn: 1 | 2;
  moves: SerializedMove[];
  cells: string;
  quiet: number;
  winner: 1 | 2 | 3 | null;
  reason: string | null;
  seats: { white: Seat | null; black: Seat | null };
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  ver: number;
};
type Player = { name: string; games: number; wins: number };

/* ─────────── хранилище: Deno KV c откатом в память ─────────── */
type Row = { key: string[]; value: any; versionstamp: string };

const store = await (async () => {
  try {
    const kv: any = await (Deno as any).openKv();
    return {
      kind: "kv" as const,
      async get(key: string[]): Promise<Row | null> {
        const r = await kv.get(key);
        return r.value === null ? null : { key, value: r.value, versionstamp: r.versionstamp };
      },
      async set(key: string[], value: any, expireIn?: number) {
        await kv.set(key, value, expireIn ? { expireIn } : undefined);
      },
      async del(key: string[]) { await kv.delete(key); },
      async list(prefix: string[]): Promise<Row[]> {
        const out: Row[] = [];
        for await (const e of kv.list({ prefix })) out.push({ key: e.key, value: e.value, versionstamp: e.versionstamp });
        return out;
      },
      async claim(key: string[], versionstamp: string) {
        const res = await kv.atomic().check({ key, versionstamp }).delete(key).commit();
        return res.ok;
      },
    };
  } catch (_e) {
    const mem = new Map<string, { value: any; vs: string; exp: number }>();
    let n = 0;
    const k = (key: string[]) => JSON.stringify(key);
    const alive = (e: { exp: number } | undefined) => !!e && (e.exp === 0 || e.exp > Date.now());
    return {
      kind: "memory" as const,
      async get(key: string[]): Promise<Row | null> {
        const e = mem.get(k(key));
        if (!alive(e)) { mem.delete(k(key)); return null; }
        return { key, value: e!.value, versionstamp: e!.vs };
      },
      async set(key: string[], value: any, expireIn?: number) {
        mem.set(k(key), { value, vs: `v${++n}`, exp: expireIn ? Date.now() + expireIn : 0 });
      },
      async del(key: string[]) { mem.delete(k(key)); },
      async list(prefix: string[]): Promise<Row[]> {
        const out: Row[] = [];
        for (const [kk, e] of mem) {
          if (!alive(e)) continue;
          const key = JSON.parse(kk) as string[];
          if (prefix.every((p, i) => key[i] === p)) out.push({ key, value: e.value, versionstamp: e.vs });
        }
        return out;
      },
      async claim(key: string[], vs: string) {
        const e = mem.get(k(key));
        if (!alive(e) || e!.vs !== vs) return false;
        mem.delete(k(key));
        return true;
      },
    };
  }
})();

/* ─────────── перенос старого рейтинга (однократно) ─────────── */
try {
  if (!(await store.get(["meta", "seed"]))) {
    const raw = JSON.parse(await Deno.readTextFile(new URL("./seed/leaderboard.json", import.meta.url)));
    const ps: any[] = raw.players ?? [];
    for (let k = 0; k < ps.length; k++) {
      await store.set(["player", `seed_${k + 1}`], {
        name: String(ps[k].name ?? "Игрок").slice(0, 24),
        wins: Number(ps[k].wins ?? 0),
        games: Number(ps[k].games ?? 0),
      });
    }
    await store.set(["meta", "seed"], { at: Date.now(), players: ps.length });
  }
} catch (_e) { /* нет файла — просто начнём с чистого рейтинга */ }

/* ─────────── игра ─────────── */
const other = (t: number) => (t === 1 ? 2 : 1);
const colorName = (t: number) => (t === 1 ? "white" : "black");
const sideOf = (name: string): 1 | 2 => (name === "black" ? 2 : 1);

function newCode(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) s += a[buf[i] % a.length];
  return s;
}

async function getGame(code: string): Promise<Game | null> {
  const row = await store.get(["game", code.toUpperCase()]);
  return (row?.value as Game) ?? null;
}
async function saveGame(g: Game) {
  g.updatedAt = Date.now();
  g.ver = (g.ver ?? 0) + 1;
  await store.set(["game", g.code], g);
}

function sigOf(g: Game) {
  return `${g.moves.length}|${g.status}|${g.winner ?? ""}|${g.turn}`;
}

function publicState(g: Game, me: string | null, since: number) {
  const mySide = me ? (g.seats.white?.clientId === me ? "white" : g.seats.black?.clientId === me ? "black" : null) : null;
  return {
    code: g.code,
    sig: sigOf(g),
    status: g.status,
    turn: colorName(g.turn),
    moves: g.moves,
    since,
    total: g.moves.length,
    winner: g.winner === null ? null : g.winner === 3 ? "draw" : colorName(g.winner),
    reason: g.reason,
    you: mySide,
    names: { white: g.seats.white?.name ?? null, black: g.seats.black?.name ?? null },
    seats: { white: !!g.seats.white, black: !!g.seats.black },
  };
}

function finish(g: Game, winner: 1 | 2 | 3, reason: string) {
  g.status = "finished";
  g.winner = winner;
  g.reason = reason;
}

async function scoreGame(g: Game) {
  for (const side of [1, 2] as const) {
    const seat = side === 1 ? g.seats.white : g.seats.black;
    if (!seat) continue;
    const row = await store.get(["player", seat.clientId]);
    const p: Player = (row?.value as Player) ?? { name: seat.name, games: 0, wins: 0 };
    p.name = seat.name || p.name;
    p.games += 1;
    if (g.winner === side) p.wins += 1;
    await store.set(["player", seat.clientId], p);
  }
}

function touch(g: Game, me: string) {
  const now = Date.now();
  for (const side of ["white", "black"] as const) {
    const s = g.seats[side];
    if (s && s.clientId === me && now - s.lastSeen > 2000) s.lastSeen = now;
  }
}

function checkForfeit(g: Game, me: string | null): boolean {
  if (g.status !== "playing" || !me) return false;
  const mySide = g.seats.white?.clientId === me ? 1 : g.seats.black?.clientId === me ? 2 : 0;
  if (!mySide) return false;
  const oppSeat = mySide === 1 ? g.seats.black : g.seats.white;
  if (!oppSeat) return false;
  const last = Math.max(oppSeat.lastSeen || 0, g.startedAt || 0);
  if (Date.now() - last > FORFEIT_MS) {
    finish(g, mySide as 1 | 2, "abandon");
    return true;
  }
  return false;
}

const json = (data: unknown, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,x-client-id,accept",
      "cache-control": "no-store",
    },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ─────────── статика ─────────── */
const types: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8",
  svg: "image/svg+xml", ico: "image/x-icon", exe: "application/vnd.microsoft.portable-executable",
  apk: "application/vnd.android.package-archive", png: "image/png",
};

async function serveFile(path: string, downloadName?: string): Promise<Response> {
  try {
    const data = await Deno.readFile(new URL(path, import.meta.url));
    const ext = path.split(".").pop() || "";
    const headers: Record<string, string> = {
      "content-type": types[ext] ?? "application/octet-stream",
      "cache-control": ext === "html" ? "no-cache" : "public, max-age=3600",
    };
    if (downloadName) headers["content-disposition"] = `attachment; filename="${downloadName}"`;
    return new Response(data, { headers });
  } catch (_e) {
    return new Response("Not found", { status: 404 });
  }
}

/* ─────────── сервер ─────────── */
const startedAt = Date.now();

const portEnv = Deno.env.get("PORT");
const serveOptions = portEnv ? { port: Number(portEnv) } : {};

Deno.serve(serveOptions, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const me = req.headers.get("x-client-id") || null;
  const origin = "*";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,x-client-id,accept",
        "access-control-max-age": "86400",
      },
    });
  }

  /* health */
  if (path === "/health") {
    return json({ ok: true, game: "checkers", uptime: Math.round((Date.now() - startedAt) / 1000), store: store.kind }, 200, origin);
  }

  /* очередь соперника */
  if (path === "/api/queue" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "Игрок").slice(0, 14) || "Игрок";
    if (!me) return json({ error: "no_client_id" }, 400, origin);

    const mine = await store.get(["q", me]);
    if (mine?.value?.assigned) {
      const { code, color } = mine.value.assigned;
      await store.del(["q", me]);
      return json({ code, color }, 200, origin);
    }

    const list = await store.list(["q"]);
    const now = Date.now();
    for (const row of list) {
      const v = row.value;
      if (!v || v.assigned || v.clientId === me) continue;
      if (now - (v.ts || 0) > 15000) continue;
      if (!(await store.claim(row.key, row.versionstamp))) continue;
      const code = newCode();
      const g: Game = {
        code, status: "playing", turn: 1, moves: [], cells: cellsKey(initialCells()), quiet: 0,
        winner: null, reason: null,
        seats: {
          white: { name: v.name, clientId: v.clientId, lastSeen: now },
          black: { name, clientId: me, lastSeen: now },
        },
        createdAt: now, startedAt: now, updatedAt: now, ver: 0,
      };
      await saveGame(g);
      await store.set(["q", v.clientId], { assigned: { code, color: "white" }, ts: now }, 120);
      return json({ code, color: "black" }, 200, origin);
    }

    await store.set(["q", me], { name, clientId: me, ts: now }, 120);
    return json({ status: "waiting" }, 200, origin);
  }

  /* создать комнату */
  if (path === "/api/room" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "Игрок").slice(0, 14) || "Игрок";
    if (!me) return json({ error: "no_client_id" }, 400, origin);
    const now = Date.now();
    const code = newCode();
    const g: Game = {
      code, status: "waiting", turn: 1, moves: [], cells: cellsKey(initialCells()), quiet: 0,
      winner: null, reason: null,
      seats: { white: { name, clientId: me, lastSeen: now }, black: null },
      createdAt: now, startedAt: null, updatedAt: now, ver: 0,
    };
    await saveGame(g);
    return json({ code, color: "white" }, 200, origin);
  }

  /* войти по коду */
  if (path === "/api/room/join" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "Игрок").slice(0, 14) || "Игрок";
    const code = String(body.code ?? "").toUpperCase().trim();
    if (!me) return json({ error: "no_client_id" }, 400, origin);
    const g = await getGame(code);
    if (!g) return json({ error: "not_found" }, 404, origin);
    if (g.status === "finished") return json({ error: "finished" }, 409, origin);
    const now = Date.now();
    if (!g.seats.black) {
      g.seats.black = { name, clientId: me, lastSeen: now };
      g.status = "playing";
      g.startedAt = now;
      await saveGame(g);
      return json({ code: g.code, color: "black" }, 200, origin);
    }
    if (!g.seats.white) {
      g.seats.white = { name, clientId: me, lastSeen: now };
      g.status = "playing";
      g.startedAt = now;
      await saveGame(g);
      return json({ code: g.code, color: "white" }, 200, origin);
    }
    if (g.seats.white.clientId === me) return json({ code: g.code, color: "white" }, 200, origin);
    if (g.seats.black.clientId === me) return json({ code: g.code, color: "black" }, 200, origin);
    return json({ error: "full" }, 409, origin);
  }

  /* состояние партии + long-poll */
  if (path === "/api/game" && req.method === "GET") {
    const code = (url.searchParams.get("code") || "").toUpperCase();
    const sinceParam = url.searchParams.get("since");
    const wait = url.searchParams.get("wait") === "1";
    if (!code) return json({ error: "bad_code" }, 400, origin);
    let g = await getGame(code);
    if (!g) return json({ error: "not_found" }, 404, origin);

    const since = Number(sinceParam ?? g.moves.length) || 0;
    const deadline = Date.now() + (wait ? WAIT_MS : 0);
    const sig = sigOf(g);
    let dirty = false;

    while (wait && g.moves.length === since && g.status !== "finished" && Date.now() < deadline) {
      await sleep(TICK_MS);
      const fresh = await getGame(code);
      if (fresh) g = fresh;
      if (checkForfeit(g, me)) { dirty = true; break; }   // соперник пропал — сразу заканчиваем
      if (sigOf(g) !== sig) break;
    }

    if (dirty) {
      await saveGame(g);
      await scoreGame(g);
    } else if (checkForfeit(g, me)) {
      await saveGame(g);
      await scoreGame(g);
    } else if (me) {
      const before = JSON.stringify(g.seats);
      touch(g, me);
      if (JSON.stringify(g.seats) !== before) await saveGame(g);
    }

    return json(publicState(g, me, since), 200, origin);
  }

  /* ход */
  if (path === "/api/game/move" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const code = String(b.code ?? "").toUpperCase();
    if (!me) return json({ error: "no_client_id" }, 400, origin);
    const g = await getGame(code);
    if (!g) return json({ error: "not_found" }, 404, origin);
    if (g.status !== "playing") return json({ error: "not_playing" }, 409, origin);

    const mySide = g.seats.white?.clientId === me ? 1 : g.seats.black?.clientId === me ? 2 : 0;
    if (!mySide) return json({ error: "not_a_player" }, 403, origin);
    if (g.turn !== mySide) return json({ error: "not_your_turn" }, 409, origin);

    const from = Array.isArray(b.from) ? b.from[0] * 8 + b.from[1] : -1;
    const pathArr: number[] = Array.isArray(b.path) ? b.path.map((p: number[]) => p[0] * 8 + p[1]) : [];
    const capArr: number[] = Array.isArray(b.captured) ? b.captured.map((p: number[]) => p[0] * 8 + p[1]) : [];
    const cells: Cells = fromKey(g.cells);
    const legal: Move | null = findMove(cells, g.turn, from, pathArr, capArr);
    if (!legal) return json({ error: "illegal_move" }, 409, origin);

    const next = applyMove(cells, legal);
    g.cells = cellsKey(next);
    g.quiet = legal.captured.length ? 0 : g.quiet + 1;
    g.moves.push({
      from: [legal.from >> 3, legal.from & 7],
      path: legal.path.map((i) => [i >> 3, i & 7] as [number, number]),
      captured: legal.captured.map((i) => [i >> 3, i & 7] as [number, number]),
    });
    g.turn = other(g.turn) as 1 | 2;

    const res = outcome(next, g.turn, g.quiet);
    if (res) finish(g, res as 1 | 2 | 3, res === 3 ? "draw" : "win");
    await saveGame(g);
    if ((g.status as string) === "finished") await scoreGame(g);
    return json(publicState(g, me, g.moves.length), 200, origin);
  }

  /* сдаться */
  if (path === "/api/game/resign" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const code = String(b.code ?? "").toUpperCase();
    if (!me) return json({ error: "no_client_id" }, 400, origin);
    const g = await getGame(code);
    if (!g) return json({ error: "not_found" }, 404, origin);
    const mySide = g.seats.white?.clientId === me ? 1 : g.seats.black?.clientId === me ? 2 : 0;
    if (!mySide) return json({ error: "not_a_player" }, 403, origin);
    if (g.status === "playing") {
      finish(g, other(mySide) as 1 | 2, "abandon");
      await saveGame(g);
      await scoreGame(g);
    }
    return json(publicState(g, me, g.moves.length), 200, origin);
  }

  /* список партий */
  if (path === "/api/games") {
    const rows = await store.list(["game"]);
    const games = rows
      .map((r) => r.value as Game)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20)
      .map((g) => ({
        code: g.code, status: g.status,
        white: g.seats.white?.name ?? null, black: g.seats.black?.name ?? null,
        names: { white: g.seats.white?.name ?? null, black: g.seats.black?.name ?? null },
        moves: g.moves.length,
      }));
    return json({ games }, 200, origin);
  }

  /* рейтинг */
  if (path === "/api/leaderboard") {
    const rows = await store.list(["player"]);
    const players = rows.map((r) => ({ clientId: r.key[1], ...(r.value as Player) }));
    players.sort((a, b) => b.wins - a.wins || b.games - a.games);
    const top = players.slice(0, 20).map((p) => ({
      name: p.name, wins: p.wins, games: p.games, you: p.clientId === me,
    }));
    const mine = players.find((p) => p.clientId === me);
    return json({ players: top, you: mine ? { name: mine.name, wins: mine.wins, games: mine.games } : null }, 200, origin);
  }

  /* сайт и файлы */
  if (path === "/" || path === "/index.html") return serveFile("./static/index.html");
  if (path === "/play") return Response.redirect(url.origin + "/play/", 308);
  if (path === "/play/") return serveFile("./play/index.html");
  if (path === "/download/win") return serveFile("./downloads/Shashki.exe", "Shashki.exe");
  if (path === "/download/apk") return serveFile("./downloads/Shashki-2.0.1.apk", "Shashki-2.0.1.apk");
  if (path === "/download/apk19") return serveFile("./downloads/Shashki-1.9.apk", "Shashki-1.9.apk");
  if (path === "/favicon.ico") return new Response(null, { status: 204 });

  const safe = path.replace(/\.\./g, "").replace(/^\/+/, "");
  if (safe.startsWith("play/") || safe.startsWith("static/")) return serveFile("./" + safe);
  return new Response("Not found", { status: 404 });
});
