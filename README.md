# Newborn Journal Agent

Log your newborn's feeds, diapers, sleep, vitals and notes by sending a Telegram message, by voice or text, to a
[nanoclaw](https://github.com/qwibitai/nanoclaw) agent. The agent turns each message into tidy rows in your own Google Sheet.

```
"fed 90ml formula, wet diaper"  ──▶  nanoclaw agent  ──▶  Apps Script API  ──▶  Google Sheet
                                                                                 ├─ journal-log  (raw message, always)
                                                                                 ├─ feed-log
                                                                                 ├─ poopee-log
                                                                                 ├─ sleep-log
                                                                                 ├─ vitals-log
                                                                                 └─ notes-log
```

Reply: `✅ 14:20 — bottle, formula, 90 mL · wet diaper`

## Features
- **Text or voice:** voice notes are transcribed first (optional).
- **One message, many rows:** every message is kept verbatim in `journal-log`, then parsed into the structured tabs.
- **Natural timestamps:** "fed at 3am" is logged at 03:00. With no time given, it uses the time the message was sent.
- **Corrections and undo:** "actually it was 120ml", "undo last".
- **Questions:** "when was the last feed?", "how much did she drink today?"
- **Your data stays yours:** a private Google Sheet in your own Drive, written by an Apps Script that runs as you.

## Repo layout

```
.
├── README.md
├── docs/
│   └── SETUP.md                          # full step-by-step guide
├── apps-script/                          # paste into the Apps Script project attached to your sheet
│   ├── Code.gs                           # JSON API: log, append, tail, query, update, void, summary, meta
│   └── appsscript.json                   # manifest (V8, web app settings)
└── nanoclaw/
    ├── babylog/                          # → copy into groups/babylog/ on your nanoclaw host
    │   ├── instructions.prepend.md       # the agent's standing instructions
    │   └── tools/
    │       ├── baby_api.py               # API client (Python standard library only)
    │       └── baby_api.example.json     # → copy to baby_api.json: exec URL + sheet URL (key lives in OneCLI)
    └── main-agent/
        └── instructions.baby-mode.md     # append to your main agent instead (prefix-triggered)
```

## Quick start

**Requires:** a Google account, and nanoclaw v2 with the Telegram channel set up.

1. **Sheet:** make a copy of the [template sheet](https://docs.google.com/spreadsheets/d/1oEOnGw-hdj69HHVlYXEsRnK80pmBJmEQsN9_fLfpkP4/edit) and set its time zone.
2. **API:** in your copy, open Extensions → Apps Script and paste in `apps-script/`. Run `setup()` to get the API key,
   then deploy it as a web app (Execute as *Me*, access *Anyone*) to get the `/exec` URL.
3. **Agent:** pick one:
   - **Separate agent (recommended, best if your partner logs too):**
     ```bash
     REPO=~/newborn-journal-agent              # where you cloned this repo
     ncl groups create --name "Baby Journal" --folder babylog --timezone Asia/Singapore
     ncl groups config add-package --id <babylog-id> --apt python3
     mkdir -p groups/babylog/tools
     cp "$REPO/nanoclaw/babylog/instructions.prepend.md" groups/babylog/
     cp "$REPO/nanoclaw/babylog/tools/baby_api.py" groups/babylog/tools/
     cp "$REPO/nanoclaw/babylog/tools/baby_api.example.json" groups/babylog/tools/baby_api.json   # exec URL + sheet URL

     # API key → OneCLI. The gateway adds ?key=… to requests to script.google.com, so the agent never sees it.
     onecli secrets create --name "Baby journal API" --type generic \
       --value "<API key>" --host-pattern script.google.com --param-name key
     # then grant the secret to the babylog agent only (docs/SETUP.md, Step 10a), and verify (Step 10c)
     ```
     Then wire your Telegram chat to `babylog` and restart with `--rebuild`.
   - **Main agent (only you log, from your DM):** append `nanoclaw/main-agent/instructions.baby-mode.md` to your
     main agent's `instructions.prepend.md`, then start messages with `baby`.
4. **Test:** send `fed 60ml formula`.

Full instructions, worked examples, the API reference and troubleshooting are in **[docs/SETUP.md](docs/SETUP.md)**.

## Security
- **The API key lives in OneCLI.** nanoclaw's credential gateway injects it as a `?key=` query parameter, so the key
  never enters the agent's container, its context or Telegram. (Apps Script can't read headers, which is why it's a query parameter.)
- `baby_api.json` only holds the exec URL and sheet URL. It's git-ignored anyway.
- Grant the OneCLI secret only to the journal agent, because the gateway adds it to every request that agent makes to `script.google.com`.
- Keep the sheet private. The script runs as you, so it doesn't need link sharing.
- To lock the API to your sheet, set the Script property `ALLOWED_SHEET_IDS`. To replace a leaked key, run `rotateToken()`,
  then `onecli secrets update --id <secret-id> --value "<new key>"`.

## Disclaimer
This is a logging tool, not medical software. It doesn't give medical advice. Always consult your baby's doctor about health concerns.
