import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PARTICIPANTS = 1200;
const PARTICIPANT_PREFIX = "participants/";
const WINNERS_KEY = "winners.json";

const AWARDS = {
  first: { label: "一等奖", count: 1 },
  second: { label: "二等奖", count: 2 },
  third: { label: "三等奖", count: 3 }
};

const DEFAULT_WINNERS = {
  first: [],
  second: [],
  third: []
};

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const routePath = getRoutePath(url.pathname);
    const route = `${request.method} ${routePath}`;

    if (route === "GET /api/healthz") {
      return json(200, { success: true, status: "ok", storage: "netlify-blobs" });
    }

    if (route === "GET /api/admin/check") {
      requireAdmin(request);
      return json(200, { success: true });
    }

    if (route === "GET /api/state") {
      return json(200, { success: true, data: await readState() });
    }

    if (route === "GET /api/config") {
      return json(200, {
        success: true,
        data: { urls: [url.origin] }
      });
    }

    if (route === "POST /api/participants") {
      const body = await readJsonBody(request);
      const nextState = await addParticipants([body.name], body.source || "scan");
      return json(200, { success: true, data: nextState });
    }

    if (route === "POST /api/participants/import") {
      requireAdmin(request);
      const body = await readJsonBody(request);
      const names = Array.isArray(body.names) ? body.names : String(body.names || "").split(/[\n,，;；]+/);
      const nextState = await addParticipants(names, "import");
      return json(200, { success: true, data: nextState });
    }

    if (route === "DELETE /api/participants") {
      requireAdmin(request);
      await clearParticipants();
      return json(200, { success: true, data: await readState() });
    }

    if (route === "POST /api/winners/reset") {
      requireAdmin(request);
      await writeWinners(DEFAULT_WINNERS);
      return json(200, { success: true, data: await readState() });
    }

    if (route === "POST /api/draw") {
      requireAdmin(request);
      const body = await readJsonBody(request);
      const nextState = await drawAward(body.awardKey);
      return json(200, { success: true, data: nextState });
    }

    if (route === "GET /api/export.csv") {
      requireAdmin(request);
      return csv(await readState());
    }

    throw new HttpError(404, "API route not found");
  } catch (error) {
    const status = error.status || 500;
    return json(status, {
      success: false,
      error: status === 500 ? "Server error" : error.message
    }, error.headers || {});
  }
};

async function readState() {
  const [participants, winners] = await Promise.all([readParticipants(), readWinners()]);
  const updatedAt = [
    ...participants.map((participant) => participant.createdAt),
    ...Object.values(winners).flat().map((winner) => winner.createdAt)
  ].filter(Boolean).sort().at(-1) || null;

  return { participants, winners, updatedAt };
}

async function readParticipants() {
  const store = getLotteryStore();
  const { blobs } = await store.list({ prefix: PARTICIPANT_PREFIX });
  const participants = await Promise.all(
    blobs.map(async (blob) => store.get(blob.key, { type: "json" }))
  );

  return participants
    .filter(Boolean)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

async function readWinners() {
  const winners = await getLotteryStore().get(WINNERS_KEY, { type: "json" });
  return {
    ...DEFAULT_WINNERS,
    ...(winners || {})
  };
}

async function writeWinners(winners) {
  await getLotteryStore().setJSON(WINNERS_KEY, {
    ...DEFAULT_WINNERS,
    ...(winners || {})
  });
}

async function addParticipants(rawNames, source) {
  const names = rawNames.map(sanitizeName).filter(Boolean);
  if (names.length === 0) {
    throw new HttpError(400, "请输入姓名");
  }

  const current = await readParticipants();
  const existing = new Set(current.map((participant) => participant.name.toLocaleLowerCase()));
  const sourceName = ["scan", "manual", "import"].includes(source) ? source : "scan";
  const createdAt = new Date().toISOString();
  const additions = [];

  names.forEach((name) => {
    const key = name.toLocaleLowerCase();
    if (existing.has(key)) return;
    existing.add(key);
    additions.push({
      id: crypto.randomUUID(),
      name,
      source: sourceName,
      createdAt
    });
  });

  if (additions.length === 0) {
    throw new HttpError(409, "姓名已登记");
  }

  if (current.length + additions.length > MAX_PARTICIPANTS) {
    throw new HttpError(400, `参与人员最多 ${MAX_PARTICIPANTS} 人`);
  }

  const store = getLotteryStore();
  await Promise.all(additions.map((participant) => {
    const key = `${PARTICIPANT_PREFIX}${participantKey(participant.name)}.json`;
    return store.setJSON(key, participant);
  }));

  return readState();
}

async function clearParticipants() {
  const store = getLotteryStore();
  const { blobs } = await store.list({ prefix: PARTICIPANT_PREFIX });
  await Promise.all([
    ...blobs.map((blob) => store.delete(blob.key)),
    store.delete(WINNERS_KEY)
  ]);
}

async function drawAward(awardKey) {
  const award = AWARDS[awardKey];
  if (!award) {
    throw new HttpError(400, "奖项不存在");
  }

  const state = await readState();
  if ((state.winners[awardKey] || []).length > 0) {
    throw new HttpError(409, `${award.label} 已抽出`);
  }

  const winnerIds = new Set(Object.values(state.winners).flat().map((winner) => winner.id));
  const eligible = state.participants.filter((participant) => !winnerIds.has(participant.id));
  if (eligible.length < award.count) {
    throw new HttpError(400, `${award.label} 至少还需要 ${award.count} 位未中奖参与者`);
  }

  const winners = {
    ...state.winners,
    [awardKey]: takeRandom(eligible, award.count)
  };
  await writeWinners(winners);
  return readState();
}

async function readJsonBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "提交内容过大");
  }

  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new HttpError(400, "JSON 格式错误");
  }
}

function requireAdmin(request) {
  const passwordSetting = getEnv("ADMIN_PASSWORD");
  if (!passwordSetting) return;

  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Basic\s+(.+)$/i);
  if (match) {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    if (secureEqual(username, getEnv("ADMIN_USERNAME") || "admin") && secureEqual(password, passwordSetting)) {
      return;
    }
  }

  throw new HttpError(401, "需要老板密码", {
    "WWW-Authenticate": 'Basic realm="WPP Lottery Admin", charset="UTF-8"'
  });
}

function sanitizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function participantKey(name) {
  return crypto.createHash("sha256").update(name.toLocaleLowerCase()).digest("hex");
}

function takeRandom(items, count) {
  const pool = [...items];
  return Array.from({ length: count }, () => {
    const index = crypto.randomInt(pool.length);
    const selected = pool[index];
    pool.splice(index, 1);
    return selected;
  });
}

function csv(state) {
  const rows = [
    ["序号", "姓名", "来源", "登记时间"],
    ...state.participants.map((participant, index) => [
      String(index + 1),
      participant.name,
      participant.source,
      participant.createdAt
    ])
  ];

  return new Response(`\ufeff${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"wpp-media-delivery-618-participants.csv\"",
      "Cache-Control": "no-store"
    }
  });
}

function escapeCsv(value) {
  const text = String(value || "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers
    }
  });
}

function getRoutePath(pathname) {
  if (pathname.startsWith("/api/")) return pathname;
  const functionPrefix = "/.netlify/functions/api";
  if (pathname === functionPrefix) return "/api";
  if (pathname.startsWith(`${functionPrefix}/`)) {
    return `/api/${pathname.slice(functionPrefix.length + 1)}`;
  }
  return pathname;
}

function getLotteryStore() {
  return getStore({ name: "wpp-lottery-data", consistency: "strong" });
}

function getEnv(name) {
  if (globalThis.Netlify?.env?.get) {
    return globalThis.Netlify.env.get(name);
  }
  return process.env[name] || "";
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
