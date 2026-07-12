# Telegram Bot Farm — Mermaid Diagrams

Every diagram is a self-contained view. Read top-to-bottom: system → trigger → each action → detector → database.

---

## 1. System overview — three processes, one database

```mermaid
flowchart LR
    subgraph LOGIN["login.js — manual onboarding (run by hand)"]
        L1["phone + instanceId"] --> L2["client.start()<br/>SMS code / 2FA"]
        L2 --> L3["session_string = session.save()"]
        L3 --> L4["INSERT accounts<br/>next_clicker=now+1min<br/>next_daily=now+1-24h"]
    end

    subgraph WORKER["index.js ×12 — THE WORKER · PORT 10000"]
        W1["GET / → liveness"]
        W2["GET /trigger → runTrigger()"]
    end

    subgraph MONITOR["promo/monitor.js ×1 — DETECTOR · PORT 10001"]
        M1["GET / → poll (cron 1min)"]
        M2["GET /health → UptimeRobot 5min"]
        M3["NewMessage event listener"]
    end

    DB[("SUPABASE / Postgres")]

    L4 -->|service-role INSERT| DB
    W2 -->|read/write state via RPCs| DB
    M3 -->|INSERT promo_codes| DB
    M1 -->|INSERT promo_codes| DB

    UR1["UptimeRobot"] -->|every 5 min| W2
    CRON["cron"] -->|every 1 min| M1
    UR2["UptimeRobot"] -->|every 5 min| M2
    TG(["Telegram<br/>@patrickstarsrobot<br/>@patrickstarsfarm"])
    W2 <-->|GramJS sessions| TG
    M3 <-->|watch channel| TG

    classDef db fill:#2d4,stroke:#093,color:#000
    classDef tg fill:#39f,stroke:#036,color:#fff
    class DB db
    class TG tg
```

---

## 2. `/trigger` sweep — top-level control flow

```mermaid
flowchart TD
    PING["UptimeRobot → GET /trigger"] --> GUARD{triggerRunning?}
    GUARD -->|yes| SKIP["res: 'Already running'<br/>(prevents same-session<br/>double-connect = AUTH_KEY_DUPLICATED)"]
    GUARD -->|no| SET["triggerRunning = true<br/>res: 'Triggered' (instant)"]
    SET --> RT["runTrigger()"]

    RT --> P1["① processPendingPromos()<br/>returns Set&lt;user_id&gt; touched"]
    P1 --> P2["② getAccountsDue()<br/>→ claim_due_accounts RPC"]
    P2 --> FILTER["remaining = due − promoProcessed"]
    FILTER --> LOOP{"for each<br/>remaining acc"}
    LOOP -->|next| PA["③ processAccount(acc)"]
    PA --> GAP["sleep 1-3 s"] --> LOOP
    LOOP -->|done| FIN["✅ Done<br/>finally: triggerRunning = false"]

    classDef guard fill:#fc6,stroke:#a60,color:#000
    class GUARD,SKIP guard
```

---

## 3. "Calling to due" — `getAccountsDue()` + `claim_due_accounts`

```mermaid
flowchart TD
    GAD["getAccountsDue()"] --> RPC["rpc claim_due_accounts(<br/>instance, now,<br/>clk_min=12, clk_max=20,<br/>daily_delay=24-26h)"]
    RPC --> ERR{RPC error?}
    ERR -->|yes| FB["FALLBACK: plain select<br/>is_active AND<br/>(next_clicker≤now OR next_daily≤now)"]
    ERR -->|no| OK["return claimed rows"]

    subgraph SQL["claim_due_accounts (atomic in Postgres)"]
        S1["SELECT due rows for instance<br/>next_clicker≤now OR next_daily≤now<br/>OR next_leave≤now"]
        S2["FOR UPDATE SKIP LOCKED<br/>(other instances skip these — no blocking)"]
        S3["UPDATE: BUMP next_clicker (+12-32min)<br/>and next_daily (+24-26h) NOW<br/>next_leave NOT bumped (app sets it)"]
        S4["RETURN new times<br/>+ ORIGINAL pre-bump times<br/>(so app knows what was due)"]
        S1 --> S2 --> S3 --> S4
    end

    RPC -.runs.-> SQL
    OK --> DONE["accounts[] → runTrigger"]
    FB --> DONE
```

---

## 4. `processAccount(acc)` — per-account dispatch

```mermaid
flowchart TD
    START["processAccount(acc)"] --> CONN["new TelegramClient(session)<br/>connectionRetries:5<br/>autoReconnect:false<br/>client.connect()"]
    CONN --> DUE{"compute due<br/>(from ORIGINAL times)"}
    DUE --> NONE{"nothing due?"}
    NONE -->|yes| RET["return (Nothing due)"]
    NONE -->|no| C{clickerDue?}

    C -->|yes| DC["doClicker()"]
    DC -.error.-> CE["clicker taxonomy"]
    C -->|no / after| D{dailyDue?}
    D -->|yes| DD["doDaily()"]
    DD -.error.-> DE["daily taxonomy"]
    D -->|no / after| LV{leaveDue?}
    LV -->|yes| LC["leaveChannels()"]
    LC -.error.-> LE["log only"]
    LV -->|no / after| FIN["finally: destroy()"]

    subgraph TAX["error taxonomies (independent — one failing skips nothing)"]
        CE --> CE1["CHANNELS_TOO_MUCH → notify + next_clicker+10h + force leave"]
        CE --> CE2["SPONSOR_UNRESOLVABLE → notify + next_clicker+10h"]
        CE --> CE3["MENU_NOT_FOUND / TIMEOUT / MSG_ID_INVALID → silent reschedule 12-32min"]
        CE --> CE4["else → increment_error + notify"]
        DE --> DE1["transient list → reschedule 15 min"]
        DE --> DE2["else → increment_error + notify"]
    end

    classDef ok fill:#2d4,stroke:#093,color:#000
    class DC,DD,LC ok
```

---

## 5. CLICKER — `doClicker()`

```mermaid
flowchart TD
    S["doClicker()"] --> M["ensureMenu() → re-fetch FRESH menu"]
    M --> CLK["withCaptcha( click 'Кликер' ) → popup"]
    CLK --> Q{popup?}

    Q -->|"'завтра' / 'слишком много'"| LIM["DAILY CLICK LIMIT<br/>next_clicker=now+10h, cap=0<br/>return false"]

    Q -->|"'выполни хотя бы' / 'выполни всего'"| GATE["TASK GATE → handleTasks()"]
    GATE --> GQ{result?}
    GQ -->|NO_TASKS_AVAILABLE| GN["next_clicker=now+30min<br/>return false"]
    GQ -->|failed| GF["return false"]
    GQ -->|done| RECLICK["RE-CLICK Кликер WITHOUT /start<br/>(/start resets task counter → re-gate)"]
    RECLICK --> Q2

    Q -->|"'Подпишись на все каналы'"| SPON["handleSponsor()"]
    SPON --> SQ{resolved?}
    SQ -->|yes| SR["next_clicker=12-32min<br/>return false (retry next)"]
    SQ -->|no| ST["throw SPONSOR_UNRESOLVABLE"]

    Q -->|reward path| Q2["final solveCaptcha()"]
    Q2 --> CAP{"captcha solved<br/>OR popup 'получил'?"}
    CAP -->|no| NOR["next_clicker=12-32min<br/>last_error='Click failed'<br/>return false"]
    CAP -->|yes| REC["record_click RPC (atomic)"]

    subgraph RC["record_click"]
        R1["total_clicks++, cap++"]
        R2{"cap+1 ≥ 25?"}
        R2 -->|yes| R3["cap→0<br/>next_clicker=now+10-15h (CAP_DELAY)"]
        R2 -->|no| R4["next_clicker=now+12-32min"]
        R1 --> R2
    end
    REC -.-> RC
    RC --> WIN["✅ Success (cap n/25)"]

    classDef bad fill:#f66,stroke:#900,color:#fff
    class ST,NOR,LIM bad
```

---

## 6. DAILY — `doDaily()`

```mermaid
flowchart TD
    S["doDaily()"] --> M["ensureMenu() → click '👤 Профиль'"]
    M --> W["sleep 3s → solveCaptcha → sleep 2s"]
    W --> PF["fetch FRESH profile msg<br/>(text 'Профиль' + replyMarkup)"]
    PF --> PFQ{found?}
    PFQ -->|no, retry fails| PNF["throw PROFILE_NOT_FOUND"]
    PFQ -->|yes| EX["extractProfileData()<br/>stars = 💰 Баланс: X ⭐<br/>referrals = ✅ Активировали: X"]
    EX --> BTN["click 'Ежедневка' btn<br/>(else DAILY_BTN_NOT_FOUND) → popup"]
    BTN --> CS["solveCaptcha()"]
    CS --> Q{outcome?}

    Q -->|captcha solved| WIN
    Q -->|popup null / MESSAGE_EXPIRED| R5["next_daily=now+5min<br/>return false"]
    Q -->|"'Сначала поставь ссылку'"| RLINK["notify admin<br/>next_daily=24-26h<br/>return false"]
    Q -->|"'уже получил' / 'приходи завтра'"| ALR["already claimed<br/>next_daily=24-26h<br/>return false"]
    Q -->|success| WIN["record_daily RPC (atomic):<br/>total_dailies++<br/>next_daily=now+24-26h<br/>clear errors"]

    WIN --> BAL["storeBalance()<br/>INSERT balances {stars+1, referrals}"]

    classDef bad fill:#f66,stroke:#900,color:#fff
    class PNF bad
```

---

## 7. PROMO — `doPromo()` wrapper + `_doPromoAttempt()`

```mermaid
flowchart TD
    DP["doPromo(client, userId, code)<br/>up to 2 attempts"] --> AT["_doPromoAttempt()"]
    AT --> RES{status}

    RES -->|"SPONSOR_UNRESOLVABLE / MENU_NOT_FOUND /<br/>PROFILE_NOT_FOUND / PROMO_BTN_NOT_FOUND / gated"| HARD["HARD-SKIP → return (no retry)"]
    RES -->|MENU_RESPONSE| RETRY["send /start → retry once"]
    RETRY --> AT
    RES -->|"success / already_used / exhausted / failed"| OUT["return status"]

    subgraph ATTEMPT["_doPromoAttempt()"]
        A1["ensureMenu()"] --> A2["click 'Профиль' → solveCaptcha<br/>→ fetch FRESH profile (limit 10)"]
        A2 --> A3{"'Промокод' btn?"}
        A3 -->|no| A3N["return PROMO_BTN_NOT_FOUND"]
        A3 -->|yes| A4["click Промокод → btnPopup"]
        A4 --> A5{"isPromoGated(btnPopup)?"}
        A5 -->|yes| A5G["return 'gated' (skip before sending)"]
        A5 -->|no| A6["solveCaptcha → sendMessage(BOT, code)"]
        A6 --> A7["read bot reply<br/>(retry once, handle captcha-after-send)"]
        A7 --> A8{classify reply text}
        A8 -->|"'успешно активирован'"| R_S["success"]
        A8 -->|"'уже активировал'"| R_A["already_used"]
        A8 -->|"'недействителен' / 'закончились'"| R_E["exhausted"]
        A8 -->|"isPromoGated (подпишись/вступи/выполни)"| R_G["gated (terminal skip)"]
        A8 -->|"'Получи свою личную ссылку'"| R_M["MENU_RESPONSE (retry)"]
        A8 -->|else| R_F["failed (transient)"]
    end
    AT -.-> ATTEMPT
```

---

## 8. PROMO orchestration — `processPendingPromos()`

```mermaid
flowchart TD
    PPP["processPendingPromos()<br/>returns Set&lt;user_id&gt;"] --> LOAD["load promo_codes WHERE is_active"]
    LOAD --> PLOOP{"for each promo"}

    PLOOP --> RC1{"re-check is_active?<br/>(another instance may exhaust)"}
    RC1 -->|no| PLOOP
    RC1 -->|yes| ATT["attempted = SELECT user_id<br/>FROM promo_redemptions"]
    ATT --> PEND["pending = active accounts<br/>(this instance) − attempted"]
    PEND --> BATCH{"batches of<br/>PROMO_CONCURRENCY=15"}

    BATCH --> RC2{"re-check is_active<br/>before batch"}
    RC2 -->|exhausted| MARKOUT
    RC2 -->|active| ALL["Promise.allSettled(<br/>batch.map(processPromoAccount) )"]

    subgraph PAC["processPromoAccount(acc, idx)"]
        C1["stagger: sleep(idx × 400ms)<br/>(↓ FLOOD_WAIT)"]
        C1 --> C2["fresh TelegramClient<br/>withTimeout(connect,60s)"]
        C2 --> C3["withTimeout(doPromo, 180s) → status"]
        C3 --> C4["exhausted? → exhaustedFlag=true"]
        C4 --> C5["processed.add(user_id)<br/>(ALWAYS — no same-run re-touch)"]
        C5 --> C6{"TERMINAL?<br/>[success, already_used,<br/>exhausted, gated]"}
        C6 -->|yes| C7["INSERT promo_redemptions<br/>UNIQUE(code,user)=idempotent"]
        C6 -->|"no (failed)"| C8["TRANSIENT: not recorded<br/>→ retried next sweep"]
    end
    ALL -.-> PAC

    ALL --> BATCH
    BATCH -->|all done| MARKOUT{exhaustedFlag?}
    MARKOUT -->|yes| UPD["UPDATE promo_codes<br/>SET is_active=false"]
    MARKOUT -->|no| PLOOP
    UPD --> PLOOP
```

---

## 9. TASKS — `handleTasks()` (sub-flow of the clicker task-gate)

```mermaid
flowchart TD
    S["handleTasks()"] --> M["ensureMenu → click '📝 Задания'"]
    M --> ANY{"'выполнил все задания'?"}
    ANY -->|yes| NONE["return NO_TASKS_AVAILABLE"]
    ANY -->|no| LOOP{"loop up to 5×:<br/>find 'Новое задание' + buttons"}

    LOOP --> URL["resolveUrl(action.url)<br/>unwrap redirect_url/url/link"]
    URL --> TYPE{URL type}
    TYPE -->|flocktory login| SK1["SKIP task"]
    TYPE -->|"?start= bot"| B1["/start &lt;param&gt; · entity=bot"]
    TYPE -->|startapp patrickgamesbot| B2["join patrickgames_news · channel"]
    TYPE -->|startapp MyChimpBot| B3["join mychimp · channel"]
    TYPE -->|other webapp| B4["/start · entity=webapp"]
    TYPE -->|plain t.me/id| B5["joinChannel(id) · channel"]
    TYPE -->|unknown| B6["simulate visit"]

    B1 & B2 & B3 & B4 & B5 & B6 --> V["click 'Подтвердить' → popup"]
    V --> VQ{popup?}
    VQ -->|"'выполнено' / 'получена'"| WIN["completed++ → break ✅"]
    VQ -->|"'не найдена' + webapp"| FB["RequestAppWebView fallback → re-verify"]
    FB --> FBQ{ok?}
    FBQ -->|yes| WIN
    FBQ -->|no| SKIP
    VQ -->|entity set, not rejected| WIN
    VQ -->|else| SKIP["skip btn / mainMenu → continue"]
    SK1 --> SKIP
    SKIP --> LOOP
    LOOP -->|exhausted| RET["return completed>0"]
```

---

## 10. CAPTCHA & SPONSOR (cross-cutting helpers)

```mermaid
flowchart TD
    subgraph CAP["solveCaptcha() / withCaptcha(action)"]
        C0["fetch last 5 msgs<br/>find 'ПРОВЕРКА НА РОБОТА'"] --> CT{type?}
        CT -->|math| CM["regex N op N → eval(expr)<br/>sleep 3-6s → click btn==answer"]
        CT -->|fruit| CF["match name (Киви…) → emoji (🥝…)<br/>sleep 3-6s → click btn==emoji"]
    end

    subgraph SPON["handleSponsor() — up to 3 attempts"]
        S0["collect action btns(.url) + verify btn"] --> S1["per action: resolveUrl →<br/>/start bot / joinChannel / startapp"]
        S1 --> S2["click verify → popup"]
        S2 --> SQ{"'Подпишись на все каналы'?"}
        SQ -->|yes| S3["RequestAppWebView fallback → retry"]
        S3 --> S0
        SQ -->|no| S4["✅ verified → true"]
        S2 -.3 fails.-> S5["false → caller throws<br/>SPONSOR_UNRESOLVABLE"]
    end
```

---

## 11. `leaveChannels()` — housekeeping (fail-closed)

```mermaid
flowchart TD
    S["leaveChannels(userId)"] --> D["getDialogs(limit 500)"]
    D --> P["load protected_channels ids"]
    P --> PQ{fetch error?}
    PQ -->|yes| FC["return 0<br/>FAIL-CLOSED: leave nothing if unsure"]
    PQ -->|no| F["filter: broadcast Channel,<br/>not megagroup, username≠Aliorithm,<br/>id NOT in protected"]
    F --> LV["for each: LeaveChannel<br/>sleep 0.8-1.5s"]
    LV --> NX["next_leave_time = now + 24-48h"]
```

---

## 12. DETECTOR — `promo/monitor.js`

```mermaid
flowchart TD
    MAIN["main()"] --> CONN["connect MONITOR_SESSION<br/>join @patrickstarsfarm"]
    CONN --> HIST["checkHistory()<br/>scan last 20 msgs<br/>set last_seen_msg_id"]
    HIST --> LISTEN["registerEventHandler()<br/>NewMessage listener"]

    subgraph DETECT["three redundant detection layers"]
        LISTEN -->|real-time| HANDLE
        POLL1["GET / (cron 1min)<br/>pollChannel() debounced 5s"] --> HANDLE
        POLL2["setInterval 30s<br/>pollChannel()"] --> HANDLE
    end

    HANDLE["extractPromos(text)"] --> EXQ{"line has<br/>'Ловите дейли промо'?"}
    EXQ -->|yes| PARSE["code = after last ':' (or next line)<br/>strip \|\| ** * _<br/>stars = 'на N ⭐'<br/>activations = 'N активаций'<br/>reject http/t.me/len&lt;2/&gt;60"]
    PARSE --> HNC["handleNewCode()"]
    HNC --> INS["INSERT promo_codes<br/>{code, raw[:500], stars, activations}"]
    INS --> DUP{dup 23505?}
    DUP -->|yes| SKIP["skip (UNIQUE on code)"]
    DUP -->|no| SAVED["saved → instances pick up next trigger"]

    HEALTH["GET /health (UptimeRobot 5min)<br/>JSON {connected, reachable, last_seen}"]
    RECON["ensureConnected() → auto-reconnect on drop"]
```

---

## 13. DATABASE — tables & the four atomic RPCs

```mermaid
flowchart LR
    subgraph TABLES["Tables"]
        ACC["accounts<br/>instance_id, user_id, session_string,<br/>is_active, next_clicker/daily/leave_time,<br/>cap, total_clicks/dailies, error_count"]
        BAL["balances<br/>user_id, stars, referrals, checked_at<br/>(view latest_balances)"]
        PC["promo_codes<br/>code UNIQUE, is_active,<br/>stars_amount, max_activations"]
        PR["promo_redemptions<br/>UNIQUE(promo_code_id, user_id),<br/>status, instance_id, result_text"]
        MS["monitor_state<br/>key/value → last_seen_msg_id"]
        PROT["protected_channels<br/>channel_id PK (never leave)"]
    end

    subgraph RPCS["Atomic RPCs — no read-modify-write races across 12 instances"]
        F1["claim_due_accounts<br/>SELECT FOR UPDATE SKIP LOCKED<br/>+ bump next times in same stmt<br/>+ return new & original times"]
        F2["increment_error<br/>error_count++, disable at ≥3<br/>return new count"]
        F3["record_click<br/>total_clicks++, cap logic,<br/>set next_clicker, clear errors<br/>return new cap"]
        F4["record_daily<br/>total_dailies++,<br/>set next_daily, clear errors"]
    end

    F1 --> ACC
    F2 --> ACC
    F3 --> ACC
    F4 --> ACC
    PR -.->|FK| PC

    classDef t fill:#eef,stroke:#66a,color:#000
    classDef r fill:#efe,stroke:#6a6,color:#000
    class ACC,BAL,PC,PR,MS,PROT t
    class F1,F2,F3,F4 r
```

---

## 14. One full trigger — the lifeline (sequence)

```mermaid
sequenceDiagram
    participant UR as UptimeRobot
    participant W as index.js (Instance N)
    participant DB as Supabase
    participant TG as @patrickstarsrobot
    participant MON as monitor.js

    Note over MON,DB: continuously & independently
    MON->>TG: watch @patrickstarsfarm
    TG-->>MON: new promo message
    MON->>DB: INSERT promo_codes (UNIQUE code)

    UR->>W: GET /trigger (every 5 min)
    alt triggerRunning
        W-->>UR: "Already running"
    else free
        W-->>UR: "Triggered" (instant)
        W->>DB: ① load promo_codes(is_active)
        loop each promo, batches of 15
            W->>TG: connect + doPromo(code)
            TG-->>W: success / gated / exhausted / ...
            W->>DB: record terminal → promo_redemptions
        end
        W->>DB: ② claim_due_accounts (SKIP LOCKED + bump)
        DB-->>W: due accounts (minus promo-processed)
        loop each remaining account
            W->>TG: connect one session
            W->>TG: doClicker / doDaily / leaveChannels
            TG-->>W: popups / rewards
            W->>DB: record_click / record_daily / storeBalance
        end
        Note over W: finally triggerRunning = false
    end
```
