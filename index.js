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
async function ensureMenu(client) {
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
        const botMatch = url.match(/t\.me\/([^?/]+)\?start=(.+)/);
        const channelMatch = !botMatch && url.match(/t\.me\/(.+)/);

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
            const bot = url.match(/t\.me\/([^/?]+)/)?.[1];
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
        const bot = burl.match(/t\.me\/([^/?]+)/)?.[1];
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
  const menu = await ensureMenu(client);

  // Re-fetch fresh before clicking to avoid stale message ID
  await sleep(1000);
  const freshMsgs = await client.getMessages(BOT, { limit: 5 });
  const freshMenu =
    freshMsgs.find(
      (m) => m.text?.includes("Получи свою личную ссылку") && m.replyMarkup,
    ) || menu;

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

    if (
      url.includes("flocktory.com/exchange/login") ||
      url.includes("share.flocktory.com/exchange/login")
    ) {
      console.log("[TASK] Flocktory init detected — skipping task");
      if (buttons.skip) {
        await withCaptcha(client, async () => {
          await sleep(1500);
          await getCallbackAnswer(client, taskMsg, buttons.skip.data);
          await sleep(2000);
        });
      } else if (buttons.mainMenu) {
        console.log("[TASK] Flocktory + no skip — going to main menu");
        await getCallbackAnswer(client, taskMsg, buttons.mainMenu.data);
        await sleep(2000);
        break;
      }
      continue;
    }

    let entity = null;

    if (url.includes("?start=") && !url.includes("startapp")) {
      const m = url.match(/t\.me\/([^?]+)\?start=(.+)/);
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
        const bot = url.match(/t\.me\/([^/?]+)/)?.[1];
        if (bot) {
          console.log(`[TASK] Webapp /start @${bot}`);
          try {
            await withCaptcha(client, async () => {
              await client.sendMessage(bot, { message: "/start" });
            });
            await sleep(3000 + Math.random() * 2000);
            entity = { type: "webapp", bot, url };
          } catch (e) {
            console.log(`[TASK] Start @${bot} failed: ${e.message}`);
          }
        }
      }
    } else {
      const m = url.match(/t\.me\/(.+)/);
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
      const ok = msgs.find(
        (m) => m.text?.includes("выполнено") || m.text?.includes("получена"),
      );
      if (ok || entity) {
        console.log("[TASK] ✅ Success");
        completed++;
        break;
      }
      popup = null;
    }

    console.log(`[TASK] Popup: ${popup || "none"}`);

    if (popup?.includes("выполнено") || popup?.includes("получена")) {
      console.log("[TASK] ✅ Success");
      completed++;
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
        if (popup2?.includes("выполнено") || popup2?.includes("получена")) {
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
    menu = await ensureMenu(client);
  } catch (e) {
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
  await client.sendMessage(BOT, { message: code });
  console.log(`[PROMO] Sent: "${code}"`);

  // Step 5: Wait for bot reply
  await sleep(1500);
  let resMsgs = await client.getMessages(BOT, { limit: 5 });
  let botMsg = resMsgs.find((m) => !m.out && m.text);
  if (!botMsg) {
    await sleep(1500);
    resMsgs = await client.getMessages(BOT, { limit: 5 });
    botMsg = resMsgs.find((m) => !m.out && m.text);
  }

  // Handle captcha that appeared after code send
  const captchaHere = (resMsgs || []).find((m) => m.text?.includes("ПРОВЕРКА НА РОБОТА"));
  if (captchaHere) {
    console.log(`[PROMO] Captcha after code send — solving...`);
    await solveCaptcha(client);
    await sleep(1500);
    resMsgs = await client.getMessages(BOT, { limit: 5 });
    botMsg = resMsgs.find((m) => !m.out && m.text && !m.text.includes("ПРОВЕРКА НА РОБОТА"));
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

      console.log(`\n[PROMO] ━━━ ${acc.phone} ━━━`);
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
        await withTimeout(client.connect(), 60000, "CONNECT");

        // Hard ceiling per account so one stuck flow can't freeze the batch.
        status = await withTimeout(
          doPromo(client, acc.user_id, promo.code),
          180000,
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

    // Process accounts in concurrent batches
    for (let i = 0; i < pending.length; i += PROMO_CONCURRENCY) {
      if (exhaustedFlag) break;

      // Re-check is_active before each batch
      const { data: stillActive } = await supabase
        .from("promo_codes")
        .select("is_active")
        .eq("id", promo.id)
        .single();

      if (!stillActive?.is_active) {
        console.log("[PROMO] ⛔ Code exhausted by another instance — stopping");
        break;
      }

      const batch = pending.slice(i, i + PROMO_CONCURRENCY);
      await Promise.allSettled(batch.map((acc, idx) => processPromoAccount(acc, idx)));
    }

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
  }
}

// ============================================
// TRIGGER + SERVER
// ============================================
async function runTrigger() {
  console.log(
    `\n${"=".repeat(40)}\n🚀 Instance ${INSTANCE_ID} - ${new Date().toLocaleString()}\n${"=".repeat(40)}`,
  );

  // 1. Process pending promo codes (same per-account pattern as daily)
  const promoProcessed = await processPendingPromos();

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
app.listen(PORT, () =>
  console.log(`\n🌐 Port ${PORT} | Instance ${INSTANCE_ID}\n`),
);