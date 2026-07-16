# Telegram Bot Farm — Full System Architecture

Distributed automation for **@patrickstarsrobot** (a Telegram star-farming bot).
Up to **12 instances** run in parallel, each owning a slice of accounts, coordinated
through a shared **Supabase (Postgres)** database. All race-sensitive writes are pushed
into atomic SQL functions so instances never corrupt each other's state.

> **Maintenance note:** this file is the canonical mental model of the system. When you
> change control flow (routes, guards, the promo pool, detection), update the matching
> section here. Sections tagged **⟳ updated** reflect the promo-fast-path work.

---

## 0. The three processes at a glance

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              SUPABASE (Postgres)                               │
│                                                                                │
│   accounts · balances · promo_codes · promo_redemptions ·                     │
│   monitor_state · protected_channels                                           │
│                                                                                │
│   ATOMIC RPCs:  claim_due_accounts · increment_error ·                        │
│                 record_click · record_daily                                    │
└───────▲───────────────────────▲──────────────────────────────▲────────────────┘
        │                        │                              │
        │ insert account         │ read/write account state     │ insert promo_codes
        │ (one-time, manual)     │ (every trigger + promo push)  │ (real-time watcher)
        │                        │                              │
┌───────┴────────┐   ┌───────────┴─────────────┐   ┌────────────┴───────────────┐
│   login.js     │   │   index.js  (×N, ≤12)   │   │   promo/monitor.js  (×1)   │
│  (CLI, manual) │   │   THE WORKER            │   │   THE PROMO DETECTOR        │
│                │   │   PORT 10000            │   │   PORT 10001                │
│ phone → code   │   │                         │   │                             │
│ → session_str  │   │ GET /        liveness   │   │ GET /       cron 1min→poll  │
│ → INSERT       │   │ GET /trigger sweep      │   │ GET /health UptimeRobot 5min│
│                │   │ GET /promo   fast-path ◀─┼───┤ push on new code (HTTP)     │
└────────────────┘   └─────────────────────────┘   └─────────────────────────────┘
        one account          the farm loop              watches @patrickstarsfarm
        onboarding           (clicker/daily/promo)      channel for promo codes
```

The monitor now **pushes** to each worker's `/promo` endpoint the instant it detects a code
(promos expire in ~1–2 min, so waiting for the 5-min sweep loses most of them). The two
processes are otherwise decoupled — they share only the database.

| Process | Count | Role | Trigger cadence |
|---|---|---|---|
| `login.js` | manual | Onboards ONE account: phone auth → session string → `INSERT accounts` | Run by hand |
| `index.js` | 1 per instance (≤12) | Worker: clicker, daily, promo redemption, channel-leave | UptimeRobot → `GET /trigger` 5 min **+** monitor push → `GET /promo` |
| `promo/monitor.js` | 1 (global) | Detects promo codes, writes `promo_codes`, **pushes workers** | Real-time event + `GET /` cron 1 min + 30 s interval |

**Deployment:** each of these is its own process/node. The monitor is a **separate Render
service** with Root Directory `promo/` (own `package.json`). See §8.

---

## 1. `login.js` — account onboarding (run once per account, by hand)

```
operator runs `npm run login`
        │
        ▼
prompt: phone (+123…)   prompt: instance ID (1–12, validated)
        │
        ▼
new TelegramClient(empty StringSession, API_ID, API_HASH)
        │
        ▼
client.start({ phoneNumber, phoneCode (SMS), password (optional 2FA) })
        │
        ▼
getMe() → user_id, name, username
        │
        ▼
sendMessage(@patrickstarsrobot, "/start")   ← smoke-test the bot link
        │
        ▼
session_string = client.session.save()
        │
        ▼
INSERT accounts {
    instance_id,
    user_id,
    phone,
    session_string,
    is_active        = true,
    next_clicker_time = now + 1 min   ← getInitialClickerTime(): run almost immediately
    next_daily_time   = now + 1–24 h  ← getNextDailyTime(): random spread
    error_count = 0, total_clicks = 0, total_dailies = 0
}
        │
        ▼
(on DB error) prints manual INSERT SQL as fallback → client.destroy()
```

Uses the **service-role key** (bypasses RLS) — the only process that does.

---

## 2. `index.js` — THE WORKER (the heart of the system)

### 2.1 HTTP surface & the two guards  ⟳ updated

```
GET /          → "Instance N ✅"                     (liveness only)

GET /trigger   → if (triggerRunning) return "Already running"      ← TRIGGER GUARD
                 triggerRunning = true
                 res.send("Triggered")                ← responds INSTANTLY
                 runTrigger().finally(() => triggerRunning = false)

GET /promo     → res.send("Promo triggered")          ← responds INSTANTLY
                 runPromoSweep()                       ← promo-only, no full sweep
                 (no auth — same trust model as /trigger)
```

There are **two independent flags** for two different concerns:

- **`triggerRunning`** — one full sweep (`runTrigger`) at a time. UptimeRobot pings `/trigger`
  every 5 min but a sweep takes longer; overlapping full sweeps must not run.
- **`promoRunning`** — owned by `runPromoSweep()` and shared by **both** entry points
  (`/trigger`'s promo phase *and* the `/promo` push). This guarantees only ONE promo sweep
  runs at a time, so two sources can't each spin up `PROMO_CONCURRENCY` clients and double
  the real concurrency against the bot.

```
runPromoSweep():                    ← the single owner of promoRunning
  if promoRunning → log + return null   (skip; a sweep is already in flight)
  promoRunning = true
  try   return await processPendingPromos()
  finally promoRunning = false
```

**Why guards matter at all:** without them, two runs could connect the **same
`session_string` concurrently** → Telegram invalidates the auth key (`AUTH_KEY_DUPLICATED`)
→ **account permanently lost.** Session-level collisions between the trigger and promo paths
are additionally prevented by the `activeSessions` guard (§2.5).

### 2.2 `runTrigger()` — the top-level sweep order  ⟳ updated

```
runTrigger()
  │
  ├─ 1. promoProcessed = (await runPromoSweep()) || new Set()   ← PROMO FIRST, via shared guard
  │        · returns Set<user_id> touched this run
  │        · returns null if a /promo push is already sweeping → treated as empty Set
  │
  ├─ 2. accounts  = await getAccountsDue()              ← claim due accounts
  │     remaining = accounts.filter(a => !promoProcessed.has(a.user_id))
  │                 ▲ skip anyone already handled by promo this run
  │
  └─ 3. for (acc of remaining):
             await processAccount(acc)
             await sleep(1–3 s)          ← gap between accounts
```

### 2.3 "Calling to due" — `getAccountsDue()` + `claim_due_accounts` RPC

```
getAccountsDue()
  │
  ├─ supabase.rpc("claim_due_accounts", {
  │      p_instance_id,
  │      p_now              = now,
  │      p_clicker_delay_min = 12,
  │      p_clicker_delay_max = 20,
  │      p_daily_delay       = DAILY_DELAY()  (24 h + 0–2 h random)
  │  })
  │
  └─ on RPC error → FALLBACK: plain select where is_active
                    AND (next_clicker_time ≤ now OR next_daily_time ≤ now)
```

**Inside `claim_due_accounts` (atomic, SKIP LOCKED):**
```
WITH claimed AS (
  SELECT … FROM accounts
  WHERE instance_id = p_instance_id AND is_active
    AND ( next_clicker_time ≤ now
       OR next_daily_time  ≤ now
       OR (next_leave_time IS NOT NULL AND next_leave_time ≤ now) )
  FOR UPDATE SKIP LOCKED        ← other instances skip these rows, no blocking
)
UPDATE accounts
  SET next_clicker_time = (due? now + 12..32 min : unchanged)   ← BUMP immediately
      next_daily_time   = (due? now + p_daily_delay : unchanged)
      -- next_leave_time is NOT bumped here (app sets it after leaveChannels)
RETURNING  … the NEW times AS next_*_time,
           … the ORIGINAL pre-bump times AS original_*_time
```

The bump-on-claim means: even if the worker crashes mid-run, the account won't be
re-claimed immediately (its next time already moved forward). The `original_*` columns
tell the app **which task was actually due**.

> Note: `processAccount` recomputes due-ness from `acc.next_*_time`, which the RPC maps
> to the *original* pre-bump times — so the "what's due" decision uses real due times.

### 2.4 `processAccount(acc)` — per-account dispatch (normal sweep)

```
processAccount(acc)
  │
  ├─ if activeSessions.has(user_id) → skip ("session in flight (promo)")   ← §2.5
  ├─ activeSessions.add(user_id)
  │
  ├─ client = new TelegramClient(session_string, {connectionRetries:5,
  │                              receiveUpdates:false, autoReconnect:false})
  ├─ await client.connect()
  │
  ├─ now = new Date()
  │  clickerDue = next_clicker_time ≤ now
  │  dailyDue   = next_daily_time   ≤ now
  │  leaveDue   = next_leave_time && next_leave_time ≤ now
  │  if none → "Nothing due" → return
  │
  ├─ if clickerDue:  try doClicker()   catch → ERROR TAXONOMY (below)
  ├─ if dailyDue:    try doDaily()     catch → transient reschedule / incrementError
  ├─ if leaveDue:    try leaveChannels() catch → log only
  │        ▲ EACH ACTION IS INDEPENDENT — one throwing does NOT skip the others
  │
  └─ finally: sleep(500ms) → client.destroy()  → activeSessions.delete(user_id)
```

**Clicker error taxonomy (catch block):**
```
CHANNELS_TOO_MUCH   → notify admin + next_clicker += 10 h-ish + next_leave = now (force cleanup)
SPONSOR_UNRESOLVABLE→ notify admin + next_clicker += 10 h-ish
MENU_NOT_FOUND /
MESSAGE_ID_INVALID /
TIMEOUT             → TRANSIENT: silent reschedule (next_clicker = now + 12–32 min)
everything else     → incrementError() + notify admin
```
Daily uses a similar split: a transient list (`SPONSOR_UNRESOLVABLE`, `MENU_NOT_FOUND`,
`PROFILE_NOT_FOUND`, `DAILY_BTN_NOT_FOUND`, `MESSAGE_ID_INVALID`, `TIMEOUT`) → reschedule
in 15 min; anything else → `incrementError` + notify.

### 2.5 `activeSessions` — cross-path session lock  ⟳ new

A module-level `Set<user_id>`. Because `/trigger` and `/promo` now run independently, the
**same session must never be connected by both at once** (→ `AUTH_KEY_DUPLICATED`). Every
code path that connects a session claims its `user_id` here first and releases it in
`finally`:

- `processAccount` (trigger path) — skips the account this sweep if already in flight.
- `processPromoAccount` (promo path) — skips the account this run if already in flight.

Net effect: promo redemption wins the race for a session; a clicker/daily that was due at
the same moment simply slips to the next sweep. Correct trade for a 1–2 min promo window.

---

## 3. The four bot actions in detail

All actions talk to `@patrickstarsrobot` by **reading recent messages, finding inline
buttons, and answering callbacks** (`GetBotCallbackAnswer`) rather than clicking blindly.
Shared helpers:

- `ensureMenu()` — guarantees the main menu ("Получи свою личную ссылку") is on screen;
  sends `/start` if needed, resolves any blocking **sponsor** screen, throws `MENU_NOT_FOUND`.
- `findButton(msg, textPart)` — locate an inline button by partial text.
- `getCallbackAnswer()` — safe callback click; swallows `MESSAGE_ID_INVALID` → `"MESSAGE_EXPIRED"`.
- `solveCaptcha()` / `withCaptcha(action)` — see §3.5.
- `jitter()` = 4–6 s human-like delay; `sleep()` everywhere.

> The per-action delays (jitter, captcha waits, button round-trips) are **intentional** —
> the bot is not fast and needs time to render inline buttons. Do NOT trim them; promo speed
> comes from starting sooner (push) and concurrency, not from shorter sleeps.

### 3.1 CLICKER — `doClicker()`  (the money-maker)

**What it is:** clicks the "✨ Кликер" button to collect stars. Rate-limited by the bot,
gated by tasks, and capped locally.

```
doClicker()
  │
  ├─ ensureMenu()  → re-fetch FRESH menu (stale msg id = MESSAGE_ID_INVALID)
  ├─ withCaptcha( click "Кликер" ) → popup
  │
  ├─ popup "завтра"/"слишком много"  → DAILY CLICK LIMIT
  │        next_clicker = now + (10 h + 12–32 min);  cap = 0;  return false
  │
  ├─ popup "выполни хотя бы"/"выполни всего"  → TASK GATE
  │        result = handleTasks()                  ← must do a task first (§3.4)
  │        · NO_TASKS_AVAILABLE → next_clicker = now + 30 min; return false
  │        · tasks failed        → return false
  │        · tasks done → RE-CLICK кликер WITHOUT /start
  │                       (sending /start resets bot's task counter → re-gate)
  │
  ├─ popup "Подпишись на все каналы" → SPONSOR mid-click
  │        handleSponsor(); if ok → next_clicker = 12–32 min, return false (retry next)
  │                          else → throw SPONSOR_UNRESOLVABLE
  │
  ├─ final solveCaptcha()  (bot sometimes delays it)
  │        captchaSolved OR captchaSolvedDuringClick → success
  │        else require popup "получил"; else → fail + reschedule
  │
  └─ SUCCESS → record_click RPC (atomic):
             total_clicks++, cap++
             if cap+1 ≥ CAP_LIMIT(25):  cap→0,  next_clicker = now + CAP_DELAY (10–15 h)
             else:                       next_clicker = now + 12–32 min
```

**Timing constants:** `CLICKER_MIN=12`, `CLICKER_MAX=20` (next click 12–32 min),
`CAP_LIMIT=25`, `CAP_DELAY=10–15 h`, `DAILY_LIMIT_DELAY=10 h`, `NO_TASKS_DELAY=30 min`.

### 3.2 DAILY — `doDaily()`  (once-a-day reward + balance snapshot)

**What it is:** claims the daily reward from the Profile page, and records a balance snapshot.

```
doDaily()
  │
  ├─ ensureMenu() → click "👤 Профиль"
  ├─ sleep 3 s → solveCaptcha() → sleep 2 s
  ├─ fetch FRESH profile msg (text includes "Профиль" + replyMarkup)
  │        not found → retry once → else throw PROFILE_NOT_FOUND
  │
  ├─ extractProfileData(profile.text):
  │        stars     = /💰 Баланс: ([\d.]+) ⭐/
  │        referrals = /✅ Активировали бота: (\d+)/
  │
  ├─ click "Ежедневка" button (needs .data, else DAILY_BTN_NOT_FOUND) → popup
  ├─ solveCaptcha()
  │        captchaSolved                       → success path
  │        popup null / MESSAGE_EXPIRED         → retry in 5 min; return false
  │        "Сначала поставь свою личную ссылку" → notify admin; reschedule 24–26 h; false
  │        "уже получил"/"приходи завтра"       → already claimed; reschedule 24–26 h; false
  │
  ├─ SUCCESS → record_daily RPC (atomic):
  │        total_dailies++, next_daily_time = now + DAILY_DELAY (24–26 h), clear errors
  │
  └─ storeBalance(user_id, phone, stars+1, referrals) → INSERT balances (snapshot row)
```

**Timing:** `DAILY_DELAY()` = 24 h + 0–2 h random (fresh each call).

### 3.3 PROMO — `doPromo()` / `_doPromoAttempt()`  (redeem a detected code)

**What it is:** takes a code that `monitor.js` found, walks Profile → Промокод → sends the
code as text → reads the verdict. Deliberately **skips** promos that demand tasks/subs.

```
doPromo(client, userId, code)          ← outer wrapper, up to 2 attempts
  │
  ├─ attempt 0: _doPromoAttempt()
  ├─ HARD-SKIP statuses → return immediately (no retry):
  │     SPONSOR_UNRESOLVABLE, MENU_NOT_FOUND, PROFILE_NOT_FOUND,
  │     PROMO_BTN_NOT_FOUND, gated
  ├─ result == "MENU_RESPONSE" (promo btn didn't register)
  │     → attempt 1: send /start, retry once
  └─ else return result

_doPromoAttempt():
  │
  ├─ ensureMenu()  (SPONSOR_UNRESOLVABLE / MENU_NOT_FOUND bubble up as skip)
  ├─ click "Профиль" → solveCaptcha → fetch FRESH profile (limit 10)
  │        not found → PROFILE_NOT_FOUND
  ├─ findButton "Промокод" → none → PROMO_BTN_NOT_FOUND
  ├─ click Промокод → btnPopup
  │        isPromoGated(btnPopup)?  → "gated"  (skip before even sending code)
  ├─ solveCaptcha
  ├─ sendMessage(BOT, code)                 ← send the code as a text message
  ├─ read bot reply (retry once; handle captcha-after-send)
  │
  └─ CLASSIFY reply text:
        "успешно активирован"                          → "success"
        "уже активировал"                              → "already_used"
        "недействителен"/"закончились использования"    → "exhausted"
        isPromoGated(text)  (подпишись/вступи/выполни…) → "gated"   (terminal skip)
        "Получи свою личную ссылку" (menu came back)    → "MENU_RESPONSE" (retry)
        else                                            → "failed"  (transient)
```

**`isPromoGated(text)`** trips on: `подпишись`, `подписаться`, `вступи в`,
`выполни задани`, `выполни хотя бы`, `выполни всего`. **Design choice:** gated promos are
recorded terminally and never retried — limited activations are better spent on accounts
that can claim instantly, instead of burning time doing sponsor tasks. (Checked AFTER
success/already/exhausted, so a clean success is never misread as gated.)

### 3.3.1 PROMO orchestration — `processPendingPromos()`  ⟳ updated (rolling pool)

Called via `runPromoSweep()` from BOTH `/trigger` (phase 1) and the `/promo` push.

```
processPendingPromos()  → returns Set<user_id> processed
  │
  ├─ load promo_codes WHERE is_active
  │
  └─ for each promo:
       ├─ re-check is_active (another instance may have exhausted it) → skip if not
       ├─ attempted = SELECT user_id FROM promo_redemptions WHERE promo_code_id
       ├─ accounts  = active accounts for THIS instance
       ├─ pending   = accounts NOT in attempted
       │
       └─ ROLLING POOL of PROMO_CONCURRENCY (=15) workers over `pending`:
            · poolSize = min(15, pending.length) runNext() coroutines run concurrently
            · each runNext() pulls the next index off a shared cursor until drained
            · NO batch barrier — a fast account never waits on a slow one
            · every ~15 starts: re-check is_active → stop early if exhausted
            · first pool-fill is ramped (idx*400ms stagger) to avoid lockstep connects
            │
            processPromoAccount(acc, idx):
              ├─ if exhaustedFlag → return
              ├─ if idx>0 (first fill) → stagger sleep(idx*400ms)   (↓ FLOOD_WAIT)
              ├─ if activeSessions.has(user_id) → skip (session lock, §2.5)
              ├─ activeSessions.add(user_id); promoInFlight++  (logged: "in-flight: N")
              ├─ fresh TelegramClient (autoReconnect:false)
              ├─ withTimeout(connect, 60 s) ; withTimeout(doPromo, 180 s)
              ├─ status == "exhausted" → exhaustedFlag = true
              ├─ finally: destroy() → activeSessions.delete(user_id) → promoInFlight--
              ├─ processed.add(user_id)          ← ALWAYS (prevents same-run re-touch)
              │
              └─ RECORD only if TERMINAL:
                   TERMINAL = [success, already_used, exhausted, gated]
                   → INSERT promo_redemptions {promo_code_id,user_id,instance_id,
                                               status,result_text}
                     (UNIQUE(promo_code_id,user_id) makes it idempotent; 23505 ignored)
                   "failed" is TRANSIENT → NOT recorded → retried next sweep
       │
       └─ after pool drains: if exhaustedFlag → UPDATE promo_codes SET is_active=false
```

**Key safety properties:**
- **Rolling pool, not barriered batches** — continuous refill maximizes activations before
  a code dies (~1–2 min). This replaced the old batch-of-15 barrier.
- `exhaustedFlag` short-circuits the pool the instant any account hits "exhausted", and
  flips `is_active=false` so all other instances stop within seconds.
- `withTimeout` (gramjs #691 workaround) guarantees a hung `connect()` can't freeze the pool.
- `processed.add()` + `activeSessions` together ensure a session is never connected twice.
- Only terminal outcomes persist; `failed` stays retriable → no promo silently lost.
- **`PROMO_CONCURRENCY` reality check:** FLOOD limits are per-account, so 15 *distinct*
  sessions is safe from Telegram's per-account limiter. The real risks are (a) two promo
  sweeps overlapping (solved by the shared `promoRunning` guard), (b) bot-side anti-spam from
  many accounts messaging one bot at once. Don't raise 15 without watching `in-flight` logs
  and FLOOD rates.

### 3.4 TASKS — `handleTasks()`  (sub-flow, only invoked by the clicker task-gate)

**What it is:** the bot forces you to complete "tasks" (join a channel, start a bot, open a
webapp) before letting you click. This does exactly one and returns.

```
handleTasks()
  │
  ├─ ensureMenu() → re-fetch fresh → click "📝 Задания"
  ├─ if "выполнил все задания" → return "NO_TASKS_AVAILABLE"
  │
  └─ loop up to 5 times, find msg "Новое задание" + buttons {action(url), verify, skip, mainMenu}:
        ├─ resolveUrl(action.url)   ← unwrap redirect_url / redirectUrl / url / link params
        │
        ├─ flocktory login URL     → SKIP task (skip btn, else mainMenu, else break)
        ├─ url ?start= (bot)        → sendMessage(bot, "/start <param>")   entity=bot
        ├─ url startapp (webapp — never opened):
        │     patrickgamesbot       → joinChannel("patrickgames_news")
        │     MyChimpBot            → joinChannel("mychimp")
        │     other webapp          → sendMessage(bot, "/start <startapp param>")  entity=webapp
        │                             (referral passed so the referrer gets credit)
        ├─ plain t.me/<id> ending in "bot" → sendMessage(bot,"/start")  entity=bot
        │     (bots must be /start-ed; JoinChannel on a bot → InputPeerUser cast error)
        ├─ plain t.me/<id>          → joinChannel(id)   entity=channel
        └─ unknown                  → simulate visit (sleep)  entity=unknown
        │
        ├─ click "Подтвердить" (verify) → popup
        │     "выполнено"/"получена"                  → completed++, break ✅
        │     MESSAGE_EXPIRED but success msg/entity   → completed++, break ✅
        │     "не найдена" + webapp → RequestAppWebView fallback → re-verify
        │                              still no → skip / mainMenu
        │     entity set & not rejected               → assume success, break ✅
        │     else → skip (or mainMenu) and continue
        └─ no verify btn → skip; no skip → mainMenu → break
```

Returns `true` (≥1 completed) / `false` / `"NO_TASKS_AVAILABLE"`.

### 3.5 CAPTCHA — `solveCaptcha()` / `withCaptcha()`  (cross-cutting)

```
solveCaptcha(client):
  fetch last 5 msgs → find "ПРОВЕРКА НА РОБОТА"
  │
  ├─ MATH captcha:  regex (\d+)([+\-*/])(\d+) → answer = eval(expr)
  │        sleep 3–6 s → click button whose text == answer
  │
  └─ FRUIT captcha: match name (Киви, Банан, Арбуз, …) → emoji (🥝,🍌,🍉…)
           sleep 3–6 s → click button whose text == emoji

withCaptcha(action):  await action(); sleep 1.5 s; solveCaptcha()
```
> Note: math uses `eval()` on a regex-constrained `N op N` string — safe here but scanner-flaggable.

### 3.6 SPONSOR — `handleSponsor()`  (unblock the bot)

```
handleSponsor(sponsorMsg):  up to 3 attempts
  │
  ├─ collect action buttons (with .url) + verify button ("Я выполнил"/"Проверить")
  ├─ for each action button:
  │     resolveUrl → botMatch(?start=) → /start bot
  │                 → startapp (checked BEFORE generic t.me — TG_ANY_LINK matches
  │                   everything) → join patrickgames_news / webapp bot gets
  │                   "/start <startapp param>" (referral credited, webapp never opened)
  │                 → bare t.me/<name> ending in "bot" → /start bot (not a channel)
  │                 → channelMatch      → joinChannel
  │     (CHANNELS_TOO_MUCH → notify admin)
  ├─ click verify → popup
  │     "Подпишись на все каналы" → RequestAppWebView fallback per webapp → retry loop
  │     else → ✅ verified → return true
  └─ after 3 fails → return false  (caller throws SPONSOR_UNRESOLVABLE)
```

### 3.7 LEAVE CHANNELS — `leaveChannels()`  (housekeeping, fail-closed)

```
leaveChannels(userId):
  ├─ getDialogs(limit 500)
  ├─ load protected_channels (telegap-protected ids)
  │        ON FETCH ERROR → return 0   ← FAIL-CLOSED: leave nothing if unsure
  ├─ filter: broadcast Channel, not megagroup, username≠Aliorithm, id NOT in protected
  ├─ for each: LeaveChannel  (sleep 0.8–1.5 s between)
  └─ next_leave_time = now + 24–48 h (random)
```

---

## 4. `promo/monitor.js` — THE PROMO DETECTOR (separate service)  ⟳ updated

Watches source channel **@patrickstarsfarm**, writes discovered codes to `promo_codes`, and
**pushes** each worker's `/promo` endpoint so redemption starts in seconds instead of waiting
for the next 5-min sweep.

```
main()
  ├─ connect user-client (MONITOR_SESSION) → joinChannel(@patrickstarsfarm)
  ├─ checkHistory(): scan last 20 msgs, insert any untracked codes (push=FALSE), set last_seen
  ├─ registerEventHandler(): NewMessage listener  ← PRIMARY real-time detection (push=TRUE)
  ├─ Express:
  │     GET /       → pollChannel() (debounced 5 s) + keep-alive   ← cron every 1 min (push=TRUE)
  │     GET /health → JSON {connected, channel_reachable, last_seen_msg_id}  ← UptimeRobot 5 min
  ├─ setInterval(pollChannel, 30 s)   ← safety-net backup detection (push=TRUE)
  └─ auto-reconnect (ensureConnected) on lost connection

Detection paths → all funnel into handleNewCode(code, meta, raw, push=true):

  extractPromos(text):
     for each line containing "Ловите дейли промо":
        stars_amount    = /на (\d+) ⭐/
        max_activations = /(\d+) активаций/
        code            = text after last ":" (or next non-empty line)
                          strip || ** * _ ; reject if http/t.me/len<2/len>60

  handleNewCode(code, meta, raw, push):
     INSERT promo_codes {code, raw_message[:500], stars_amount, max_activations}
        · dup (23505) → skip (UNIQUE on code) — NO push (not a new code)
        · else saved  → if push: pushToInstances(code)   ← fire-and-forget

  pushToInstances(code):
     for each base in INSTANCE_URLS (comma-separated env):
        GET `${base}/promo`  with 8 s AbortController timeout
        Promise.allSettled → one dead instance never blocks the others

Progress tracking:  monitor_state key "last_seen_msg_id"  (get/setLastSeenMsgId)
```

**Push discipline (important):**
- Real-time paths (event handler, 1-min poll, 30-s interval) call with **`push=true`**.
- **`checkHistory()` (startup backfill) calls with `push=false`** — the last-20 scan is full
  of already-expired codes; pushing them would wake every instance to redeem dead promos on
  every restart. Backfill inserts them (so they're deduped later) but does NOT push.

**Three redundant detection layers** (belt-and-suspenders): real-time event handler +
per-minute HTTP poll + 30 s interval poll, all debounced and idempotent via the UNIQUE
constraint on `promo_codes.code`.

**Env:** `API_ID`, `API_HASH`, `MONITOR_SESSION`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`INSTANCE_URLS` (comma-separated worker base URLs, no trailing `/promo`), `PORT`.

---

## 5. Database schema & the ATOMIC actions

### 5.1 Tables

| Table | Purpose | Key columns |
|---|---|---|
| `accounts` | one row per Telegram account | `instance_id (1–12)`, `user_id`, `session_string`, `is_active`, `next_clicker_time`, `next_daily_time`, `next_leave_time`, `cap`, `total_clicks`, `total_dailies`, `error_count`, `last_error` |
| `balances` | balance snapshot per daily claim | `user_id`, `stars`, `referrals`, `checked_at` (+ view `latest_balances` = DISTINCT ON user_id) |
| `promo_codes` | detected codes | `code` (UNIQUE), `is_active`, `stars_amount`, `max_activations`, `raw_message`, `detected_at` |
| `promo_redemptions` | per-account attempt log | `UNIQUE(promo_code_id, user_id)`, `status CHECK IN (success,already_used,exhausted,gated)`, `instance_id`, `result_text` |
| `monitor_state` | detector progress | key/value JSONB → `last_seen_msg_id` |
| `protected_channels` | never-leave list (telegap) | `channel_id` PK |

`accounts` also has a `BEFORE UPDATE` trigger keeping `updated_at` fresh, and partial
indexes on each `next_*_time WHERE is_active`.

> **⚠️ `status` CHECK must include `'gated'`.** The code inserts `gated` as a terminal
> status. An older `migration.sql` allowed only `(success, already_used, exhausted, failed)`
> — that rejected every gated insert (Postgres `23514`, which the code does NOT ignore), so
> gated accounts retried the same dead promo on **every** sweep forever. Fixed in
> `promo/migration.sql`. Authoritative DDL for the 3 promo tables lives there; `schema.sql`
> also carries a reproducibility copy (with plain-TEXT status, no CHECK).

### 5.2 The four atomic RPCs (why they exist: no read-modify-write races across instances)

```
claim_due_accounts(instance, now, clk_min, clk_max, daily_delay)
   → SELECT … FOR UPDATE SKIP LOCKED  (due rows for this instance)
   → BUMP next_clicker/next_daily in the SAME statement
   → RETURN new times + ORIGINAL pre-bump times
   Effect: safe multi-instance claiming; crash-safe (times already advanced);
           next_leave_time deliberately NOT bumped (app sets it post-leave).

increment_error(user_id, error)
   → error_count++, last_error=…, is_active=false WHEN count≥3
   → RETURN new count      (worker logs "error N/3" / "disabled")

record_click(user_id, cap_limit, next_cap_ts, next_norm_ts)
   → total_clicks++, cap = (cap+1≥limit ? 0 : cap+1),
     next_clicker_time = (cap+1≥limit ? long cap-delay : normal),
     clear errors → RETURN new cap
   Effect: cap counter + reward count advance atomically; 0 = just reset.

record_daily(user_id, next_daily_ts)
   → total_dailies++, next_daily_time=…, clear errors
```

Callers: `record_click` (doClicker success), `record_daily` (doDaily success),
`increment_error` (error taxonomy), `claim_due_accounts` (getAccountsDue).

---

## 6. End-to-end lifecycle  ⟳ updated

```
                  ┌─────────────────────── promo/monitor.js ───────────────────────┐
                  │ watches @patrickstarsfarm (event + 1-min poll + 30-s interval)  │
                  │ new code → INSERT promo_codes → pushToInstances(code)           │
                  └───────────────┬────────────────────────────────────────────────┘
                                  │ GET /promo  (fire-and-forget, 8s timeout each)
                                  ▼
   ┌──────────── index.js (Instance N) ────────────────────────────────────────────┐
   │                                                                                │
   │  GET /promo ─────► runPromoSweep() ──┐                                         │
   │                                       ├──(shared promoRunning guard)──► processPendingPromos()
   │  GET /trigger ─► runTrigger() phase 1─┘                                        │
   │                          │ phase 2                                             │
   │                          ▼                                                     │
   │   getAccountsDue() → claim_due_accounts (SKIP LOCKED + bump)                   │
   │   remaining = due − promoProcessed                                            │
   │        │ for each remaining (sequential, 1–3 s gap)                            │
   │        ▼                                                                       │
   │   processAccount(acc): connect ONE session (activeSessions lock)              │
   │       clickerDue → doClicker → record_click                                    │
   │       dailyDue   → doDaily   → record_daily + storeBalance                     │
   │       leaveDue   → leaveChannels                                               │
   │       (each independent; errors → taxonomy → reschedule/notify)               │
   │       finally destroy()                                                        │
   └────────────────────────────────────────────────────────────────────────────────┘

processPendingPromos() detail:
  promo_codes(is_active) → per code → pending accounts (minus already-attempted)
  → ROLLING POOL of 15 (continuous refill, no barrier)
  → each: activeSessions-lock → connect → doPromo → record if terminal
  → first "exhausted" flips is_active=false → all instances stop within seconds
  → return Set<user_id>
```

---

## 7. Cheat-sheet of every timing / concurrency constant (`index.js`)

| Constant | Value | Used for |
|---|---|---|
| `CLICKER_MIN` / `CLICKER_MAX` | 12 / 20 min | normal next-click delay (12–32 min) |
| `CAP_LIMIT` | 25 | clicks before a long cooldown |
| `CAP_DELAY()` | 10–15 h | cooldown after hitting cap |
| `DAILY_DELAY()` | 24–26 h | next daily |
| `DAILY_LIMIT_DELAY` | 10 h | after "daily click limit" popup |
| `SPONSOR_DELAY` | 10 h | after unresolvable sponsor |
| `CHANNEL_LIMIT_DELAY` | 10 h | after CHANNELS_TOO_MUCH |
| `NO_TASKS_DELAY` | 30 min | clicker gated but no tasks available |
| `LEAVE_DELAY_MIN/MAX` | 24 / 48 h | next channel cleanup |
| `PROMO_CONCURRENCY` | 15 | rolling-pool size (max sessions in flight per promo sweep) |
| `promoInFlight` | (runtime) | live in-flight counter, logged per account to verify concurrency |
| `jitter()` | 4–6 s | human-like click delay |
| stagger (first pool fill) | idx × 400 ms | de-lockstep initial connects (↓ FLOOD_WAIT) |
| connect / promo timeouts | 60 s / 180 s | `withTimeout` ceilings |

---

## 8. Deployment (Render)

Each process is its own node. Order matters on changes to the promo path.

**Workers (`index.js`, ×N):** repo root. Build `npm install`, start `npm start`.
Env: `INSTANCE_ID`, `API_ID`, `API_HASH`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (+ Render's `PORT`).
Must expose `GET /promo` (present after the fast-path change) or the monitor's push 404s and
silently falls back to the 5-min sweep.

**Monitor (`promo/monitor.js`, ×1):** **separate Render service**, Root Directory `promo/`
(has its own `package.json`, deps: telegram, @supabase/supabase-js, dotenv, express; `engines`
node ≥18 for global `fetch`). Build `npm install`, start `npm start`.
Env from `promo/.env.example`: `API_ID`, `API_HASH`, `MONITOR_SESSION`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `INSTANCE_URLS` (comma-separated worker URLs, no `/promo` suffix).

**Keep-alive:** UptimeRobot/cron → workers `GET /trigger` every 5 min; monitor `GET /`
every 1 min + `GET /health` every 5 min.

**Deploy order for promo changes:**
1. Run `promo/migration.sql` in Supabase (drops & recreates the 3 promo tables — `gated` allowed).
2. Redeploy all workers (so `/promo` exists).
3. Deploy/redeploy the monitor with `INSTANCE_URLS` set.
```
