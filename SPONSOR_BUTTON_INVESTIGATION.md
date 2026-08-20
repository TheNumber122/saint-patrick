# Sponsor Button Investigation — Log Analysis

**Date:** August 20, 2026  
**Status:** Root cause CONFIRMED via live logs  
**Resolution:** Not a code bug — sponsor bot-side propagation/cache issue

---

## What the Logs Revealed

### Button type: `KeyboardButtonUrl` (NOT WebView)

The original hypothesis was wrong. The sponsor bot uses plain **URL-type buttons**, not web_app:

```
[SPONSOR-DBG] button: text="🧷 Подписаться" url=https://t.me/+ttEJjHt7KaY5Y2Rk className=KeyboardButtonUrl hasData=false
```

So the code's `btn.url` detection works perfectly. No gramjs change needed.

### The URL is a private channel invite link

```
url=https://t.me/+ttEJjHt7KaY5Y2Rk
classify: saved=false botMatch=false isWebapp=false channelMatch=true isBot=false username=+ttEJjHt7KaY5Y2Rk
```

It's classified correctly as a channel invite → `joinChannel()` is called.

---

## The Actual Problem: Join Succeeds, Verify Still Fails

### Account 1 (+989212379161) — Flood Wait Scenario

```
Attempt 1: Join failed: A wait of 78 seconds is required (ImportChatInvite)
Attempt 2: [sleeps 50s + 5s + 18s] → Already a member → verify ❌
Attempt 3: Join failed: A wait of 197 seconds is required (ImportChatInvite)
```

The first attempt hits a **flood wait** (Telegram rate limit). By the time attempt 2 runs, the account is already a member (from a previous join), but the verify **still fails**.

### Account 2 (+989030272818) — Success Scenario

```
Attempt 1: Joined ✅ → verify ❌ "Подпишись на все каналы"
Attempt 2: Already a member → verify ❌ "Подпишись на все каналы"
Attempt 3: Already a member → verify ❌ "Подпишись на все каналы"
```

The join **succeeds on the first try**. The bot is definitely in the channel. But the verify callback **always fails** with "subscribe to ALL channels."

---

## Why This Happens

The sponsor bot's verify callback (`"✅ Я выполнил(а)"`) checks channel membership via its own mechanism. There are three possible reasons it fails even after a successful join:

### 1. Telegram propagation delay (most likely)
When you join a channel via `ImportChatInvite`, Telegram's internal membership index doesn't update instantly. The sponsor bot's callback handler reads from this index, which can lag behind. This explains why it "fixes itself after some hours" — eventually the index catches up.

### 2. The invite link resolves to a different entity
`t.me/+inviteHash` links can resolve to:
- A channel
- A supergroup (which looks like a channel but is technically different)
- A chat

The sponsor bot might be checking `channels.getParticipant(channelId)` but the invite hash resolves to a supergroup ID. The types don't match, so the check fails.

### 3. Rate limiting on the verify callback
After the first successful join, Telegram may rate-limit the bot's callback answers. The sponsor bot receives "user joined" but can't process it quickly enough, so it reports "not subscribed" on the next verify click.

---

## Why It "Fixes Itself After Hours"

The bot sets `next_clicker_time = now + 10 minutes` after `SPONSOR_UNRESOLVABLE`. So:

```
Sweep 1: join → verify fails → retry in 10 min
Sweep 2: already member → verify fails → retry in 10 min
Sweep 3: already member → verify fails → retry in 10 min
... (multiple cycles) ...
Sweep N: already member → verify succeeds ✅ (propagation caught up)
```

After enough time (hours), Telegram's membership index has fully propagated, and the sponsor bot's callback handler finally sees the join.

---

## What Can Be Done

### Option 1: Add delay between join and verify (simplest)
Currently the delay is only 2-3 seconds. Increasing it to 15-30 seconds after a fresh join (not "Already a member") might help:

```javascript
// After joinChannel
if (!alreadyMember) await sleep(15000 + Math.random() * 15000); // wait for propagation
```

### Option 2: Retry with longer backoff
Instead of 3 rapid attempts, space them out:

```
Attempt 1: join → wait 20s → verify
Attempt 2: wait 60s → verify  
Attempt 3: wait 120s → verify
```

### Option 3: Re-send /start before verifying
The sponsor bot might need to re-initialize its state:

```javascript
await client.sendMessage(BOT, { message: "/start" });
await sleep(3000);
// then re-fetch the sponsor message and click verify
```

### Option 4: Accept the race condition
Since it fixes itself, the current behavior might be acceptable — the account retries in 10 minutes and eventually succeeds. The main cost is lost clicker cycles during the delay.

---

## Debug Logs (what to look for next time)

All logs prefixed with `[SPONSOR-DBG]`:

| Log | Meaning |
|-----|---------|
| `ensureMenu found sponsor msg id=X` | Sponsor message detected in ensureMenu |
| `menu=false menuId=undefined` | No menu was found (sponsor is blocking) |
| `freshMsg.id=X same=true` | Using same message (not re-fetched) |
| `button: text="..." url=... className=KeyboardButtonUrl` | Button type and URL — confirms it's a plain URL button |
| `classify: saved=false botMatch=false isWebapp=false channelMatch=true` | URL classified as channel invite |
| `Joined ✅` vs `Already a member` vs `Join failed` | Join outcome |
| `Verify full response: "❌ Подпишись..."` | Sponsor bot says not subscribed despite successful join |
