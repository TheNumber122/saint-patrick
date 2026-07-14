require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");

// ============================================
// CONFIG
// ============================================
const INSTANCE_ID = parseInt(process.env.INSTANCE_ID);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);
const BOT = "patrickstarsrobot";
const ADMIN = "Aliorythm";
const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const PORT = process.env.PORT || 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 4000 + Math.random() * 2000;

// Session-safety guard: /promo and /trigger now run independently, so the SAME
// session_string must never be connected by both paths at once (that triggers
// AUTH_KEY_DUPLICATED and loses the account). Any code path that connects a
// session claims its user_id here first and releases it in finally.
const activeSessions = new Set();

// In-flight counter for the promo rolling pool — surfaced in logs so we can
// confirm real concurrency in production.
let promoInFlight = 0;

// Race a promise against a timeout so a hung GramJS connect/op can never
// stall a whole batch (gramjs #691 — connect() can hang indefinitely).
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`TIMEOUT_${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// TIME DELAYS (minutes)
const CLICKER_MIN = 12;
const CLICKER_MAX = 20;
const CAP_LIMIT = 25;
const CAP_DELAY = () => 600 + Math.floor(Math.random() * 300); // 10–15h random
const DAILY_DELAY = () => 24 * 60 + Math.floor(Math.random() * 120); // 24–26h random (fn so each call differs)
const DAILY_LIMIT_DELAY = 10 * 60;
const SPONSOR_DELAY = 10 * 60;
const CHANNEL_LIMIT_DELAY = 10 * 60;
const NO_TASKS_DELAY = 30;
const LEAVE_DELAY_MIN = 24 * 60;
const LEAVE_DELAY_MAX = 48 * 60;
const PROMO_CONCURRENCY = 15;

const nextClickerTime = () =>
  new Date(
    Date.now() + (CLICKER_MIN + Math.random() * CLICKER_MAX) * 60000,
  ).toISOString();

// ============================================
// SUPABASE
// ============================================
async function getAccountsDue() {
  const now = new Date().toISOString();
  const { data, error } = await supabase.rpc("claim_due_accounts", {
    p_instance_id: INSTANCE_ID,
    p_now: now,
    p_clicker_delay_min: CLICKER_MIN,
    p_clicker_delay_max: CLICKER_MAX,
    p_daily_delay: DAILY_DELAY(),
  });
  if (error) {
    console.log(`[ERROR] claim_due_accounts: ${error.message} — falling back`);
    const { data: fb } = await supabase
      .from("accounts")
      .select("*")
      .eq("instance_id", INSTANCE_ID)
      .eq("is_active", true)
      .or(`next_clicker_time.lte.${now},next_daily_time.lte.${now}`);
    return fb || [];
  }
  return data || [];
}

async function updateAccount(userId, updates) {
  await supabase.from("accounts").update(updates).eq("user_id", userId);
}

async function incrementError(userId, errMsg) {
  const { data, error } = await supabase.rpc("increment_error", {
    p_user_id: userId,
    p_error: errMsg,
  });
  if (error) {
    console.log(`[ERROR] increment_error RPC failed: ${error.message}`);
    return;
  }
  const count = data ?? 1;
  if (count >= 3) {
    console.log(`❌ Account ${userId} disabled after 3 errors`);
  } else {
    console.log(`⚠️ Account ${userId} error ${count}/3`);
  }
}

async function notify(client, title, details) {
  try {
    await client.sendMessage(ADMIN, {
      message: `${title}\n\n${details}\n\nTime: ${new Date().toLocaleString()}`,
    });
    console.log(`📨 Notified @${ADMIN}`);
  } catch (e) {
    console.log(`Notification failed: ${e.message}`);
  }
}

async function extractProfileData(profileText) {
  try {
    const starsMatch = profileText.match(/💰\s*Баланс:\s*([\d.]+)\s*⭐/);
    const referralsMatch = profileText.match(/✅\s*Активировали бота:\s*(\d+)/);
    return {
      stars: starsMatch ? parseFloat(starsMatch[1]) : null,
      referrals: referralsMatch ? parseInt(referralsMatch[1]) : 0,
    };
  } catch (_) {
    return { stars: null, referrals: 0 };
  }
}

async function storeBalance(userId, phone, stars, referrals) {
  try {
    await supabase.from("balances").insert({
      user_id: userId,
      phone,
      instance_id: INSTANCE_ID,
      stars,
      referrals,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    console.log(`[DAILY] Balance insert failed: ${e.message}`);
  }
}

// ============================================
// HELPERS
// ============================================

// Safe callback click — catches MESSAGE_ID_INVALID so it never leaks
async function getCallbackAnswer(client, msg, data) {
  try {
    const r = await client.invoke(
      new Api.messages.GetBotCallbackAnswer({
        peer: BOT,
        msgId: msg.id,
        data,
      }),
    );
    return r.message || null;
  } catch (e) {
    if (e.message?.includes("MESSAGE_ID_INVALID")) return "MESSAGE_EXPIRED";
    return null;
  }
}

function findButton(msg, textPart) {
  if (!msg?.replyMarkup?.rows) return null;
  for (const row of msg.replyMarkup.rows)
    for (const btn of row.buttons) if (btn.text?.includes(textPart)) return btn;
  return null;
}

// Join a channel — centralised so CHANNELS_TOO_MUCH always surfaces correctly
async function joinChannel(client, identifier, tag) {
  try {
    if (identifier.startsWith("+")) {
      await client.invoke(
        new Api.messages.ImportChatInvite({ hash: identifier.substring(1) }),
      );
    } else {
      await client.invoke(
        new Api.channels.JoinChannel({ channel: identifier }),
      );
    }
    console.log(`[${tag}] Joined ✅`);
    return "joined";
  } catch (e) {
    const eu = (e.message || "").toUpperCase();
    if (eu.includes("CHANNELS_TOO_MUCH") || eu.includes("TOO MANY CHANNELS"))
      throw new Error("CHANNELS_TOO_MUCH");
    if (
      e.message?.includes("USER_ALREADY_PARTICIPANT") ||
      e.message?.includes("INVITE_REQUEST_SENT")
    ) {
      console.log(`[${tag}] Already a member`);
      return "already";
    }
    console.log(`[${tag}] Join failed (skipping): ${e.message}`);
    return "failed";
  }
}

// Decode tracker/redirect URLs
function resolveUrl(url) {
  try {
    const p = new URL(url);
    const real =
      p.searchParams.get("redirect_url") ||
      p.searchParams.get("redirectUrl") ||
      p.searchParams.get("redirect") ||
      p.searchParams.get("url") ||
      p.searchParams.get("link");
    if (real) {
      const decoded = decodeURIComponent(real);
      console.log(`[URL] Redirect → ${decoded}`);
      return decoded;
    }
  } catch (_) {}
  return url;
}

// Telegram changed its link domain — links now arrive as t.me OR telegram.me.
// Every URL classifier (tasks + sponsor) must accept both.
const TG_BOT_START = /(?:t|telegram)\.me\/([^?/]+)\?start=(.+)/;
const TG_ANY_LINK  = /(?:t|telegram)\.me\/(.+)/;
const TG_USERNAME  = /(?:t|telegram)\.me\/([^/?]+)/;
const isTelegramUrl = (u) => /(?:t|telegram)\.me\//.test(u);

// Task verdict from a verify popup. "Задание не выполнено" CONTAINS
// "выполнено", so a plain .includes("выполнено") reads the FAIL popup as
// success — that bug burned whole clicker cycles. Check failure first.
function taskVerdict(popup) {
  if (!popup) return "none";
  if (popup.includes("не выполнено")) return "fail";
  if (popup.includes("выполнено") || popup.includes("получена")) return "success";
  return "other";
}

// ============================================
// CAPTCHA
// ============================================
async function solveCaptcha(client) {
  const msgs = await client.getMessages(BOT, { limit: 5 });
  const captcha = msgs.find((m) => m.text?.includes("ПРОВЕРКА НА РОБОТА"));
  if (!captcha) return false;
  console.log("[CAPTCHA] Detected!");

  // Math captcha
  const math = captcha.text.match(/(\d+)\s*([\+\-\*\/])\s*(\d+)/);
  if (math) {
    const answer = eval(`${math[1]}${math[2]}${math[3]}`);
    console.log(`[CAPTCHA] Math: ${math[1]} ${math[2]} ${math[3]} = ${answer}`);
    await sleep(3000 + Math.random() * 3000);
    for (const row of captcha.replyMarkup.rows)
      for (const btn of row.buttons)
        if (btn.text === answer.toString()) {
          await getCallbackAnswer(client, captcha, btn.data);
          console.log("[CAPTCHA] Solved ✅");
          await sleep(2000);
          return true;
        }
    return false;
  }

  // Fruit emoji captcha
  const fruits = {
    Киви: "🥝",
    Банан: "🍌",
    Арбуз: "🍉",
    Апельсин: "🍊",
    Клубника: "🍓",
    Виноград: "🍇",
    Яблоко: "🍎",
    Вишня: "🍒",
    Кокос: "🥥",
    Помидор: "🍅",
  };
  for (const [name, emoji] of Object.entries(fruits)) {
    if (captcha.text.includes(name)) {
      console.log(`[CAPTCHA] Fruit: ${name} = ${emoji}`);
      await sleep(3000 + Math.random() * 3000);
      for (const row of captcha.replyMarkup.rows)
        for (const btn of row.buttons)
          if (btn.text === emoji) {
            await getCallbackAnswer(client, captcha, btn.data);
            console.log("[CAPTCHA] Solved ✅");
            await sleep(2000);
            return true;
          }
    }
  }
  return false;
}

async function withCaptcha(client, action) {
  await action();
  await sleep(1500);
  await solveCaptcha(client);
}

// ============================================
// MENU
// ============================================
async function ensureMenu(client, { skipSponsor = false } = {}) {
  let msgs = await client.getMessages(BOT, { limit: 5 });
  let menu = msgs.find(
    (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
  );

  if (!menu) {
    await withCaptcha(client, async () => {
      await client.sendMessage(BOT, { message: "/start" });
      await sleep(4000);
    });
    msgs = await client.getMessages(BOT, { limit: 5 });
    menu = msgs.find(
      (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
    );
  }

  // Check for blocking sponsor screens
  const sponsorMsg = msgs.find(
    (m) =>
      (m.text?.includes("Чтобы активировать бота:") ||
        m.text?.includes("Для продолжения фарма звёзд")) &&
      m.replyMarkup,
  );
  if (sponsorMsg) {
    // Promo path: a sponsor screen means this account can't claim NOW.
    // Resolving one costs 40–120s of a pool seat while the code is dying —
    // skip the account instead (recorded as gated), same as task-gated promos.
    if (skipSponsor) throw new Error("SPONSOR_GATED");
    console.log(`[SPONSOR] Blocking screen — resolving...`);
    const resolved = await handleSponsor(client, sponsorMsg);
    if (!resolved) throw new Error("SPONSOR_UNRESOLVABLE");
    await sleep(5000);
    msgs = await client.getMessages(BOT, { limit: 5 });
    menu = msgs.find(
      (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
    );
    if (!menu) {
      await withCaptcha(client, async () => {
        await client.sendMessage(BOT, { message: "/start" });
        await sleep(4000);
      });
      msgs = await client.getMessages(BOT, { limit: 5 });
      menu = msgs.find(
        (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
      );
    }
  }

  if (!menu) throw new Error("MENU_NOT_FOUND");
  return menu;
}

// ============================================
// SPONSOR HANDLER
// ============================================
async function handleSponsor(client, sponsorMsg) {
  console.log("[SPONSOR] Processing...");

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[SPONSOR] Attempt ${attempt}/3`);

    const msgs = await client.getMessages(BOT, { limit: 5 });
    const freshMsg =
      msgs.find(
        (m) =>
          (m.text?.includes("Чтобы активировать бота:") ||
            m.text?.includes("Для продолжения фарма звёзд")) &&
          m.replyMarkup,
      ) || sponsorMsg;

    if (!freshMsg?.replyMarkup?.rows) {
      console.log("[SPONSOR] No buttons");
      return false;
    }

    const actionBtns = [];
    let verifyBtn = null;
    for (const row of freshMsg.replyMarkup.rows)
      for (const btn of row.buttons) {
        const t = btn.text || "";
        if (t.includes("Я выполнил") || t.includes("Проверить"))
          verifyBtn = btn;
        else if (btn.url) actionBtns.push(btn);
      }

    console.log(
      `[SPONSOR] ${actionBtns.length} action(s), verify: ${!!verifyBtn}`,
    );

    for (const btn of actionBtns) {
      const url = resolveUrl(btn.url || "");
      const text = btn.text || "";
      console.log(`[SPONSOR] "${text}" → ${url}`);
      await sleep(2000 + Math.random() * 2000);

      try {
        const botMatch = url.match(TG_BOT_START);
        const channelMatch = !botMatch && url.match(TG_ANY_LINK);

        if (botMatch) {
          console.log(`[SPONSOR] Starting bot @${botMatch[1]}`);
          await withCaptcha(client, async () => {
            await client.sendMessage(botMatch[1], {
              message: `/start ${botMatch[2]}`,
            });
          });
          await sleep(3000 + Math.random() * 2000);
        } else if (channelMatch) {
          const id = channelMatch[1].split("?")[0];
          await withCaptcha(client, async () => {
            await joinChannel(client, id, "SPONSOR");
          });
        } else if (url.includes("startapp")) {
          if (url.includes("patrickgamesbot")) {
            await withCaptcha(client, async () => {
              await joinChannel(client, "patrickgames_news", "SPONSOR");
            });
          } else {
            const bot = url.match(TG_USERNAME)?.[1];
            if (bot) {
              console.log(`[SPONSOR] Webapp /start @${bot}`);
              await withCaptcha(client, async () => {
                await client.sendMessage(bot, { message: "/start" });
              });
              await sleep(3000 + Math.random() * 2000);
            }
          }
        } else {
          console.log(`[SPONSOR] Unknown URL — simulating visit`);
          await sleep(4000 + Math.random() * 3000);
        }
      } catch (e) {
        if (e.message === "CHANNELS_TOO_MUCH") {
          await notify(
            client,
            "🚨 Sponsor: Channel Limit",
            `Instance: ${INSTANCE_ID}\nURL: ${url}`,
          );
        } else {
          console.log(`[SPONSOR] Button error (skipping): ${e.message}`);
        }
      }
      await sleep(1500 + Math.random() * 1500);
    }

    if (!verifyBtn) {
      console.log("[SPONSOR] No verify button");
      return false;
    }

    console.log("[SPONSOR] Clicking verify...");
    await sleep(2000 + Math.random() * 1000);
    const verifyPopup = await getCallbackAnswer(
      client,
      freshMsg,
      verifyBtn.data,
    );
    console.log(`[SPONSOR] Verify: ${verifyPopup || "none"}`);

    if (verifyPopup?.includes("Подпишись на все каналы")) {
      console.log(`[SPONSOR] Not all done — RequestAppWebView fallback`);
      for (const btn of actionBtns) {
        const burl = resolveUrl(btn.url || "");
        if (!burl.includes("startapp") || burl.includes("patrickgamesbot"))
          continue;
        const bot = burl.match(TG_USERNAME)?.[1];
        if (!bot) continue;
        try {
          const peer = await client.getEntity(bot);
          await client.invoke(
            new Api.messages.RequestAppWebView({
              peer,
              platform: "android",
              startParam: "",
              writeAllowed: true,
              app: new Api.InputBotAppShortName({
                botId: peer,
                shortName: "app",
              }),
            }),
          );
          console.log(`[SPONSOR] RequestAppWebView done @${bot}`);
        } catch (e) {
          console.log(
            `[SPONSOR] RequestAppWebView failed @${bot}: ${e.message}`,
          );
        }
        await sleep(2000);
      }
      await sleep(3000);
      continue;
    }

    console.log("[SPONSOR] ✅ Verified");
    await sleep(5000 + Math.random() * 3000);
    return true;
  }

  console.log("[SPONSOR] ❌ Failed after 3 attempts");
  return false;
}

// ============================================
// LEAVE CHANNELS
// ============================================
async function leaveChannels(client, userId) {
  console.log("[LEAVE] Starting cleanup...");
  let dialogs;
  try {
    dialogs = await client.getDialogs({ limit: 500 });
  } catch (e) {
    console.log(`[LEAVE] getDialogs failed: ${e.message}`);
    return 0;
  }

  // Fetch telegap-protected channel ids. Fail-closed: if we can't verify the
  // protected list, leave nothing so we never lose a telegap channel.
  let protectedIds = new Set();
  try {
    const { data, error } = await supabase
      .from("protected_channels")
      .select("channel_id");
    if (error) throw error;
    protectedIds = new Set((data || []).map((r) => String(r.channel_id)));
    console.log(`[LEAVE] ${protectedIds.size} protected channel(s) loaded`);
  } catch (e) {
    console.log(`[LEAVE] protected fetch failed: ${e.message}`);
    return 0; // fail-closed: don't leave anything if we can't verify
  }

  const channels = dialogs.filter(
    (d) =>
      d.entity?.className === "Channel" &&
      d.entity?.broadcast === true &&
      d.entity?.megagroup !== true &&
      d.entity?.username !== "Aliorithm" &&
      !protectedIds.has(String(d.entity.id)),
  );
  console.log(`[LEAVE] ${channels.length} broadcast channel(s)`);

  let left = 0;
  for (const d of channels) {
    try {
      await client.invoke(new Api.channels.LeaveChannel({ channel: d.entity }));
      console.log(
        `[LEAVE] Left: ${d.entity.title} (${++left}/${channels.length})`,
      );
    } catch (e) {
      console.log(`[LEAVE] Failed ${d.entity.title}: ${e.message}`);
    }
    await sleep(800 + Math.random() * 700);
  }

  const nextMin =
    LEAVE_DELAY_MIN +
    Math.floor(Math.random() * (LEAVE_DELAY_MAX - LEAVE_DELAY_MIN));
  await updateAccount(userId, {
    next_leave_time: new Date(Date.now() + nextMin * 60000).toISOString(),
  });
  console.log(
    `[LEAVE] ✅ Left ${left}/${channels.length} — next in ${Math.round(nextMin / 60)}h`,
  );
  return left;
}

// ============================================
// TASKS
// ============================================
async function handleTasks(client, userId) {
  console.log("[TASK] Starting...");

  // The task-gate popup comes WITH an unprompted sponsor-style task message
  // already pushed into the chat (no Пропустить button, usually a website
  // link). Never process that pushed task: send a fresh /start to get the
  // menu back, then enter tasks through 📝 Задания — tasks served that way
  // have a skip button. (/start before doing any task is safe; the "no /start
  // after completing tasks" rule protects the bot's task counter, which is
  // only relevant AFTER a completion.)
  await withCaptcha(client, async () => {
    await client.sendMessage(BOT, { message: "/start" });
    await sleep(4000);
  });

  const freshMsgs = await client.getMessages(BOT, { limit: 5 });
  let freshMenu = freshMsgs.find(
    (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
  );
  if (!freshMenu) {
    // Menu didn't render (sponsor screen, slow bot) — ensureMenu resolves it
    freshMenu = await ensureMenu(client);
  }

  await withCaptcha(client, async () => {
    await sleep(jitter());
    const btn = findButton(freshMenu, "Задания");
    if (btn?.data) {
      await getCallbackAnswer(client, freshMenu, btn.data);
    } else {
      try {
        await freshMenu.click({ text: "📝 Задания" });
      } catch (_) {}
    }
    await sleep(jitter());
  });

  let msgs = await client.getMessages(BOT, { limit: 3 });
  if (msgs.find((m) => m.text?.includes("выполнил все задания"))) {
    console.log("[TASK] No tasks available");
    return "NO_TASKS_AVAILABLE";
  }

  let completed = 0;

  for (let i = 0; i < 5; i++) {
    console.log(`[TASK] Attempt ${i + 1}/5`);
    msgs = await client.getMessages(BOT, { limit: 3 });
    const taskMsg = msgs.find(
      (m) => m.text?.includes("Новое задание") && m.replyMarkup,
    );
    if (!taskMsg) {
      console.log("[TASK] No more tasks");
      break;
    }

    const buttons = {};
    for (const row of taskMsg.replyMarkup.rows)
      for (const btn of row.buttons) {
        if (btn.url) buttons.action = btn;
        if (btn.text?.includes("Подтвердить")) buttons.verify = btn;
        if (btn.text?.includes("Пропустить")) buttons.skip = btn;
        if (btn.text?.includes("главное меню") || btn.text?.includes("Главное меню")) buttons.mainMenu = btn;
      }

    if (!buttons.action?.url) {
      console.log("[TASK] No action button");
      break;
    }

    const url = resolveUrl(buttons.action.url);
    console.log(`[TASK] ${buttons.action.text} → ${url}`);

    // Website links (anything not t.me/telegram.me) can't be completed by a
    // Telegram client — skip immediately, no fake "visit". Same for linknibot:
    // a webapp that only advertises other bots, starting it is wasted time.
    if (!isTelegramUrl(url) || url.toLowerCase().includes("linknibot")) {
      console.log(`[TASK] ${!isTelegramUrl(url) ? "Website link" : "linknibot"} — skipping task`);
      if (buttons.skip) {
        await withCaptcha(client, async () => {
          await sleep(1500);
          await getCallbackAnswer(client, taskMsg, buttons.skip.data);
          await sleep(2000);
        });
      } else if (buttons.mainMenu) {
        console.log("[TASK] Unskippable — going to main menu");
        await getCallbackAnswer(client, taskMsg, buttons.mainMenu.data);
        await sleep(2000);
        break;
      }
      continue;
    }

    let entity = null;

    if (url.includes("?start=") && !url.includes("startapp")) {
      const m = url.match(/(?:t|telegram)\.me\/([^?/]+)\?start=(.+)/);
      if (m) {
        console.log(`[TASK] Bot: @${m[1]}`);
        await withCaptcha(client, async () => {
          await sleep(2000);
          await client.sendMessage(m[1], { message: `/start ${m[2]}` });
        });
        entity = { type: "bot" };
      }
    } else if (url.includes("startapp")) {
      if (url.includes("patrickgamesbot")) {
        console.log("[TASK] Patrick webapp");
        await withCaptcha(client, async () => {
          const r = await joinChannel(client, "patrickgames_news", "TASK");
          if (r !== "failed") entity = { type: "channel" };
        });
      } else if (url.includes("MyChimpBot")) {
        console.log("[TASK] MyChimp — joining channel");
        await withCaptcha(client, async () => {
          const r = await joinChannel(client, "mychimp", "TASK");
          if (r !== "failed") entity = { type: "channel" };
        });
      } else {
        const bot = url.match(/(?:t|telegram)\.me\/([^/?]+)/)?.[1];
        if (bot) {
          console.log(`[TASK] Webapp /start @${bot}`);
          try {
            await withCaptcha(client, async () => {
              await client.sendMessage(bot, { message: "/start" });
            });
            // Generous settle time — starting the bot (not the webapp) needs
            // to register on the task-checker's side before we hit verify.
            await sleep(8000 + Math.random() * 4000);
            entity = { type: "webapp", bot, url };
          } catch (e) {
            console.log(`[TASK] Start @${bot} failed: ${e.message}`);
          }
        }
      }
    } else {
      const m = url.match(/(?:t|telegram)\.me\/(.+)/);
      if (m) {
        const id = m[1].split("?")[0];
        console.log(`[TASK] Channel: ${id}`);
        await withCaptcha(client, async () => {
          const r = await joinChannel(client, id, "TASK");
          if (r !== "failed") entity = { type: "channel" };
        });
      } else {
        console.log(`[TASK] Unknown URL — simulating visit`);
        await sleep(4000 + Math.random() * 3000);
        entity = { type: "unknown" };
      }
    }

    if (!buttons.verify) {
      if (buttons.skip) {
        await withCaptcha(client, async () => {
          await sleep(1500);
          await getCallbackAnswer(client, taskMsg, buttons.skip.data);
          await sleep(2000);
        });
      } else {
        // No verify and no skip — navigate back to menu cleanly and stop
        console.log("[TASK] No verify button and no skip — going to main menu");
        if (buttons.mainMenu) {
          await getCallbackAnswer(client, taskMsg, buttons.mainMenu.data);
          await sleep(2000);
        }
        break;
      }
      continue;
    }

    console.log("[TASK] Verifying...");
    await sleep(2000);
    let popup = await getCallbackAnswer(client, taskMsg, buttons.verify.data);

    if (popup === "MESSAGE_EXPIRED") {
      msgs = await client.getMessages(BOT, { limit: 3 });
      const ok = msgs.find((m) => taskVerdict(m.text) === "success");
      if (ok || entity) {
        console.log("[TASK] ✅ Success");
        completed++;
        break;
      }
      popup = null;
    }

    console.log(`[TASK] Popup: ${popup || "none"}`);

    if (taskVerdict(popup) === "success") {
      console.log("[TASK] ✅ Success");
      completed++;
      break;
    }

    // Explicit fail popup ("Задание не выполнено... пропусти") — for a webapp
    // task this means it truly requires opening the web application, which we
    // deliberately never do. Skip, exactly as the popup itself suggests.
    if (taskVerdict(popup) === "fail") {
      console.log("[TASK] ❌ Bot says not done — skipping task");
      if (buttons.skip) {
        await withCaptcha(client, async () => {
          await sleep(1500);
          await getCallbackAnswer(client, taskMsg, buttons.skip.data);
          await sleep(2000);
        });
        continue;
      }
      if (buttons.mainMenu) {
        await getCallbackAnswer(client, taskMsg, buttons.mainMenu.data);
        await sleep(2000);
      }
      break;
    }

    if (popup?.includes("не найдена") && entity?.type === "webapp") {
      // Bot explicitly rejected — try RequestAppWebView fallback
      try {
        const peer = await client.getEntity(entity.bot);
        await client.invoke(
          new Api.messages.RequestAppWebView({
            peer,
            platform: "android",
            startParam: "",
            writeAllowed: true,
            app: new Api.InputBotAppShortName({
              botId: peer,
              shortName: "app",
            }),
          }),
        );
        await sleep(3000 + Math.random() * 2000);
        const popup2 = await getCallbackAnswer(
          client,
          taskMsg,
          buttons.verify.data,
        );
        console.log(`[TASK] Re-verify: ${popup2 || "none"}`);
        if (taskVerdict(popup2) === "success") {
          console.log("[TASK] ✅ Success after fallback");
          completed++;
          break;
        }
      } catch (e) {
        console.log(`[TASK] Fallback failed: ${e.message}`);
      }
      // Bot rejected AND fallback failed — skip this task, don't assume success
      console.log("[TASK] ⏭️ Bot rejected — skipping");
      if (buttons.skip) {
        await withCaptcha(client, async () => {
          await sleep(1500);
          await getCallbackAnswer(client, taskMsg, buttons.skip.data);
          await sleep(2000);
        });
      } else {
        // No skip available — go back to menu to avoid getting stuck
        console.log("[TASK] No skip after rejection — going to main menu");
        if (buttons.mainMenu) {
          await getCallbackAnswer(client, taskMsg, buttons.mainMenu.data);
          await sleep(2000);
        }
        break;
      }
      continue;
    }

    // Only assume success for truly ambiguous cases: we joined/started but got no clear popup
    if (entity && !popup?.includes("не найдена")) {
      console.log("[TASK] ✅ Assuming success (joined/started, no rejection)");
      completed++;
      break;
    }

    if (buttons.skip) {
      await withCaptcha(client, async () => {
        await sleep(1500);
        await getCallbackAnswer(client, taskMsg, buttons.skip.data);
        await sleep(2000);
      });
    } else {
      // No skip button (e.g. mandatory single-task gate) — navigate back to menu
      // so the bot state is clean, then break. Next cycle will retry normally.
      console.log("[TASK] No skip — clicking back to menu");
      if (buttons.mainMenu) {
        await getCallbackAnswer(client, taskMsg, buttons.mainMenu.data);
        await sleep(2000);
      }
      break;
    }
  }

  console.log(`[TASK] Completed ${completed} task(s)`);
  return completed > 0;
}

// ============================================
// CLICKER
// ============================================
async function doClicker(client, userId) {
  console.log("[CLICKER] Starting...");
  const menu = await ensureMenu(client);

  // Re-fetch fresh right before clicking — avoids stale message ID = MESSAGE_ID_INVALID
  await sleep(1000);
  const freshMsgs = await client.getMessages(BOT, { limit: 5 });
  const freshMenu =
    freshMsgs.find(
      (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
    ) || menu;

  let popup = null;
  let captchaSolvedDuringClick = false;

  await withCaptcha(client, async () => {
    await sleep(jitter());
    const btn = findButton(freshMenu, "Кликер");
    if (btn?.data) {
      popup = await getCallbackAnswer(client, freshMenu, btn.data);
      console.log(`[CLICKER] Popup: ${popup || "none"}`);
    } else {
      try {
        await freshMenu.click({ text: "✨ Кликер" });
      } catch (_) {}
    }
  });

  // If popup was null and no captcha left in chat → captcha was shown and solved by withCaptcha
  const afterMsgs = await client.getMessages(BOT, { limit: 3 });
  if (
    popup === null &&
    !afterMsgs.find((m) => m.text?.includes("ПРОВЕРКА НА РОБОТА"))
  ) {
    captchaSolvedDuringClick = true;
  }

  // Daily click limit
  if (popup?.includes("завтра") || popup?.includes("слишком много")) {
    console.log("[CLICKER] ⚠️ Daily limit");
    await updateAccount(userId, {
      next_clicker_time: new Date(
        Date.now() +
          (DAILY_LIMIT_DELAY + CLICKER_MIN + Math.random() * CLICKER_MAX) *
            60000,
      ).toISOString(),
      last_error: "Daily limit",
      cap: 0,
    });
    return false;
  }

  // Task gate — handles both "выполни хотя бы" (old) and "выполни всего" (new single-task popup)
  if (popup?.includes("выполни хотя бы") || popup?.includes("выполни всего")) {
    console.log("[CLICKER] Task required!");
    const result = await handleTasks(client, userId);
    if (result === "NO_TASKS_AVAILABLE") {
      await updateAccount(userId, {
        next_clicker_time: new Date(
          Date.now() + NO_TASKS_DELAY * 60000,
        ).toISOString(),
        last_error: "No tasks available",
      });
      return false;
    }
    if (result !== true) {
      console.log("[CLICKER] Tasks failed");
      return false;
    }

    // Tasks done — re-click WITHOUT sending /start first
    // Sending /start resets the bot task counter, causing it to gate us again
    console.log(
      "[CLICKER] Tasks done — clicking again (no /start to preserve task state)...",
    );
    // Just re-fetch current messages — menu should already be visible after task flow
    await sleep(2000);
    await solveCaptcha(client);
    const fresh2Msgs = await client.getMessages(BOT, { limit: 5 });
    let fresh2Menu = fresh2Msgs.find(
      (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
    );
    if (!fresh2Menu) {
      // Menu not visible — navigate back minimally without /start
      const backMsgs = await client.getMessages(BOT, { limit: 5 });
      const anyMenuMsg = backMsgs.find((m) => m.replyMarkup);
      if (anyMenuMsg) {
        const backBtn =
          findButton(anyMenuMsg, "Назад") ||
          findButton(anyMenuMsg, "Меню") ||
          findButton(anyMenuMsg, "Главная");
        if (backBtn?.data) {
          await getCallbackAnswer(client, anyMenuMsg, backBtn.data);
          await sleep(2000);
        }
      }
      const reMsgs = await client.getMessages(BOT, { limit: 5 });
      fresh2Menu = reMsgs.find(
        (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
      );
    }
    // If still no menu, fall back to /start as last resort
    if (!fresh2Menu) {
      console.log("[CLICKER] Menu not found without /start — falling back");
      await client.sendMessage(BOT, { message: "/start" });
      await sleep(4000);
      await solveCaptcha(client);
      const fallbackMsgs = await client.getMessages(BOT, { limit: 5 });
      fresh2Menu = fallbackMsgs.find(
        (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
      );
    }
    if (!fresh2Menu) throw new Error("MENU_NOT_FOUND");

    await withCaptcha(client, async () => {
      await sleep(jitter());
      const btn2 = findButton(fresh2Menu, "Кликер");
      if (btn2?.data) {
        popup = await getCallbackAnswer(client, fresh2Menu, btn2.data);
        console.log(`[CLICKER] Popup after tasks: ${popup || "none"}`);
      } else {
        try {
          await fresh2Menu.click({ text: "✨ Кликер" });
        } catch (_) {}
      }
    });
  }

  // Sponsor mid-click
  if (popup?.includes("Подпишись на все каналы")) {
    console.log("[CLICKER] Sponsor mid-click — resolving...");
    const sMsgs = await client.getMessages(BOT, { limit: 5 });
    const sMsg = sMsgs.find(
      (m) =>
        (m.text?.includes("Чтобы активировать бота:") ||
          m.text?.includes("Для продолжения фарма звёзд")) &&
        m.replyMarkup,
    );
    if (sMsg) {
      const ok = await handleSponsor(client, sMsg);
      if (!ok) throw new Error("SPONSOR_UNRESOLVABLE");
      await updateAccount(userId, {
        next_clicker_time: nextClickerTime(),
        last_error: "Sponsor cleared — retrying next cycle",
      });
      return false;
    }
    throw new Error("SPONSOR_UNRESOLVABLE");
  }

  // Final captcha check (bot sometimes delays it)
  await sleep(jitter());
  const captchaSolved = await solveCaptcha(client);

  if (captchaSolved || captchaSolvedDuringClick) {
    console.log("[CLICKER] ✅ Captcha click succeeded");
  } else {
    if (!popup?.includes("получил")) {
      console.log(`[CLICKER] ❌ No reward — popup: ${popup}`);
      await updateAccount(userId, {
        next_clicker_time: nextClickerTime(),
        last_error: `Click failed: ${popup?.substring(0, 50)}`,
      });
      return false;
    }
    console.log("[CLICKER] ✅ Reward confirmed");
  }

  // Atomically increment clicks + cap — no read-modify-write race
  const capDelay = CAP_DELAY();
  const { data: newCap, error: clickErr } = await supabase.rpc("record_click", {
    p_user_id: userId,
    p_cap_limit: CAP_LIMIT,
    p_next_clicker_cap: new Date(Date.now() + capDelay * 60000).toISOString(),
    p_next_clicker_norm: nextClickerTime(),
  });
  if (clickErr) {
    console.log(`[ERROR] record_click RPC failed: ${clickErr.message}`);
    return false;
  }
  if (newCap === 0) {
    console.log(`[CLICKER] 🛑 Cap limit (${CAP_LIMIT}) — delay ${capDelay}min`);
  } else {
    console.log(`[CLICKER] ✅ Success (cap: ${newCap}/${CAP_LIMIT})`);
  }
  return true;
}

// ============================================
// DAILY
// ============================================
async function doDaily(client, userId) {
  console.log("[DAILY] Starting...");
  const menu = await ensureMenu(client);

  // Step 1: Navigate to Profile — use callback data, not text-click
  const profileBtn = findButton(menu, "Профиль");
  if (profileBtn?.data) {
    await getCallbackAnswer(client, menu, profileBtn.data);
  } else {
    try {
      await menu.click({ text: "👤 Профиль" });
    } catch (_) {}
  }

  // Wait for profile page to render + clear any captcha
  await sleep(3000);
  await solveCaptcha(client);
  await sleep(2000);

  // Step 2: Always fetch FRESH messages — stale ID = MESSAGE_ID_INVALID
  let msgs = await client.getMessages(BOT, { limit: 5 });
  let profile = msgs.find((m) => m.replyMarkup && m.text?.includes("Профиль"));
  if (!profile) {
    await sleep(4000);
    msgs = await client.getMessages(BOT, { limit: 5 });
    profile = msgs.find((m) => m.replyMarkup && m.text?.includes("Профиль"));
    if (!profile) throw new Error("PROFILE_NOT_FOUND");
  }
  console.log("[DAILY] Profile found, clicking Ежедневка...");

  // Extract stars + referrals from profile BEFORE claiming
  const profileData = await extractProfileData(profile.text || "");

  // Step 3: Click daily button on freshly fetched message
  const dailyBtn = findButton(profile, "Ежедневка");
  if (!dailyBtn?.data) throw new Error("DAILY_BTN_NOT_FOUND");

  await sleep(1500 + Math.random() * 1000);
  const popup = await getCallbackAnswer(client, profile, dailyBtn.data);
  console.log(`[DAILY] Popup: ${popup || "none"}`);

  // Step 4: Handle captcha response (bot may send it instead of inline popup)
  await sleep(2000);
  const captchaSolved = await solveCaptcha(client);

  if (captchaSolved) {
    console.log("[DAILY] Captcha solved — daily registered");
    // fall through to success
  } else if (popup === null || popup === "MESSAGE_EXPIRED") {
    console.log("[DAILY] ⚠️ No response — retrying in 5min");
    await updateAccount(userId, {
      next_daily_time: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    return false;
  } else if (popup?.includes("Сначала поставь свою личную ссылку")) {
    console.log("[DAILY] ⚠️ Profile link required");
    await notify(
      client,
      "⚠️ Daily: Profile Link Required",
      `Instance: ${INSTANCE_ID}\nUser: ${userId}`,
    );
    await updateAccount(userId, {
      next_daily_time: new Date(
        Date.now() + DAILY_DELAY() * 60000,
      ).toISOString(),
      last_error: "Profile link required",
    });
    return false;
  } else if (
    popup?.includes("уже получил") ||
    popup?.includes("приходи завтра")
  ) {
    console.log("[DAILY] Already claimed — rescheduling");
    await updateAccount(userId, {
      next_daily_time: new Date(
        Date.now() + DAILY_DELAY() * 60000,
      ).toISOString(),
    });
    return false;
  }

  // Atomically increment dailies in one SQL operation — no read-modify-write race
  const { error: dailyErr } = await supabase.rpc("record_daily", {
    p_user_id: userId,
    p_next_daily_time: new Date(
      Date.now() + DAILY_DELAY() * 60000,
    ).toISOString(),
  });
  if (dailyErr) {
    console.log(`[ERROR] record_daily RPC failed: ${dailyErr.message}`);
    return false;
  }
  console.log("[DAILY] ✅ Success");

  // Store balance after successful daily claim
  if (profileData?.stars !== null) {
    const acc = await supabase
      .from("accounts")
      .select("phone")
      .eq("user_id", userId)
      .single();
    const phone = acc.data?.phone || "unknown";
    await storeBalance(userId, phone, profileData.stars + 1, profileData.referrals);
  }

  return true;
}

// Detect a promo reply that demands channel-subscriptions / task-completion
// before it will activate. Per configuration these accounts are SKIPPED
// (recorded terminally, never retried) instead of doing the tasks — the
// limited promo activations are better spent on accounts that can claim
// immediately. This is checked AFTER success/already/exhausted, so only an
// otherwise-unrecognized "do this first" reply trips it.
function isPromoGated(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("подпишись") ||        // "subscribe to ..."
    t.includes("подписаться") ||      // "subscribe"
    t.includes("вступи в") ||         // "join the channel ..."
    t.includes("выполни задани") ||   // "complete the task(s)"
    t.includes("выполни хотя бы") ||  // "complete at least ..."
    t.includes("выполни всего")       // "complete in total ..."
  );
}

// ============================================
// WAIT FOR BOT REPLY — adaptive poll
// Returns as soon as a NEW inbound text (id beyond `sinceId`) arrives, up to
// `capMs`. A fixed sleep is simultaneously too short under a promo rush (bot
// lags → we falsely give up and mark the account "failed") and too slow when
// the bot is idle (we burn the full wait before looking). Polling fixes both.
// Per-account clients run with receiveUpdates:false, so update-based event
// handlers never fire on these connections — polling is the only option here.
// Anchoring on `sinceId` (the id of the message we just sent) prevents a fast
// poll from returning a stale pre-existing message.
// ============================================
async function waitForBotReply(client, sinceId, { capMs = 9000, stepMs = 350 } = {}) {
  const deadline = Date.now() + capMs;
  let msgs = [];
  while (Date.now() < deadline) {
    msgs = await client.getMessages(BOT, { limit: 5 });
    const reply = msgs.find(
      (m) => !m.out && m.text && (!sinceId || m.id > sinceId),
    );
    if (reply) return { reply, msgs };
    await sleep(stepMs);
  }
  return { reply: null, msgs };
}

// ============================================
// PROMO
// Mirrors doDaily steps 1-4 exactly, then clicks
// Промокод, sends the code as a text message,
// and reads the bot's reply.
// Returns: 'success' | 'already_used' | 'exhausted' | 'gated' | 'failed'
// ============================================
async function doPromo(client, userId, code) {
  console.log(`[PROMO] Starting — code: "${code}"`);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.log(`[PROMO] Retrying after menu response...`);
      await client.sendMessage(BOT, { message: "/start" });
      await sleep(2000);
    }

    const result = await _doPromoAttempt(client, userId, code);
    // Permanent skip statuses — no point retrying. "gated" = promo demanded
    // tasks/channel-subs, which we deliberately do NOT do (skip fast).
    if (["SPONSOR_UNRESOLVABLE", "MENU_NOT_FOUND", "PROFILE_NOT_FOUND", "PROMO_BTN_NOT_FOUND", "gated"].includes(result)) return result;
    if (result !== "MENU_RESPONSE" || attempt === 1) return result;
    console.log(`[PROMO] Got menu response — will retry`);
  }
  return "failed";
}

async function _doPromoAttempt(client, userId, code) {
  await sleep(1000);

  let menu;
  try {
    menu = await ensureMenu(client, { skipSponsor: true });
  } catch (e) {
    // Sponsor screen = account can't claim immediately → terminal "gated",
    // recorded so it's never retried for this code (same as task-gated).
    if (e.message === "SPONSOR_GATED") {
      console.log(`[PROMO] Sponsor screen — gated, skipping account`);
      return "gated";
    }
    if (["SPONSOR_UNRESOLVABLE", "MENU_NOT_FOUND"].includes(e.message)) {
      console.log(`[PROMO] ${e.message} — skipping account`);
      return e.message;
    }
    throw e;
  }

  // Step 1: Navigate to Profile
  const profileBtn = findButton(menu, "Профиль");
  if (profileBtn?.data) {
    await getCallbackAnswer(client, menu, profileBtn.data);
  } else {
    try { await menu.click({ text: "👤 Профиль" }); } catch (_) {}
  }

  await sleep(1500);
  await solveCaptcha(client);
  await sleep(800);

  // Step 2: Re-fetch fresh profile page — higher limit for reliability
  let msgs = await client.getMessages(BOT, { limit: 10 });
  let profile = msgs.find((m) => m.replyMarkup && m.text?.includes("Профиль"));
  if (!profile) {
    await sleep(2000);
    msgs = await client.getMessages(BOT, { limit: 10 });
    profile = msgs.find((m) => m.replyMarkup && m.text?.includes("Профиль"));
    if (!profile) {
      console.log(`[PROMO] PROFILE_NOT_FOUND — skipping account`);
      return "PROFILE_NOT_FOUND";
    }
  }

  // Step 3: Find and click Промокод button
  const promoBtn = findButton(profile, "Промокод");
  if (!promoBtn?.data) {
    console.log(`[PROMO] PROMO_BTN_NOT_FOUND — skipping account`);
    return "PROMO_BTN_NOT_FOUND";
  }

  await sleep(500 + Math.random() * 500);
  const btnPopup = await getCallbackAnswer(client, profile, promoBtn.data);
  console.log(`[PROMO] Btn popup: ${btnPopup || "none"}`);

  // Gate can appear right on the promo button (e.g. "subscribe first") —
  // skip fast before even sending the code.
  if (isPromoGated(btnPopup)) {
    console.log(`[PROMO] Gated at button (tasks/channels required) — skipping account`);
    return "gated";
  }

  // Captcha may appear after promo button click
  await sleep(1200);
  await solveCaptcha(client);

  // Step 4: Send the code
  await sleep(800 + Math.random() * 400);
  const sent = await client.sendMessage(BOT, { message: code });
  console.log(`[PROMO] Sent: "${code}"`);

  // Step 5: Wait for bot reply — adaptive poll, returns the instant a reply
  // newer than our sent message lands. Fast when the bot is idle, patient (up
  // to the cap) when a rush slows it so we don't falsely mark wins as "failed".
  let { reply: botMsg, msgs: resMsgs } = await waitForBotReply(client, sent?.id);

  // Handle captcha that appeared after code send
  const captchaHere = (resMsgs || []).find((m) => m.text?.includes("ПРОВЕРКА НА РОБОТА"));
  if (captchaHere) {
    console.log(`[PROMO] Captcha after code send — solving...`);
    await solveCaptcha(client);
    // Wait for the real result that lands after the captcha message (adaptive).
    ({ reply: botMsg, msgs: resMsgs } = await waitForBotReply(client, captchaHere.id));
    if (botMsg?.text?.includes("ПРОВЕРКА НА РОБОТА")) botMsg = null;
  }

  const text = botMsg?.text || "";
  console.log(`[PROMO] Response: ${text.substring(0, 120)}`);

  if (text.includes("успешно активирован")) return "success";
  if (text.includes("уже активировал"))    return "already_used";
  if (text.includes("недействителен") || text.includes("закончились использования"))
    return "exhausted";

  // Promo requires joining channels / completing tasks first. We skip these
  // (terminal) instead of doing the tasks, so the limited activations go to
  // accounts that can claim immediately.
  if (isPromoGated(text)) {
    console.log("[PROMO] Gated (tasks/channels required) — skipping account");
    return "gated";
  }

  // Bot responded with main menu — promo button didn't register
  if (text.includes("Получи свою личную ссылку")) return "MENU_RESPONSE";

  return "failed";
}

// ============================================
// PROCESS PENDING PROMOS
// Called from runTrigger(). For each active promo
// code in the DB, processes this instance's accounts
// 1-by-1 using the same per-account pattern as
// daily claiming (connect → doPromo → record → disconnect).
//
// Returns Set of user_ids that were processed, so
// runTrigger() can filter them out of the due list.
// ============================================
async function processPendingPromos() {
  const processed = new Set();

  // 1. Get all active promo codes
  const { data: promos, error: promoErr } = await supabase
    .from("promo_codes")
    .select("id, code, is_active")
    .eq("is_active", true);

  if (promoErr) {
    console.log(`[PROMO] Query error: ${promoErr.message}`);
    return processed;
  }
  if (!promos?.length) return processed;

  console.log(`[PROMO] ${promos.length} active code(s) to check`);

  for (const promo of promos) {
    // Re-check is_active — another instance may have exhausted it
    const { data: fresh } = await supabase
      .from("promo_codes")
      .select("is_active")
      .eq("id", promo.id)
      .single();

    if (!fresh?.is_active) {
      console.log(`[PROMO] "${promo.code}" exhausted — skipping`);
      continue;
    }

    // Get user_ids that already attempted this code
    const { data: attempted } = await supabase
      .from("promo_redemptions")
      .select("user_id")
      .eq("promo_code_id", promo.id);

    const attemptedIds = new Set((attempted || []).map((r) => r.user_id));

    // Get all active accounts for this instance
    const { data: accounts, error: accErr } = await supabase
      .from("accounts")
      .select("id, user_id, phone, session_string")
      .eq("instance_id", INSTANCE_ID)
      .eq("is_active", true);

    if (accErr || !accounts?.length) continue;

    const pending = accounts.filter((a) => !attemptedIds.has(a.user_id));
    if (!pending.length) {
      console.log(`[PROMO] "${promo.code}" — all accounts already attempted`);
      continue;
    }

    console.log(
      `\n${"=".repeat(40)}\n🎟️  Promo: "${promo.code}" — ${pending.length} account(s)\n${"=".repeat(40)}`,
    );

    let successCount = 0;
    let exhaustedFlag = false;

    // Terminal statuses are recorded permanently (UNIQUE blocks re-attempt).
    // "failed" is treated as TRANSIENT (flood wait, network, slow bot, captcha
    // miss) — NOT recorded, so the account retries on the next sweep instead of
    // silently losing the promo forever.
    const TERMINAL = ["success", "already_used", "exhausted", "gated"];

    async function processPromoAccount(acc, idx = 0) {
      if (exhaustedFlag) return;

      // Stagger connects across the batch so 15 clients don't hit the same bot
      // in lockstep (reduces FLOOD_WAIT and connect contention).
      if (idx > 0) await sleep(idx * 400);
      if (exhaustedFlag) return;

      // Session-safety: never let /trigger and /promo connect the same session
      // concurrently. If it's already in flight elsewhere, skip this run.
      if (activeSessions.has(acc.user_id)) {
        console.log(`[PROMO] ⏭️  ${acc.phone} — session already in flight, skipping`);
        return;
      }
      activeSessions.add(acc.user_id);
      promoInFlight++;
      console.log(`[PROMO] ━━━ ${acc.phone} ━━━ (in-flight: ${promoInFlight})`);

      let client;
      let status = "failed";
      let resultText = "";

      try {
        client = new TelegramClient(
          new StringSession(acc.session_string),
          API_ID,
          API_HASH,
          { connectionRetries: 5, receiveUpdates: false, autoReconnect: false },
        );
        // Tight ceilings for the promo race: a code lives ~1–2 min, so a seat
        // held longer than that is a seat lost. A connect that needs >20s or a
        // flow that needs >75s won't win a slot anyway — recycle the seat.
        await withTimeout(client.connect(), 20000, "CONNECT");

        status = await withTimeout(
          doPromo(client, acc.user_id, promo.code),
          75000,
          "PROMO",
        );

        if (status === "success") { console.log(`[PROMO] ✅ ${acc.phone}`); successCount++; }
        else if (status === "already_used") console.log(`[PROMO] 🚫 ${acc.phone} — already used`);
        else if (status === "exhausted") console.log(`[PROMO] ❌ ${acc.phone} — code exhausted`);
        else if (status === "gated") console.log(`[PROMO] ⏭️  ${acc.phone} — gated (tasks/channels required), skipping`);
        else console.log(`[PROMO] ⚠️  ${acc.phone} — ${status}`);
      } catch (e) {
        const flood = /FLOOD/i.test(e.message || "");
        console.error(`[PROMO] ${acc.phone} error${flood ? " (FLOOD)" : ""}: ${e.message}`);
        status = "failed";
        resultText = e.message;
      } finally {
        if (client) {
          try { await sleep(200); await client.destroy(); } catch (_) {}
        }
        activeSessions.delete(acc.user_id);
        promoInFlight--;
      }

      // Mark processed regardless so the same session is never re-touched later
      // in THIS run (prevents AUTH_KEY_DUPLICATED from same-run double use).
      processed.add(acc.user_id);

      if (status === "exhausted") exhaustedFlag = true;

      // Only persist terminal outcomes. Transient "failed" is left unrecorded
      // so the account is retried next sweep.
      if (!TERMINAL.includes(status)) {
        console.log(`[PROMO] ↻ ${acc.phone} — transient (${status}), will retry next sweep`);
        return;
      }

      // Record attempt — UNIQUE(promo_code_id, user_id) makes this idempotent
      await supabase
        .from("promo_redemptions")
        .insert({
          promo_code_id: promo.id,
          user_id: acc.user_id,
          instance_id: INSTANCE_ID,
          status,
          result_text: (resultText || status).substring(0, 200),
        })
        .then(({ error: e }) => {
          if (e && e.code !== "23505") console.error(`[PROMO] DB insert: ${e.message}`);
        });
    }

    // Rolling pool: keep up to PROMO_CONCURRENCY accounts in flight at all
    // times, refilling as each finishes — no barrier, so fast accounts never
    // wait on slow ones. Promos die in ~1–2 min, so every stalled slot is lost
    // activations. is_active is re-checked periodically as slots are filled.
    let cursor = 0;
    let sinceActiveCheck = 0;

    async function runNext() {
      while (true) {
        if (exhaustedFlag) return;
        const i = cursor++;
        if (i >= pending.length) return;

        // Periodically re-check is_active (roughly once per pool-worth of starts)
        // so we stop fast once another instance exhausts the code.
        if (++sinceActiveCheck >= PROMO_CONCURRENCY) {
          sinceActiveCheck = 0;
          const { data: stillActive } = await supabase
            .from("promo_codes")
            .select("is_active")
            .eq("id", promo.id)
            .single();
          if (!stillActive?.is_active) {
            console.log("[PROMO] ⛔ Code exhausted by another instance — stopping");
            exhaustedFlag = true;
            return;
          }
        }

        // Ramp the first pool-fill so we don't connect all 15 in lockstep.
        await processPromoAccount(pending[i], i < PROMO_CONCURRENCY ? i : 0);
      }
    }

    const poolSize = Math.min(PROMO_CONCURRENCY, pending.length);
    await Promise.allSettled(Array.from({ length: poolSize }, () => runNext()));

    // Mark exhausted in DB after batch completes
    if (exhaustedFlag) {
      await supabase
        .from("promo_codes")
        .update({ is_active: false })
        .eq("id", promo.id);
      console.log("[PROMO] ⛔ Marked code exhausted in DB");
    }

    console.log(
      `[PROMO] ✅ "${promo.code}" — ${successCount} success(es) on instance ${INSTANCE_ID}`,
    );
  }

  return processed;
}

// ============================================
// PROCESS ACCOUNT
// ============================================
async function processAccount(acc) {
  console.log(`\n━━━ Account ${acc.phone} ━━━`);

  // Session-safety: skip if a promo push is already using this session.
  if (activeSessions.has(acc.user_id)) {
    console.log(`⏭️ ${acc.phone} — session in flight (promo), skipping this sweep`);
    return;
  }
  activeSessions.add(acc.user_id);

  let client;

  try {
    client = new TelegramClient(
      new StringSession(acc.session_string),
      API_ID,
      API_HASH,
      {
        connectionRetries: 5,
        receiveUpdates: false,
        autoReconnect: false,
      },
    );
    await client.connect();
    console.log("✅ Connected");

    const now = new Date();
    const clickerDue = new Date(acc.next_clicker_time) <= now;
    const dailyDue = new Date(acc.next_daily_time) <= now;
    const leaveDue =
      acc.next_leave_time && new Date(acc.next_leave_time) <= now;
    if (!clickerDue && !dailyDue && !leaveDue) {
      console.log("⏭️ Nothing due");
      return;
    }

    // Each action is independent — one failing does NOT skip the others
    if (clickerDue) {
      try {
        await doClicker(client, acc.user_id);
      } catch (e) {
        console.error(`[CLICKER] ❌ ${e.message}`);
        if (e.message === "CHANNELS_TOO_MUCH") {
          await notify(
            client,
            "🚨 Channel Limit (500)",
            `Instance: ${INSTANCE_ID}\nPhone: ${acc.phone}`,
          );
          await updateAccount(acc.user_id, {
            next_clicker_time: new Date(
              Date.now() +
                (CHANNEL_LIMIT_DELAY +
                  CLICKER_MIN +
                  Math.random() * CLICKER_MAX) *
                  60000,
            ).toISOString(),
            next_leave_time: new Date().toISOString(),
            last_error: "Channel limit (500)",
          });
        } else if (e.message === "SPONSOR_UNRESOLVABLE") {
          await notify(
            client,
            "🚨 Sponsor Unresolvable",
            `Instance: ${INSTANCE_ID}\nPhone: ${acc.phone}`,
          );
          await updateAccount(acc.user_id, {
            next_clicker_time: new Date(
              Date.now() +
                (SPONSOR_DELAY + CLICKER_MIN + Math.random() * CLICKER_MAX) *
                  60000,
            ).toISOString(),
            last_error: "Sponsor unresolvable after 3 attempts",
          });
        } else if (
          ["MENU_NOT_FOUND", "MESSAGE_ID_INVALID", "TIMEOUT"].some((t) =>
            e.message.includes(t),
          )
        ) {
          // Transient — bot was slow, retry next cycle silently
          await updateAccount(acc.user_id, {
            next_clicker_time: nextClickerTime(),
            last_error: e.message.substring(0, 100),
          });
        } else {
          await incrementError(acc.user_id, e.message);
          await notify(
            client,
            "⚠️ Clicker Error",
            `Instance: ${INSTANCE_ID}\nPhone: ${acc.phone}\n${e.message}`,
          );
        }
      }
    }

    if (dailyDue) {
      try {
        await doDaily(client, acc.user_id);
      } catch (e) {
        console.error(`[DAILY] ❌ ${e.message}`);
        const transient = [
          "SPONSOR_UNRESOLVABLE",
          "MENU_NOT_FOUND",
          "PROFILE_NOT_FOUND",
          "DAILY_BTN_NOT_FOUND",
          "MESSAGE_ID_INVALID",
          "TIMEOUT",
        ].some((t) => e.message.includes(t));
        if (transient) {
          console.log("[DAILY] Transient — rescheduling in 15min");
          await updateAccount(acc.user_id, {
            next_daily_time: new Date(Date.now() + 15 * 60000).toISOString(),
            last_error: e.message.substring(0, 100),
          });
        } else {
          await incrementError(acc.user_id, e.message);
          await notify(
            client,
            "⚠️ Daily Error",
            `Instance: ${INSTANCE_ID}\nPhone: ${acc.phone}\n${e.message}`,
          );
        }
      }
    }

    if (leaveDue) {
      try {
        await leaveChannels(client, acc.user_id);
      } catch (e) {
        console.error(`[LEAVE] ❌ ${e.message}`);
      }
    }
  } catch (e) {
    // Top-level: connection/session failures
    console.error(`❌ ${e.message}`);
    await incrementError(acc.user_id, e.message);
    if (client)
      await notify(
        client,
        "⚠️ Error",
        `Instance: ${INSTANCE_ID}\nPhone: ${acc.phone}\n${e.message}`,
      );
  } finally {
    if (client) {
      try {
        await sleep(500);
        await client.destroy();
        console.log("🔌 Disconnected");
      } catch (_) {}
    }
    activeSessions.delete(acc.user_id);
  }
}

// ============================================
// TRIGGER + SERVER
// ============================================
async function runTrigger() {
  console.log(
    `\n${"=".repeat(40)}\n🚀 Instance ${INSTANCE_ID} - ${new Date().toLocaleString()}\n${"=".repeat(40)}`,
  );

  // 1. Process pending promo codes (same per-account pattern as daily).
  // Goes through the shared guard so a concurrent /promo push can't launch a
  // second overlapping pool (which would double the real concurrency).
  const promoProcessed = (await runPromoSweep()) || new Set();

  // 2. Normal trigger — filter out accounts already processed for promos
  const accounts = await getAccountsDue();
  const remaining = accounts.filter((a) => !promoProcessed.has(a.user_id));
  console.log(`📋 ${accounts.length} due, ${remaining.length} after promo filter`);
  for (const acc of remaining) {
    await processAccount(acc);
    await sleep(1000 + Math.random() * 2000);
  }
  console.log("\n✅ Done\n");
}

// Single owner of the promo-sweep guard. BOTH /trigger and the /promo push call
// this, so only ONE promo sweep can run at a time on this instance — otherwise
// two overlapping pools would each spin up PROMO_CONCURRENCY clients (2× the
// intended concurrency against the same bot). Returns the processed Set, or
// null if a sweep was already in flight and this call was skipped.
let promoRunning = false;
async function runPromoSweep() {
  if (promoRunning) {
    console.log("⏳ Promo sweep already running — skipping this request");
    return null;
  }
  promoRunning = true;
  try {
    return await processPendingPromos();
  } finally {
    promoRunning = false;
  }
}

const app = express();

// Re-entrancy guard: UptimeRobot pings /trigger every 5 min, but a full sweep
// (esp. promo) takes far longer. Without this, overlapping runs can connect the
// SAME session_string concurrently → Telegram invalidates the auth key
// (AUTH_KEY_DUPLICATED) and the account is lost. Only one run at a time.
let triggerRunning = false;

app.get("/", (req, res) => res.send(`Instance ${INSTANCE_ID} ✅`));
app.get("/trigger", (req, res) => {
  if (triggerRunning) {
    console.log("⏳ Trigger already running — skipping this ping");
    res.send("Already running");
    return;
  }
  triggerRunning = true;
  res.send("Triggered");
  runTrigger()
    .catch(console.error)
    .finally(() => {
      triggerRunning = false;
    });
});

// Promo fast-path — pushed by monitor.js on every new code. Runs ONLY the
// promo sweep (via the shared runPromoSweep guard, so it can't overlap a promo
// sweep already running inside /trigger), so redemption starts in seconds
// instead of waiting up to 5 min for the next UptimeRobot ping.
app.get("/promo", (req, res) => {
  res.send("Promo triggered");
  console.log(`\n🎟️  Promo push received — ${new Date().toLocaleString()}`);
  runPromoSweep().catch((e) =>
    console.error(`[PROMO] Fast-path error: ${e.message}`),
  );
});

app.listen(PORT, () =>
  console.log(`\n🌐 Port ${PORT} | Instance ${INSTANCE_ID}\n`),
);