const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 5173);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_PATH = path.join(DATA_DIR, "lottery-data.json");
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PARTICIPANTS = 1200;

const AWARDS = {
  first: { label: "一等奖", count: 1 },
  second: { label: "二等奖", count: 2 },
  third: { label: "三等奖", count: 3 }
};

const DEFAULT_STATE = {
  participants: [],
  winners: {
    first: [],
    second: [],
    third: []
  },
  updatedAt: null
};

let writeQueue = Promise.resolve();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url);
  } catch (error) {
    const status = error.status || 500;
    sendJson(response, status, {
      success: false,
      error: status === 500 ? "Server error" : error.message
    });
    if (status === 500) {
      console.error(error);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const urls = getLocalUrls(PORT);
  console.log("WPP Media Delivery lottery is running:");
  urls.forEach((url) => console.log(`  ${url}`));
  console.log("Use a LAN URL on the big screen so phones can scan and submit.");
});

async function handleApi(request, response, url) {
  const route = `${request.method} ${url.pathname}`;

  if (route === "GET /api/state") {
    sendJson(response, 200, { success: true, data: await readState() });
    return;
  }

  if (route === "GET /api/config") {
    const urls = getLocalUrls(PORT);
    if (process.env.TUNNEL_URL) {
      urls.unshift(process.env.TUNNEL_URL);
    }
    sendJson(response, 200, {
      success: true,
      data: { urls }
    });
    return;
  }

  if (route === "POST /api/participants") {
    const body = await readJsonBody(request);
    const nextState = await updateState((state) => addParticipants(state, [body.name], body.source || "scan"));
    sendJson(response, 200, { success: true, data: nextState });
    return;
  }

  if (route === "POST /api/participants/import") {
    const body = await readJsonBody(request);
    const names = Array.isArray(body.names) ? body.names : String(body.names || "").split(/[\n,，;；]+/);
    const nextState = await updateState((state) => addParticipants(state, names, "import"));
    sendJson(response, 200, { success: true, data: nextState });
    return;
  }

  if (route === "DELETE /api/participants") {
    const nextState = await updateState(() => withTimestamp(DEFAULT_STATE));
    sendJson(response, 200, { success: true, data: nextState });
    return;
  }

  if (route === "POST /api/winners/reset") {
    const nextState = await updateState((state) => ({
      ...state,
      winners: DEFAULT_STATE.winners,
      updatedAt: new Date().toISOString()
    }));
    sendJson(response, 200, { success: true, data: nextState });
    return;
  }

  if (route === "POST /api/draw") {
    const body = await readJsonBody(request);
    const nextState = await updateState((state) => drawAward(state, body.awardKey));
    sendJson(response, 200, { success: true, data: nextState });
    return;
  }

  if (route === "GET /api/export.csv") {
    const state = await readState();
    sendCsv(response, state);
    return;
  }

  throw new HttpError(404, "API route not found");
}

function addParticipants(state, rawNames, source) {
  const names = rawNames.map(sanitizeName).filter(Boolean);
  if (names.length === 0) {
    throw new HttpError(400, "请输入姓名");
  }

  const existing = new Set(state.participants.map((participant) => participant.name.toLocaleLowerCase()));
  const sourceName = ["scan", "manual", "import"].includes(source) ? source : "scan";
  const createdAt = new Date().toISOString();
  const newParticipants = names.reduce((items, name) => {
    const key = name.toLocaleLowerCase();
    if (existing.has(key)) return items;
    existing.add(key);
    return [
      ...items,
      {
        id: crypto.randomUUID(),
        name,
        source: sourceName,
        createdAt
      }
    ];
  }, []);

  if (newParticipants.length === 0) {
    throw new HttpError(409, "姓名已登记");
  }

  if (state.participants.length + newParticipants.length > MAX_PARTICIPANTS) {
    throw new HttpError(400, `参与人员最多 ${MAX_PARTICIPANTS} 人`);
  }

  return {
    ...state,
    participants: [...state.participants, ...newParticipants],
    updatedAt: createdAt
  };
}

function drawAward(state, awardKey) {
  const award = AWARDS[awardKey];
  if (!award) {
    throw new HttpError(400, "奖项不存在");
  }

  if ((state.winners[awardKey] || []).length > 0) {
    throw new HttpError(409, `${award.label} 已抽出`);
  }

  const winnerIds = new Set(Object.values(state.winners).flat().map((winner) => winner.id));
  const eligible = state.participants.filter((participant) => !winnerIds.has(participant.id));

  if (eligible.length < award.count) {
    throw new HttpError(400, `${award.label} 至少还需要 ${award.count} 位未中奖参与者`);
  }

  return {
    ...state,
    winners: {
      ...state.winners,
      [awardKey]: takeRandom(eligible, award.count)
    },
    updatedAt: new Date().toISOString()
  };
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

async function updateState(updater) {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const current = await readState();
    const next = updater(current);
    await saveState(next);
    return next;
  });
  return writeQueue;
}

async function readState() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      winners: {
        ...DEFAULT_STATE.winners,
        ...(parsed.winners || {})
      }
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return DEFAULT_STATE;
    }
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${DATA_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempPath, DATA_PATH);
}

async function readJsonBody(request) {
  const raw = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "提交内容过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new HttpError(400, "JSON 格式错误");
  }
}

async function serveStatic(response, url) {
  let pathname = url.pathname;
  if (pathname === "/" || pathname === "/join") pathname = "/index.html";

  const safePart = path.normalize(decodeURIComponent(pathname).replace(/^\/+/, ""));
  if (safePart.startsWith("..")) {
    throw new HttpError(403, "Forbidden");
  }

  const filePath = path.join(ROOT_DIR, safePart);
  if (!filePath.startsWith(ROOT_DIR)) {
    throw new HttpError(403, "Forbidden");
  }

  const content = await fs.readFile(filePath);
  response.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": "no-store"
  });
  response.end(content);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendCsv(response, state) {
  const rows = [
    ["序号", "姓名", "来源", "登记时间"],
    ...state.participants.map((participant, index) => [
      String(index + 1),
      participant.name,
      participant.source,
      participant.createdAt
    ])
  ];
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": "attachment; filename=\"wpp-media-delivery-618-participants.csv\""
  });
  response.end(`\ufeff${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}`);
}

function sanitizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function escapeCsv(value) {
  const text = String(value || "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function withTimestamp(state) {
  return {
    ...state,
    updatedAt: new Date().toISOString()
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  };
  return types[ext] || "application/octet-stream";
}

function getLocalUrls(port) {
  const urls = [`http://127.0.0.1:${port}`];
  const networks = os.networkInterfaces();
  Object.values(networks).flat().filter(Boolean).forEach((network) => {
    if (network.family === "IPv4" && !network.internal) {
      urls.push(`http://${network.address}:${port}`);
    }
  });
  return urls;
}
