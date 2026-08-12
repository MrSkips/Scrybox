# Scrybox

A Scryfall-style search page for your own ManaBox collection. Runs entirely in your browser — your collection data never leaves your computer (only card names/IDs are sent to the public Scryfall API to fetch images and text).

## Launching it

Double-click **`Start Scrybox.vbs`** in this folder. It silently starts the local server and opens the app in Firefox — no console window, nothing to type.

If that doesn't work (e.g. it can't find Python or Firefox), double-click **`Start Scrybox (debug).bat`** instead — it shows a console window so you can see what's failing.

Optional: right-click `Start Scrybox.vbs` → **Send to → Desktop (create shortcut)** if you'd rather launch it from a shortcut on your actual Desktop instead of opening this folder every time.

## Hosting it on GitHub Pages

Scrybox is just static files (`index.html`, `style.css`, `app.js`) — no server, no build step — so it can be hosted for free on GitHub Pages instead of (or alongside) running it locally:

1. Create a new GitHub repo and push this folder's contents to it. `index.html` must sit at the **root** of the repo (or in a `/docs` folder — either works, just pick one when you enable Pages). The `.gitignore` in this folder already excludes the Windows-only launcher files (`Start Scrybox.vbs`/`.bat`) since they're not needed for a hosted version.
2. In the repo, go to **Settings → Pages**, set **Source** to "Deploy from a branch," pick your branch (usually `main`) and the folder (`/root` or `/docs`), then save.
3. GitHub gives you a URL like `https://<your-username>.github.io/<repo-name>/` — that's the whole app, live.
4. The `.nojekyll` file in this folder tells GitHub Pages to skip its default Jekyll processing, so the site is served exactly as-is.

Everything still works the same once hosted: your collection, scratchpad, presets, and AI settings are all stored in **your browser's** local storage (IndexedDB), scoped to that GitHub Pages URL — nothing is stored on GitHub or any server. If you open the site in a different browser or clear site data, you'll need to re-upload your ManaBox CSV, same as switching computers locally. If you make the repo public, anyone with the link can open the app, but they'd see a blank collection until they upload their own CSV — your data itself is never included in the repo or pushed anywhere.

Your Anthropic API key is also already safe from other people without any extra lock: it lives only in your own browser's local storage, scoped to your device, and nobody visiting your GitHub Pages URL on their own device or browser can ever see it (each browser's local storage is completely separate from everyone else's).

## Persistent memory

Once you upload your ManaBox CSV, your collection (plus binder/deck data) is cached in the browser and reopening the app — even after restarting your computer — goes straight to your collection instead of asking you to re-upload. The header shows when it was last synced. Use **Upload / Resync** in the top nav any time you want to refresh from a new CSV export.

Loosely speaking this whole README calls that "your browser's local storage," but under the hood it's actually two different mechanisms: your collection, scratchpad, presets, AI settings, and everything else sizeable is stored in **IndexedDB** (via a small library called localForage), while a couple of small internal values — like the learned Scryfall request pacing described below — use the browser's plain **`localStorage`** API directly. Both are scoped per browser origin and never leave your device either way, so functionally it makes no difference to you; it only matters if you're a developer poking around in your browser's DevTools looking for where a specific setting lives.

### Smart re-sync

Re-uploading a CSV doesn't wipe and re-fetch everything. It diffs against what's cached: unchanged cards are reused as-is, only genuinely new printings get fetched from Scryfall, and anything no longer in your CSV (sold/traded away) is dropped. The status message after a re-sync tells you how many were new/unchanged/removed.

### If you hit "Network error while contacting Scryfall"

Requests are paced at 120ms apart (Scryfall asks for 50-100ms) and retry automatically with backoff if one hiccups. If you see a genuine `HTTP 429` (rate limited) in your browser's Network tab, Scrybox now detects that and fails fast with a clear message instead of silently retrying for 40+ seconds — a rate-limited response from Scryfall sometimes comes back without CORS headers, which the browser reports as a blocked/network error rather than a readable 429, so once a real 429 is seen, any further failure in that same import is treated as the same block rather than retried uselessly. This isn't a bug in Scrybox or a GitHub Pages setting — it clears on Scryfall's end on its own, usually within a minute or two. Wait a bit, then click **Upload / Resync** (or **refresh prices**) again. If the error instead mentions an ad blocker, that's the fallback guess for network failures that *don't* show a genuine 429 first — worth checking too, but the 429 case above is the more common one for large collections.

**Why this is more likely the first time you use a new hosting setup:** local storage (where your collection cache lives) is scoped per browser *origin* — `http://localhost:...` and `https://you.github.io/...` are different origins, so nothing carries over between them. Every resync you've done before probably only needed to fetch a handful of *new* cards, since the rest was already cached — but the first time on a brand-new origin (like right after moving to GitHub Pages), there's nothing cached yet, so it has to fetch your *entire* collection in one go. That's a much bigger burst of requests than a normal resync, and exactly the scenario most likely to trip a rate limit.

If a large import does fail partway through (e.g. "batch 26 of 40"), Scrybox now saves whatever it fetched before the failure instead of throwing it away, and a **🔁 Retry without re-uploading** button appears — click it once the rate limit clears and it resumes from the CSV already sitting in memory, no need to browse and re-select the file from your computer again. (The parsed CSV is only kept in memory for the current page session — a full page reload still needs the file re-selected, since nothing about the raw file itself is saved to disk or storage.) It'll skip everything already saved and only fetch what's still missing, so each retry gets further rather than starting over from card #1.

**Adaptive pacing:** requests start at 200ms apart. The moment a real rate-limit response is confirmed, the pacing for all further requests automatically doubles (up to a 3-second cap) — and this is remembered in this browser (not reset on retry or page reload), so if 200ms turns out to be too fast for your network, every subsequent attempt starts at the slower, working pace instead of re-triggering the same rate limit at the same point every time. Chunk size itself is already fixed at Scryfall's maximum of 75 cards per request, so pacing is the only real lever available — if you're still hitting this repeatedly, it usually means the pacing hasn't found the right speed yet; a couple of retries should let it settle.

### Refresh prices

Prices go stale the moment they're cached. Click **refresh prices** (next to re-sync) any time to re-pull current Scryfall data — prices, oracle text, etc. — for your existing collection without needing a new CSV.

If you're upgrading from an older version of Scrybox, click **refresh prices** once — the expanded search syntax below (artist, flavor text, loyalty, format legality, etc.) relies on fields that older cached cards don't have yet.

### Starting over completely

Re-sync diffs against what's cached, which is normally what you want. If you'd rather wipe the slate clean (e.g. you're importing a totally different ManaBox account/export), go to **Upload / Resync** and click **Reset collection (clear all data)** at the bottom — it asks for confirmation first, and clears everything cached in the browser. A brief **Undo** toast appears afterward in case you clicked it by mistake (see Undo below) — but that only lasts a few seconds, so treat the confirmation dialog as the real safety net.

### Full backup & restore

Also on the **Upload / Resync** screen: **Download full backup (.json)** saves everything — every card's enriched Scryfall data, quantities, binder/deck info, your scratchpad, excluded binders, and saved searches — to a single JSON file. **Restore from backup…** loads one back in. Unlike a ManaBox CSV re-sync, restoring a backup never needs to contact Scryfall, so it's instant and works offline. Worth doing occasionally as a safety copy, or before switching computers.

### Stale price reminder

If it's been 14+ days since your last sync or price refresh, a small note appears in the header ("Prices last refreshed N days ago") next to the total value figure. It's just a nudge — click **refresh prices** whenever you see it.

### Undo

Two one-click actions — **Reset collection** and **Clear all** in the scratchpad — show a brief "Undo" toast at the bottom of the screen for a few seconds afterward. Click it to put things back exactly as they were. Once it disappears, it's gone.

## Getting your ManaBox CSV

In the ManaBox app: **Collection tab → menu (top right) → Export → CSV file**. Save the file, then upload it on the site's welcome screen (or via Upload / Resync).

## Requirements

- Internet connection the first time you import (and any time you re-sync), so the app can look up your cards on Scryfall.
- Internet connection whenever you browse, since card images are streamed from Scryfall's image servers rather than downloaded to your computer.
- Python and Firefox installed (both are used by the launcher).

## Search syntax

Works like Scryfall's search bar — nearly the full operator set is supported:

| Example | Meaning |
|---|---|
| `c:rg`, `color:rg` | Contains red and green |
| `id:bant`, `identity:bant` | Color identity within white/blue/green |
| `t:creature`, `type:creature` | Type line contains "creature" |
| `o:"draw a card"`, `oracle:...` | Oracle text contains the phrase |
| `mv:3`, `mv>=4`, `cmc:3` | Mana value comparisons |
| `pow>=4`, `tou<=2` | Power / toughness |
| `loy>=5`, `loyalty>=5` | Starting loyalty (planeswalkers) |
| `r:mythic`, `rarity:mythic` | Rarity |
| `set:mh3`, `s:`, `e:`, `edition:` | Set code |
| `number:161`, `cn:161` | Collector number |
| `year:1993`, `year<=2000` | Release year |
| `date>=2020-01-01` | Release date |
| `a:"jason chan"`, `artist:` | Illustrator |
| `ft:"draw a card"`, `flavor:` | Flavor text contains the phrase |
| `wm:orzhov`, `watermark:` | Watermark |
| `border:black` | Border color |
| `frame:2015` | Card frame style/year |
| `lang:ja`, `l:ja` | Printed language |
| `m:{2}{r}`, `mana:` | Exact mana cost string |
| `produces:wg` | Can produce white and green mana |
| `f:modern`, `format:modern` | Legal in a format |
| `banned:standard`, `restricted:vintage` | Format ban/restriction status |
| `usd>=50`, `eur<=5` | Price comparisons |
| `tag:removal` | Functional tag — see Function tags below |
| `kw:deathtouch`, `keyword:` | Has this exact keyword ability (Scryfall's keywords list) |
| `is:foil`, `is:nonfoil` | Ownership |
| `is:deck` | Currently placed in a registered deck |
| `is:commander` | Legendary creature |
| `is:split`/`flip`/`transform`/`meld`/`mdfc`/`dfc` | Layout checks |
| `is:permanent`, `is:spell` | Permanent vs. instant/sorcery |
| `is:promo`/`reprint`/`fullart`/`textless`/`reserved`/`digital` | Printing flags |
| `is:hybrid`, `is:phyrexian` | Mana symbol checks |
| `is:vanilla` | Creature with no rules text/keywords |
| `is:leveler` | Has "Level up" |
| `-t:land` | Exclude a term (leading minus works on any operator) |
| `art:sword`, `atag:`, `arttag:` | Illustration tag — see Live search below |
| `otag:removal`, `function:removal` | Scryfall's own oracle/function tags — see Live search below |

Typed search and the left-hand filters (color identity, mana value, power/toughness, playstyle, function tags, mechanics, type, rarity, set, release year, foil/non-foil, deck status) all combine together with AND.

### Saved searches

Above the search bar, **Save current as…** stores your current search text plus every sidebar filter under a name you pick. **Saved searches ▾** lists everything you've saved — pick one and click **Load** to instantly restore that exact search/filter combination, or **Delete** to remove it. Handy for searches you run often, like "Esper removal I'm not currently using in a deck."

### Results view & format legality

Next to the sort controls, **Grid / Table** switches between the usual card-image grid and a dense sortable table (name, mana value, color, set, rarity, quantity, price) — useful for scanning a long list fast. Table column headers are clickable to sort by that column.

The **Legal in** dropdown next to it highlights format legality: pick a format (Standard, Modern, Commander, etc.) and anything not legal there gets dimmed with a "Not legal" flag in the grid, a "Not legal" badge in the table, and a legality line in the card modal — without removing them from the results, so you can still see everything you own at a glance.

### Color Identity is Commander-style

Picking colors in the sidebar filters by color *identity*, the same way Commander deckbuilding works: select 3 colors and you'll see everything that fits that identity — mono-colored cards, two-color cards, colorless cards, all of it — not just cards that use all 3. Check **exact match only** if you want just the exact combination instead (e.g. only true Jeskai cards, no mono-color).

### Range and set filters

Mana Value, Power/Toughness, and Release Year each have Min/Max boxes in the sidebar — leave either side blank for an open-ended range (e.g. just a Min of 5 means "5 or more"). Power/Toughness filtering excludes cards with non-numeric values (`*`, `1+*`, etc.) once either box is set, since they can't be meaningfully compared. Set is a chip list built from whatever sets are actually in your collection (not all of Magic's sets) — select more than one to match any of them (OR).

### Live search (`art:`, `atag:`, `arttag:`, `otag:`, `function:`)

Illustration tags and Scryfall's own oracle/functional tags aren't part of the standard card data, so they can't be matched locally. If your query uses any of these operators, the whole query is sent to Scryfall's live search API instead, and the returned printings are intersected with your owned collection (other operators and the sidebar filters still apply on top). This means it needs an internet connection and can take a few seconds — very broad tags (like `art:sword`, which matches over 10,000 cards) may hit an internal page cap and show a warning to narrow the query, e.g. `art:sword t:creature`.

Playstyle tags (Aggro/Control/Midrange/Ramp/Combo) are a heuristic guess based on card type, mana value, and oracle text — treat them as a starting point, not gospel.

### Function tags

A second heuristic layer beyond playstyle: **Removal**, **Board Wipe**, **Card Advantage**, **Protection** — detected from oracle text patterns (destroy/exile target, destroy all, draw cards, hexproof/indestructible/ward, etc). Usable as sidebar chips or as `tag:removal`, `tag:boardwipe`, `tag:cardadvantage`, `tag:protection` in search (a few aliases work too, like `tag:wipe` or `tag:draw`). Combine with color identity for things like "removal in my Esper deck": `tag:removal id:esper`.

### Mechanics: AND / OR

Mechanic chips (Flying, +1/+1 Counters, etc.) are tri-state — click once for **AND** (turns green, the card must have this), click again for **OR** (turns red, the card must have at least one of the red ones), click a third time to clear it. So "Flying" green + "+1/+1 Counters" green + "Trample" red means: must have flying AND counters, AND at least one of whatever's marked red.

### Deck Status

Next to the sort control (results toolbar, not the sidebar) there's a **Deck status** group: **In a Deck** / **Not in a Deck**. This uses the binder/deck info from your ManaBox export.

Toggling "Not in a Deck" doesn't just hide any card that has ever touched a deck — if a card is split (say 2 copies in a deck, 2 loose in a binder), it still shows up, but the quantity shown is just the loose/storage copies. A card fully used up in a deck (0 left in storage) is the only case that disappears. Select "In a Deck" instead to see what's currently built into your decks.

### ManaBox "Lists" are ignored

ManaBox's smart/dynamic **Lists** (e.g. "everything over $1") aren't a real storage location — they're just a saved filter. Scrybox never registers these as a binder or deck: cards in a list still count toward your normal ownership total, but the list itself won't show up in the Binders tab, in a card's "Stored in" line, or anywhere else. Only real Binders and Decks from your ManaBox export are treated as locations.

## Decks & Binders

If your ManaBox CSV export includes binder/list names (and, for registered decks, a type column), two extra tabs appear in the top nav: **Decks** and **Binders**. Each shows the folders from your ManaBox collection as clickable tiles — click one to search/filter within just that deck or binder, with a banner to jump back to the full collection. If your export doesn't include this info, these tabs will say so rather than showing nothing.

### AI deck grading (Power / Fun / Does The Thing)

Open any deck and you'll see a **Commander** row at the top of the panel with a **Set commander** button — the AI's guess at the commander isn't always right (especially for less-famous cards), so you can pin the actual commander yourself. Click it, start typing a card name (it autocompletes against legendary creatures/planeswalkers actually in the deck), and save. Once set, every grading prompt tells Claude the commander definitively instead of asking it to guess, and the saved grade always shows your pinned name regardless of what the model writes back. Click **Clear** to go back to letting the AI guess.

Below that you'll see a **Grade with AI** and **Copy prompt for Claude** button. There's no local heuristic anymore — an earlier version tried to guess a deck's theme with regex pattern-matching against oracle text, but that approach couldn't handle commanders with more than one thing going on at once (e.g. a card that's simultaneously a tribal anthem for five creature types *and* a +1/+1 counters payoff), so it's been replaced with an actual language model doing the reading.

**Grade with AI** sends the deck's full decklist (name, mana cost, color identity, type line, oracle text — same detail level as **Export results ↓**) straight from your browser to Anthropic's API using your own API key, and asks Claude to grade the deck on three /100 scores:

- **Power** — competitiveness: speed, interaction, card advantage, ramp, consistency, overall quality
- **Fun** — how enjoyable it is to play and play against: variety, interactivity, table-friendliness, whether it avoids being oppressive or a solitaire deck
- **Does The Thing** — Claude first identifies the commander and *every* theme it's actually going for (explicitly instructed not to force a deck into a single bucket — a multi-theme commander gets multiple themes listed), then judges how well the rest of the deck supports all of them

Results are cached per deck (so you're not re-grading every time you open it) and show the commander, every identified theme, all three scores, and Claude's reasoning for each.

**Copy prompt for Claude** builds the same decklist plus grading instructions as plain text and copies it to your clipboard — no API key needed, just paste it into any Claude.ai conversation yourself and read the response there instead. Claude's reply is written to end with a small JSON block after its explanation, specifically so you can bring that score back into Scrybox: click **Paste Claude's reply…** on the same deck, paste the whole response (the reasoning is for you to read; only the trailing JSON block gets parsed), and hit **Update score from this reply** to cache it exactly like an auto-graded deck.

#### Setting up your API key

Click **⚙ AI Grading** in the header. Paste an Anthropic API key, pick a model, and save — that's it. A few things worth knowing:

- This is a fully client-side app with no server. Your key is saved only in this browser's local storage and sent **directly from your browser to Anthropic's API** — it never passes through anything Scrybox-related.
- That does mean the key is visible in your browser's network requests, same as any local tool that calls an API directly. Don't use a key you wouldn't want exposed on this machine, and don't share this folder with the key already saved in it.
- If you'd rather not save a key at all, skip this and just use **Copy prompt for Claude** instead.

### Hiding a specific binder/deck from Collection

Each tile in the Decks/Binders screens has a small **Hide from Collection** checkbox. Check it for a binder (say, a "Duplicates" or "For Trade" list) and its cards stop showing up in the main Collection and Value views/search — but they're still fully browsable by opening that binder directly. This choice is remembered across sessions.

## Settings & theme

Click **⚙ Settings** in the header — this is the single settings entry point for the whole app (an earlier version had two near-identical gear-icon buttons here, which was confusing; there's just one now). It covers **Appearance** (a **ManaBox-style theme** toggle: a dark, purple-accented palette applied across the whole app instead of the default light theme, off by default, remembered across sessions — note the palette is an approximation based on general familiarity with ManaBox's look, not exact brand colors, since those aren't published anywhere Scrybox can pull from automatically) and **AI Deck Grading** (your Anthropic API key and model choice).

## Commander Recommendations

Click **🪄 Commander Recs** above the results grid, type any legendary creature or planeswalker you own, and Scrybox ranks owned cards that fit that commander's color identity and playstyle, in two stages:

1. **Instantly**, from local heuristics — shared creature types (tribal), playstyle tags (aggro/ramp/control/combo/midrange), functional tags (removal/board wipe/card advantage/protection), and a +1/+1 counters theme. No network call, no API key.
2. **A moment later**, boosted with real data from EDHREC — Scrybox fetches EDHREC's own "Top Cards" list for that specific commander (what people actually play with it) and cross-references it against your collection. Matches get a green **EDHREC N%** badge showing what fraction of EDHREC decks for that commander run the card, and their score goes up accordingly. This is an unofficial, undocumented EDHREC endpoint (there's no official public API), so if EDHREC is unreachable, blocks the request, or doesn't recognize the card as a commander, you'll see a note and the list just stays at its local-heuristic ranking — nothing breaks.

If you have an Anthropic API key set (see AI deck grading below), a **🤖 Refine with AI** button sends the commander plus the current top candidates to Claude for a smarter, reasoned re-rank on top of all that — useful since neither the local heuristic nor EDHREC's popularity data understands your specific deck's synergies.

## Multiple printings

If you own the same card across several sets, the results grid shows it as a single tile with a "N versions" badge instead of cluttering the grid with duplicates — the badge's quantity is the sum across every printing you own. Click it and a row of small thumbnails appears in the card modal so you can pick which printing's art/set/price you're looking at. The modal also has a **Stored in** line showing which binder(s)/deck(s) that specific printing lives in, with quantities — so if you own a card in three places, clicking it tells you exactly where.

## Sorting & Value

The sort dropdown covers name, mana value, power, toughness, color, rarity, set, release date, artist, quantity owned, and price. Color sorts colorless first, then white/blue/black/red/green, then multicolor grouped by combination. Next to it is an **Asc ↑ / Desc ↓** button — click to flip the current sort direction for whatever field you've picked.

(There used to be a generic "cEDH Rank" sort here using Scryfall's global `edhrec_rank` field, but that wasn't commander-specific enough to be useful, so it's been replaced by the commander-scoped EDHREC matching described below.)

There's also a **Value** tab in the top nav: it opens the same search/filter view pre-sorted by price (highest first), with a "only show cards worth at least $X" box that updates a running total of what's currently shown. Separately, the very top-right of the header always shows a subtle, always-on estimate of your whole collection's total value (based on current Scryfall prices), regardless of what tab or filters you're using.

## Stats

The **Stats** tab is a read-only dashboard over your whole collection (respecting binders you've hidden from Collection, same as the Value tab): total unique cards, total copies, foil count, and estimated value up top, then a color identity breakdown, mana curve, rarity split, card-type breakdown, and top-12-sets-by-count as simple bar charts, plus your top 10 most valuable cards and your oldest and newest printings. All bars are proportional to the true total for that breakdown (e.g. cards owned in a color ÷ your whole collection), not just the largest value shown, so a bar only fills all the way if it actually is ~100% of the total.

There's also a **Top 10 Most Complete Sets** card, showing which sets you're closest to finishing (unique printings owned ÷ Scryfall's total card count for that set). This one needs a network call the first time you open Stats — Scryfall doesn't publish per-set totals anywhere in your local collection data, so Scrybox fetches the full set list once and caches it for 30 days. If it can't reach Scryfall, that card shows an error instead of blocking the rest of the page.

A further seven cards round out the page, all computed locally from data already in your collection (no extra network calls):

- **Format Legality Coverage** — % of your unique cards legal in each of Standard, Pioneer, Modern, Legacy, Vintage, Commander, and Pauper.
- **Value Distribution** — how many unique cards fall into $0-1 / $1-5 / $5-20 / $20-50 / $50+ buckets.
- **Guild / Wedge / Shard Breakdown** — your multicolor cards split by exact color combination (Azorius, Naya, Five-Color, etc.), proportional to your total multicolor count rather than your whole collection.
- **Top 10 Keywords** — the most common abilities across your collection (Flying, Trample, Deathtouch, and so on).
- **Top Artists** — your top 10 illustrators by card count.
- **Top Sets by Value** — like "Top Sets by Card Count," but ranked by total dollar value instead.
- **Special Printings** — quick counts of full-art, promo, textless, and Reserved List cards you own.

Nothing here is interactive — it's a snapshot, not another filter view.

## Exporting results

Two buttons next to 🛠 Deck Builder in the search bar export whatever's currently shown — respecting the search box and every sidebar filter, color identity included — in two different formats:

- **Export as text ↓** downloads a plain-text file with one line per card: quantity owned, name, mana cost, color identity, type line, power/toughness or loyalty, and full oracle text. Meant to be handed straight to an AI (like Claude) to build a deck from, without it needing to look anything up.
- **Export as CSV ↓** downloads a ManaBox-compatible CSV covering the same filtered set of cards — one row per binder/deck the card is tracked in (foil and non-foil split into separate rows), plus a row for any loose/unassigned copies. Column headers match what Scrybox's own importer recognizes, so this file can be re-imported into Scrybox (as a new collection, or merged via re-sync) or into ManaBox itself. Two columns can't be carried over faithfully: **Condition** and **Purchase price** are always blank, because Scrybox's importer recognizes those columns on the way in but never actually stores their values — that data is gone the moment your original ManaBox CSV was first imported, so there's nothing to re-export.

Typical flow: pick your colors in **Color Identity** (Commander-style, so this also picks up every mono-colored and colorless card that fits), narrow further with any other filters or a search term if you want, then click whichever export button matches what you're about to do with the file.

## Deck Builder

**Deck Builder** is its own tab in the top nav (like Collection/Decks/Binders) — not a popup. Hover any card tile anywhere in the app for a small **+** button (or use **+ Add to scratchpad** in the card modal) to add it here while you browse; the **🛠 Deck Builder (N)** button in the search bar jumps straight to the tab, and so does pressing `s` (both only fire when you're not already typing somewhere).

Cards you've added show up as real Archidekt-style visual tiles — actual card art, a quantity badge, and hover controls (**−** removes one, **+** adds another, **✕** removes all copies) — not a plain text list. Ghost cards (things you don't own) fall back to a plain name placeholder since there's no local art for something you don't have.

- Add a **ghost card** — something you want but don't currently own — by typing its name in the "Add a card you don't own…" box; it shows up dimmed with a "not owned" tag
- **Copy list** to your clipboard, or **Download .txt** — both export in plain `<qty> <name>` format (one per line), ready to paste into Archidekt, Moxfield, or MTG Arena's deck importer

### Import a decklist

Open **Import a decklist** on the Deck Builder tab, paste in a list (one card per line — `1 Sol Ring`, `2x Lightning Bolt`, or just a bare name all work), and click **Import**. Anything you own gets pulled in the same way clicking **+** would (best-stocked location picked automatically — no interactive picker, since this could be dozens of cards at once); anything you don't own, or don't own enough of, is added as a ghost card for the shortfall. A summary shows exactly what happened per card.

Blank lines, `//` and `#` comments, and common section headers a list might include (`Commander`, `Deck`, `Sideboard`, `Maybeboard`, etc.) are recognized and skipped rather than becoming bogus ghost cards. A leading `SB:` marker is stripped and the card imported normally, since the scratchpad doesn't track separate main/sideboard sections.

The deck builder's contents persist across sessions the same way your collection does.

### Commander-locked building

Set a **Commander** at the top of the Deck Builder tab (same autocomplete-against-owned-legendaries pattern as everywhere else Scrybox asks for a commander) and three things happen:

- The sidebar's **Color Identity** filter locks to that commander's colors (Commander-style/subset, same as clicking the mana symbols yourself), so switching over to Collection to browse only shows legal cards.
- A row of clickable tags appears — **Ramp**, **Card Draw**, **Removal**, **Board Wipes**, **Protection**, and (if the commander has a creature type) **`<Type>` Tribal** — each one jumps straight to the Collection tab showing matching owned cards.
- A **build checklist** tracks real (non-ghost) cards already in the deck against rough 99-card Commander guidelines: 36 lands, 10 ramp, 10 card draw, 10 removal, 3 board wipes, 5 protection. Bars turn green once a category is met. This reuses the same functional tags used elsewhere (`tag:removal`, `tag:boardwipe`, etc.) — it's a guideline, not a rule, and ghost cards (things you don't own) aren't counted since there's no local card data for them. The **Deck size** field next to the checklist scales all of these targets proportionally, so a 60-card deck sees roughly 60/99 of each number instead of the fixed Commander defaults.

You can also set a commander straight from the card detail view: any legendary creature or planeswalker shows a **👑 Set as Commander** button next to **+ Add to Deck Builder**. Clicking it pulls that physical copy into the Deck Builder (same picker as the + button if you own more than one copy) and sets it as commander in one step — if every copy you own is already in the deck, it just sets it as commander without trying to pull again.

### Commander Synergies

Once a commander is set, a **Commander Synergies** section appears below the checklist (inside the Deck Builder tab only). Rather than matching literal oracle-text wording, it tags the commander against a master list of common EDH synergy themes — Lifegain, Sacrifice, Dies Triggers, Card Draw (payoff and enabler), Enters the Battlefield, Attack Triggers, Combat Damage Triggers, +1/+1 Counters, Artifacts/Enchantments/Tokens Matter, Spellslinger, Graveyard Matters, Discard Matters, Landfall, Counterspells, and Flying Matters — plus a tribal tab for each of the commander's creature types (e.g. "Bird Tribal"). Any theme the commander actually has becomes a tab; click it to see which other owned cards share that theme (a card can appear under multiple tabs). Clicking a card opens its detail modal.

This is a broader "what does this card care about" categorization, not a literal string match — e.g. Daxos's "whenever another creature enters or dies, gain 1 life" gets tagged both **Lifegain** and **Dies Triggers**, so it surfaces your other lifegain payoffs even though they don't share Daxos's exact wording.

If the local list mislabels or misses something, click **🔮 Suggest tags with AI** (requires an API key in Settings). Instead of asking Claude to name specific cards from your collection — which it can't see and would just guess at — it asks Claude for 4-8 **search queries** in Scrybox's own search syntax (the same one the main search box uses: `o:"phrase"`, `t:type`, `tag:removal`, `c:`/`id:`, `kw:`, and the live `otag:`/`function:` operators) that would find cards supporting the commander's game plan. Each query then runs for real against your actual collection, so the results are always accurate cards you actually own — hovering a tab (or the "Search: ..." line under it) shows the exact query it ran. Only the commander's own card details are sent to Claude, never your collection, so cost stays flat no matter how large your collection is.

AI-suggested tags are saved by the commander's **name**, not by the specific printing/Scryfall id — so if you delete that card and re-add it, or a re-sync happens to land on a different printing, the same commander name picks the saved tags right back up (queries are always re-run live against your current collection, never cached stale). Click **↺ Reset to default tags** to drop the saved AI tags for that commander and go back to the local heuristic list.

Clear the commander any time via the same row to unlock colors and hide the checklist — your actual deck contents aren't affected either way.

### Adding a card pulls it out of a binder

Adding a real (non-ghost) card to the scratchpad isn't just a checklist — it takes that physical copy out of wherever it's stored. If a card only lives in one place, it's pulled automatically. If it's spread across more than one binder/deck (or partly filed and partly loose/unfiled — shown as **Unassigned**), you'll get a small picker to choose which copy the scratchpad takes, foil vs. non-foil included.

Once pulled, that copy disappears from search results, the affected binder's count, and the Binders/Decks tabs — if it was your only copy, the card vanishes from search entirely until you return it. Owning more than one means the rest stay visible as normal.

Removing a card from the scratchpad (the ✕, or the **−** button down to zero) gives it back to wherever it came from immediately — it's not "exported," so nothing here is destructive. Clicking **Clear all** returns everything at once. Ghost cards (things you don't own) aren't pulled from anywhere, so adding/removing those has no effect on your collection.

This pull tracking survives a CSV re-sync: even though re-syncing rebuilds your binder data from scratch, Scrybox re-applies whatever's currently in your scratchpad on top of the fresh data automatically.

### Getting cards back out of your binders (pull list)

**Copy list / Download .txt** export the plain `<qty> <name>` format Archidekt, Moxfield, and MTG Arena expect for importing a deck — no binder info, since those sites wouldn't know what to do with it.

**Copy pull list / Download pull list** are for you, not for Archidekt: same cards, but grouped by which binder or deck to physically pull each one from (foil and non-foil called out separately), plus a section for anything loose/unfiled. The intended workflow: build the deck online with the plain export, then use the pull list to go collect the actual cards from wherever they're stored. Ghost cards (not owned) get their own "Not owned yet" section since there's nowhere to pull them from.

### A few smaller Deck Builder fixes

- Removing a single card from the scratchpad (the ✕, or **−** down to zero) now shows the same brief **Undo** toast that **Clear all** already had, instead of being silently permanent.
- The two "Set commander" controls in the app are deliberately separate and always have been — the **Deck Builder** tab's commander only affects that build-in-progress (color lock, checklist, synergies), while a registered deck's own **Deck Tools** panel has its own commander used purely for AI grading. Labels now spell this out directly on both screens so it's clear they don't interact.
- The **Commander Synergies** panel no longer recomputes on every unrelated scratchpad change (adding/removing an unrelated card, etc.) — it's cached and only recalculates when the commander, your collection, or the saved AI tags actually change.
- Deck Builder's quick-jump tag chips (Ramp, Card Draw, Removal, etc.) and the build checklist now share one definition instead of two separately hand-maintained lists, and a **Lands** chip was added alongside the existing checklist category.
- Scratchpad export filenames (**Download .txt** / **Download pull list**) are now timestamped, matching how **Export results** already worked.
- Scratchpad tile controls (−/+/✕) are now reachable on touch devices and via keyboard tab-through, not just mouse hover.

### A site-wide consistency pass

A round of fixes aimed at accessibility, resilience, and maintainability across the whole app, not tied to one feature:

- **Accessibility**: every icon-only button (⚙ Settings, sort direction, pagination, modal close buttons, mana-color filter toggles, and the main grid's hover-revealed **+** add-to-Deck-Builder button) now has a real `aria-label`, not just a `title` tooltip. The main grid's add button — the single most-used control in the app for getting a card into the Deck Builder — was hover-only with no way to reach it by keyboard or on a touchscreen; it's now reachable via `:focus-visible` and always visible on touch devices, matching the fix already applied to the Deck Builder's own scratchpad tiles.
- **Storage failures are no longer silent.** Every local save (scratchpad, presets, AI settings, collection sync, etc.) used to fail with no trace at all if the browser blocked it (private browsing, storage quota exceeded). Failures are now logged to the console, and the first one in a session shows a brief heads-up in the search bar so you have a chance to notice before losing work.
- **Search results are grouped and sorted once, not repeatedly.** Rendering the grid, switching to Table view, and exporting all used to independently re-group and re-sort the entire filtered result set from scratch. That work is now cached and only redone when the underlying results or sort settings actually change — matters more the larger your collection gets.
- **The AI API key warning is now inline**, not just in this README: a dedicated caution note sits directly under the key field in ⚙ Settings, so the risk (stored in this browser, sent straight to Anthropic, visible in this browser's network requests) is visible at the exact point you'd paste one in.
- **A real automated test suite exists now** (`tests/pure-logic.test.js`) covering the search parser, CSV column-matching/round-trip, card grouping/sorting, and filename helpers — see Testing below.

### A Deck Builder / Commander audit-and-fix pass

A round of fixes and improvements aimed specifically at the Deck Builder and its commander-related features, after a fresh visual + logic review:

- **"Add cards" moved to the top.** Ghost-card-add and decklist import now sit in their own boxed section right under the commander controls, above the checklist/tags/synergies panels — previously a new, empty deck showed three panels of empty state before you'd find how to add anything.
- **Decklist import is easier to find.** Its collapsed summary is now a real blue link-style affordance with a one-line description of what it does, instead of small plain text easy to scroll past.
- **AI-powered buttons look different from regular ones.** "Grade with AI," "Refine with AI," and "Suggest tags with AI" now share a consistent teal outline across the whole app, distinct from both the primary blue actions and the gold used for commander controls — a visual cue that these specifically use your own API key before you click.
- **Commander Synergy tabs are blue by default now**, matching the rest of the app, and only switch to the gold "AI" accent (with a tooltip noting it) when a tab's tags actually came from AI refinement — previously every tab was gold regardless of source, which didn't mean anything.
- **The "these are two separate commanders" note has more visual weight** — a small bordered info box under the Deck Builder's commander row, instead of a line of plain text easy to skim past.
- **Deck size is now adjustable.** The build checklist was hardcoded to 99-card Commander targets; a new "Deck size" field next to it scales every target (lands, ramp, removal, etc.) proportionally, so it's no longer Commander-only.
- **Decklist import ignores non-card lines.** Blank lines, "//" and "#" comments, and common section headers ("Commander," "Sideboard," "Maindeck," etc.) are now skipped instead of becoming bogus ghost cards; a leading "SB:" marker is stripped rather than treated as part of the card name.
- **Decklist import is faster on large collections.** It used to re-scan your entire collection once per copy of every line in the pasted list; it now builds a name lookup once per import instead.
- **Commander Synergies caching is more correct.** The cache used to key partly on your collection's *size*, which wouldn't notice a re-sync that swapped the same number of cards for different ones. It now keys on the collection itself, which is reliable since a sync always replaces it outright rather than editing it in place.
- **Releasing a scratchpad copy is now explained.** Clicking **−** on a card stored in more than one place always releases the most recently pulled copy first — that was already the behavior, it just wasn't visible; hovering the button now says so.

## Keyboard shortcuts

`/` focuses the search box, `s` toggles the Deck Builder tab — both only fire when you're not already typing somewhere. `Esc` closes whatever modal is open.

## Version

A small, low-contrast version number (e.g. `v29`) sits in the bottom-right corner of the page — bump it (and the matching `?v=N` cache-busting query string on `style.css`/`app.js` in `index.html`) any time either file changes, so browsers don't serve a stale cached copy.

## Testing

`tests/pure-logic.test.js` is a small, dependency-free Node test suite covering the app's pure logic: the search query tokenizer/parser, CSV column-matching (including a check that Scrybox's own CSV export headers actually re-import cleanly), card grouping/sorting, filename/slug helpers, `escapeHtml`, and the shared card-detail-line formatter used by both exports and AI grading prompts.

It works without any build step or test framework: at run time it reads the real `app.js` source, extracts just those specific functions by name (brace-matching, not string duplication), and evaluates them in an isolated sandbox. That means the tests always exercise the actual current implementation — if one of those functions changes, the test runs against the new version automatically, with no separate copy to keep in sync and zero risk to `app.js` itself (nothing here modifies or even requires it as a module).

Run it with:

```
node tests/pure-logic.test.js
```

It exits non-zero if anything fails, so it's safe to wire into a CI step if this repo ever gets one. This intentionally doesn't cover DOM rendering, Scryfall API calls, or IndexedDB persistence — those need a real browser and are still verified manually (open the app, do the thing, look at it), same as always.

## Files

- `index.html` — page structure
- `style.css` — Scryfall-inspired styling
- `app.js` — CSV parsing, Scryfall API enrichment, search/filter logic, rendering
- `tests/pure-logic.test.js` — automated tests for the app's pure logic (see Testing above)
- `Start Scrybox.vbs` — silent launcher (starts server + opens Firefox)
- `Start Scrybox (debug).bat` — same, but with a visible console for troubleshooting
