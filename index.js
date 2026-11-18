// Телеграм-бот для Cloudflare Workers: ищет свободные короткие никнеймы.
// Нужен секрет BOT_TOKEN (Settings -> Variables and Secrets).

const ALPHABETS = {
  letters: "abcdefghijklmnopqrstuvwxyz",
  digits: "0123456789",
  mixed: "abcdefghijklmnopqrstuvwxyz0123456789",
};
const LETTERS = ALPHABETS.letters;
const DEFAULT_LEN = 4;
const MAX_RESULTS = 20;
const MAX_ATTEMPTS = 35; // лимит бесплатного плана: 50 запросов на одно сообщение
const CONCURRENCY = 7;

const HELP =
  "Привет! Я ищу свободные короткие никнеймы.\n\n" +
  "/find - 5 свободных 4-символьных\n" +
  "/find 10 letters 4 - количество, тип (letters/digits/mixed), длина\n" +
  "/check name - проверить конкретный ник\n\n" +
  "Важно: обычные ники в Telegram - от 5 символов. 4-символьные " +
  "нельзя просто занять в настройках, они продаются на Fragment.";

async function secretFor(env) {
  const data = new TextEncoder().encode("wh:" + env.BOT_TOKEN);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// true - свободен, false - занят, null - не удалось проверить
async function isFree(name) {
  try {
    const r = await fetch(`https://t.me/${name}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.status !== 200) return null;
    const html = await r.text();
    const taken =
      html.includes("tgme_page_extra") || html.includes("tgme_page_description");
    return !taken;
  } catch {
    return null;
  }
}

function randomName(alphabet, length) {
  let s = LETTERS[Math.floor(Math.random() * LETTERS.length)]; // не с цифры
  for (let i = 1; i < length; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

async function handleFind(env, chatId, args) {
  let count = 5, mode = "mixed", length = DEFAULT_LEN, countSet = false;
  for (const a of args) {
    if (/^\d+$/.test(a)) {
      const n = parseInt(a, 10);
      if (!countSet && n <= MAX_RESULTS) { count = n; countSet = true; }
      else length = Math.max(2, Math.min(n, 32));
    } else if (ALPHABETS[a]) mode = a;
  }
  count = Math.max(1, Math.min(count, MAX_RESULTS));

  const sent = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `Ищу ${count} свободных (${length} симв., ${mode})...`,
  });
  const messageId = sent.result && sent.result.message_id;

  const alphabet = ALPHABETS[mode];
  const tried = new Set();
  const found = [];
  let attempts = 0;

  while (found.length < count && attempts < MAX_ATTEMPTS) {
    const batch = [];
    while (batch.length < CONCURRENCY && attempts + batch.length < MAX_ATTEMPTS) {
      const n = randomName(alphabet, length);
      if (!tried.has(n)) { tried.add(n); batch.push(n); }
    }
    const results = await Promise.all(batch.map(isFree));
    attempts += batch.length;
    batch.forEach((n, i) => {
      if (results[i] && found.length < count) found.push(n);
    });
  }

  const text = found.length
    ? `Свободные (${attempts} проверок):\n\n` + found.map((n) => "@" + n).join("\n") +
      "\n\nНажми /find ещё раз, чтобы искать дальше."
    : `Ничего не нашёл за ${attempts} проверок. Попробуй ещё раз или другую длину/тип.`;

  await tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

async function handleUpdate(env, update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await tg(env, "sendMessage", { chat_id: chatId, text: HELP });
  } else if (cmd === "/check") {
    const name = (args[0] || "").replace(/^@/, "").toLowerCase();
    if (!name) {
      await tg(env, "sendMessage", { chat_id: chatId, text: "Напиши ник: /check name" });
      return;
    }
    const res = await isFree(name);
    const label = res === true ? "свободен ✅" : res === false ? "занят ❌" : "не удалось проверить";
    await tg(env, "sendMessage", { chat_id: chatId, text: `@${name} - ${label}` });
  } else if (cmd === "/find") {
    await handleFind(env, chatId, args);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Открой https://<твой-воркер>/setup один раз, чтобы подключить бота
    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN) return new Response("Нет секрета BOT_TOKEN", { status: 500 });
      const res = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: await secretFor(env),
        allowed_updates: ["message"],
      });
      return new Response(JSON.stringify(res, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await secretFor(env))) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handleUpdate(env, update));
      return new Response("ok");
    }

    return new Response("Бот работает ✅");
  },
};
