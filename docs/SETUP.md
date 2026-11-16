# Newborn Journal Agent: setup guide

A nanoclaw agent that turns Telegram voice or text messages about a newborn into rows in your own Google Sheet.

```
User(s) ⇄ (voice, text) ⇄ Telegram group ⇄ nanoclaw host ──[Voice: transcript]──▶ "babylog" agent container
                                            (voice → Whisper, optional)                │
                                                                                       ▼
                                                        /workspace/agent/tools/baby_api.py
                                                                                       │  HTTPS POST (no key)
                                                                                       ▼
                                                        OneCLI gateway: adds ?key=<API key> for script.google.com
                                                                                       │
                                                                                       ▼
                                                        Apps Script web app (/exec), attached to your sheet copy
                                                                                       │
                                                                                       ▼
                                                        Google Sheet: journal-log (raw)
                                                           └─ parsed into → feed-log · poopee-log · sleep-log · vitals-log · notes-log
```

**Assumes:** nanoclaw **v2** is installed, its Telegram channel is set up (`/add-telegram`), and you've paired with the bot.
Commands run from the nanoclaw folder on the host. If you're still on v1, see the box at the end of Part B.

**Repo files and where they go**

| File in this repo | Where it goes |
|---|---|
| `apps-script/Code.gs` | The Apps Script project attached to your sheet copy |
| `apps-script/appsscript.json` | The same project (its settings file) |
| `nanoclaw/babylog/instructions.prepend.md` | `groups/babylog/instructions.prepend.md` on the nanoclaw host |
| `nanoclaw/babylog/tools/baby_api.py` | `groups/babylog/tools/baby_api.py` (or `groups/<main>/tools/` for §3a) |
| `nanoclaw/babylog/tools/baby_api.example.json` | Template for `tools/baby_api.json` (exec URL and sheet URL; the key lives in OneCLI). Git-ignored. |
| `nanoclaw/main-agent/instructions.baby-mode.md` | Appended to `groups/<main>/instructions.prepend.md` (§3a only) |

In the nanoclaw commands below, `$REPO` is where you cloned this repo, e.g. `REPO=~/newborn-journal-agent`.

---

## 1. Sheet layout (for reference)

| Tab | Columns |
|---|---|
| `journal-log` | Date/Time · Log · Raw log |
| `feed-log` | Date/Time · Milk type · Format · Volume (mL) · Duration (min) · Additives · Remarks |
| `poopee-log` | Date/Time · Poo · Pee · Remarks |
| `sleep-log` | Date/Time · Status · Remarks |
| `vitals-log` | Date/Time · Feature · Measurement · Unit · Remarks |
| `notes-log` | Date/Time · Notes |

The API refuses any sheet whose tabs or headers don't match this table exactly, so don't rename them.

---

## 2. Part A: Google Sheet and Apps Script

### Step 1: Copy the template sheet
1. Open the template:
   https://docs.google.com/spreadsheets/d/1oEOnGw-hdj69HHVlYXEsRnK80pmBJmEQsN9_fLfpkP4/edit
2. **File → Make a copy**, and save it to your own Google Drive.
3. In your copy, open **File → Settings** and set the **Time zone** to your own (e.g. *(GMT+08:00) Singapore*).
   The API reads and writes every Date/Time in this time zone.

> You don't need to share the sheet with anyone. The script runs as you, so the sheet can stay private.

### Step 2: Add the Apps Script to your copy
1. In your copy, click **Extensions → Apps Script**. This opens a script project attached to the sheet.
   - If that project already has the newborn journal `Code.gs` (it came with the template), go straight to Step 3.
2. Replace everything in `Code.gs` with the contents of `apps-script/Code.gs`.
3. Click **Project Settings** (gear icon):
   - Tick **Show "appsscript.json" manifest file in editor**.
   - Check that **Enable Chrome V8 runtime** is ticked.
4. Go back to the **Editor**, open `appsscript.json` and replace its contents with `apps-script/appsscript.json`.
5. Click **Save** (💾).

### Step 3: Generate the API key
1. In the editor's function dropdown (next to **Run**), choose **`setup`**, then click **Run**.
2. The first run asks for permission: **Review permissions** → choose your account.
   If Google shows *"Google hasn't verified this app"*, click **Advanced → Go to (project name) (unsafe)** → **Allow**.
   That's expected for your own script.
3. Copy the API key from either place:
   - the **Execution log** under the editor (`Created API_TOKEN = …`), or
   - **Project Settings → Script properties → `API_TOKEN`**.

> If Run does nothing or fails, your browser session has probably timed out. Reload the page and run it again.
> You can also skip `setup()` and add a property called `API_TOKEN` with any long random string as its value.
> To replace a leaked key, run `rotateToken()`, then `onecli secrets update --id <secret-id> --value "<new key>"` (Step 10).

### Step 4: Deploy it as a web app
1. Click **Deploy → New deployment**.
2. Next to **Select type**, click the gear icon → **Web app**.
3. Fill in:
   - **Description:** `newborn journal api v1`
   - **Execute as:** **Me**
   - **Who has access:** **Anyone**
4. Click **Deploy** (and **Authorize access** if asked).
5. Copy the **Web app URL**. It ends in **`/exec`**:
   `https://script.google.com/macros/s/AKfy…/exec`
6. Quick test: open that URL in a browser. You should see `{"ok":true,"service":"newborn-journal-api","version":1}`.

> "Anyone" only means the URL can be reached without a Google login. Every request that reads or writes data
> also needs the API key, and the script only works on sheets laid out like the template.

### Step 5: Copy your sheet URL
Go back to your sheet copy and copy the URL from the browser's address bar:
`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit…`

You should now have three values: the **exec URL**, the **API key** and the **sheet URL**.
The API key goes into OneCLI (Step 10a). The two URLs go to the agent.

### Changing the script later
If you edit `Code.gs`, the live URL keeps running the **old version** until you redeploy it:
**Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
The `/exec` URL stays the same, so the agent needs no changes.

---

## 3. Part B: nanoclaw agent setup (after Telegram is wired)

This gives the journal its own **agent group** (`babylog`), wired to its own **Telegram group** that both parents can post in.
Keeping it separate from your main assistant means its instructions, memory and sheet access stay apart, and it can answer every message with no @mention.

> **Prefer to use your main agent?** See [§3a](#3a-alternative-run-it-on-your-main-agent). It skips creating a new agent group, at the cost of some separation.

### Step 6: Create a Telegram group for logging
1. In Telegram, create a group (e.g. "Baby Log"). Add your nanoclaw bot and, if you like, your partner.
2. In **@BotFather**: `/mybots` → your bot → **Bot Settings → Group Privacy → Turn off**.
   Then **remove the bot from the group and add it back**. The new setting only applies after it rejoins.
   (With privacy on, the bot only sees @mentions and /commands, so plain messages like "fed 90ml" would be missed.)
3. In your **DM with the bot**, send `/connect_group` and approve the card it shows, choosing the "Baby Log" group.
   Nothing is wired until the card is approved.

> Prefer to log in your existing DM with the bot? Skip this step and use that chat in Step 8. Be aware that every message in that chat then goes to the baby agent.

### Step 7: Create the agent group
```bash
ncl groups create --name "Baby Journal" --folder babylog --timezone Asia/Singapore
ncl groups list                      # note the agent group ID for babylog
```
This creates `groups/babylog/` on the host. Inside the agent's container that folder is mounted read-write at **`/workspace/agent`**.

### Step 8: Wire the Telegram group to the agent
```bash
ncl messaging-groups list --channel-type telegram     # find the "Baby Log" chat and note its ID
ncl wirings create --messaging-group-id <mg-id> --agent-group babylog \
  --engage-mode pattern --engage-pattern '.'
```
`--engage-pattern '.'` makes the agent answer **every** message in that chat.
If the same chat is also wired to your main agent, remove that wiring, or both agents will reply.

### Step 9: Install Python in the agent's container
The default container image (`node:22-slim`) doesn't include Python, which `baby_api.py` needs:
```bash
ncl groups config add-package --id <babylog-id> --apt python3
```
(It takes effect with the `--rebuild` restart in Step 13.)

### Step 10: Add the API client and connect it to the sheet
```bash
mkdir -p groups/babylog/tools
cp "$REPO/nanoclaw/babylog/tools/baby_api.py" groups/babylog/tools/
```
#### 10a. Store the API key in OneCLI (recommended)
nanoclaw v2 sends all container traffic through the OneCLI gateway. Store the key there, and the gateway adds
`?key=<API key>` to the agent's requests to `script.google.com` on the way out.
The key never enters the container, the config file, the chat or the agent's context.
(Apps Script can't read request headers, so the key goes in as a query parameter, which `Code.gs` reads.)

**0. Check that your OneCLI can inject query parameters.** nanoclaw installs a pinned OneCLI version (see
`.claude/skills/add-onecli/versions.json`), and query-parameter injection needs a version whose CLI has `--param-name`:
```bash
onecli secrets create --help | grep -E -- '--param-name|--path-pattern|--type'
```
- `--param-name` is listed → continue.
- It isn't → update OneCLI with `/add-onecli` (it "installs or refreshes OneCLI"), or use the [fallback](#no-onecli-fallback) for now.

**1. Store the key (from Step 3), injected as the `key` query parameter**
```bash
onecli secrets create --name "Baby journal API" --type generic \
  --value "<API key>" --host-pattern script.google.com --param-name key \
  --path-pattern "/macros/s/<DEPLOYMENT_ID>/exec"   # only if --help listed it; see Scope below
onecli secrets list                                   # note the new secret's ID
```
`<DEPLOYMENT_ID>` is the part of your exec URL between `/macros/s/` and `/exec`.

**2. Grant it to the babylog agent only** (nanoclaw's documented recipe; `set-secrets` replaces the list, so it merges):
```bash
AGENT_GROUP_ID=<babylog agent group ID from `ncl groups list`>
SECRET_ID=<secret ID from step 1>
AGENT_ID=$(onecli agents list --max 100 | jq -r --arg g "$AGENT_GROUP_ID" '.data[] | select(.identifier==$g) | .id')
CURRENT=$(onecli agents secrets --id "$AGENT_ID" | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$SECRET_ID" | tr ',' '\n' | grep -v '^$' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id "$AGENT_ID" --secret-ids "$MERGED"
```
(Newer OneCLI versions also have `onecli agents grants attach-secret --id "$AGENT_ID" --secret-id "$SECRET_ID"`, which adds one secret without the merge.)
The OneCLI agent only exists once the agent group's container has started at least once. If `AGENT_ID` comes back
empty, send any message to the Baby Log chat and try again.

**3. Don't turn on approval for this secret.** OneCLI secrets can be set to need an Approve/Reject card for every request.
For a logger that writes on every message, that means a card per log. Leave approval off.

> **Scope:** without a path pattern, the gateway adds the key to *every* request this agent makes to `script.google.com`,
> including other people's Apps Script web apps. Limit it to your deployment's path with `--path-pattern`, or with
> **Path pattern** in the OneCLI dashboard if the CLI doesn't offer it. Either way, give the journal its own agent, and
> don't grant this secret to agents that browse the web.

#### 10c. Check that the key gets through (after Step 13)
Ask the agent: *"run `python3 /workspace/agent/tools/baby_api.py status` and show me the output"*.

| Output | Meaning |
|---|---|
| `"ok": true, "key_source": "OneCLI"` | Working. The gateway added the key; the container never had it. |
| `unauthorized` + hint "No key reached the API" | The secret isn't granted to this agent, the host or path pattern doesn't match, or this OneCLI can't inject query parameters. |
| `unauthorized` with no hint | The key reached the API but it's wrong. Update it: `onecli secrets update --id <secret-id> --value "<API_TOKEN>"`. |
| SSL or certificate error | The container doesn't trust the gateway's CA. See Troubleshooting. |

Confirm the key isn't in the agent's workspace: `grep -rF "<first 8 chars of the key>" groups/babylog/` should print nothing.

#### 10b. Tell the agent which deployment and sheet to use
The exec URL and sheet URL aren't secrets, so either of these is fine:

- **On the host:**
  ```bash
  cp "$REPO/nanoclaw/babylog/tools/baby_api.example.json" groups/babylog/tools/baby_api.json
  nano groups/babylog/tools/baby_api.json       # fill in url and sheet; no token
  ```
- **In Telegram (after Step 13):** send `/babysheet <exec url> <sheet url>` in the Baby Log group.
  The agent tests the connection and replies "✅ Connected to … (key from OneCLI)".

#### No OneCLI fallback
Use this if your OneCLI can't inject query parameters yet, or you don't run OneCLI.
Add `"token": "<API key>"` to `groups/babylog/tools/baby_api.json` on the host and `chmod 600` it. The client then sends the
key in the request body. This works, but the key sits in the agent's workspace where the agent could read it.
Never send the key through Telegram.

### Step 11: Add the agent instructions
```bash
cp "$REPO/nanoclaw/babylog/instructions.prepend.md" groups/babylog/instructions.prepend.md
```
This replaces the default file that `ncl groups create` made. Edit the copy in `groups/babylog/` to change how the agent behaves.

> Don't edit `groups/babylog/CLAUDE.md`. nanoclaw rebuilds it every time the container starts, from `instructions.prepend.md` and the agent's memory.

### Step 12 (optional): Voice-note transcription
**Skip this step if you'll only log by text.** Everything else works without it. Without it, voice notes reach the agent
with no transcript, and the agent asks you to type the message instead. You can add this step at any time later.

Stock nanoclaw v2 doesn't transcribe Telegram voice notes. The old `/add-voice-transcription` skill was v1 and WhatsApp-only.
To add it, open `claude` in the nanoclaw folder on the host and paste:

```
Add voice-note transcription to the Telegram channel. When a Telegram voice or audio message arrives in a
wired chat: download it with the Bot API (getFile), transcribe it host-side with OpenAI's Whisper API
(model whisper-1, key OPENAI_API_KEY in .env), and deliver it to the agent as the message text in the form
"[Voice: <transcript>]". If transcription fails, deliver "[Voice: transcription failed]". Keep the
OpenAI key on the host and out of containers. Follow the pattern of the v1 add-voice-transcription skill,
add a test, then restart the service.
```

Then add `OPENAI_API_KEY=sk-…` to `.env` and restart nanoclaw. Whisper costs about US$0.006 per minute of audio.

### Step 13: Restart and test
```bash
ncl groups restart --id <babylog-id> --rebuild
```
In the Baby Log group, send `fed 60ml formula` and expect a reply within 30–60 seconds (the first message starts the container).
If nothing comes back:
```bash
ncl dropped-messages list                              # was the message dropped (e.g. not wired)?
ncl sessions list --agent-group-id <babylog-id>        # container_status should be "running"
```
Then run the checklist in §7.

> **Still on nanoclaw v1?** There's no `ncl`. Register the Telegram chat from your main channel, put the contents of
> `nanoclaw/babylog/instructions.prepend.md` straight into `groups/<name>/CLAUDE.md`, copy `baby_api.py` into `groups/<name>/tools/` (mounted at `/workspace/group`),
> and change `/workspace/agent` to `/workspace/group` in the instructions. The v1 voice skill can be adapted
> to Telegram with the same Claude Code prompt.

---

## 3a. Alternative: run it on your main agent

Use this instead of Steps 6–8 if you'd rather not create a separate agent group. Part A and the optional Step 12 (voice) are unchanged.

### Is it the right choice?

| | Separate `babylog` agent (§3) | Main agent (this section) |
|---|---|---|
| Setup | Create group + wire chat | Nothing new to create |
| Which messages get logged | Every message in Baby Log | Only messages with the prefix (below) |
| Risk of mis-logging | Low | Untagged messages may be logged by mistake, or missed |
| Who can reach the sheet | Only the Baby Log chat | Every chat wired to your main agent |
| Partner logging | Safe: they only reach the baby agent | They reach your main assistant, with all its tools and files |
| Instructions and memory | Separate | Shared with everything else the main agent does |

**Good fit:** only you log, from your own DM with the bot. **If your partner logs too,** use §3.

### Steps

1. **Find the main agent's ID and folder.**
   ```bash
   ncl groups list            # note the main agent's ID and its folder name
   ```
   Below, `<main-id>` and `<main>` stand for those values. The folder is `groups/<main>/` on the host and `/workspace/agent` inside the container.

2. **Install Python.**
   ```bash
   ncl groups config add-package --id <main-id> --apt python3
   ```

3. **Add the API client and its config.**
   ```bash
   mkdir -p groups/<main>/tools
   cp "$REPO/nanoclaw/babylog/tools/baby_api.py" groups/<main>/tools/
   cp "$REPO/nanoclaw/babylog/tools/baby_api.example.json" groups/<main>/tools/baby_api.json
   nano groups/<main>/tools/baby_api.json        # fill in url and sheet; no token
   ```
   Then store the key in OneCLI as in **Step 10a**, granting it to your **main** agent's OneCLI agent.
   Be aware the main agent will then send your key to *any* `script.google.com` URL it calls, for example if it
   browses or calls someone else's Apps Script. If your main agent does that kind of work, use a separate agent (§3).

4. **Append the instructions.** Back up the main agent's instructions, then add the baby-mode block to the **end**:
   ```bash
   cp groups/<main>/instructions.prepend.md groups/<main>/instructions.prepend.md.bak
   printf '\n\n' >> groups/<main>/instructions.prepend.md
   cat "$REPO/nanoclaw/main-agent/instructions.baby-mode.md" >> groups/<main>/instructions.prepend.md
   ```
   The block only applies to messages that start with `baby`, `b:` or 🍼, or voice notes that start with "baby".
   It strips the prefix before writing **Raw log**. Your existing instructions above it are unchanged.

5. **Choose where you log.**
   - **Your existing DM with the bot:** nothing to wire. Just start messages with `baby`.
   - **A Baby Log group:** do Step 6 (create the group, turn off Group Privacy, `/connect_group`), then wire it to the main agent:
     ```bash
     ncl messaging-groups list --channel-type telegram
     ncl wirings create --messaging-group-id <mg-id> --agent-group <main> \
       --engage-mode pattern --engage-pattern '^(?:[Bb][Aa][Bb][Yy]\b|[Bb]:|🍼|\[Voice:)'
     ```
     The pattern only wakes the agent for prefixed messages and voice notes. JavaScript regex doesn't support inline flags like `(?i)`, so the pattern spells out each case.

6. **Restart and test.**
   ```bash
   ncl groups restart --id <main-id> --rebuild
   ```
   - `baby fed 60ml formula` → logged.
   - `fed the cat` → **not** logged; normal reply.
   - Voice note "baby wet diaper" → logged, with the transcript echoed back.
   - `what's on my calendar` → normal reply, and nothing touches the sheet.

### Switching to a separate agent later
Move `tools/baby_api.py` and `tools/baby_api.json` from `groups/<main>/` to `groups/babylog/`, delete the
"Baby journal mode" block from the main agent's instructions (or restore `instructions.prepend.md.bak`), and follow §3. The sheet and Apps Script don't change.

---

## 4. Agent instructions

The agent's standing rules live in the repo, ready to copy:

| Setup | File in this repo | Copy it to |
|---|---|---|
| Separate agent (§3) | [`nanoclaw/babylog/instructions.prepend.md`](../nanoclaw/babylog/instructions.prepend.md) | `groups/babylog/instructions.prepend.md` |
| Main agent (§3a) | [`nanoclaw/main-agent/instructions.baby-mode.md`](../nanoclaw/main-agent/instructions.baby-mode.md) | **Append** to the end of `groups/<main>/instructions.prepend.md` |

They cover: connecting (`/babysheet <exec url> <sheet url>`; the key comes from OneCLI), voice notes, the timestamp rule, the one-`log`-call-per-message workflow, rules for each tab, corrections and questions, error handling and reply style.
Edit the copy in your nanoclaw folder to change how the agent behaves, then run `ncl groups restart --id <id>`.

---

## 5. API reference (`baby_api.py`)

```
python3 /workspace/agent/tools/baby_api.py connect '<exec url>' '<sheet url>'               # test, then save (key from OneCLI)
python3 /workspace/agent/tools/baby_api.py status                                           # check the connection
python3 /workspace/agent/tools/baby_api.py <action> '<json payload>'                        # call the API
```

It prints the API's JSON response and exits with code 1 when `"ok": false`. It uses only the Python standard library,
and it picks up nanoclaw's proxy (`HTTPS_PROXY`) and CA bundle automatically.

| Action | Payload | What it does |
|---|---|---|
| `log` | `{"entries": {"<tab>": [row, …], …}}` | Writes the journal-log row and its parsed rows in one locked write. **Use this for every message.** |
| `append` | `{"tab": "...", "rows": [row, …]}` | Adds rows to one tab |
| `tail` | `{"tab": "...", "n": 5}` | Last n rows, each with its `row` number |
| `query` | `{"tab": "...", "from": "YYYY-MM-DD[ HH:mm]", "to": "..."}` | Rows in a date range (VOID rows left out) |
| `update` | `{"tab": "...", "row": 12, "values": {"Volume (mL)": 120}}` | Changes the given cells; the rest of the row stays as it is |
| `void` | `{"tab": "...", "row": 12}` | Cancels a row (keeps Date/Time and marks it VOID) |
| `summary` | `{"date": "YYYY-MM-DD"}` | Day totals: feeds, mL, minutes, diapers, sleep events, vitals, last feed |
| `meta` | `{}` | Sheet title, time zone and row counts |

A row is a JSON object keyed by column header (case doesn't matter). Date/Time is `"YYYY-MM-DD HH:mm+HH:MM"`
(with a UTC offset, or `Z`); the API converts it to the sheet's time zone, and every Date/Time it returns, and every
Date/Time cell in the sheet, shows the offset, e.g. `2026-11-15 14:20 +08:00`. A value with no offset is read in the sheet's time zone.

### Worked examples

**Text, sent 2026-11-15 14:20:** *"Just gave her 90ml formula in a bottle, she spat up a bit. Also a wet diaper"*
```bash
python3 /workspace/agent/tools/baby_api.py log '{
  "entries": {
    "journal-log": [{
      "Date/Time": "2026-11-15 14:20+08:00",
      "Log": {"feed": "90ml formula in a bottle, she spat up a bit", "poopee": "wet diaper",
              "sleep": null, "vitals": null, "notes": null},
      "Raw log": "Just gave her 90ml formula in a bottle, she spat up a bit. Also a wet diaper"
    }],
    "feed-log":   [{"Date/Time": "2026-11-15 14:20+08:00", "Milk type": "formula", "Format": "bottle",
                    "Volume (mL)": 90, "Remarks": "spat up a bit"}],
    "poopee-log": [{"Date/Time": "2026-11-15 14:20+08:00", "Poo": 0, "Pee": 1}]
  }
}'
```
Reply: `✅ 14:20 — bottle, formula, 90 mL (spat up a bit) · wet diaper`

**Voice note, sent 07:05:** `[Voice: breastfed fifteen minutes at 3am then she slept till 6]`
```bash
python3 /workspace/agent/tools/baby_api.py log '{
  "entries": {
    "journal-log": [{"Date/Time": "2026-11-15 03:00+08:00",
                     "Log": {"feed": "breastfed fifteen minutes at 3am", "poopee": null,
                             "sleep": "slept till 6", "vitals": null, "notes": null},
                     "Raw log": "breastfed fifteen minutes at 3am then she slept till 6"}],
    "feed-log":  [{"Date/Time": "2026-11-15 03:00+08:00", "Milk type": "breast milk", "Format": "breast",
                   "Duration (min)": 15}],
    "sleep-log": [{"Date/Time": "2026-11-15 03:15+08:00", "Status": "sleep"},
                  {"Date/Time": "2026-11-15 06:00+08:00", "Status": "wake"}]
  }
}'
```
Reply: `🎙 "breastfed fifteen minutes at 3am then she slept till 6" → ✅ 03:00 breastfed 15 min · slept 03:15–06:00`

**Correction:** *"actually that bottle was 120"*
```bash
python3 /workspace/agent/tools/baby_api.py tail '{"tab": "feed-log", "n": 3}'     # find the row, e.g. row 12
python3 /workspace/agent/tools/baby_api.py update '{"tab": "feed-log", "row": 12, "values": {"Volume (mL)": 120}}'
```

**Question:** *"How much has she had today?"* → `summary '{"date": "2026-11-15"}'`

---

## 6. Security notes
- The API key is the only thing protecting the web app. With OneCLI (Step 10a) it never enters the container,
  the config file, Telegram or the agent's context, so a prompt-injected agent can't leak it.
- The gateway adds the key to every request that agent makes to `script.google.com`. Grant the secret only to the journal agent.
- If the key ever leaks, run `rotateToken()` in Apps Script, then `onecli secrets update --id <secret-id> --value "<new key>"`.
- The key travels as a URL query parameter, so Google's request logs for your script can show it. Only you can see those logs.
- For extra safety, add a Script property called `ALLOWED_SHEET_IDS` set to your sheet's ID.
  The API will then refuse to touch any other sheet, even with a valid key.
- The sheet stays private. Don't turn on link sharing.
- Everyone in the Baby Log Telegram group can log, correct and query entries. Only add people you trust with the record.

## 7. Test checklist
- [ ] Opening the `/exec` URL in a browser shows `{"ok":true,...}`.
- [ ] Ask the agent "check the sheet connection". It runs `status`, names your sheet and reports `key_source: OneCLI`.
- [ ] `grep -r "<first 6 chars of your key>" groups/babylog/` finds nothing, so the key isn't in the agent's workspace.
- [ ] A text message creates one `journal-log` row (with **Raw log**) and the right structured rows.
- [ ] *(If you did Step 12)* A voice note arrives as `[Voice: …]`, the transcript is echoed back, and **Raw log** holds the transcript.
- [ ] *(If you skipped Step 12)* A voice note gets a reply asking you to type it, and nothing is logged.
- [ ] "Fed at 3am", sent later, gets the 03:00 timestamp. A message with no time gets the send time.
- [ ] "Actually it was 120ml" updates the previous `feed-log` row.
- [ ] "Undo last" voids the last message's rows.
- [ ] "How much did she drink today?" answers from `summary` without writing anything.
- [ ] Your partner can log from the same group.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `setup()` does nothing or errors | Browser session timed out. Reload Apps Script and run it again. |
| Bot ignores plain messages in the group | Turn off Group Privacy in @BotFather, then remove and re-add the bot. Check the wiring uses `--engage-pattern '.'`. |
| No reply at all | `ncl dropped-messages list` and `ncl sessions list --agent-group-id <id>`. Is the chat wired to `babylog`? |
| Two agents reply | The chat is also wired to your main agent. Remove that wiring. |
| Main agent (§3a) logs things that aren't baby events | Tighten the "When it applies" rules, or move to a separate agent (§3). |
| Main agent (§3a) ignores `baby …` messages in the group | Check the wiring's `--engage-pattern` matches the prefix, then restart. |
| `python3: not found` | Run Step 9, then `ncl groups restart --id <id> --rebuild`. |
| Agent ignores new instructions | Instructions load when the container starts: `ncl groups restart --id <id>`. Edit `instructions.prepend.md`, not `CLAUDE.md`. |
| Voice notes arrive with no transcript | Expected if you skipped the optional Step 12. If you did it, check that `OPENAI_API_KEY` is in `.env`. |
| SSL or certificate error from `baby_api.py` | Ask the agent to run `env \| grep -i -E 'proxy\|cert'`. The client trusts `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE` if they're set. |
| Connection refused / blocked | `NANOCLAW_EGRESS_LOCKDOWN=true` blocks the open internet. Allow `script.google.com` and `script.googleusercontent.com`. |
| Client says it got a page, not JSON | Deployment access must be **Anyone**, and the URL must end in `/exec`, not `/dev`. |
| `unauthorized` with "No key reached the API" | The OneCLI secret is missing, not granted to this agent, or its host pattern isn't `script.google.com`. Check with `onecli agents list --with-grants`. |
| `unauthorized` otherwise | Key mismatch. Update the OneCLI secret with the `API_TOKEN` from Script properties (`onecli secrets update`). |
| `schema_mismatch` | A tab or header was renamed or is missing. Match §1 exactly. |
| Edits to `Code.gs` don't take effect | Deploy → Manage deployments → Edit → **New version**. |
| Times are off by hours | Set the sheet's time zone (File → Settings), then redeploy. |
