# Sponsor Button Link Investigation

**Date:** August 20, 2026  
**Status:** Root cause narrowed — debug logging needed to confirm  
**Resolution:** Not yet applied

---

## Problem

The bot enters a loop: `/start` → sponsor screen → processes buttons → verify fails → `/start` → sponsor screen → repeat. Previously it would resolve the sponsor and continue. Now it never completes.

---

## Sponsor Message (What the Bot Sees)

Text detected by the code:
- `"Чтобы активировать бота:"` (To activate the bot:)
- OR `"Для продолжения фарма звёзд"` (To continue farming stars)

Screenshot (confirmed working format):
```
Для продолжения фарма звёзд, пожалуйста, выполни всего 1 задание

1. Подпишись на наших спонсоров (это займёт 5 секунд)
2. Жми кнопку «✅ Я выполнил(а)»

┌─────────────────────────────────────┐
│  ✏️ Подписаться            ↗️      │   ← action button (KeyboardButtonWebView or KeyboardButtonUrl)
├─────────────────────────────────────┤
│  ✅ Я выполнил(а)                   │   ← verify button (KeyboardButtonCallback)
└─────────────────────────────────────┘
```

**All detection checks PASS:**
| Check | Code | Result |
|-------|------|--------|
| Message text | `m.text?.includes("Для продолжения фарма звёзд")` | ✅ Matches |
| Not captcha | `!m.text?.includes("ПРОВЕРКА НА РОБОТА")` | ✅ Pass |
| Has buttons | `m.replyMarkup` | ✅ Pass |
| Verify button | `t.includes("Я выполнил")` | ✅ Matches "Я выполнил(а)" |
| Action button | `btn.url` | ✅ Gramjs exposes .url on both types |

---

## Initial Hypothesis (DISPROVEN)

**Hypothesis:** The bot changed from URL-type buttons to web_app-type buttons, and `btn.web_app.url` is not the same as `btn.url`.

**Finding: This is WRONG for gramjs.**

The project uses gramjs (`"telegram": "^2.26.22"`) which is an MTProto client, NOT the Telegram Bot API. In the MTProto layer:

| Bot API type | MTProto type (gramjs) | Properties |
|---|---|---|
| `{ type: "url", url: "..." }` | `KeyboardButtonUrl` | `{ text, url }` |
| `{ type: "web_app", web_app: { url: "..." } }` | `KeyboardButtonWebView` | `{ text, url }` |

**Both types expose `btn.url` directly.** Verified with:
```javascript
const btn = new Api.KeyboardButtonWebView({text: 'test', url: 'https://...'});
btn.url  // → 'https://...'  ✅ works!
```

So the button detection code `else if (btn.url) actionBtns.push(btn)` works for both types.

---

## Revised Analysis

Since the buttons ARE detected and the action loop DOES run, the issue is that the **sponsor task is not being completed**. After processing the action button and clicking verify, the bot gets back `"Подпишись на все каналы"` (you haven't subscribed to all channels) and retries 3 times, all failing.

### Likely causes (in order of probability):

#### 1. The "Подписаться" URL leads to something the code can't auto-complete
The URL behind the button might be:
- A Cloudflare-protected page (can't be opened by a Telegram client)
- A URL that requires manual human interaction
- A redirector that doesn't resolve to a t.me link

**Evidence:** The code has a relay system (`relaySponsorUrls`) specifically for "unknown URLs" — these are URLs that don't match any t.me pattern. If the URL has changed to a non-t.me URL, it would fall through to the "Unknown URL" path, which only adds it to `captchaUrls` but does NOT actually subscribe.

#### 2. The verify callback data is stale
The `freshMsg` is the message found in `ensureMenu` with `limit: 5`. If there are newer messages, this message's callback data might be expired by the time `handleSponsor` clicks it 3 times (with delays of 2-4 seconds each).

#### 3. The downstream action (join/start) fails silently
The `try/catch` at line 670 catches ALL errors with just `console.log`:
```javascript
} catch (e) {
  if (e.message === "CHANNELS_TOO_MUCH") {
    await notify(...);
  } else {
    console.log(`[SPONSOR] Button error (skipping): ${e.message}`);
  }
}
```
If the action fails (e.g., "CHANNELS_TOO_MUCH", "Cannot find entity", rate limit), it's silently swallowed.

#### 4. `getMessages(limit: 5)` doesn't return the sponsor message
If there are many new messages in the chat, the sponsor message might fall out of the `limit: 5` window on retry attempts.

---

## Code Locations

| File | Lines | Function | What it does |
|---|---|---|---|
| `index.js` | 51 | `SPONSOR_DELAY` | 10 minutes (600 seconds) |
| `index.js` | 129 | `RELAY_TO` | "Aliorythm" — where captcha URLs are relayed |
| `index.js` | 181-195 | `relaySponsorUrls()` | Sends unknown URLs to admin |
| `index.js` | 318-335 | `resolveUrl()` | Unwraps redirect URLs |
| `index.js` | 337-353 | URL regex constants | TG_BOT_START, TG_ANY_LINK, TG_USERNAME |
| `index.js` | 355-370 | `startBot()` | Sends /start via StartBot API |
| `index.js` | 390-430 | `getSavedLink()` | Checks saved_links DB for known redirectors |
| `index.js` | 435-455 | `executeSavedLink()` | Joins channel or starts bot from saved link |
| `index.js` | 533-601 | `ensureMenu()` | Detects sponsor screen, calls handleSponsor |
| `index.js` | 603-770 | `handleSponsor()` | Processes sponsor buttons, clicks verify |
| `index.js` | 625-638 | (inside handleSponsor) | Button detection — WORKS correctly |
| `index.js` | 645-720 | (inside handleSponsor) | URL classification & execution |
| `index.js` | 670-685 | (inside handleSponsor) | Error catch — SILENT, logs but continues |
| `index.js` | 737-762 | (inside handleSponsor) | RequestAppWebView fallback |
| `index.js` | 880-910 | handleTasks flow | Sends /start before tasks |
| `index.js` | 937-939 | (inside handleTasks) | Task button detection (same pattern) |
| `index.js` | 1206-1340 | `doClicker()` | Main clicker entry point |
| `index.js` | 1969 | processAccount | Catches SPONSOR_UNRESOLVABLE error |

---

## The Loop Flow (Step by Step)

```
processAccount()
  → doClicker()
    → ensureMenu()
      → sends /start
      → polls for menu (limit: 5)
      → finds sponsor message
      → calls handleSponsor(client, sponsorMsg)
        → attempt 1/3:
          → fetches fresh messages (limit: 5)
          → finds sponsor message (or falls back to sponsorMsg)
          → detects buttons: actionBtns[0] + verifyBtn
          → processes actionBtns[0]:
            → extracts URL from btn.url
            → classifies URL:
              → saved link? bot? webapp? channel? unknown?
              → if unknown: adds to captchaUrls, sleeps 4-7s, does nothing
          → clicks verifyBtn:
            → gets callback popup
            → if popup contains "Подпишись на все каналы":
              → tries RequestAppWebView fallback (only for startapp links)
              → continue (retry)
            → if popup is success: return true ✅
        → attempt 2/3: same
        → attempt 3/3: same
        → all failed: relaySponsorUrls(captchaUrls) → admin notified
        → return false ❌
    → ensureMenu: resolved = false → throws SPONSOR_UNRESOLVABLE
  → processAccount catches:
    → sets next_clicker_time = now + 10 minutes
    → sets last_error = "Sponsor unresolvable after 3 attempts"
  → next sweep (10 min later): same thing happens
```

---

## What to Debug (Next Steps)

### Option A: Add debug logging (recommended first step)

Add temporary logs to `handleSponsor` to print:

1. **The raw button structure** — confirm what gramjs returns:
```javascript
for (const row of freshMsg.replyMarkup.rows || [])
  for (const btn of row.buttons)
    console.log(`[SPONSOR DEBUG] btn: text="${btn.text}" url=${btn.url} className=${btn.className}`);
```

2. **The URL being processed** — what URL the "Подписаться" button points to:
```javascript
console.log(`[SPONSOR DEBUG] Processing URL: ${url}`);
```

3. **The classification result** — which branch the URL hits:
```javascript
console.log(`[SPONSOR DEBUG] Classification: saved=${!!saved} botMatch=${!!botMatch} isWebapp=${isWebapp} channelMatch=${!!channelMatch}`);
```

4. **The verify popup** — what the bot says after clicking verify:
```javascript
console.log(`[SPONSOR DEBUG] Verify popup: ${verifyPopup}`);
```

5. **Raw message info** — whether the fresh message is the same as the original:
```javascript
console.log(`[SPONSOR DEBUG] freshMsg.id=${freshMsg.id} sponsorMsg.id=${sponsorMsg.id} same=${freshMsg.id === sponsorMsg.id}`);
```

### Option B: Check what URL the button has

The screenshot shows "✏️ Подписаться" with ↗️ arrow. We need to know the actual URL. Options:
- Add the debug logging above
- Or check the bot's message history in Telegram Desktop (right-click → copy link)

### Option C: Check if it's a rate limit / channel limit issue

The silent error catch at line 670 might be swallowing errors. The log line `[SPONSOR] Button error (skipping): ${e.message}` should appear in the console if this is the case. Check the logs for this line.

---

## Saved Links System (for reference)

If we confirm the URL and it's a redirector that can be mapped to a destination:

```sql
-- schema.sql line 456-468
CREATE TABLE saved_links (
  id         BIGSERIAL PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,       -- exact full redirector URL
  dest_type  TEXT NOT NULL CHECK (dest_type IN ('bot', 'channel')),
  dest_value TEXT NOT NULL,              -- bot: "username?start=param"  channel: id/username
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`getSavedLink(url)` checks:
1. Exact URL match
2. tgrass tracking URL (match by `tb_id`)
3. Fuzzy prefix match (`prefixRatio`)

`executeSavedLink(client, link, tag)` runs:
- `dest_type = "channel"` → `joinChannel()`
- `dest_type = "bot"` → `startBot()`

---

## Gramjs API Reference

### KeyboardButton types (gramjs v2.26.22)

All available types (from `node_modules/telegram/tl/api.d.ts`):

| Type | Properties | Has `.url`? |
|------|-----------|-------------|
| `KeyboardButton` | `{ text }` | ❌ |
| `KeyboardButtonUrl` | `{ text, url }` | ✅ |
| `KeyboardButtonCallback` | `{ text, data }` | ❌ |
| `KeyboardButtonWebView` | `{ text, url }` | ✅ |
| `KeyboardButtonSimpleWebView` | `{ text, url }` | ✅ |
| `KeyboardButtonGame` | `{ text }` | ❌ |
| `KeyboardButtonBuy` | `{ text }` | ❌ |
| `KeyboardButtonUrlAuth` | `{ text, fwdText, botId, buttonId }` | ❌ |
| `KeyboardButtonRequestPhone` | `{ text }` | ❌ |
| `KeyboardButtonRequestGeoLocation` | `{ text }` | ❌ |
| `KeyboardButtonSwitchInline` | `{ text, query, peerTypes, samePeer }` | ❌ |
| `KeyboardButtonRequestPoll` | `{ text, quiz? }` | ❌ |
| `KeyboardButtonRequestPeer` | `{ text, buttonId, peerTypes }` | ❌ |
| `KeyboardButtonCopy` | `{ text, copyText }` | ❌ |

### Constructor IDs (verified)

```
KeyboardButton:          2734311552
KeyboardButtonUrl:        629866245
KeyboardButtonCallback:   901503851
KeyboardButtonWebView:    326529584
KeyboardButtonSimpleWebView: 2696958044
```

### How replyMarkup is structured

```javascript
// msg.replyMarkup is Api.ReplyInlineMarkup
{
  className: 'ReplyInlineMarkup',
  rows: [
    {
      className: 'KeyboardButtonRow',
      buttons: [
        // KeyboardButtonWebView — has .url
        { className: 'KeyboardButtonWebView', text: 'Подписаться', url: 'https://...' },
        // KeyboardButtonCallback — has .data
        { className: 'KeyboardButtonCallback', text: 'Я выполнил(а)', data: Buffer }
      ]
    }
  ]
}
```

---

## Key Insight

The original `web_app.url` vs `btn.url` hypothesis was **wrong for gramjs**. Gramjs normalizes both `KeyboardButtonUrl` and `KeyboardButtonWebView` to expose `.url` directly. The button detection code works correctly.

The real issue is almost certainly that **the URL behind the "Подписаться" button leads to something the code can't auto-complete**, causing the verify step to fail every time. Debug logging will confirm this.
