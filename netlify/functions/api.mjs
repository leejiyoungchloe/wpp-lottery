import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PARTICIPANTS = 1200;
const PARTICIPANT_PREFIX = "participants/";
const PARTICIPANT_BACKUP_PREFIX = "participants-by-name/";
const STATE_KEY = "state.json";
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
      const state = await readState();
      await Promise.all([
        writeState(createState(state.participants, DEFAULT_WINNERS)),
        writeWinners(DEFAULT_WINNERS)
      ]);
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
  const store = getLotteryStore();
  const [cachedState, backupBlobs] = await Promise.all([
    store.get(STATE_KEY, { type: "json" }).catch(() => null),
    listParticipantBackups()
  ]);
  const normalized = normalizeState(cachedState);
  if (normalized && normalized.participants.length === backupBlobs.length) {
    return normalized;
  }

  return rebuildStateFromBackups(normalized?.winners);
}

async function rebuildStateFromBackups(existingWinners) {
  const [backupParticipants, legacyParticipants, winners] = await Promise.all([
    readParticipantBackups(),
    readLegacyParticipants(),
    existingWinners ? Promise.resolve(existingWinners) : readWinners()
  ]);
  const participantMap = new Map();

  [...legacyParticipants, ...backupParticipants].forEach((participant) => {
    if (!participant?.name) return;
    participantMap.set(participant.name.toLocaleLowerCase(), participant);
  });

  const participants = [...participantMap.values()]
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const state = createState(participants, winners);
  await Promise.all([
    writeState(state),
    ...legacyParticipants.map((participant) => writeParticipantBackup(participant))
  ]);
  return state;
}

async function readParticipantBackups() {
  const store = getLotteryStore();
  const blobs = await listParticipantBackups();
  const participants = await Promise.all(
    blobs.map(async (blob) => store.get(blob.key, { type: "json" }))
  );

  return participants.filter(Boolean);
}

async function readLegacyParticipants() {
  const store = getLotteryStore();
  const { blobs } = await store.list({ prefix: PARTICIPANT_PREFIX });
  const participants = await Promise.all(
    blobs.map(async (blob) => store.get(blob.key, { type: "json" }))
  );

  return participants
    .filter(Boolean)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

async function listParticipantBackups() {
  const { blobs } = await getLotteryStore().list({ prefix: PARTICIPANT_BACKUP_PREFIX });
  return blobs;
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

async function writeState(state) {
  await getLotteryStore().setJSON(STATE_KEY, normalizeState(state) || createState([], DEFAULT_WINNERS));
}

async function writeParticipantBackup(participant) {
  const key = `${PARTICIPANT_BACKUP_PREFIX}${participantKey(participant.name)}.json`;
  await getLotteryStore().setJSON(key, participant);
}

async function addParticipants(rawNames, source) {
  const names = rawNames.map(sanitizeName).filter(Boolean);
  if (names.length === 0) {
    throw new HttpError(400, "请输入姓名");
  }

  const current = await readState();
  const existing = new Set(current.participants.map((participant) => participant.name.toLocaleLowerCase()));
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

  if (current.participants.length + additions.length > MAX_PARTICIPANTS) {
    throw new HttpError(400, `参与人员最多 ${MAX_PARTICIPANTS} 人`);
  }

  const nextState = createState([...current.participants, ...additions], current.winners);
  await Promise.all([
    ...additions.map((participant) => writeParticipantBackup(participant)),
    writeState(nextState)
  ]);

  return readState();
}

async function clearParticipants() {
  const store = getLotteryStore();
  const [legacy, backups] = await Promise.all([
    store.list({ prefix: PARTICIPANT_PREFIX }),
    store.list({ prefix: PARTICIPANT_BACKUP_PREFIX })
  ]);
  await Promise.all([
    ...legacy.blobs.map((blob) => store.delete(blob.key)),
    ...backups.blobs.map((blob) => store.delete(blob.key)),
    store.delete(STATE_KEY),
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
  await Promise.all([
    writeState(createState(state.participants, winners)),
    writeWinners(winners)
  ]);
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

function createState(participants, winners) {
  const normalizedParticipants = Array.isArray(participants)
    ? participants.filter(Boolean).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    : [];
  const normalizedWinners = {
    ...DEFAULT_WINNERS,
    ...(winners || {})
  };
  const updatedAt = [
    ...normalizedParticipants.map((participant) => participant.createdAt),
    ...Object.values(normalizedWinners).flat().map((winner) => winner.createdAt)
  ].filter(Boolean).sort().at(-1) || null;

  return {
    participants: normalizedParticipants,
    winners: normalizedWinners,
    updatedAt
  };
}

function normalizeState(state) {
  if (!state || typeof state !== "object") return null;
  return createState(
    Array.isArray(state.participants) ? state.participants : [],
    state.winners || DEFAULT_WINNERS
  );
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
