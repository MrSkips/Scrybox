/* Scrybox — search your ManaBox collection, Scryfall-style.
   Everything runs client-side: CSV parsing, Scryfall API enrichment,
   IndexedDB persistence (via localForage), search parsing, filtering, rendering. */

(() => {
  'use strict';

  const STORAGE_KEY = 'scrybox_collection_v1';
  const META_KEY = 'scrybox_meta_v1';
  const SCRATCHPAD_KEY = 'scrybox_scratchpad_v1';
  const EXCLUDED_BINDERS_KEY = 'scrybox_excluded_binders_v1';
  const PRESETS_KEY = 'scrybox_presets_v1';
  const AI_SETTINGS_KEY = 'scrybox_ai_settings_v1';
  const AI_GRADES_KEY = 'scrybox_ai_grades_v1';
  const DECK_COMMANDERS_KEY = 'scrybox_deck_commanders_v1';
  const APP_SETTINGS_KEY = 'scrybox_app_settings_v1';
  const SETS_META_KEY = 'scrybox_sets_meta_v1';
  const SCRYFALL_SETS_URL = 'https://api.scryfall.com/sets';
  const SETS_META_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const SCRATCHPAD_COMMANDER_KEY = 'scrybox_scratchpad_commander_v1';
  const COMMANDER_SYNERGY_TAGS_KEY = 'scrybox_commander_synergy_tags_v1';
  const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
  const PAGE_SIZE = 60;
  const SCRYFALL_COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
  const SCRYFALL_SEARCH_URL = 'https://api.scryfall.com/cards/search';
  const CHUNK_SIZE = 75;
  const MAX_RETRIES = 5;
  const LIVE_OPERATOR_RE = /\b(art|atag|arttag|otag|function):/i;

  const GUILDS = {
    azorius: 'wu', dimir: 'ub', rakdos: 'br', gruul: 'rg', selesnya: 'gw',
    orzhov: 'wb', izzet: 'ur', golgari: 'bg', boros: 'rw', simic: 'gu',
    naya: 'rgw', mardu: 'wbr', abzan: 'wbg', temur: 'ugr', sultai: 'bgu',
    bant: 'gwu', esper: 'wub', grixis: 'ubr', jeskai: 'urw', jund: 'bgr',
    jama: 'wubrg', wubrg: 'wubrg'
  };

  const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };

  // Display names for the Guild/Wedge/Shard Stats breakdown — reuses the
  // GUILDS color-combo map already defined above (used for search parsing).
  const GUILD_DISPLAY_NAMES = {
    azorius: 'Azorius (WU)', dimir: 'Dimir (UB)', rakdos: 'Rakdos (BR)', gruul: 'Gruul (RG)', selesnya: 'Selesnya (GW)',
    orzhov: 'Orzhov (WB)', izzet: 'Izzet (UR)', golgari: 'Golgari (BG)', boros: 'Boros (RW)', simic: 'Simic (GU)',
    naya: 'Naya (RGW)', mardu: 'Mardu (WBR)', abzan: 'Abzan (WBG)', temur: 'Temur (UGR)', sultai: 'Sultai (BGU)',
    bant: 'Bant (GWU)', esper: 'Esper (WUB)', grixis: 'Grixis (UBR)', jeskai: 'Jeskai (URW)', jund: 'Jund (BGR)',
    wubrg: 'Five-Color (WUBRG)'
  };

  // Matches a card's color identity to a guild/wedge/shard name regardless
  // of letter order. Returns null for mono-color/colorless cards.
  function comboNameForColors(colors) {
    const sorted = (colors || []).map((c) => c.toLowerCase()).sort().join('');
    if (sorted.length < 2) return null;
    for (const [name, combo] of Object.entries(GUILDS)) {
      if (name === 'jama') continue; // duplicate alias of wubrg
      if (combo.split('').sort().join('') === sorted) return GUILD_DISPLAY_NAMES[name] || name;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    collection: [],       // full enriched collection (individual printings)
    filtered: [],         // after search + filters (individual printings)
    page: 1,
    sortBy: 'name',
    sortDir: 'asc',
    query: '',
    view: 'collection',   // 'collection' | 'decks' | 'binders' | 'binderDetail'
    activeBinder: null,   // { name, type } when view === 'binderDetail'
    scratchpad: [],        // [{ key, name, image, mana_cost, qty, ghost }]
    excludedBinders: new Set(), // binder/deck names hidden from Collection & Value views
    liveCache: new Map(),  // query string -> Set of Scryfall printing IDs (art:/otag: live search results)
    searchRequestToken: 0, // guards against stale async search responses
    filters: {
      colors: new Set(),
      colorExact: false,
      playstyles: new Set(),
      tags: new Set(),
      mechanicsAnd: new Set(),
      mechanicsOr: new Set(),
      types: new Set(),
      rarities: new Set(),
      ownership: new Set(),
      deckStatus: new Set(),
      minValue: null,
      mvMin: null,
      mvMax: null,
      powMin: null,
      powMax: null,
      touMin: null,
      touMax: null,
      sets: new Set(),
      yearMin: null,
      yearMax: null
    },
    presets: [],           // [{ name, query, filters }] saved searches
    legalityFormat: '',    // format key to highlight non-legal cards against, e.g. 'modern'
    resultsView: 'grid',   // 'grid' | 'table'
    lastSyncedAt: null,    // ISO string, used for the stale-price reminder
    aiSettings: { apiKey: '', model: 'claude-sonnet-5' },
    aiGrades: {},           // deckName -> grade result from the AI grading feature
    deckCommanders: {},     // deckName -> user-set commander card name (overrides AI's guess)
    appSettings: { manaboxTheme: false },
    setsMeta: null,          // set code -> { name, card_count }, lazily fetched from Scryfall
    statsRenderToken: 0,     // guards the async set-completeness render against stale overwrites
    commanderRecs: { commander: null, allCandidates: [], candidates: [] }, // ephemeral, not persisted — recomputed each time
    commanderRecsToken: 0,  // guards the async EDHREC fetch against stale overwrites if the user picks another commander mid-fetch
    scratchpadCommander: '',  // card name (not object — resolved by lookup each time so it survives a re-sync)
    commanderSynergiesActiveTab: 0,
    commanderSynergiesToken: 0,  // guards against a stale async re-render if the commander changes mid-query
    commanderSynergyTags: {}  // { [commanderNameLowercase]: [{label, query}] } — AI-suggested tags, keyed by name (not card id/printing) so they survive a delete + re-add or a re-sync onto a different printing
  };

  const LEGALITY_LABELS = {
    standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern', legacy: 'Legacy',
    vintage: 'Vintage', commander: 'Commander', pauper: 'Pauper'
  };

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const uploadScreen = $('#uploadScreen');
  const app = $('#app');
  const csvInput = $('#csvInput');
  const dropzone = $('#dropzone');
  const uploadStatus = $('#uploadStatus');
  const collectionCountEl = $('#collectionCount');
  const lastSyncedEl = $('#lastSyncedInfo');
  const searchInput = $('#searchInput');
  const searchClearBtn = $('#searchClearBtn');
  const resultCountEl = $('#resultCount');
  const resultsGrid = $('#resultsGrid');
  const emptyState = $('#emptyState');
  const loadingState = $('#loadingState');
  const sortSelect = $('#sortSelect');
  const clearFiltersBtn = $('#clearFiltersBtn');
  const mechanicsChipsEl = $('#mechanicsChips');
  const setChipsEl = $('#setChips');
  const mvMinInput = $('#mvMinInput');
  const mvMaxInput = $('#mvMaxInput');
  const powMinInput = $('#powMinInput');
  const powMaxInput = $('#powMaxInput');
  const touMinInput = $('#touMinInput');
  const touMaxInput = $('#touMaxInput');
  const yearMinInput = $('#yearMinInput');
  const yearMaxInput = $('#yearMaxInput');
  const paginationBottom = $('#paginationBottom');
  const paginationTop = $('#paginationTop');
  const folderScreen = $('#folderScreen');
  const folderScreenTitle = $('#folderScreenTitle');
  const folderScreenSub = $('#folderScreenSub');
  const folderGrid = $('#folderGrid');
  const folderEmptyState = $('#folderEmptyState');
  const scopeBanner = $('#scopeBanner');
  const scopeBannerName = $('#scopeBannerName');
  const syncStatusEl = $('#syncStatus');
  const scratchpadCountEl = $('#scratchpadCount');
  const scratchpadGrid = $('#scratchpadGrid');
  const scratchpadEmpty = $('#scratchpadEmpty');
  const totalValueEl = $('#totalValueInfo');
  const valueToolbar = $('#valueToolbar');
  const valueTotalEl = $('#valueTotal');
  const minValueInput = $('#minValueInput');
  const pullPickerModal = $('#pullPickerModal');
  const pullPickerCardName = $('#pullPickerCardName');
  const pullPickerList = $('#pullPickerList');
  const staleReminderEl = $('#staleReminder');
  const statsScreen = $('#statsScreen');
  const deckBuilderScreen = $('#deckBuilderScreen');
  const statsEmpty = $('#statsEmpty');
  const statsBody = $('#statsBody');
  const presetSelect = $('#presetSelect');
  const formatLegalitySelect = $('#formatLegalitySelect');
  const viewGridBtn = $('#viewGridBtn');
  const viewTableBtn = $('#viewTableBtn');
  const resultsTableWrap = $('#resultsTableWrap');
  const resultsTableBody = $('#resultsTableBody');
  const undoToast = $('#undoToast');
  const undoToastMessage = $('#undoToastMessage');
  const undoToastBtn = $('#undoToastBtn');
  const aiApiKeyInput = $('#aiApiKeyInput');
  const aiModelSelect = $('#aiModelSelect');
  const aiSettingsStatus = $('#aiSettingsStatus');
  const deckGradePanel = $('#deckGradePanel');
  const gradeWithAiBtn = $('#gradeWithAiBtn');
  const copyGradePromptBtn = $('#copyGradePromptBtn');
  const deckGradeStatus = $('#deckGradeStatus');
  const deckGradeResults = $('#deckGradeResults');
  const pasteGradeToggleBtn = $('#pasteGradeToggleBtn');
  const pasteGradeRow = $('#pasteGradeRow');
  const pasteGradeInput = $('#pasteGradeInput');
  const pasteGradeSubmitBtn = $('#pasteGradeSubmitBtn');
  const deckCommanderDisplay = $('#deckCommanderDisplay');
  const setCommanderBtn = $('#setCommanderBtn');
  const setCommanderRow = $('#setCommanderRow');
  const setCommanderInput = $('#setCommanderInput');
  const setCommanderOptions = $('#setCommanderOptions');
  const setCommanderSaveBtn = $('#setCommanderSaveBtn');
  const setCommanderClearBtn = $('#setCommanderClearBtn');
  const setCommanderCancelBtn = $('#setCommanderCancelBtn');
  const generalSettingsBtn = $('#generalSettingsBtn');
  const settingsModal = $('#settingsModal');
  const manaboxThemeToggle = $('#manaboxThemeToggle');
  const commanderRecsBtn = $('#commanderRecsBtn');
  const commanderPickerModal = $('#commanderPickerModal');
  const commanderPickerInput = $('#commanderPickerInput');
  const commanderPickerOptions = $('#commanderPickerOptions');
  const commanderPickerSubmitBtn = $('#commanderPickerSubmitBtn');
  const commanderPickerStatus = $('#commanderPickerStatus');
  const commanderRecsModal = $('#commanderRecsModal');
  const commanderRecsTitle = $('#commanderRecsTitle');
  const commanderRecsRefineBtn = $('#commanderRecsRefineBtn');
  const commanderRecsStatus = $('#commanderRecsStatus');
  const commanderRecsList = $('#commanderRecsList');
  const scratchCommanderDisplay = $('#scratchCommanderDisplay');
  const scratchSetCommanderBtn = $('#scratchSetCommanderBtn');
  const scratchSetCommanderRow = $('#scratchSetCommanderRow');
  const scratchCommanderInput = $('#scratchCommanderInput');
  const scratchCommanderOptions = $('#scratchCommanderOptions');
  const scratchCommanderSaveBtn = $('#scratchCommanderSaveBtn');
  const scratchCommanderClearBtn = $('#scratchCommanderClearBtn');
  const scratchCommanderCancelBtn = $('#scratchCommanderCancelBtn');
  const deckBuilderPanel = $('#deckBuilderPanel');
  const deckBuilderTags = $('#deckBuilderTags');
  const deckBuilderChecklist = $('#deckBuilderChecklist');
  const commanderSynergiesPanel = $('#commanderSynergiesPanel');
  const commanderSynergiesTabs = $('#commanderSynergiesTabs');
  const commanderSynergiesContent = $('#commanderSynergiesContent');

  let lastOpenModal = null; // { group, selectedIndex } — tracked so we can refresh the modal after a pull
  let pendingUndo = null;   // { message, action } — set while the undo toast is showing

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  async function init() {
    bindUploadEvents();
    bindSearchEvents();
    bindFilterEvents();
    bindModalEvents();
    bindNavEvents();
    bindScratchpadEvents();
    bindPresetEvents();
    bindBackupEvents();
    bindViewToggleEvents();
    bindDecklistImportEvents();
    bindUndoToastEvents();
    bindKeyboardShortcuts();
    bindAiSettingsEvents();
    bindDeckGradeEvents();
    bindSetCommanderEvents();
    bindGeneralSettingsEvents();
    bindCommanderRecsEvents();
    bindScratchCommanderEvents();

    let cached = null;
    let meta = null;
    let scratch = null;
    let excluded = null;
    let presets = null;
    let aiSettings = null;
    let aiGrades = null;
    let deckCommanders = null;
    let appSettings = null;
    let scratchpadCommander = null;
    let commanderSynergyTags = null;
    try {
      cached = await localforage.getItem(STORAGE_KEY);
      meta = await localforage.getItem(META_KEY);
      scratch = await localforage.getItem(SCRATCHPAD_KEY);
      excluded = await localforage.getItem(EXCLUDED_BINDERS_KEY);
      presets = await localforage.getItem(PRESETS_KEY);
      aiSettings = await localforage.getItem(AI_SETTINGS_KEY);
      aiGrades = await localforage.getItem(AI_GRADES_KEY);
      deckCommanders = await localforage.getItem(DECK_COMMANDERS_KEY);
      appSettings = await localforage.getItem(APP_SETTINGS_KEY);
      scratchpadCommander = await localforage.getItem(SCRATCHPAD_COMMANDER_KEY);
      commanderSynergyTags = await localforage.getItem(COMMANDER_SYNERGY_TAGS_KEY);
    } catch (err) {
      setStatus('This browser is blocking local storage (e.g. private browsing) — you\'ll need to re-upload your CSV each time.', true);
    }

    if (scratch && Array.isArray(scratch)) state.scratchpad = scratch;
    if (typeof scratchpadCommander === 'string') state.scratchpadCommander = scratchpadCommander;
    if (commanderSynergyTags && typeof commanderSynergyTags === 'object') state.commanderSynergyTags = commanderSynergyTags;

    if (excluded && Array.isArray(excluded)) state.excludedBinders = new Set(excluded);
    if (presets && Array.isArray(presets)) state.presets = presets;
    renderPresetOptions();
    if (aiSettings && typeof aiSettings === 'object') state.aiSettings = Object.assign(state.aiSettings, aiSettings);
    if (aiGrades && typeof aiGrades === 'object') state.aiGrades = aiGrades;
    if (deckCommanders && typeof deckCommanders === 'object') state.deckCommanders = deckCommanders;
    if (appSettings && typeof appSettings === 'object') state.appSettings = Object.assign(state.appSettings, appSettings);
    applyTheme();

    if (cached && Array.isArray(cached) && cached.length) {
      state.collection = cached;
      showApp(meta);
      runSearch();
    }

    // Rendered after state.collection is populated so the scratchpad
    // commander (if any) can actually resolve to a real card object.
    renderScratchpad();
  }

  function persistExcludedBinders() {
    localforage.setItem(EXCLUDED_BINDERS_KEY, Array.from(state.excludedBinders)).catch(() => {});
  }

  function setActiveNav(id) {
    document.querySelectorAll('.topnav a').forEach((a) => a.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
  }

  function formatSyncedAt(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return `synced ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    } catch (e) {
      return '';
    }
  }

  function showApp(meta) {
    uploadScreen.classList.add('hidden');
    folderScreen.classList.add('hidden');
    statsScreen.classList.add('hidden');
    deckBuilderScreen.classList.add('hidden');
    app.classList.remove('hidden');
    state.view = 'collection';
    state.activeBinder = null;
    scopeBanner.classList.add('hidden');
    deckGradePanel.classList.add('hidden');
    valueToolbar.classList.add('hidden');
    setActiveNav('navCollection');
    collectionCountEl.textContent = `${state.collection.length.toLocaleString()} unique cards imported`;
    state.lastSyncedAt = meta && meta.syncedAt ? meta.syncedAt : null;
    lastSyncedEl.textContent = state.lastSyncedAt ? formatSyncedAt(state.lastSyncedAt) : '';
    buildMechanicsChips();
    buildSetChips();
    updateHeaderTotalValue();
    updateStaleReminder();
  }

  // Nudges toward "refresh prices" once data's gotten old enough that
  // prices/oracle text are likely stale, without being naggy about it.
  const STALE_DAYS_THRESHOLD = 14;
  function updateStaleReminder() {
    if (!state.lastSyncedAt) { staleReminderEl.classList.add('hidden'); return; }
    const days = Math.floor((Date.now() - new Date(state.lastSyncedAt).getTime()) / 86400000);
    if (days >= STALE_DAYS_THRESHOLD) {
      staleReminderEl.textContent = `Prices last refreshed ${days} days ago`;
      staleReminderEl.classList.remove('hidden');
    } else {
      staleReminderEl.classList.add('hidden');
    }
  }

  function showUpload() {
    app.classList.add('hidden');
    folderScreen.classList.add('hidden');
    statsScreen.classList.add('hidden');
    deckBuilderScreen.classList.add('hidden');
    uploadScreen.classList.remove('hidden');
  }

  function showCollectionView() {
    state.view = 'collection';
    state.activeBinder = null;
    setActiveNav('navCollection');
    scopeBanner.classList.add('hidden');
    deckGradePanel.classList.add('hidden');
    valueToolbar.classList.add('hidden');
    folderScreen.classList.add('hidden');
    uploadScreen.classList.add('hidden');
    statsScreen.classList.add('hidden');
    deckBuilderScreen.classList.add('hidden');
    app.classList.remove('hidden');
    runSearch();
  }

  function showValueView() {
    state.view = 'value';
    state.activeBinder = null;
    setActiveNav('navValue');
    scopeBanner.classList.add('hidden');
    deckGradePanel.classList.add('hidden');
    folderScreen.classList.add('hidden');
    uploadScreen.classList.add('hidden');
    statsScreen.classList.add('hidden');
    deckBuilderScreen.classList.add('hidden');
    app.classList.remove('hidden');
    valueToolbar.classList.remove('hidden');
    state.sortBy = 'price';
    sortSelect.value = 'price';
    state.sortDir = 'desc';
    $('#sortDirBtn').textContent = 'Desc ↓';
    runSearch();
  }

  function showStatsView() {
    state.view = 'stats';
    setActiveNav('navStats');
    app.classList.add('hidden');
    folderScreen.classList.add('hidden');
    uploadScreen.classList.add('hidden');
    deckBuilderScreen.classList.add('hidden');
    statsScreen.classList.remove('hidden');
    renderStats();
  }

  function showDeckBuilderView() {
    state.view = 'deckBuilder';
    setActiveNav('navDeckBuilder');
    app.classList.add('hidden');
    folderScreen.classList.add('hidden');
    uploadScreen.classList.add('hidden');
    statsScreen.classList.add('hidden');
    deckBuilderScreen.classList.remove('hidden');
    renderScratchpad();
  }

  // ---------------------------------------------------------------------
  // Stats dashboard — pure aggregation over the whole (unfiltered) collection,
  // excluding binders the user has marked "hide from collection" so it
  // matches what Collection/Value show.
  // ---------------------------------------------------------------------
  function statsScopedCards() {
    if (!state.excludedBinders.size) return state.collection;
    return state.collection.filter((c) => !(c._binders || []).some((b) => state.excludedBinders.has(b.name)));
  }


  // `total` is the denominator the bar is proportional to — e.g. the whole
  // collection's card count, not just the largest value in this particular
  // breakdown — so a bar only fills all the way if it really is ~100% of
  // the total, not just the biggest of a handful of small numbers.
  function makeBarRow(label, count, total) {
    const row = document.createElement('div');
    row.className = 'stats-bar-row';
    const pct = total ? Math.max(2, Math.round((count / total) * 100)) : 0;
    row.innerHTML =
      `<span class="stats-bar-label">${escapeHtml(label)}</span>` +
      `<span class="stats-bar-track"><span class="stats-bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="stats-bar-count">${count.toLocaleString()}</span>`;
    return row;
  }

  function makeStatsListRow(name, meta) {
    const row = document.createElement('div');
    row.className = 'stats-list-row';
    row.innerHTML = `<span class="sl-name">${escapeHtml(name)}</span><span class="sl-meta">${escapeHtml(meta)}</span>`;
    return row;
  }

  // A bar row for "N/M (X%)" style completeness — same visual language as
  // makeBarRow, but the fraction/percentage is spelled out in the count
  // column instead of a raw number, since the denominator differs per row.
  function makeCompletionBarRow(label, owned, setTotal) {
    const row = document.createElement('div');
    row.className = 'stats-bar-row';
    const exactPct = setTotal ? Math.min(100, (owned / setTotal) * 100) : 0;
    const displayPct = setTotal ? Math.max(2, Math.round(exactPct)) : 0;
    row.innerHTML =
      `<span class="stats-bar-label">${escapeHtml(label)}</span>` +
      `<span class="stats-bar-track"><span class="stats-bar-fill" style="width:${displayPct}%"></span></span>` +
      `<span class="stats-bar-count stats-bar-count-wide">${owned}/${setTotal} (${Math.round(exactPct)}%)</span>`;
    return row;
  }

  // Like makeBarRow, but the count column shows a dollar amount and the bar
  // is proportional to a dollar total instead of a card-count total.
  function makeValueBarRow(label, value, totalValue) {
    const row = document.createElement('div');
    row.className = 'stats-bar-row';
    const pct = totalValue ? Math.max(2, Math.round((value / totalValue) * 100)) : 0;
    row.innerHTML =
      `<span class="stats-bar-label">${escapeHtml(label)}</span>` +
      `<span class="stats-bar-track"><span class="stats-bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="stats-bar-count stats-bar-count-wide">$${value.toFixed(2)}</span>`;
    return row;
  }

  // Set metadata (official card_count per set) isn't in the local collection
  // data at all — it has to come from Scryfall's /sets endpoint. Fetched
  // once and cached for 30 days since set lists change slowly.
  async function ensureSetsMeta() {
    if (state.setsMeta) return state.setsMeta;
    try {
      const cached = await localforage.getItem(SETS_META_KEY);
      if (cached && cached.map && cached.fetchedAt && (Date.now() - cached.fetchedAt) < SETS_META_MAX_AGE_MS) {
        state.setsMeta = cached.map;
        return state.setsMeta;
      }
    } catch (err) { /* fall through to a fresh fetch */ }

    const resp = await fetch(SCRYFALL_SETS_URL);
    if (!resp.ok) throw new Error(`Scryfall returned HTTP ${resp.status}`);
    const data = await resp.json();
    const map = {};
    (data.data || []).forEach((s) => { map[s.code] = { name: s.name, card_count: s.card_count }; });
    state.setsMeta = map;
    localforage.setItem(SETS_META_KEY, { map, fetchedAt: Date.now() }).catch(() => {});
    return map;
  }

  // Renders asynchronously into #statsCompletionBars, separately from the
  // rest of renderStats (which is synchronous) — this is the one Stats
  // section that needs a network call. token guards against a stale
  // response landing after the user has navigated away and back.
  function renderSetCompleteness(cards) {
    const token = ++state.statsRenderToken;
    const el = $('#statsCompletionBars');
    el.innerHTML = '<div class="stats-empty-note">Loading set completeness from Scryfall…</div>';

    ensureSetsMeta().then((setsMeta) => {
      if (token !== state.statsRenderToken) return;

      const ownedBySet = {};
      cards.forEach((c) => { if (c.set) ownedBySet[c.set] = (ownedBySet[c.set] || 0) + 1; });

      const rows = Object.entries(ownedBySet)
        .map(([code, owned]) => {
          const meta = setsMeta[code];
          if (!meta || !meta.card_count) return null;
          return { name: meta.name || code.toUpperCase(), owned, total: meta.card_count, pct: owned / meta.card_count };
        })
        .filter(Boolean)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, 10);

      el.innerHTML = '';
      if (!rows.length) {
        el.innerHTML = '<div class="stats-empty-note">No matching set data yet.</div>';
        return;
      }
      rows.forEach((r) => el.appendChild(makeCompletionBarRow(r.name, r.owned, r.total)));
    }).catch((err) => {
      if (token !== state.statsRenderToken) return;
      el.innerHTML = `<div class="stats-empty-note">Couldn't load set completeness (${escapeHtml(err.message)}) — check your connection and reopen Stats to retry.</div>`;
    });
  }

  function renderStats() {
    const cards = statsScopedCards();
    if (!cards.length) {
      statsEmpty.classList.remove('hidden');
      statsBody.classList.add('hidden');
      return;
    }
    statsEmpty.classList.add('hidden');
    statsBody.classList.remove('hidden');

    const uniqueCount = cards.length;
    const totalQty = cards.reduce((s, c) => s + c.qtyFoil + c.qtyNonfoil, 0);
    const totalValue = cards.reduce((s, c) => s + computeCardValue(c), 0);
    const foilCount = cards.reduce((s, c) => s + c.qtyFoil, 0);

    $('#statsSummaryRow').innerHTML = '';
    [
      ['Unique cards', uniqueCount.toLocaleString()],
      ['Total copies owned', totalQty.toLocaleString()],
      ['Foil copies', foilCount.toLocaleString()],
      ['Estimated value', `$${totalValue.toFixed(2)}`]
    ].forEach(([label, value]) => {
      const item = document.createElement('div');
      item.className = 'stats-summary-item';
      item.innerHTML = `<span class="stat-value">${value}</span><span class="stat-label">${label}</span>`;
      $('#statsSummaryRow').appendChild(item);
    });

    // Color identity breakdown (mono W/U/B/R/G, colorless, multicolor)
    const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0, Colorless: 0, Multicolor: 0 };
    cards.forEach((c) => {
      const ci = c.color_identity || [];
      if (ci.length === 0) colorCounts.Colorless++;
      else if (ci.length > 1) colorCounts.Multicolor++;
      else colorCounts[ci[0]] = (colorCounts[ci[0]] || 0) + 1;
    });
    const colorBarsEl = $('#statsColorBars');
    colorBarsEl.innerHTML = '';
    Object.entries(colorCounts).forEach(([label, count]) => colorBarsEl.appendChild(makeBarRow(label, count, uniqueCount)));

    // Mana curve (0-7+)
    const curve = {};
    for (let i = 0; i <= 7; i++) curve[i] = 0;
    cards.forEach((c) => {
      if ((c.type_line || '').toLowerCase().includes('land')) return;
      const mv = Math.min(7, Math.floor(c.cmc || 0));
      curve[mv] = (curve[mv] || 0) + 1;
    });
    const curveTotal = Object.values(curve).reduce((a, b) => a + b, 0);
    const curveEl = $('#statsCurveBars');
    curveEl.innerHTML = '';
    Object.entries(curve).forEach(([mv, count]) => curveEl.appendChild(makeBarRow(mv === '7' ? '7+' : mv, count, curveTotal)));

    // Rarity split
    const rarityCounts = {};
    cards.forEach((c) => { rarityCounts[c.rarity] = (rarityCounts[c.rarity] || 0) + 1; });
    const rarityEl = $('#statsRarityBars');
    rarityEl.innerHTML = '';
    Object.entries(rarityCounts)
      .sort((a, b) => (RARITY_ORDER[b[0]] || 0) - (RARITY_ORDER[a[0]] || 0))
      .forEach(([label, count]) => rarityEl.appendChild(makeBarRow(label, count, uniqueCount)));

    // Card type breakdown (primary type word)
    const typeCounts = {};
    const primaryTypes = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Battle'];
    cards.forEach((c) => {
      const tl = c.type_line || '';
      const match = primaryTypes.find((t) => tl.includes(t)) || 'Other';
      typeCounts[match] = (typeCounts[match] || 0) + 1;
    });
    const typeEl = $('#statsTypeBars');
    typeEl.innerHTML = '';
    Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([label, count]) => typeEl.appendChild(makeBarRow(label, count, uniqueCount)));

    // Top sets by card count (unique printings)
    const setCounts = {};
    cards.forEach((c) => {
      const label = c.set_name || (c.set || '').toUpperCase() || 'Unknown set';
      setCounts[label] = (setCounts[label] || 0) + 1;
    });
    const topSets = Object.entries(setCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const setBarsEl = $('#statsSetBars');
    setBarsEl.innerHTML = '';
    topSets.forEach(([label, count]) => setBarsEl.appendChild(makeBarRow(label, count, uniqueCount)));

    // Top 10 most valuable (single highest-value printing of each name)
    const topValuableEl = $('#statsTopValuable');
    topValuableEl.innerHTML = '';
    cards.slice()
      .sort((a, b) => priceOf(b) - priceOf(a))
      .slice(0, 10)
      .forEach((c) => topValuableEl.appendChild(makeStatsListRow(c.name, `$${priceOf(c).toFixed(2)} · ${c.set_name}`)));

    // Oldest / newest printings
    const withDates = cards.filter((c) => c.released_at);
    const oldestEl = $('#statsOldest');
    oldestEl.innerHTML = '';
    withDates.slice().sort((a, b) => a.released_at.localeCompare(b.released_at)).slice(0, 10)
      .forEach((c) => oldestEl.appendChild(makeStatsListRow(c.name, `${c.released_at} · ${c.set_name}`)));

    const newestEl = $('#statsNewest');
    newestEl.innerHTML = '';
    withDates.slice().sort((a, b) => b.released_at.localeCompare(a.released_at)).slice(0, 10)
      .forEach((c) => newestEl.appendChild(makeStatsListRow(c.name, `${c.released_at} · ${c.set_name}`)));

    // Format legality coverage — % of unique cards legal in each format.
    const legalityEl = $('#statsLegalityBars');
    legalityEl.innerHTML = '';
    Object.entries(LEGALITY_LABELS).forEach(([key, label]) => {
      const count = cards.filter((c) => c.legalities && c.legalities[key] === 'legal').length;
      legalityEl.appendChild(makeBarRow(label, count, uniqueCount));
    });

    // Value distribution — how many unique cards fall into each price bucket.
    const valueBuckets = [
      { label: '$0–1', min: 0, max: 1 },
      { label: '$1–5', min: 1, max: 5 },
      { label: '$5–20', min: 5, max: 20 },
      { label: '$20–50', min: 20, max: 50 },
      { label: '$50+', min: 50, max: Infinity }
    ];
    const valueBucketCounts = valueBuckets.map(() => 0);
    cards.forEach((c) => {
      const v = priceOf(c);
      const idx = valueBuckets.findIndex((b) => v >= b.min && v < b.max);
      valueBucketCounts[idx === -1 ? valueBuckets.length - 1 : idx]++;
    });
    const valueDistEl = $('#statsValueDistBars');
    valueDistEl.innerHTML = '';
    valueBuckets.forEach((b, i) => valueDistEl.appendChild(makeBarRow(b.label, valueBucketCounts[i], uniqueCount)));

    // Guild/wedge/shard breakdown — only multicolor cards, proportional to
    // the total number of multicolor cards owned (not the whole collection).
    const guildCounts = {};
    cards.forEach((c) => {
      const name = comboNameForColors(c.color_identity);
      if (name) guildCounts[name] = (guildCounts[name] || 0) + 1;
    });
    const guildTotal = Object.values(guildCounts).reduce((a, b) => a + b, 0);
    const guildEl = $('#statsGuildBars');
    guildEl.innerHTML = '';
    if (!guildTotal) {
      guildEl.innerHTML = '<div class="stats-empty-note">No multicolor cards yet.</div>';
    } else {
      Object.entries(guildCounts).sort((a, b) => b[1] - a[1]).forEach(([label, count]) => guildEl.appendChild(makeBarRow(label, count, guildTotal)));
    }

    // Top 10 keywords across the collection.
    const keywordCounts = {};
    cards.forEach((c) => { (c.keywords || []).forEach((k) => { keywordCounts[k] = (keywordCounts[k] || 0) + 1; }); });
    const topKeywords = Object.entries(keywordCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const keywordEl = $('#statsKeywordBars');
    keywordEl.innerHTML = '';
    if (!topKeywords.length) {
      keywordEl.innerHTML = '<div class="stats-empty-note">No keyword data yet.</div>';
    } else {
      topKeywords.forEach(([label, count]) => keywordEl.appendChild(makeBarRow(label, count, uniqueCount)));
    }

    // Top 10 artists by card count.
    const artistCounts = {};
    cards.forEach((c) => { const a = c.artist || 'Unknown'; artistCounts[a] = (artistCounts[a] || 0) + 1; });
    const topArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const artistEl = $('#statsArtistBars');
    artistEl.innerHTML = '';
    topArtists.forEach(([label, count]) => artistEl.appendChild(makeBarRow(label, count, uniqueCount)));

    // Top sets by total dollar value (vs. the earlier "by card count" chart).
    const setValues = {};
    cards.forEach((c) => {
      const label = c.set_name || (c.set || '').toUpperCase() || 'Unknown set';
      setValues[label] = (setValues[label] || 0) + computeCardValue(c);
    });
    const topSetValues = Object.entries(setValues).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const setValueEl = $('#statsSetValueBars');
    setValueEl.innerHTML = '';
    topSetValues.forEach(([label, value]) => setValueEl.appendChild(makeValueBarRow(label, value, totalValue)));

    // Special printings summary — full art / promo / textless / Reserved List counts.
    $('#statsSpecialSummary').innerHTML = '';
    [
      ['Full art', cards.filter((c) => c.full_art).length],
      ['Promo', cards.filter((c) => c.promo).length],
      ['Textless', cards.filter((c) => c.textless).length],
      ['Reserved List', cards.filter((c) => c.reserved).length]
    ].forEach(([label, value]) => {
      const item = document.createElement('div');
      item.className = 'stats-summary-item';
      item.innerHTML = `<span class="stat-value">${value.toLocaleString()}</span><span class="stat-label">${label}</span>`;
      $('#statsSpecialSummary').appendChild(item);
    });

    renderSetCompleteness(cards);
  }

  // Total value across the WHOLE collection (unfiltered), shown subtly
  // in the top-right of the header at all times.
  function computeCardValue(card) {
    const p = card.prices || {};
    const nonfoilPrice = parseFloat(p.usd || 0) || 0;
    const foilPrice = parseFloat(p.usd_foil || p.usd || 0) || 0;
    return (card.qtyNonfoil || 0) * nonfoilPrice + (card.qtyFoil || 0) * foilPrice;
  }

  function updateHeaderTotalValue() {
    if (!state.collection.length) {
      totalValueEl.textContent = '';
      return;
    }
    const total = state.collection.reduce((sum, c) => sum + computeCardValue(c), 0);
    totalValueEl.textContent = `≈$${total.toFixed(2)} total value`;
  }

  function bindNavEvents() {
    $('#navCollection').addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.collection.length) { showUpload(); return; }
      showCollectionView();
    });
    $('#navDecks').addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.collection.length) { showUpload(); return; }
      showFolderScreen('decks');
    });
    $('#navBinders').addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.collection.length) { showUpload(); return; }
      showFolderScreen('binders');
    });
    $('#navValue').addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.collection.length) { showUpload(); return; }
      showValueView();
    });
    $('#navStats').addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.collection.length) { showUpload(); return; }
      showStatsView();
    });
    $('#navDeckBuilder').addEventListener('click', (e) => {
      e.preventDefault();
      if (!state.collection.length) { showUpload(); return; }
      showDeckBuilderView();
    });
    $('#scopeBannerBack').addEventListener('click', () => showCollectionView());
    $('#refreshPricesLink').addEventListener('click', (e) => {
      e.preventDefault();
      refreshPrices();
    });
    minValueInput.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.filters.minValue = isNaN(v) || e.target.value === '' ? null : v;
      runSearch();
    });
    bindRangeInput(mvMinInput, 'mvMin');
    bindRangeInput(mvMaxInput, 'mvMax');
    bindRangeInput(powMinInput, 'powMin');
    bindRangeInput(powMaxInput, 'powMax');
    bindRangeInput(touMinInput, 'touMin');
    bindRangeInput(touMaxInput, 'touMax');
    bindRangeInput(yearMinInput, 'yearMin');
    bindRangeInput(yearMaxInput, 'yearMax');
  }

  // Wires a number <input> to a numeric state.filters field, treating an
  // empty/invalid value as "no bound".
  function bindRangeInput(inputEl, filterKey) {
    inputEl.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.filters[filterKey] = (e.target.value === '' || isNaN(v)) ? null : v;
      runSearch();
    });
  }

  // ---------------------------------------------------------------------
  // Decks / Binders
  // ---------------------------------------------------------------------
  function computeFolderIndex(kind) {
    const wantDeck = kind === 'decks';
    const map = new Map();
    state.collection.map(applyPullAdjustment).forEach((card) => {
      (card._binders || []).forEach((b) => {
        const isDeck = b.type === 'deck';
        if (isDeck !== wantDeck) return;
        if (!map.has(b.name)) map.set(b.name, { name: b.name, type: b.type, uniqueCount: 0, totalQty: 0, sampleImage: null });
        const entry = map.get(b.name);
        entry.uniqueCount += 1;
        entry.totalQty += (b.qtyFoil + b.qtyNonfoil);
        if (!entry.sampleImage && card.image) entry.sampleImage = card.image;
      });
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  function showFolderScreen(kind) {
    state.view = kind;
    app.classList.add('hidden');
    uploadScreen.classList.add('hidden');
    statsScreen.classList.add('hidden');
    deckBuilderScreen.classList.add('hidden');
    valueToolbar.classList.add('hidden');
    folderScreen.classList.remove('hidden');
    setActiveNav(kind === 'decks' ? 'navDecks' : 'navBinders');

    const list = computeFolderIndex(kind);
    folderScreenTitle.textContent = kind === 'decks' ? 'Decks' : 'Binders';
    folderScreenSub.textContent = kind === 'decks'
      ? 'Decks registered in your ManaBox collection.'
      : 'Binders / lists from your ManaBox collection.';

    folderGrid.innerHTML = '';
    if (!list.length) {
      folderEmptyState.textContent = kind === 'decks'
        ? "No decks found. Either you haven't registered any decks in ManaBox's collection, or your CSV export didn't include binder/deck info."
        : "No binders found in this CSV export.";
      folderEmptyState.classList.remove('hidden');
      return;
    }
    folderEmptyState.classList.add('hidden');

    const frag = document.createDocumentFragment();
    list.forEach((entry) => frag.appendChild(renderFolderTile(entry)));
    folderGrid.appendChild(frag);
  }

  function renderFolderTile(entry) {
    const tile = document.createElement('div');
    tile.className = 'folder-tile';

    const img = document.createElement('img');
    img.className = 'folder-tile-image';
    img.loading = 'lazy';
    if (entry.sampleImage) img.src = entry.sampleImage;
    tile.appendChild(img);

    const body = document.createElement('div');
    body.className = 'folder-tile-body';
    body.innerHTML = `
      <div class="folder-tile-name">${escapeHtml(entry.name)}</div>
      <div class="folder-tile-meta">${entry.uniqueCount.toLocaleString()} unique · ${entry.totalQty.toLocaleString()} total</div>
      <span class="folder-tile-badge">${entry.type}</span>
    `;

    if (entry.type === 'deck' && state.aiGrades[entry.name]) {
      const scoresRow = document.createElement('div');
      scoresRow.className = 'folder-tile-scores';
      scoresRow.innerHTML = gradeBadgesHtml(state.aiGrades[entry.name]) + ' <span class="fg-hint">click to view</span>';
      body.appendChild(scoresRow);
    }

    const excludeLabel = document.createElement('label');
    excludeLabel.className = 'folder-exclude-row';
    excludeLabel.addEventListener('click', (e) => e.stopPropagation());
    const excludeCb = document.createElement('input');
    excludeCb.type = 'checkbox';
    excludeCb.checked = state.excludedBinders.has(entry.name);
    excludeCb.addEventListener('change', () => {
      if (excludeCb.checked) state.excludedBinders.add(entry.name);
      else state.excludedBinders.delete(entry.name);
      persistExcludedBinders();
      updateHeaderTotalValue();
      runSearch();
    });
    excludeLabel.appendChild(excludeCb);
    excludeLabel.appendChild(document.createTextNode(' Hide from Collection'));
    body.appendChild(excludeLabel);

    tile.appendChild(body);

    tile.addEventListener('click', () => openBinderDetail(entry));
    return tile;
  }

  function openBinderDetail(entry) {
    state.view = 'binderDetail';
    state.activeBinder = entry;
    folderScreen.classList.add('hidden');
    uploadScreen.classList.add('hidden');
    statsScreen.classList.add('hidden');
    deckBuilderScreen.classList.add('hidden');
    valueToolbar.classList.add('hidden');
    app.classList.remove('hidden');
    setActiveNav(entry.type === 'deck' ? 'navDecks' : 'navBinders');

    scopeBannerName.textContent = `${entry.type === 'deck' ? 'deck' : 'binder'}: ${entry.name}`;
    scopeBanner.classList.remove('hidden');

    if (entry.type === 'deck') {
      deckGradePanel.classList.remove('hidden');
      renderDeckCommanderRow(entry.name);
      renderDeckGradePanel(entry.name);
    } else {
      deckGradePanel.classList.add('hidden');
    }

    searchInput.value = '';
    state.query = '';
    runSearch();
  }

  function getScopedCollection() {
    if (state.view === 'binderDetail' && state.activeBinder) {
      const name = state.activeBinder.name;
      return state.collection.filter((c) => (c._binders || []).some((b) => b.name === name));
    }
    // Collection & Value views: drop cards that belong to any binder/deck
    // the user has marked "hide from Collection" — they're still viewable
    // by opening that specific binder/deck directly.
    if (state.excludedBinders.size) {
      return state.collection.filter((c) => !(c._binders || []).some((b) => state.excludedBinders.has(b.name)));
    }
    return state.collection;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------
  // Upload handling
  // ---------------------------------------------------------------------
  function bindUploadEvents() {
    dropzone.addEventListener('click', () => csvInput.click());
    csvInput.addEventListener('change', (e) => {
      if (e.target.files[0]) handleFile(e.target.files[0]);
    });
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    $('#navUpload').addEventListener('click', (e) => {
      e.preventDefault();
      showUpload();
    });
    $('#resyncLink').addEventListener('click', (e) => {
      e.preventDefault();
      showUpload();
    });
    $('#logoLink').addEventListener('click', (e) => e.preventDefault());
    $('#resetCollectionBtn').addEventListener('click', resetCollection);
  }

  async function resetCollection() {
    if (!state.collection.length) {
      setStatus('Nothing to reset — no collection loaded yet.');
      return;
    }
    const ok = window.confirm(
      `This will permanently clear your cached collection (${state.collection.length.toLocaleString()} cards, quantities, and binder/deck data) from this browser. ` +
      `Your next CSV upload will start completely fresh instead of syncing against it. This can't be undone. Continue?`
    );
    if (!ok) return;

    const snapshotCollection = state.collection;
    const snapshotMeta = { count: snapshotCollection.length, syncedAt: state.lastSyncedAt };

    try {
      await localforage.removeItem(STORAGE_KEY);
      await localforage.removeItem(META_KEY);
    } catch (err) {
      // ignore — we still reset in-memory state below
    }

    state.collection = [];
    state.filtered = [];
    collectionCountEl.textContent = '';
    lastSyncedEl.textContent = '';
    totalValueEl.textContent = '';
    csvInput.value = '';
    showUpload();
    setStatus('Collection cleared. Upload a CSV to start fresh.');

    showUndoToast(`Cleared ${snapshotCollection.length.toLocaleString()} cards.`, async () => {
      state.collection = snapshotCollection;
      try {
        await localforage.setItem(STORAGE_KEY, snapshotCollection);
        await localforage.setItem(META_KEY, snapshotMeta);
      } catch (err) {
        // non-fatal — in-memory state is restored either way
      }
      showApp(snapshotMeta);
      runSearch();
    });
  }

  function setStatus(msg, isError) {
    uploadStatus.textContent = msg;
    uploadStatus.classList.toggle('error', !!isError);
  }

  function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setStatus('Please choose a .csv file exported from ManaBox.', true);
      return;
    }
    setStatus('Reading CSV…');
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => processRows(results.data),
      error: (err) => setStatus('Could not read that file: ' + err.message, true)
    });
  }

  // ---------------------------------------------------------------------
  // CSV column normalization
  // ---------------------------------------------------------------------
  const ALIASES = {
    name: ['name', 'cardname'],
    setcode: ['setcode', 'set', 'edition', 'editioncode'],
    setname: ['setname', 'editionname'],
    collector: ['collectornumber', 'cardnumber', 'number', 'collectornum'],
    foil: ['foil', 'printing', 'finish'],
    quantity: ['quantity', 'qty', 'count'],
    scryfallid: ['scryfallid'],
    rarity: ['rarity'],
    condition: ['condition'],
    language: ['language', 'lang'],
    purchaseprice: ['purchaseprice', 'price'],
    bindername: ['bindername', 'listname', 'binder', 'list', 'deckname'],
    bindertype: ['bindertype', 'listtype']
  };

  function normKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function buildRowGetter(sampleRow) {
    const keyMap = {};
    Object.keys(sampleRow).forEach((k) => { keyMap[normKey(k)] = k; });
    const resolved = {};
    Object.entries(ALIASES).forEach(([field, aliases]) => {
      for (const a of aliases) {
        if (keyMap[a] !== undefined) { resolved[field] = keyMap[a]; break; }
      }
    });
    return (row, field) => (resolved[field] !== undefined ? row[resolved[field]] : undefined);
  }

  async function processRows(rows) {
    rows = rows.filter((r) => r && Object.values(r).some((v) => v && String(v).trim() !== ''));
    if (!rows.length) {
      setStatus('That CSV appears to be empty.', true);
      return;
    }
    const get = buildRowGetter(rows[0]);
    if (get(rows[0], 'name') === undefined) {
      setStatus('Could not find a "Name" column — is this a ManaBox export?', true);
      return;
    }

    // group rows by scryfall id (preferred) or name+set
    const groups = new Map();
    const binders = new Map(); // binderName -> { type, cardKeys: Map(key -> {qtyFoil, qtyNonfoil}) }

    let listRowsSkipped = 0;

    for (const row of rows) {
      const name = (get(row, 'name') || '').trim();
      if (!name) continue;

      // ManaBox "Lists" are virtual/smart groupings (e.g. auto-populated by price threshold),
      // not a physical copy — they duplicate a card that's already counted via a real binder,
      // deck, or unassigned row. Skip the entire row: no quantity, no location.
      const binderName = (get(row, 'bindername') || '').trim();
      const binderTypeRaw = (get(row, 'bindertype') || '').trim().toLowerCase();
      const isListRow = binderTypeRaw.includes('list');
      if (isListRow) { listRowsSkipped++; continue; }

      const scryfallId = (get(row, 'scryfallid') || '').trim();
      const setCode = (get(row, 'setcode') || '').trim().toLowerCase();
      const setName = (get(row, 'setname') || '').trim();
      const key = scryfallId ? `id:${scryfallId}` : `ns:${name.toLowerCase()}|${setCode || setName.toLowerCase()}`;

      const qtyRaw = get(row, 'quantity');
      const qty = qtyRaw ? (parseInt(qtyRaw, 10) || 1) : 1;
      const finish = (get(row, 'foil') || '').trim().toLowerCase();
      const isFoil = finish && finish !== 'normal' && finish !== 'nonfoil' && finish !== 'false' && finish !== '0';

      if (!groups.has(key)) {
        groups.set(key, {
          name, scryfallId, setCode, setName, key,
          qtyFoil: 0, qtyNonfoil: 0
        });
      }
      const g = groups.get(key);
      if (isFoil) g.qtyFoil += qty; else g.qtyNonfoil += qty;

      if (binderName) {
        let btype = 'binder';
        if (binderTypeRaw.includes('deck')) btype = 'deck';
        else if (binderTypeRaw.includes('binder')) btype = 'binder';
        else if (binderTypeRaw) btype = 'other';

        if (!binders.has(binderName)) binders.set(binderName, { type: btype, cardKeys: new Map() });
        const b = binders.get(binderName);
        if (btype === 'deck') b.type = 'deck'; // deck info takes priority if it ever conflicts
        const bc = b.cardKeys.get(key) || { qtyFoil: 0, qtyNonfoil: 0 };
        if (isFoil) bc.qtyFoil += qty; else bc.qtyNonfoil += qty;
        b.cardKeys.set(key, bc);
      }
    }

    const listNote = listRowsSkipped ? ` (ignored ${listRowsSkipped.toLocaleString()} row${listRowsSkipped === 1 ? '' : 's'} from ManaBox Lists)` : '';
    setStatus(`Found ${groups.size.toLocaleString()} unique printings${listNote}. Checking against your existing collection…`);
    await enrichAndStore(Array.from(groups.values()), binders);
  }

  // ---------------------------------------------------------------------
  // Scryfall enrichment
  // ---------------------------------------------------------------------
  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // Fetch one batch from Scryfall with retry + exponential backoff.
  // Retries on network errors, 429 (rate limited), and 5xx server errors.
  // Set the moment a REAL, readable 429 comes back from Scryfall during the
  // current import/refresh run. Once true, any further failure (even a
  // generic "CORS Missing Allow Origin" network error, which is what a 429
  // response without CORS headers looks like to the browser) is treated as
  // the same rate limit rather than silently retried for tens of seconds —
  // see resetScryfallRateLimitState(), called at the start of each run.
  let scryfallRateLimitSeen = false;
  // Adaptive inter-batch pacing: starts at a conservative 200ms (well under
  // Scryfall's "10 requests/sec" ceiling) and doubles, up to a cap, the
  // moment a real 429 is seen. Deliberately NOT reset per-run (only
  // scryfallRateLimitSeen is) and persisted to localStorage, because a
  // retry that just resets back to the pace that already got rate-limited
  // will very likely fail at the same spot again — this needs to be
  // learned once and remembered across retries/reloads for this browser
  // until it stops happening. Chunk size itself is already at Scryfall's
  // max (75 identifiers per request), so pacing is the only lever left.
  const SCRYFALL_PACING_KEY = 'scrybox_scryfall_pacing_ms_v1';
  const BASE_BATCH_DELAY_MS = 200;
  const MAX_BATCH_DELAY_MS = 3000;
  let currentBatchDelayMs = (() => {
    const saved = parseInt(localStorage.getItem(SCRYFALL_PACING_KEY), 10);
    return (!isNaN(saved) && saved >= BASE_BATCH_DELAY_MS && saved <= MAX_BATCH_DELAY_MS) ? saved : BASE_BATCH_DELAY_MS;
  })();
  function resetScryfallRateLimitState() {
    scryfallRateLimitSeen = false;
  }
  function slowDownBatchPacing() {
    currentBatchDelayMs = Math.min(MAX_BATCH_DELAY_MS, currentBatchDelayMs * 2);
    try { localStorage.setItem(SCRYFALL_PACING_KEY, String(currentBatchDelayMs)); } catch (e) { /* non-fatal */ }
  }
  function rateLimitError() {
    const err = new Error("Scryfall is rate-limiting requests from your network right now (HTTP 429). This isn't a bug in Scrybox — it clears on its own, usually within a minute or two. Wait a bit, then click Upload / Resync (or refresh prices) again.");
    err.isRateLimit = true;
    return err;
  }

  async function fetchScryfallBatchWithRetry(identifiers, attempt) {
    attempt = attempt || 1;
    let resp;
    try {
      resp = await fetch(SCRYFALL_COLLECTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers })
      });
    } catch (networkErr) {
      // A rate-limited response missing CORS headers looks identical to a
      // generic network failure to the browser — if we already confirmed a
      // real 429 this run, don't keep burning retries on what's almost
      // certainly the same block; fail fast with an accurate message.
      if (scryfallRateLimitSeen) throw rateLimitError();
      if (attempt >= MAX_RETRIES) throw networkErr;
      return retryAfterDelay(identifiers, attempt);
    }

    if (resp.status === 429 || resp.status >= 500) {
      if (resp.status === 429) {
        if (scryfallRateLimitSeen) throw rateLimitError(); // confirmed a second time — stop here
        scryfallRateLimitSeen = true;
        slowDownBatchPacing();
      }
      if (attempt >= MAX_RETRIES) throw new Error(`Scryfall returned ${resp.status} after ${MAX_RETRIES} attempts`);
      const retryAfterHeader = parseFloat(resp.headers.get('Retry-After'));
      const waitMs = !isNaN(retryAfterHeader) ? retryAfterHeader * 1000 : 1500 * Math.pow(2, attempt - 1);
      return retryAfterDelay(identifiers, attempt, waitMs);
    }

    return resp.json();
  }

  // Rate-limit (429) responses from Scryfall sometimes come back without
  // CORS headers, which makes the browser report the whole request as a
  // blocked "CORS Missing Allow Origin" failure rather than a readable 429
  // — so we can't always read a Retry-After header to know exactly how
  // long to wait. Backing off generously (starting at 1.5s, doubling each
  // attempt) gives a temporary rate limit real room to clear either way.
  async function retryAfterDelay(identifiers, attempt, waitMsOverride) {
    const waitMs = waitMsOverride || 1500 * Math.pow(2, attempt - 1);
    setStatus(`Scryfall request hiccuped — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})…`);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchScryfallBatchWithRetry(identifiers, attempt + 1);
  }

  // GET-based fetch (for the live /cards/search endpoint) with the same
  // retry/backoff behavior, plus special handling for 404 (Scryfall's way
  // of saying "zero results" — not an error) and 400 (bad query syntax).
  async function scryfallSearchFetch(url, attempt) {
    attempt = attempt || 1;
    let resp;
    try {
      resp = await fetch(url);
    } catch (networkErr) {
      if (attempt >= MAX_RETRIES) throw networkErr;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      return scryfallSearchFetch(url, attempt + 1);
    }

    if (resp.status === 404) {
      return { data: [], has_more: false };
    }
    if (resp.status === 400) {
      const body = await resp.json().catch(() => ({}));
      const err = new Error(body.details || 'Scryfall could not parse that search.');
      err.badQuery = true;
      throw err;
    }
    if (resp.status === 429 || resp.status >= 500) {
      if (attempt >= MAX_RETRIES) throw new Error(`Scryfall returned ${resp.status} after ${MAX_RETRIES} attempts`);
      const retryAfterHeader = parseFloat(resp.headers.get('Retry-After'));
      const waitMs = !isNaN(retryAfterHeader) ? retryAfterHeader * 1000 : 500 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, waitMs));
      return scryfallSearchFetch(url, attempt + 1);
    }
    return resp.json();
  }

  // Runs a query against Scryfall's real, live search (used for operators
  // like art:/atag:/otag: whose data we don't have cached locally) and
  // returns the full set of matching printing IDs, paginating as needed.
  // Cached per exact query string for the session.
  async function liveScryfallSearch(query) {
    if (state.liveCache.has(query)) return state.liveCache.get(query);

    const ids = new Set();
    let url = `${SCRYFALL_SEARCH_URL}?q=${encodeURIComponent(query)}&unique=prints`;
    let pageCount = 0;
    const MAX_PAGES = 60; // ~10,500 results — covers all but the broadest single-word art tags

    while (url && pageCount < MAX_PAGES) {
      const data = await scryfallSearchFetch(url);
      (data.data || []).forEach((c) => ids.add(c.id));
      url = data.has_more ? data.next_page : null;
      pageCount++;
      if (url) await new Promise((r) => setTimeout(r, 100));
    }

    ids.truncated = !!url; // stopped due to MAX_PAGES, not because results ran out
    state.liveCache.set(query, ids);
    return ids;
  }

  function buildCardFromScryfall(card, g) {
    const faceImages = card.image_uris ? card.image_uris
      : (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) || null;

    return {
      id: card.id,
      name: card.name,
      mana_cost: card.mana_cost || (card.card_faces && card.card_faces.map((f) => f.mana_cost).join(' // ')) || '',
      cmc: card.cmc || 0,
      type_line: card.type_line || '',
      oracle_text: card.oracle_text || (card.card_faces && card.card_faces.map((f) => f.oracle_text).join('\n')) || '',
      colors: card.colors || (card.card_faces && card.card_faces[0] && card.card_faces[0].colors) || [],
      color_identity: card.color_identity || [],
      keywords: card.keywords || [],
      rarity: card.rarity || 'common',
      set_name: card.set_name || '',
      set: card.set || '',
      power: card.power || (card.card_faces && card.card_faces[0] && card.card_faces[0].power) || null,
      toughness: card.toughness || (card.card_faces && card.card_faces[0] && card.card_faces[0].toughness) || null,
      loyalty: card.loyalty || (card.card_faces && card.card_faces[0] && card.card_faces[0].loyalty) || null,
      image: faceImages ? (faceImages.normal || faceImages.large || faceImages.small) : null,
      prices: card.prices || {},
      artist: card.artist || (card.card_faces && card.card_faces[0] && card.card_faces[0].artist) || '',
      flavor_text: card.flavor_text || (card.card_faces && card.card_faces[0] && card.card_faces[0].flavor_text) || '',
      watermark: card.watermark || (card.card_faces && card.card_faces[0] && card.card_faces[0].watermark) || '',
      border_color: card.border_color || '',
      frame: card.frame || '',
      lang: card.lang || 'en',
      layout: card.layout || '',
      legalities: card.legalities || {},
      produced_mana: card.produced_mana || [],
      released_at: card.released_at || '',
      edhrec_rank: (typeof card.edhrec_rank === 'number') ? card.edhrec_rank : null,
      collector_number: card.collector_number || '',
      set_type: card.set_type || '',
      promo: !!card.promo,
      reprint: !!card.reprint,
      full_art: !!card.full_art,
      textless: !!card.textless,
      reserved: !!card.reserved,
      digital: !!card.digital,
      qtyFoil: g.qtyFoil,
      qtyNonfoil: g.qtyNonfoil,
      _groupKey: g.key,
      _binders: []
    };
  }

  function tagCard(c) {
    c._playstyles = derivePlaystyles(c);
    c._counters = /\{?\+1\/\+1\}?\s*counter/i.test(c.oracle_text);
    c._tags = deriveFunctionalTags(c);
  }

  // Fetches + builds card objects for a list of groups that need Scryfall data.
  async function fetchAndBuildCards(groups) {
    if (!groups.length) return [];

    const identifiers = groups.map((g) => {
      if (g.scryfallId) return { id: g.scryfallId };
      if (g.setCode) return { name: g.name, set: g.setCode };
      return { name: g.name };
    });

    const byMatchKey = new Map();
    groups.forEach((g) => {
      const k1 = g.scryfallId ? `id:${g.scryfallId}` : null;
      const k2 = `ns:${g.name.toLowerCase()}|${g.setCode || g.setName.toLowerCase()}`;
      const k3 = `n:${g.name.toLowerCase()}`;
      if (k1) byMatchKey.set(k1, g);
      byMatchKey.set(k2, g);
      if (!byMatchKey.has(k3)) byMatchKey.set(k3, g);
    });

    const chunks = chunk(identifiers, CHUNK_SIZE);
    const cards = [];

    function buildFromRaw(rawList) {
      rawList.forEach((card) => {
        const k1 = `id:${card.id}`;
        const k2 = `ns:${card.name.toLowerCase()}|${(card.set || '').toLowerCase()}`;
        const k3 = `n:${card.name.toLowerCase()}`;
        const g = byMatchKey.get(k1) || byMatchKey.get(k2) || byMatchKey.get(k3);
        if (!g) return;
        const c = buildCardFromScryfall(card, g);
        tagCard(c);
        cards.push(c);
      });
    }

    for (let i = 0; i < chunks.length; i++) {
      setStatus(`Fetching card data from Scryfall… batch ${i + 1} of ${chunks.length}`);
      let data;
      try {
        data = await fetchScryfallBatchWithRetry(chunks[i]);
      } catch (err) {
        // Attach whatever batches DID complete so the caller can save that
        // partial progress instead of throwing it all away — a big first
        // import (e.g. a brand-new browser/origin with nothing cached yet)
        // can take many batches, and a rate limit partway through
        // shouldn't mean starting over from card #1 on every retry.
        err.partialCards = cards;
        throw err;
      }
      buildFromRaw(data.data || []);
      // Adaptive delay — starts conservative and doubles automatically if
      // a 429 was hit (see slowDownBatchPacing above).
      await new Promise((r) => setTimeout(r, currentBatchDelayMs));
    }

    return cards;
  }

  // Imports/re-syncs the collection. On first import, everything is fetched
  // fresh. On a re-sync (collection already cached), cards that already exist
  // are reused as-is (just their quantities/binders updated) and only truly
  // new printings hit the Scryfall API — cards no longer present in the CSV
  // are dropped.
  async function enrichAndStore(groups, binders) {
    resetScryfallRateLimitState();
    binders = binders || new Map();
    const isResync = state.collection.length > 0;
    const oldCount = state.collection.length;

    const existingByKey = new Map();
    if (isResync) state.collection.forEach((c) => existingByKey.set(c._groupKey, c));

    const reused = [];
    const toFetch = [];
    groups.forEach((g) => {
      const existing = isResync ? existingByKey.get(g.key) : null;
      if (existing) {
        const clone = Object.assign({}, existing);
        clone.qtyFoil = g.qtyFoil;
        clone.qtyNonfoil = g.qtyNonfoil;
        clone._binders = [];
        reused.push(clone);
      } else {
        toFetch.push(g);
      }
    });

    let newlyFetched = [];
    if (toFetch.length) {
      try {
        newlyFetched = await fetchAndBuildCards(toFetch);
      } catch (err) {
        const partial = err.partialCards || [];
        let progressNote = ' Nothing was changed.';
        if (partial.length) {
          // Save what was fetched before the failure so a retry resumes
          // instead of restarting from scratch — the diffing logic above
          // will treat these as already-cached next time and only fetch
          // whatever's still missing. Binder/deck assignment for these
          // cards catches up automatically on the next successful sync
          // (the assignment loop below always runs over the full merged
          // set), so it's fine that they don't have it yet.
          const partialCollection = reused.concat(partial);
          state.collection = partialCollection;
          try {
            await localforage.setItem(STORAGE_KEY, partialCollection);
            await localforage.setItem(META_KEY, { count: partialCollection.length, syncedAt: new Date().toISOString() });
          } catch (storeErr) { /* best-effort — if this fails too, the in-memory state still has it for this session */ }
          progressNote = ` Saved progress on ${partial.length.toLocaleString()} card${partial.length === 1 ? '' : 's'} fetched before this happened — click Upload / Resync again in a bit (same CSV) and it'll pick up where it left off instead of starting over.`;
        }
        if (err.isRateLimit) {
          setStatus(err.message + progressNote, true);
        } else {
          setStatus('Network error while contacting Scryfall (' + err.message + ').' + progressNote + ' If this keeps happening, check for an ad blocker or privacy extension blocking requests to api.scryfall.com (try disabling it just for this site), since Scryfall itself is a public API that works from any browser otherwise.', true);
        }
        return;
      }
    }

    const finalCollection = reused.concat(newlyFetched);

    if (!finalCollection.length) {
      setStatus('Could not match any cards against Scryfall. Double check this is a ManaBox export.', true);
      return;
    }

    // attach binder/deck membership fresh from this CSV
    const keyToCard = new Map();
    finalCollection.forEach((c) => keyToCard.set(c._groupKey, c));
    binders.forEach((b, binderName) => {
      b.cardKeys.forEach((qtyInfo, key) => {
        const card = keyToCard.get(key);
        if (!card) return;
        card._binders.push({ name: binderName, type: b.type, qtyFoil: qtyInfo.qtyFoil, qtyNonfoil: qtyInfo.qtyNonfoil });
      });
    });

    state.collection = finalCollection;
    const meta = { count: finalCollection.length, syncedAt: new Date().toISOString() };
    state.lastSyncedAt = meta.syncedAt;
    try {
      await localforage.setItem(STORAGE_KEY, finalCollection);
      await localforage.setItem(META_KEY, meta);
    } catch (err) {
      setStatus('Imported, but this browser blocked local storage — you\'ll need to re-upload next time.', true);
    }

    let msg;
    if (isResync) {
      const removedCount = Math.max(0, oldCount - reused.length);
      const parts = [];
      if (newlyFetched.length) parts.push(`${newlyFetched.length.toLocaleString()} new`);
      if (reused.length) parts.push(`${reused.length.toLocaleString()} unchanged`);
      if (removedCount) parts.push(`${removedCount.toLocaleString()} removed`);
      msg = `Synced: ${parts.join(', ') || 'no changes'}.`;
    } else {
      msg = `Imported ${finalCollection.length.toLocaleString()} cards.`;
    }
    setStatus(msg);

    showApp(meta);
    runSearch();
  }

  // Re-fetches Scryfall data (prices, oracle text, etc.) for every card
  // already in the collection, without needing a new CSV upload.
  async function refreshPrices() {
    resetScryfallRateLimitState();
    if (!state.collection.length) return;
    const identifiers = state.collection.map((c) => ({ id: c.id }));
    const chunks = chunk(identifiers, CHUNK_SIZE);
    const updatesById = new Map();

    try {
      for (let i = 0; i < chunks.length; i++) {
        syncStatusEl.textContent = `Refreshing prices… batch ${i + 1} of ${chunks.length}`;
        const data = await fetchScryfallBatchWithRetry(chunks[i]);
        (data.data || []).forEach((c) => updatesById.set(c.id, c));
        await new Promise((r) => setTimeout(r, currentBatchDelayMs));
      }
    } catch (err) {
      syncStatusEl.textContent = err.isRateLimit ? err.message : 'Could not refresh prices — network error. Try again in a moment.';
      return;
    }

    let updatedCount = 0;
    state.collection.forEach((card) => {
      const fresh = updatesById.get(card.id);
      if (!fresh) return;
      const rebuilt = buildCardFromScryfall(fresh, { qtyFoil: card.qtyFoil, qtyNonfoil: card.qtyNonfoil, key: card._groupKey });
      rebuilt._binders = card._binders;
      tagCard(rebuilt);
      Object.assign(card, rebuilt);
      updatedCount++;
    });

    const meta = { count: state.collection.length, syncedAt: new Date().toISOString() };
    state.lastSyncedAt = meta.syncedAt;
    try {
      await localforage.setItem(STORAGE_KEY, state.collection);
      await localforage.setItem(META_KEY, meta);
    } catch (err) {
      // non-fatal — just means it won't persist across reload
    }

    lastSyncedEl.textContent = formatSyncedAt(meta.syncedAt);
    updateStaleReminder();
    syncStatusEl.textContent = `Prices refreshed for ${updatedCount.toLocaleString()} cards.`;
    buildMechanicsChips();
    buildSetChips();
    updateHeaderTotalValue();
    runSearch();
  }

  // ---------------------------------------------------------------------
  // Playstyle heuristics (suggested tags, not exact science)
  // ---------------------------------------------------------------------
  function derivePlaystyles(card) {
    const tags = new Set();
    const type = (card.type_line || '').toLowerCase();
    const text = (card.oracle_text || '').toLowerCase();
    const cmc = card.cmc || 0;
    const keywords = (card.keywords || []).map((k) => k.toLowerCase());

    const isCreature = type.includes('creature');
    const isSpell = type.includes('instant') || type.includes('sorcery');
    const isLand = type.includes('land');

    if ((isCreature && cmc <= 3) || keywords.includes('haste')) tags.add('aggro');

    if (/search your library for a (basic )?land|additional land|extra land|add \{[wubrgc]\}\{[wubrgc]\}|adds? \{[wubrgc]\} for each/.test(text)
      || (isLand && /search your library/.test(text))) {
      tags.add('ramp');
    }

    if (isSpell && /(counter target|destroy target|exile target|destroy all|each creature gets|return target .* to its owner|each opponent sacrifices)/.test(text)) {
      tags.add('control');
    }
    if (/draw (a|two|three) cards?/.test(text) && (isSpell || type.includes('enchantment'))) {
      tags.add('control');
    }

    if (/search your library for a card|whenever you cast .* instant or sorcery|copy target instant or sorcery|extra turn|infinite|whenever .* enters, .* triggers/.test(text)) {
      tags.add('combo');
    }

    if (isCreature && cmc >= 4 && cmc <= 6) tags.add('midrange');

    if (!tags.size && isCreature) tags.add('midrange');

    return tags;
  }

  // ---------------------------------------------------------------------
  // Functional heuristic tags (Removal / Board Wipe / Card Advantage / Protection)
  // ---------------------------------------------------------------------
  function deriveFunctionalTags(card) {
    const tags = new Set();
    const text = (card.oracle_text || '').toLowerCase();

    const isBoardWipe = /destroy all|each creature (gets|takes)|deals? \d+ damage to each creature|sacrifices? all creatures/.test(text);
    if (isBoardWipe) tags.add('boardwipe');

    if (!isBoardWipe && /destroy target|exile target (creature|artifact|enchantment|planeswalker)|-\d+\/-\d+ until end of turn|deals? \d+ damage to target creature|return target creature to its owner'?s hand/.test(text)) {
      tags.add('removal');
    }

    if (/draw (a|two|three|x) cards?|draws? a card/.test(text)) tags.add('cardadvantage');

    if (/hexproof|indestructible|protection from|ward \{|ward \d/.test(text)) tags.add('protection');

    return tags;
  }

  // ---------------------------------------------------------------------
  // Mechanics chip generation (built from actual owned cards)
  // ---------------------------------------------------------------------
  function buildMechanicsChips() {
    const freq = new Map();
    let counterCards = 0;
    state.collection.forEach((c) => {
      if (c._counters) counterCards++;
      (c.keywords || []).forEach((k) => freq.set(k, (freq.get(k) || 0) + 1));
    });

    const top = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([k]) => k);

    mechanicsChipsEl.innerHTML = '';
    if (counterCards) {
      mechanicsChipsEl.appendChild(makeMechanicChip('+1/+1 Counters', 'counters'));
    }
    top.forEach((k) => mechanicsChipsEl.appendChild(makeMechanicChip(k, k.toLowerCase())));
  }

  // Set chips, built from whatever sets are actually present in the owned
  // collection (so this stays a manageable, personal-collection-sized list).
  function buildSetChips() {
    const bySet = new Map(); // set code -> set name
    state.collection.forEach((c) => {
      if (c.set) bySet.set(c.set, c.set_name || c.set.toUpperCase());
    });
    const entries = Array.from(bySet.entries()).sort((a, b) => a[1].localeCompare(b[1]));

    setChipsEl.innerHTML = '';
    entries.forEach(([code, name]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.dataset.set = code;
      btn.textContent = name;
      btn.title = code.toUpperCase();
      if (state.filters.sets.has(code)) btn.classList.add('active');
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.sets, code);
        runSearch();
      });
      setChipsEl.appendChild(btn);
    });
  }

  // Tri-state chip: off -> AND (green, label suffixed "(AND)") -> OR (red, "(OR)") -> off.
  // State is shown via color AND text, not color alone.
  function makeMechanicChip(label, value) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.mechanic = value;
    btn.dataset.state = 'off';
    btn.dataset.label = label;
    btn.textContent = label;
    btn.title = 'Click to require this (AND)';
    btn.addEventListener('click', () => {
      const next = { off: 'and', and: 'or', or: 'off' }[btn.dataset.state];
      btn.dataset.state = next;
      btn.classList.remove('chip-and', 'chip-or');
      state.filters.mechanicsAnd.delete(value);
      state.filters.mechanicsOr.delete(value);
      if (next === 'and') {
        btn.classList.add('chip-and');
        btn.textContent = `${label} (AND)`;
        btn.title = 'Card must have this. Click again for OR.';
        state.filters.mechanicsAnd.add(value);
      } else if (next === 'or') {
        btn.classList.add('chip-or');
        btn.textContent = `${label} (OR)`;
        btn.title = 'Card must have at least one OR-marked mechanic. Click again to clear.';
        state.filters.mechanicsOr.add(value);
      } else {
        btn.textContent = label;
        btn.title = 'Click to require this (AND)';
      }
      runSearch();
    });
    return btn;
  }

  function toggleSetValue(set, value) {
    if (set.has(value)) set.delete(value); else set.add(value);
  }

  // ---------------------------------------------------------------------
  // Filter UI events
  // ---------------------------------------------------------------------
  function bindFilterEvents() {
    document.querySelectorAll('.mana-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.colors, btn.dataset.color);
        runSearch();
      });
    });
    $('#colorExactToggle').addEventListener('change', (e) => {
      state.filters.colorExact = e.target.checked;
      runSearch();
    });
    document.querySelectorAll('#playstyleChips .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.playstyles, btn.dataset.playstyle);
        runSearch();
      });
    });
    document.querySelectorAll('#tagChips .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.tags, btn.dataset.tag);
        runSearch();
      });
    });
    document.querySelectorAll('#typeChips .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.types, btn.dataset.type);
        runSearch();
      });
    });
    document.querySelectorAll('#rarityChips .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.rarities, btn.dataset.rarity);
        runSearch();
      });
    });
    document.querySelectorAll('#ownershipChips .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.ownership, btn.dataset.own);
        runSearch();
      });
    });
    document.querySelectorAll('#deckStatusChips .chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        toggleSetValue(state.filters.deckStatus, btn.dataset.deckstatus);
        runSearch();
      });
    });
    clearFiltersBtn.addEventListener('click', () => {
      state.filters.colors.clear();
      state.filters.playstyles.clear();
      state.filters.tags.clear();
      state.filters.mechanicsAnd.clear();
      state.filters.mechanicsOr.clear();
      state.filters.types.clear();
      state.filters.rarities.clear();
      state.filters.ownership.clear();
      state.filters.deckStatus.clear();
      state.filters.sets.clear();
      state.filters.minValue = null;
      minValueInput.value = '';
      state.filters.mvMin = null; state.filters.mvMax = null;
      state.filters.powMin = null; state.filters.powMax = null;
      state.filters.touMin = null; state.filters.touMax = null;
      state.filters.yearMin = null; state.filters.yearMax = null;
      [mvMinInput, mvMaxInput, powMinInput, powMaxInput, touMinInput, touMaxInput, yearMinInput, yearMaxInput].forEach((el) => { el.value = ''; });
      state.filters.colorExact = false;
      document.querySelectorAll('.mana-toggle.active, .chip.active').forEach((el) => el.classList.remove('active'));
      document.querySelectorAll('#mechanicsChips .chip').forEach((el) => {
        el.dataset.state = 'off';
        el.classList.remove('chip-and', 'chip-or');
        el.textContent = el.dataset.label;
      });
      $('#colorExactToggle').checked = false;
      runSearch();
    });
    sortSelect.addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      state.page = 1;
      renderResults();
    });
    $('#sortDirBtn').addEventListener('click', () => {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      $('#sortDirBtn').textContent = state.sortDir === 'asc' ? 'Asc ↑' : 'Desc ↓';
      state.page = 1;
      renderResults();
    });
  }

  // ---------------------------------------------------------------------
  // Search bar
  // ---------------------------------------------------------------------
  function bindSearchEvents() {
    let t;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.query = e.target.value;
        state.page = 1;
        runSearch();
      }, 200);
    });
    searchClearBtn.addEventListener('click', () => {
      searchInput.value = '';
      state.query = '';
      state.page = 1;
      runSearch();
    });
    $('#syntaxHelpLink').addEventListener('click', (e) => {
      e.preventDefault();
      $('#syntaxModal').classList.remove('hidden');
    });
    $('#syntaxModalClose').addEventListener('click', () => $('#syntaxModal').classList.add('hidden'));
    $('#syntaxModalBackdrop').addEventListener('click', () => $('#syntaxModal').classList.add('hidden'));
    $('#exportResultsBtn').addEventListener('click', exportResultsForDeckbuilding);
  }

  // Downloads whatever's currently showing (respecting the search box and
  // every sidebar filter — color identity included) as a plain-text file
  // with enough detail per card (mana cost, type, oracle text) to hand
  // straight to an AI for deckbuilding without it needing to look anything up.
  function exportResultsForDeckbuilding() {
    const groups = sortGroups(groupCardsByName(state.filtered));
    if (!groups.length) {
      syncStatusEl.textContent = 'Nothing to export — adjust your filters/search so some cards are showing first.';
      setTimeout(() => { syncStatusEl.textContent = ''; }, 3500);
      return;
    }

    const headerLines = [
      `Scrybox export — ${new Date().toLocaleString()}`,
      `${groups.length.toLocaleString()} unique card${groups.length === 1 ? '' : 's'} matching the current filters/search`
    ];
    if (state.query) headerLines.push(`Search: ${state.query}`);
    if (state.filters.colors.size) {
      const colorList = Array.from(state.filters.colors).join('');
      headerLines.push(`Color identity filter: ${colorList}${state.filters.colorExact ? ' (exact match)' : ' (Commander-style, up to these colors)'}`);
    }
    headerLines.push('Format: <qty owned>x <name> | <mana cost> | <color identity> | <type line> | <oracle text>');

    const cardLines = groups.map((g) => cardDetailLine(g.representative, g.totalQtyFoil + g.totalQtyNonfoil));

    const text = headerLines.join('\n') + '\n\n' + cardLines.join('\n');
    downloadTextFile(text, buildExportFilename());
  }

  // Shared "<qty>x Name | mana cost | color identity | type line [P/T or loyalty] | oracle text"
  // line format, used by both the deckbuilding export and the AI grading prompt.
  function cardDetailLine(c, qty) {
    const ci = (c.color_identity && c.color_identity.length) ? c.color_identity.join('') : 'C';
    const oracle = (c.oracle_text || '').replace(/\n/g, ' ').trim() || '(no rules text)';
    const ptOrLoyalty = (c.power != null && c.toughness != null)
      ? ` [${c.power}/${c.toughness}]`
      : (c.loyalty ? ` [Loyalty ${c.loyalty}]` : '');
    return `${qty}x ${c.name} | ${c.mana_cost || '—'} | ${ci} | ${c.type_line}${ptOrLoyalty} | ${oracle}`;
  }

  // A relevant-but-unique filename per export: colors (or search term) if
  // present, plus a timestamp, so repeated exports don't clobber each other
  // in your downloads folder.
  function timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function slugify(str, maxLen) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, maxLen || 30);
  }

  function buildExportFilename() {
    const parts = ['scrybox-export'];
    if (state.filters.colors.size) {
      const map = { w: 'W', u: 'U', b: 'B', r: 'R', g: 'G', c: 'C' };
      parts.push(Array.from(state.filters.colors).map((c) => map[c.toLowerCase()] || c.toUpperCase()).join(''));
    } else if (state.query) {
      const q = slugify(state.query);
      if (q) parts.push(q);
    }
    parts.push(timestampSlug());
    return parts.join('-') + '.txt';
  }

  // ---------------------------------------------------------------------
  // Query tokenizer / parser (Scryfall-like syntax)
  // ---------------------------------------------------------------------
  function tokenize(str) {
    const re = /(?:[^\s"]+|"[^"]*")+/g;
    return str.match(re) || [];
  }

  function parseToken(token) {
    let negate = false;
    if (token.startsWith('-') && token.length > 1) { negate = true; token = token.slice(1); }

    const m = token.match(/^([a-zA-Z]+)(:|>=|<=|>|<|=)(.+)$/);
    if (!m) {
      return { field: 'name', cmp: ':', value: stripQuotes(token).toLowerCase(), negate };
    }
    const field = m[1].toLowerCase();
    const cmp = m[2];
    const value = stripQuotes(m[3]).toLowerCase();
    return { field, cmp, value, negate };
  }

  function stripQuotes(s) {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
    return s;
  }

  function expandColorValue(value) {
    if (GUILDS[value]) return GUILDS[value].split('');
    return value.split('').filter((c) => 'wubrgc'.includes(c));
  }

  function numCompare(actual, cmp, target) {
    switch (cmp) {
      case '>': return actual > target;
      case '<': return actual < target;
      case '>=': return actual >= target;
      case '<=': return actual <= target;
      default: return actual === target;
    }
  }

  // ISO date strings ("2015-06-01") compare correctly with plain string
  // operators, including partial dates like "2015" vs a full date.
  function dateCompare(actual, cmp, target) {
    switch (cmp) {
      case '>': return actual > target;
      case '<': return actual < target;
      case '>=': return actual >= target;
      case '<=': return actual <= target;
      default: return actual === target;
    }
  }

  // Handles the many `is:` sub-checks Scryfall supports. Unknown values are
  // forgiving (don't filter anything out) rather than erroring.
  function isCheck(card, value) {
    const type = (card.type_line || '').toLowerCase();
    const text = (card.oracle_text || '').toLowerCase();
    const mana = (card.mana_cost || '').toLowerCase();
    switch (value) {
      case 'foil': return card.qtyFoil > 0;
      case 'nonfoil': return card.qtyNonfoil > 0;
      case 'deck':
      case 'indeck': return (card._binders || []).some((b) => b.type === 'deck');
      case 'commander': return type.includes('legendary') && type.includes('creature');
      case 'split': return card.layout === 'split';
      case 'flip': return card.layout === 'flip';
      case 'transform': return card.layout === 'transform';
      case 'meld': return card.layout === 'meld';
      case 'mdfc':
      case 'modal_dfc': return card.layout === 'modal_dfc';
      case 'dfc': return ['transform', 'modal_dfc', 'meld', 'double_faced_token'].includes(card.layout);
      case 'leveler': return /level up/.test(text);
      case 'permanent': return !type.includes('instant') && !type.includes('sorcery');
      case 'spell': return type.includes('instant') || type.includes('sorcery');
      case 'promo': return !!card.promo;
      case 'reprint': return !!card.reprint;
      case 'fullart':
      case 'full_art': return !!card.full_art;
      case 'textless': return !!card.textless;
      case 'reserved': return !!card.reserved;
      case 'digital': return !!card.digital;
      case 'hybrid': return /\{[a-z0-9]+\/[a-z0-9]+\}/.test(mana) && !mana.includes('/p}');
      case 'phyrexian': return mana.includes('/p}');
      case 'vanilla': return type.includes('creature') && !text.trim() && (card.keywords || []).length === 0;
      default: return true;
    }
  }

  const TAG_ALIASES = {
    wipe: 'boardwipe', boardwipe: 'boardwipe', sweeper: 'boardwipe',
    removal: 'removal', kill: 'removal',
    draw: 'cardadvantage', carddraw: 'cardadvantage', cardadvantage: 'cardadvantage', advantage: 'cardadvantage',
    protection: 'protection', hexproof: 'protection'
  };

  function matchesToken(card, tok) {
    let result;
    switch (tok.field) {
      case 'name': {
        result = card.name.toLowerCase().includes(tok.value);
        break;
      }
      case 'c':
      case 'color': {
        const wanted = expandColorValue(tok.value);
        const cardColors = card.colors && card.colors.length ? card.colors.map((c) => c.toLowerCase()) : ['c'];
        result = wanted.every((w) => (w === 'c' ? cardColors.length === 0 || cardColors.includes('c') : cardColors.includes(w)));
        break;
      }
      case 'id':
      case 'identity': {
        const wanted = expandColorValue(tok.value);
        const ci = card.color_identity ? card.color_identity.map((c) => c.toLowerCase()) : [];
        // card's color identity must be a subset of the searched-for colors (Scryfall id: semantics)
        result = ci.every((c) => wanted.includes(c)) && wanted.every((w) => w === 'c' ? ci.length === 0 : true);
        break;
      }
      case 't':
      case 'type': {
        result = card.type_line.toLowerCase().includes(tok.value);
        break;
      }
      case 'o':
      case 'oracle': {
        result = card.oracle_text.toLowerCase().includes(tok.value);
        break;
      }
      case 'tag': {
        const norm = tok.value.replace(/[\s_-]/g, '');
        const target = TAG_ALIASES[norm] || norm;
        result = card._tags ? card._tags.has(target) : false;
        break;
      }
      case 'kw':
      case 'keyword': {
        result = (card.keywords || []).some((k) => k.toLowerCase() === tok.value);
        break;
      }
      case 'mv':
      case 'cmc': {
        result = numCompare(card.cmc || 0, tok.cmp, parseFloat(tok.value));
        break;
      }
      case 'pow':
      case 'power': {
        result = numCompare(parseFloat(card.power) || 0, tok.cmp, parseFloat(tok.value));
        break;
      }
      case 'tou':
      case 'toughness': {
        result = numCompare(parseFloat(card.toughness) || 0, tok.cmp, parseFloat(tok.value));
        break;
      }
      case 'r':
      case 'rarity': {
        result = card.rarity.toLowerCase() === tok.value;
        break;
      }
      case 'is': {
        result = isCheck(card, tok.value);
        break;
      }
      case 'set':
      case 's':
      case 'e':
      case 'edition':
      case 'in': {
        result = card.set.toLowerCase() === tok.value;
        break;
      }
      case 'a':
      case 'artist': {
        result = (card.artist || '').toLowerCase().includes(tok.value);
        break;
      }
      case 'ft':
      case 'flavor': {
        result = (card.flavor_text || '').toLowerCase().includes(tok.value);
        break;
      }
      case 'wm':
      case 'watermark': {
        result = (card.watermark || '').toLowerCase().includes(tok.value);
        break;
      }
      case 'border': {
        result = (card.border_color || '').toLowerCase() === tok.value;
        break;
      }
      case 'frame': {
        result = (card.frame || '').toLowerCase().includes(tok.value);
        break;
      }
      case 'lang':
      case 'l': {
        result = (card.lang || 'en').toLowerCase() === tok.value;
        break;
      }
      case 'loy':
      case 'loyalty': {
        result = numCompare(parseFloat(card.loyalty) || 0, tok.cmp, parseFloat(tok.value));
        break;
      }
      case 'produces': {
        const wanted = expandColorValue(tok.value);
        const produced = (card.produced_mana || []).map((c) => c.toLowerCase());
        result = wanted.every((w) => produced.includes(w));
        break;
      }
      case 'm':
      case 'mana': {
        result = (card.mana_cost || '').toLowerCase().replace(/\s+/g, '').includes(tok.value.replace(/\s+/g, ''));
        break;
      }
      case 'f':
      case 'format': {
        result = (card.legalities || {})[tok.value] === 'legal';
        break;
      }
      case 'banned': {
        result = (card.legalities || {})[tok.value] === 'banned';
        break;
      }
      case 'restricted': {
        result = (card.legalities || {})[tok.value] === 'restricted';
        break;
      }
      case 'usd': {
        result = numCompare(parseFloat((card.prices || {}).usd) || 0, tok.cmp, parseFloat(tok.value));
        break;
      }
      case 'eur': {
        result = numCompare(parseFloat((card.prices || {}).eur) || 0, tok.cmp, parseFloat(tok.value));
        break;
      }
      case 'number':
      case 'cn': {
        result = (card.collector_number || '').toLowerCase() === tok.value;
        break;
      }
      case 'year': {
        const cardYear = card.released_at ? parseInt(card.released_at.slice(0, 4), 10) : 0;
        result = numCompare(cardYear, tok.cmp, parseFloat(tok.value));
        break;
      }
      case 'date': {
        result = dateCompare(card.released_at || '', tok.cmp, tok.value);
        break;
      }
      case 'art':
      case 'atag':
      case 'arttag':
      case 'otag':
      case 'function': {
        // Handled via a live Scryfall search in runSearch(), not locally —
        // if this ever gets called directly, don't filter anything out.
        result = true;
        break;
      }
      default: {
        // unknown field: treat whole token as a name search to be forgiving
        result = card.name.toLowerCase().includes(tok.value);
      }
    }
    return tok.negate ? !result : result;
  }

  // ---------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------
  function passesSidebarFilters(card) {
    const f = state.filters;

    if (f.colors.size) {
      // Uses color IDENTITY (not just mana cost color) so this behaves like
      // Commander deckbuilding: picking 3 colors shows every card castable
      // in that identity — mono-colored, two-color, colorless, etc. — not
      // just cards that use all 3.
      const cardColors = card.color_identity && card.color_identity.length ? card.color_identity.map((c) => c.toLowerCase()) : [];
      const selected = Array.from(f.colors).map((c) => c.toLowerCase());
      if (f.colorExact) {
        const cSet = new Set(cardColors.length ? cardColors : ['c']);
        const sSet = new Set(selected);
        if (cSet.size !== sSet.size || ![...cSet].every((c) => sSet.has(c))) return false;
      } else {
        const chosen = selected.filter((s) => s !== 'c');
        if (selected.includes('c') && chosen.length === 0) {
          // Only "Colorless" toggled on — show colorless-identity cards only.
          if (cardColors.length !== 0) return false;
        } else {
          // Commander-identity subset match: every color in the card's
          // identity must be among the selected colors (colorless cards
          // always qualify, same as they would in any commander deck).
          const ok = cardColors.every((c) => chosen.includes(c));
          if (!ok) return false;
        }
      }
    }

    if (f.playstyles.size) {
      const has = Array.from(f.playstyles).some((p) => card._playstyles.has(p));
      if (!has) return false;
    }

    if (f.tags.size) {
      const has = Array.from(f.tags).some((t) => card._tags && card._tags.has(t));
      if (!has) return false;
    }

    if (f.mechanicsAnd.size || f.mechanicsOr.size) {
      const kws = (card.keywords || []).map((k) => k.toLowerCase());
      const hasMechanic = (m) => (m === 'counters' ? card._counters : kws.includes(m));
      if (f.mechanicsAnd.size && !Array.from(f.mechanicsAnd).every(hasMechanic)) return false;
      if (f.mechanicsOr.size && !Array.from(f.mechanicsOr).some(hasMechanic)) return false;
    }

    if (f.types.size) {
      const has = Array.from(f.types).some((t) => card.type_line.toLowerCase().includes(t.toLowerCase()));
      if (!has) return false;
    }

    if (f.rarities.size) {
      const has = Array.from(f.rarities).some((r) => card.rarity.toLowerCase() === r);
      if (!has) return false;
    }

    if (f.ownership.size) {
      const has = Array.from(f.ownership).some((o) => (o === 'foil' ? card.qtyFoil > 0 : card.qtyNonfoil > 0));
      if (!has) return false;
    }

    if (f.deckStatus.size) {
      const deckQty = sumDeckQty(card);
      const inDeckQty = deckQty.foil + deckQty.nonfoil;
      const storageQty = (card.qtyFoil + card.qtyNonfoil) - inDeckQty;
      const has = Array.from(f.deckStatus).some((d) => (d === 'indeck' ? inDeckQty > 0 : storageQty > 0));
      if (!has) return false;
    }

    if (state.filters.minValue != null) {
      if (priceOf(card) < state.filters.minValue) return false;
    }

    if (f.mvMin != null && card.cmc < f.mvMin) return false;
    if (f.mvMax != null && card.cmc > f.mvMax) return false;

    if (f.powMin != null || f.powMax != null) {
      const p = parseFloat(card.power);
      if (isNaN(p)) return false; // non-numeric power (e.g. */X, or no power at all) doesn't match a power range
      if (f.powMin != null && p < f.powMin) return false;
      if (f.powMax != null && p > f.powMax) return false;
    }

    if (f.touMin != null || f.touMax != null) {
      const t = parseFloat(card.toughness);
      if (isNaN(t)) return false;
      if (f.touMin != null && t < f.touMin) return false;
      if (f.touMax != null && t > f.touMax) return false;
    }

    if (f.sets.size && !f.sets.has(card.set)) return false;

    if (f.yearMin != null || f.yearMax != null) {
      const y = card.released_at ? parseInt(card.released_at.slice(0, 4), 10) : null;
      if (y == null || isNaN(y)) return false;
      if (f.yearMin != null && y < f.yearMin) return false;
      if (f.yearMax != null && y > f.yearMax) return false;
    }

    return true;
  }

  // Sums qtyFoil/qtyNonfoil across only the binders that are registered decks.
  function sumDeckQty(card) {
    let foil = 0;
    let nonfoil = 0;
    (card._binders || []).forEach((b) => {
      if (b.type === 'deck') { foil += b.qtyFoil; nonfoil += b.qtyNonfoil; }
    });
    return { foil, nonfoil };
  }

  // Returns every card currently in a given deck (by binder name), used by
  // the AI grading feature to build the decklist it sends/displays.
  function getDeckCards(deckName) {
    return state.collection.filter((c) => (c._binders || []).some((b) => b.name === deckName && b.type === 'deck'));
  }

  // Search is async because queries using art:/atag:/arttag:/otag:/function:
  // require a live round-trip to Scryfall's real search index — we don't
  // have that data cached locally. Everything else stays fully local/instant.
  async function runSearch() {
    const requestToken = ++state.searchRequestToken;
    const query = state.query;
    const usesLiveSearch = LIVE_OPERATOR_RE.test(query);

    let liveIds = null;
    if (usesLiveSearch) {
      loadingState.textContent = 'Searching Scryfall…';
      loadingState.classList.remove('hidden');
      resultsGrid.innerHTML = '';
      emptyState.classList.add('hidden');
      try {
        liveIds = await liveScryfallSearch(query);
      } catch (err) {
        if (requestToken !== state.searchRequestToken) return; // superseded by a newer search
        loadingState.classList.add('hidden');
        resultCountEl.textContent = 'Search error';
        emptyState.textContent = err.badQuery
          ? `Scryfall couldn't parse that: ${err.message}`
          : 'Could not reach Scryfall to run this search. Check your connection and try again.';
        emptyState.classList.remove('hidden');
        renderPagination(1);
        return;
      }
      if (requestToken !== state.searchRequestToken) return; // superseded by a newer search
      loadingState.classList.add('hidden');
      syncStatusEl.textContent = liveIds.truncated
        ? 'That art/oracle-tag search has a huge number of matches on Scryfall — results may be incomplete. Try narrowing it (e.g. combine with t: or c:).'
        : '';
    }

    // Apply scratchpad pulls before anything else so ownership/deck-status
    // filters, live-search intersection, and grouping all see availability
    // rather than raw ownership — and so fully-pulled cards drop out entirely.
    const scope = getScopedCollection().map(applyPullAdjustment).filter((c) => (c.qtyFoil + c.qtyNonfoil) > 0);
    let results;
    if (usesLiveSearch) {
      results = scope.filter((card) => liveIds.has(card.id) && passesSidebarFilters(card));
    } else {
      const tokens = tokenize(query).map(parseToken);
      results = scope.filter((card) => {
        if (!tokens.every((tok) => matchesToken(card, tok))) return false;
        if (!passesSidebarFilters(card)) return false;
        return true;
      });
    }

    // If "Not in a Deck" is selected on its own (not alongside "In a Deck"),
    // show cards split between a deck and storage with ONLY their storage
    // quantity, instead of hiding them outright.
    const onlyStorage = state.filters.deckStatus.has('notindeck') && !state.filters.deckStatus.has('indeck');
    if (onlyStorage) {
      results = results.map((card) => {
        const deckQty = sumDeckQty(card);
        const adjFoil = Math.max(0, card.qtyFoil - deckQty.foil);
        const adjNonfoil = Math.max(0, card.qtyNonfoil - deckQty.nonfoil);
        if (adjFoil === card.qtyFoil && adjNonfoil === card.qtyNonfoil) return card;
        return Object.assign({}, card, { qtyFoil: adjFoil, qtyNonfoil: adjNonfoil });
      });
    }

    state.filtered = results;
    state.page = 1;
    renderResults();
  }

  // ---------------------------------------------------------------------
  // Version grouping (collapse same-name printings into one tile)
  // ---------------------------------------------------------------------
  function groupCardsByName(cards) {
    const map = new Map();
    cards.forEach((card) => {
      const key = card.name.toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(card);
    });
    const groups = [];
    map.forEach((versions) => {
      versions.sort((a, b) => ((b.qtyFoil + b.qtyNonfoil) - (a.qtyFoil + a.qtyNonfoil)) || a.set_name.localeCompare(b.set_name));
      const representative = versions[0];
      const totalQtyFoil = versions.reduce((s, v) => s + v.qtyFoil, 0);
      const totalQtyNonfoil = versions.reduce((s, v) => s + v.qtyNonfoil, 0);
      groups.push({ name: representative.name, versions, representative, totalQtyFoil, totalQtyNonfoil });
    });
    return groups;
  }

  function groupPrice(group) {
    return Math.max.apply(null, group.versions.map(priceOf));
  }

  // Power/toughness can be non-numeric ('*', '1+*', 'X', etc.) — treat those
  // as lower than any real number so they sort to one consistent end.
  function numericStat(val) {
    const n = parseFloat(val);
    return isNaN(n) ? -1 : n;
  }

  // WUBRG-ish ordering: colorless first, then each mono color in WUBRG
  // order, then multicolor cards grouped by their color combination.
  const WUBRG = ['W', 'U', 'B', 'R', 'G'];
  function colorSortKey(card) {
    const colors = (card.color_identity && card.color_identity.length) ? card.color_identity : (card.colors || []);
    if (!colors.length) return '0';
    if (colors.length > 1) {
      return '9' + colors.slice().sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b)).join('');
    }
    return '1' + WUBRG.indexOf(colors[0]);
  }

  function sortGroups(groups) {
    const arr = groups.slice();
    switch (state.sortBy) {
      case 'cmc':
        arr.sort((a, b) => (a.representative.cmc - b.representative.cmc) || a.name.localeCompare(b.name));
        break;
      case 'power':
        arr.sort((a, b) => (numericStat(a.representative.power) - numericStat(b.representative.power)) || a.name.localeCompare(b.name));
        break;
      case 'toughness':
        arr.sort((a, b) => (numericStat(a.representative.toughness) - numericStat(b.representative.toughness)) || a.name.localeCompare(b.name));
        break;
      case 'color':
        arr.sort((a, b) => colorSortKey(a.representative).localeCompare(colorSortKey(b.representative)) || a.name.localeCompare(b.name));
        break;
      case 'rarity':
        arr.sort((a, b) => (RARITY_ORDER[b.representative.rarity] - RARITY_ORDER[a.representative.rarity]) || a.name.localeCompare(b.name));
        break;
      case 'set':
        arr.sort((a, b) => (a.representative.set_name || '').localeCompare(b.representative.set_name || '') || a.name.localeCompare(b.name));
        break;
      case 'released':
        arr.sort((a, b) => (a.representative.released_at || '').localeCompare(b.representative.released_at || '') || a.name.localeCompare(b.name));
        break;
      case 'artist':
        arr.sort((a, b) => (a.representative.artist || '').localeCompare(b.representative.artist || '') || a.name.localeCompare(b.name));
        break;
      case 'quantity':
        arr.sort((a, b) => ((b.totalQtyFoil + b.totalQtyNonfoil) - (a.totalQtyFoil + a.totalQtyNonfoil)) || a.name.localeCompare(b.name));
        break;
      case 'price':
        arr.sort((a, b) => (groupPrice(b) - groupPrice(a)) || a.name.localeCompare(b.name));
        break;
      default:
        arr.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (state.sortDir === 'desc') arr.reverse();
    return arr;
  }

  function priceOf(card) {
    const p = card.prices || {};
    return parseFloat(p.usd || p.usd_foil || 0) || 0;
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  // Legality/ban status: 'legal' and 'restricted' both count as "you can
  // play this", 'not_legal' and 'banned' don't.
  function isLegalInFormat(card, format) {
    if (!format) return true;
    const status = (card.legalities || {})[format];
    return status === 'legal' || status === 'restricted';
  }

  function renderResults() {
    const groups = sortGroups(groupCardsByName(state.filtered));
    const totalPrintings = state.filtered.length;
    resultCountEl.textContent = totalPrintings === groups.length
      ? `${groups.length.toLocaleString()} card${groups.length === 1 ? '' : 's'}`
      : `${groups.length.toLocaleString()} card${groups.length === 1 ? '' : 's'} (${totalPrintings.toLocaleString()} printings)`;

    const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * PAGE_SIZE;
    const pageGroups = groups.slice(start, start + PAGE_SIZE);

    emptyState.textContent = 'No cards match your search.';
    emptyState.classList.toggle('hidden', pageGroups.length !== 0);

    if (state.resultsView === 'table') {
      resultsGrid.innerHTML = '';
      renderResultsTable(pageGroups);
    } else {
      resultsTableBody.innerHTML = '';
      resultsGrid.innerHTML = '';
      const frag = document.createDocumentFragment();
      pageGroups.forEach((g) => frag.appendChild(renderCardTile(g)));
      resultsGrid.appendChild(frag);
    }

    renderPagination(totalPages);
    updateValueTotal();
  }

  function renderResultsTable(groups) {
    resultsTableBody.innerHTML = '';
    const frag = document.createDocumentFragment();
    groups.forEach((g) => frag.appendChild(renderTableRow(g)));
    resultsTableBody.appendChild(frag);
  }

  function renderTableRow(group) {
    const card = group.representative;
    const tr = document.createElement('tr');
    const legal = isLegalInFormat(card, state.legalityFormat);
    if (state.legalityFormat && !legal) tr.classList.add('not-legal');

    const ci = (card.color_identity && card.color_identity.length) ? card.color_identity.join('') : 'C';
    const qty = group.totalQtyFoil + group.totalQtyNonfoil;
    const price = groupPrice(group);
    const versionsNote = group.versions.length > 1 ? ` <span class="fg-hint">(${group.versions.length}v)</span>` : '';

    tr.innerHTML =
      `<td class="rt-name">${escapeHtml(card.name)}${versionsNote}</td>` +
      `<td>${card.cmc}</td>` +
      `<td>${escapeHtml(ci)}</td>` +
      `<td>${escapeHtml(card.set ? card.set.toUpperCase() : '')}</td>` +
      `<td>${escapeHtml(card.rarity || '')}</td>` +
      `<td>${qty}</td>` +
      `<td>${price ? '$' + price.toFixed(2) : '—'}</td>` +
      `<td>${state.legalityFormat ? `<span class="rt-legal-badge ${legal ? 'ok' : ''}">${legal ? 'Legal' : 'Not legal'}</span>` : ''}</td>`;

    tr.addEventListener('click', () => openModal(group, 0));
    return tr;
  }

  function updateValueTotal() {
    if (state.view !== 'value') return;
    const total = state.filtered.reduce((sum, c) => sum + computeCardValue(c), 0);
    valueTotalEl.textContent = `Total: $${total.toFixed(2)} across ${state.filtered.length.toLocaleString()} printing${state.filtered.length === 1 ? '' : 's'}`;
  }

  function renderCardTile(group) {
    const card = group.representative;
    const tile = document.createElement('div');
    tile.className = 'card-tile';
    if (state.legalityFormat && !isLegalInFormat(card, state.legalityFormat)) tile.classList.add('not-legal');

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = card.image || '';
    img.alt = card.name;
    tile.appendChild(img);

    const totalQty = group.totalQtyFoil + group.totalQtyNonfoil;
    if (totalQty) {
      const badge = document.createElement('div');
      badge.className = 'qty-badge';
      badge.innerHTML = `×${totalQty}` + (group.totalQtyFoil ? ` <span class="foil-marker">★${group.totalQtyFoil}</span>` : '');
      tile.appendChild(badge);
    }

    if (group.versions.length > 1) {
      const vBadge = document.createElement('div');
      vBadge.className = 'version-badge';
      vBadge.textContent = `${group.versions.length} versions`;
      tile.appendChild(vBadge);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tile-add-btn';
    addBtn.title = 'Add to scratchpad';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pickAndPull(card);
    });
    tile.appendChild(addBtn);

    const nameEl = document.createElement('div');
    nameEl.className = 'card-name';
    nameEl.textContent = card.name;
    tile.appendChild(nameEl);

    tile.addEventListener('click', () => openModal(group, 0));
    return tile;
  }

  function renderPagination(totalPages) {
    [paginationBottom, paginationTop].forEach((container) => {
      container.innerHTML = '';
      if (totalPages <= 1) return;
      const makeBtn = (label, page, active) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (active) b.classList.add('active');
        b.addEventListener('click', () => { state.page = page; renderResults(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
        return b;
      };
      if (state.page > 1) container.appendChild(makeBtn('‹ Prev', state.page - 1, false));
      const windowSize = 5;
      let from = Math.max(1, state.page - Math.floor(windowSize / 2));
      let to = Math.min(totalPages, from + windowSize - 1);
      from = Math.max(1, to - windowSize + 1);
      for (let p = from; p <= to; p++) container.appendChild(makeBtn(String(p), p, p === state.page));
      if (state.page < totalPages) container.appendChild(makeBtn('Next ›', state.page + 1, false));
    });
  }

  // ---------------------------------------------------------------------
  // Modal (with version picker for cards owned across multiple printings)
  // ---------------------------------------------------------------------
  function bindModalEvents() {
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalBackdrop').addEventListener('click', closeModal);
    $('#pullPickerClose').addEventListener('click', closePullPicker);
    $('#pullPickerBackdrop').addEventListener('click', closePullPicker);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); closePullPicker(); $('#syntaxModal').classList.add('hidden'); }
    });
  }

  function closeModal() { $('#cardModal').classList.add('hidden'); lastOpenModal = null; }

  function manaCostToHtml(cost) {
    if (!cost) return '';
    return cost.replace(/\{([^}]+)\}/g, (m, sym) => {
      const cls = sym.toLowerCase().replace('/', '');
      return `<i class="ms ms-${cls} ms-cost"></i>`;
    });
  }

  function openModal(group, selectedIndex) {
    selectedIndex = selectedIndex || 0;
    const card = group.versions[selectedIndex];
    lastOpenModal = { cardId: card.id };

    const versionsEl = $('#modalVersions');
    versionsEl.innerHTML = '';
    if (group.versions.length > 1) {
      versionsEl.classList.remove('hidden');
      group.versions.forEach((v, idx) => {
        const thumb = document.createElement('img');
        thumb.src = v.image || '';
        thumb.alt = v.set_name;
        thumb.title = `${v.set_name} (${v.set.toUpperCase()})`;
        thumb.className = 'modal-version-thumb' + (idx === selectedIndex ? ' active' : '');
        thumb.addEventListener('click', () => openModal(group, idx));
        versionsEl.appendChild(thumb);
      });
    } else {
      versionsEl.classList.add('hidden');
    }

    $('#modalImage').src = card.image || '';
    $('#modalImage').alt = card.name;
    $('#modalName').textContent = card.name;
    $('#modalManaCost').innerHTML = manaCostToHtml(card.mana_cost);
    $('#modalTypeLine').textContent = card.type_line;
    $('#modalOracleText').textContent = card.oracle_text;
    $('#modalPowerToughness').textContent = (card.power && card.toughness) ? `${card.power} / ${card.toughness}` : '';
    $('#modalSet').textContent = `${card.set_name} (${card.set.toUpperCase()})`;
    $('#modalRarity').textContent = card.rarity;
    const ownedParts = [];
    if (card.qtyNonfoil) ownedParts.push(`${card.qtyNonfoil} non-foil`);
    if (card.qtyFoil) ownedParts.push(`${card.qtyFoil} foil`);
    $('#modalOwned').textContent = ownedParts.join(', ') || 'none';

    const locationsRow = $('#modalLocationsRow');
    const binders = card._binders || [];
    if (binders.length) {
      const text = binders
        .map((b) => `${b.name} (${b.type}) ×${b.qtyFoil + b.qtyNonfoil}`)
        .join(', ');
      $('#modalLocations').textContent = text;
      locationsRow.classList.remove('hidden');
    } else {
      $('#modalLocations').textContent = 'No binder/deck info for this printing (loose in your collection, or your CSV export didn\'t include it).';
      locationsRow.classList.remove('hidden');
    }

    const price = card.prices || {};
    const priceParts = [];
    if (price.usd) priceParts.push(`$${price.usd}`);
    if (price.usd_foil) priceParts.push(`$${price.usd_foil} foil`);
    $('#modalPrice').textContent = priceParts.length ? priceParts.join(' · ') : '';

    const legalityRow = $('#modalLegalityRow');
    if (state.legalityFormat) {
      const legal = isLegalInFormat(card, state.legalityFormat);
      legalityRow.textContent = `${legal ? '✓ Legal' : '✕ Not legal'} in ${LEGALITY_LABELS[state.legalityFormat] || state.legalityFormat}`;
      legalityRow.className = 'modal-legality ' + (legal ? 'legal' : 'not-legal');
    } else {
      legalityRow.className = 'modal-legality hidden';
    }

    $('#modalAddToScratchpad').onclick = () => pickAndPull(card);

    const isCommanderEligible = /legendary/i.test(card.type_line || '') && /(creature|planeswalker)/i.test(card.type_line || '');
    const setCommanderModalBtn = $('#modalSetCommander');
    setCommanderModalBtn.classList.toggle('hidden', !isCommanderEligible);
    setCommanderModalBtn.onclick = () => setAsCommander(card);

    $('#cardModal').classList.remove('hidden');
  }

  // ---------------------------------------------------------------------
  // Scratchpad (brewing list + export)
  // ---------------------------------------------------------------------
  function persistScratchpad() {
    localforage.setItem(SCRATCHPAD_KEY, state.scratchpad).catch(() => {});
  }

  function findScratchItem(key) {
    return state.scratchpad.find((i) => i.key === key);
  }

  // ---------------------------------------------------------------------
  // Pulling: moving a card to the scratchpad "takes" a physical copy out of
  // a specific binder/deck (or the unassigned/loose pool). Availability is
  // computed on the fly from the scratchpad's pull records rather than by
  // mutating the collection, so it automatically re-applies itself after a
  // re-sync and automatically "returns" the card the moment it's removed
  // from the scratchpad or its quantity is reduced.
  // ---------------------------------------------------------------------

  // Map bindKey ('__unassigned__' or a binder name) -> { foil, nonfoil } of
  // how many units of this specific card are currently pulled from it.
  function getPulledForCard(cardId) {
    const result = new Map();
    state.scratchpad.forEach((item) => {
      if (item.ghost || item.key !== cardId) return;
      (item.pulls || []).forEach((p) => {
        const bindKey = p.binderName || '__unassigned__';
        if (!result.has(bindKey)) result.set(bindKey, { foil: 0, nonfoil: 0 });
        const r = result.get(bindKey);
        if (p.foil) r.foil += 1; else r.nonfoil += 1;
      });
    });
    return result;
  }

  // Total pulled foil/nonfoil for a card, regardless of whether the binder
  // it was pulled from still exists (robust to renamed/removed binders).
  function getPulledTotalForCard(cardId) {
    let foil = 0;
    let nonfoil = 0;
    getPulledForCard(cardId).forEach((v) => { foil += v.foil; nonfoil += v.nonfoil; });
    return { foil, nonfoil };
  }

  // Returns a clone of `card` with qtyFoil/qtyNonfoil/_binders reduced by
  // whatever's currently pulled into the scratchpad. Returns the same
  // object (no clone) if nothing's pulled, to avoid needless allocation.
  function applyPullAdjustment(card) {
    const totalPulled = getPulledTotalForCard(card.id);
    if (!totalPulled.foil && !totalPulled.nonfoil) return card;
    const pulledByBinder = getPulledForCard(card.id);
    const newBinders = (card._binders || []).map((b) => {
      const p = pulledByBinder.get(b.name) || { foil: 0, nonfoil: 0 };
      return Object.assign({}, b, {
        qtyFoil: Math.max(0, b.qtyFoil - p.foil),
        qtyNonfoil: Math.max(0, b.qtyNonfoil - p.nonfoil)
      });
    }).filter((b) => b.qtyFoil + b.qtyNonfoil > 0);
    return Object.assign({}, card, {
      qtyFoil: Math.max(0, card.qtyFoil - totalPulled.foil),
      qtyNonfoil: Math.max(0, card.qtyNonfoil - totalPulled.nonfoil),
      _binders: newBinders
    });
  }

  // All the (binder-or-unassigned, finish) combos this specific printing
  // still has available to pull from, after subtracting existing pulls.
  function getAvailableLocations(card) {
    const pulled = getPulledForCard(card.id);
    const locations = [];
    const binderQtySum = { foil: 0, nonfoil: 0 };
    (card._binders || []).forEach((b) => {
      binderQtySum.foil += b.qtyFoil;
      binderQtySum.nonfoil += b.qtyNonfoil;
      const p = pulled.get(b.name) || { foil: 0, nonfoil: 0 };
      const availFoil = Math.max(0, b.qtyFoil - p.foil);
      const availNonfoil = Math.max(0, b.qtyNonfoil - p.nonfoil);
      if (availFoil > 0) locations.push({ binderName: b.name, type: b.type, foil: true, available: availFoil });
      if (availNonfoil > 0) locations.push({ binderName: b.name, type: b.type, foil: false, available: availNonfoil });
    });
    const unassignedFoil = Math.max(0, card.qtyFoil - binderQtySum.foil);
    const unassignedNonfoil = Math.max(0, card.qtyNonfoil - binderQtySum.nonfoil);
    const pU = pulled.get('__unassigned__') || { foil: 0, nonfoil: 0 };
    const availUFoil = Math.max(0, unassignedFoil - pU.foil);
    const availUNonfoil = Math.max(0, unassignedNonfoil - pU.nonfoil);
    if (availUFoil > 0) locations.push({ binderName: null, type: 'unassigned', foil: true, available: availUFoil });
    if (availUNonfoil > 0) locations.push({ binderName: null, type: 'unassigned', foil: false, available: availUNonfoil });
    return locations;
  }

  // Entry point for both the tile "+" button and the modal's add button.
  // Auto-pulls when there's only one possible location; otherwise opens the picker.
  // Optional onDone fires once a copy actually gets pulled (used by "Set as Commander").
  function pickAndPull(card, onDone) {
    const locations = getAvailableLocations(card);
    if (!locations.length) {
      syncStatusEl.textContent = `No more available copies of ${card.name} to add — the rest are already in your scratchpad.`;
      setTimeout(() => { if (syncStatusEl.textContent.startsWith('No more available copies')) syncStatusEl.textContent = ''; }, 3500);
      return;
    }
    if (locations.length === 1) {
      pullCardFrom(card, locations[0], onDone);
      return;
    }
    openPullPicker(card, locations, onDone);
  }

  // Pulls the card into the Deck Builder (same multi-location picker as the
  // + button) if there's a copy left to pull, then sets it as the Deck
  // Builder's commander either way — if every copy is already in the deck,
  // it just marks it as commander without trying to pull again.
  function setAsCommander(card) {
    const finalize = () => {
      state.scratchpadCommander = card.name;
      persistScratchpadCommander();
      applyCommanderColorLock(card);
      renderScratchCommanderRow();
      showDeckBuilderView();
    };
    if (!getAvailableLocations(card).length) { finalize(); return; }
    pickAndPull(card, finalize);
  }

  function pullCardFromSilent(card, loc) {
    const existing = findScratchItem(card.id);
    const pullRecord = { binderName: loc.binderName, type: loc.type, foil: loc.foil };
    if (existing) {
      existing.qty += 1;
      existing.pulls = existing.pulls || [];
      existing.pulls.push(pullRecord);
    } else {
      state.scratchpad.push({
        key: card.id, name: card.name, image: card.image, mana_cost: card.mana_cost,
        qty: 1, ghost: false, pulls: [pullRecord]
      });
    }
  }

  function pullCardFrom(card, loc, onDone) {
    pullCardFromSilent(card, loc);
    persistScratchpad();
    renderScratchpad();
    refreshAfterPullChange(card);
    if (onDone) onDone();
  }

  // Bulk-imports a pasted decklist: owned copies are pulled from wherever
  // they're available (best-stocked location first, no interactive picker
  // since this could be dozens of cards); anything not fully covered by
  // owned copies is added as a ghost card for the remainder.
  function parseDecklistText(text) {
    return (text || '').split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
        if (m) return { qty: parseInt(m[1], 10) || 1, name: m[2].trim() };
        return { qty: 1, name: line.trim() };
      })
      .filter((entry) => entry.name);
  }

  function getAvailableLocationsForName(name) {
    const lower = name.toLowerCase();
    const combined = [];
    state.collection
      .filter((c) => c.name.toLowerCase() === lower)
      .forEach((card) => {
        getAvailableLocations(card).forEach((loc) => combined.push({ card, loc }));
      });
    return combined;
  }

  function importDecklistText(text) {
    const entries = parseDecklistText(text);
    if (!entries.length) return { addedOwned: 0, addedGhost: 0, lines: [] };

    let addedOwned = 0;
    let addedGhost = 0;
    const summaryLines = [];

    entries.forEach((entry) => {
      let pulled = 0;
      for (let i = 0; i < entry.qty; i++) {
        const combined = getAvailableLocationsForName(entry.name);
        if (!combined.length) break;
        combined.sort((a, b) => b.loc.available - a.loc.available);
        const pick = combined[0];
        pullCardFromSilent(pick.card, pick.loc);
        pulled++;
      }
      addedOwned += pulled;
      const missing = entry.qty - pulled;
      if (missing > 0) {
        for (let i = 0; i < missing; i++) addGhostToScratchpadSilent(entry.name);
        addedGhost += missing;
      }
      summaryLines.push(`${entry.name}: ${pulled} pulled from your collection${missing ? `, ${missing} added as not-owned` : ''}`);
    });

    persistScratchpad();
    renderScratchpad();
    runSearch();

    return { addedOwned, addedGhost, lines: summaryLines };
  }

  function bindDecklistImportEvents() {
    $('#decklistImportBtn').addEventListener('click', () => {
      const text = $('#decklistImportInput').value;
      const result = importDecklistText(text);
      const resultEl = $('#decklistImportResult');
      if (!result.lines.length) {
        resultEl.textContent = 'Paste a decklist above first.';
        return;
      }
      resultEl.textContent =
        `Pulled ${result.addedOwned} owned cop${result.addedOwned === 1 ? 'y' : 'ies'}, added ${result.addedGhost} as not-owned.\n\n` +
        result.lines.join('\n');
    });
  }

  // Rebuilds a fresh version-group for a card by id, straight from the
  // (pull-adjusted) collection — independent of the current search/filters,
  // since the modal shows all versions of a card regardless of what's typed
  // in the search box.
  function rebuildGroupForCard(cardId) {
    const original = state.collection.find((c) => c.id === cardId);
    if (!original) return null;
    const sameName = state.collection
      .filter((c) => c.name === original.name)
      .map(applyPullAdjustment)
      .filter((c) => (c.qtyFoil + c.qtyNonfoil) > 0);
    if (!sameName.length) return null;
    const groups = groupCardsByName(sameName);
    return groups.find((g) => g.versions.some((v) => v.id === cardId)) || groups[0];
  }

  // Re-runs search (so availability everywhere reflects the new pull/return)
  // and, if this exact card's modal is open, refreshes it in place with
  // up-to-date availability — or closes it if the card fully disappeared.
  function refreshAfterPullChange(card) {
    runSearch();
    if (lastOpenModal && lastOpenModal.cardId === card.id) {
      const group = rebuildGroupForCard(card.id);
      if (group) {
        const idx = group.versions.findIndex((v) => v.id === card.id);
        openModal(group, idx >= 0 ? idx : 0);
      } else {
        closeModal();
      }
    }
  }

  function openPullPicker(card, locations, onDone) {
    pullPickerCardName.textContent = card.name;
    pullPickerList.innerHTML = '';
    locations.forEach((loc) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pull-picker-option';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'pp-name';
      nameSpan.textContent = loc.binderName || 'Unassigned (loose)';
      if (loc.binderName) {
        const typeSpan = document.createElement('span');
        typeSpan.className = 'pp-type';
        typeSpan.textContent = ` (${loc.type})`;
        nameSpan.appendChild(typeSpan);
      }
      const qtySpan = document.createElement('span');
      qtySpan.className = 'pp-qty';
      qtySpan.innerHTML = loc.foil ? `<span class="pp-foil">★ ${loc.available} foil</span>` : `${loc.available} non-foil`;
      btn.appendChild(nameSpan);
      btn.appendChild(qtySpan);
      btn.addEventListener('click', () => {
        pullCardFrom(card, loc, onDone);
        closePullPicker();
      });
      pullPickerList.appendChild(btn);
    });
    pullPickerModal.classList.remove('hidden');
  }

  function closePullPicker() {
    pullPickerModal.classList.add('hidden');
  }

  function addGhostToScratchpadSilent(name) {
    name = (name || '').trim();
    if (!name) return;
    const key = 'ghost:' + name.toLowerCase();
    const existing = findScratchItem(key);
    if (existing) existing.qty += 1;
    else state.scratchpad.push({ key, name, image: null, mana_cost: '', qty: 1, ghost: true });
  }

  function addGhostToScratchpad(name) {
    addGhostToScratchpadSilent(name);
    persistScratchpad();
    renderScratchpad();
  }

  function updateScratchQty(key, delta) {
    const item = findScratchItem(key);
    if (!item) return;

    // Increasing a real (non-ghost) card's quantity pulls another physical
    // copy — route it through the same picker/auto-pull logic as the + button.
    if (delta > 0 && !item.ghost) {
      const card = state.collection.find((c) => c.id === key);
      if (card) { pickAndPull(card); return; }
    }

    // Decreasing releases that many pulled copies back to wherever they came from.
    if (delta < 0 && !item.ghost && item.pulls && item.pulls.length) {
      const toRemove = Math.min(-delta, item.pulls.length);
      item.pulls.splice(item.pulls.length - toRemove, toRemove);
    }

    item.qty += delta;
    if (item.qty <= 0) state.scratchpad = state.scratchpad.filter((i) => i.key !== key);
    persistScratchpad();
    renderScratchpad();

    const card = state.collection.find((c) => c.id === key);
    if (card) refreshAfterPullChange(card); else runSearch();
  }

  function removeFromScratchpad(key) {
    state.scratchpad = state.scratchpad.filter((i) => i.key !== key);
    persistScratchpad();
    renderScratchpad();
    const card = state.collection.find((c) => c.id === key);
    if (card) refreshAfterPullChange(card); else runSearch();
  }

  function clearScratchpad() {
    if (!state.scratchpad.length) return;
    const snapshot = state.scratchpad;
    state.scratchpad = [];
    persistScratchpad();
    renderScratchpad();
    runSearch();
    showUndoToast(`Cleared ${snapshot.length} scratchpad item${snapshot.length === 1 ? '' : 's'}.`, () => {
      state.scratchpad = snapshot;
      persistScratchpad();
      renderScratchpad();
      runSearch();
    });
  }

  function scratchpadExportText() {
    return state.scratchpad
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => `${i.qty} ${i.name}`)
      .join('\n');
  }

  // Groups the scratchpad by the physical binder/deck each copy was pulled
  // from, so you know exactly where to pull the real cards after building
  // the list somewhere like Archidekt. Ghost (not-owned) cards get their
  // own section since there's nowhere to pull them from.
  function scratchpadPullListText() {
    const byLocation = new Map(); // bindKey -> { label, cards: Map(name -> {foil, nonfoil}) }
    const ghosts = [];

    state.scratchpad.forEach((item) => {
      if (item.ghost) { ghosts.push(item); return; }
      (item.pulls || []).forEach((p) => {
        const bindKey = p.binderName || '__unassigned__';
        if (!byLocation.has(bindKey)) {
          const label = p.binderName ? `${p.binderName} (${p.type})` : 'Unassigned (loose, not filed in any binder)';
          byLocation.set(bindKey, { label, cards: new Map() });
        }
        const loc = byLocation.get(bindKey);
        const q = loc.cards.get(item.name) || { foil: 0, nonfoil: 0 };
        if (p.foil) q.foil += 1; else q.nonfoil += 1;
        loc.cards.set(item.name, q);
      });
    });

    const sections = Array.from(byLocation.values())
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((loc) => {
        const lines = [`== ${loc.label} ==`];
        Array.from(loc.cards.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .forEach(([name, q]) => {
            const parts = [];
            if (q.nonfoil) parts.push(`${q.nonfoil}x`);
            if (q.foil) parts.push(`${q.foil}x foil`);
            lines.push(`${parts.join(' + ')} ${name}`);
          });
        return lines.join('\n');
      });

    if (ghosts.length) {
      const lines = ['== Not owned yet =='];
      ghosts.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((g) => lines.push(`${g.qty}x ${g.name}`));
      sections.push(lines.join('\n'));
    }

    return sections.join('\n\n');
  }

  async function copyTextToClipboard(text, statusEl) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = 'Copied to clipboard.';
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        statusEl.textContent = 'Copied to clipboard.';
      } catch (e2) {
        statusEl.textContent = 'Could not copy automatically — try the download button instead.';
      }
      document.body.removeChild(ta);
    }
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
  }

  function downloadTextFile(text, filename) {
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyScratchpadToClipboard() {
    return copyTextToClipboard(scratchpadExportText(), $('#scratchpadStatus'));
  }

  function downloadScratchpadTxt() {
    downloadTextFile(scratchpadExportText(), 'scrybox-scratchpad.txt');
  }

  function copyScratchpadPullListToClipboard() {
    const text = scratchpadPullListText();
    const statusEl = $('#scratchpadStatus');
    if (!text) { statusEl.textContent = 'Nothing to pull — add owned cards to the scratchpad first.'; setTimeout(() => { statusEl.textContent = ''; }, 3000); return; }
    return copyTextToClipboard(text, statusEl);
  }

  function downloadScratchpadPullListTxt() {
    downloadTextFile(scratchpadPullListText(), 'scrybox-pull-list.txt');
  }

  function renderScratchpad() {
    const count = state.scratchpad.reduce((sum, i) => sum + i.qty, 0);
    scratchpadCountEl.textContent = String(count);
    scratchpadGrid.innerHTML = '';
    if (!state.scratchpad.length) {
      scratchpadEmpty.classList.remove('hidden');
    } else {
      scratchpadEmpty.classList.add('hidden');
      const sorted = state.scratchpad.slice().sort((a, b) => a.name.localeCompare(b.name));
      const frag = document.createDocumentFragment();
      sorted.forEach((item) => frag.appendChild(renderScratchpadTile(item)));
      scratchpadGrid.appendChild(frag);
    }
    renderScratchCommanderRow();
  }

  // Archidekt-style visual tile — actual card art instead of a text row.
  // Ghost cards (not owned) have no cached image, so they fall back to a
  // plain name placeholder rather than a blank/broken image.
  function renderScratchpadTile(item) {
    const tile = document.createElement('div');
    tile.className = 'card-tile scratch-tile' + (item.ghost ? ' scratch-ghost' : '');

    if (item.image) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = item.image;
      img.alt = item.name;
      tile.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'scratch-tile-placeholder';
      placeholder.textContent = item.name;
      tile.appendChild(placeholder);
    }

    const badge = document.createElement('div');
    badge.className = 'qty-badge';
    badge.textContent = `×${item.qty}`;
    tile.appendChild(badge);

    if (item.ghost) {
      const ghostBadge = document.createElement('div');
      ghostBadge.className = 'scratch-ghost-badge';
      ghostBadge.textContent = 'not owned';
      tile.appendChild(ghostBadge);
    }

    const controls = document.createElement('div');
    controls.className = 'scratch-tile-controls';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.title = 'Remove one';
    minus.addEventListener('click', (e) => { e.stopPropagation(); updateScratchQty(item.key, -1); });
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.title = 'Add one more';
    plus.addEventListener('click', (e) => { e.stopPropagation(); updateScratchQty(item.key, 1); });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'scratch-remove';
    remove.textContent = '✕';
    remove.title = 'Remove all copies';
    remove.addEventListener('click', (e) => { e.stopPropagation(); removeFromScratchpad(item.key); });
    controls.appendChild(minus);
    controls.appendChild(plus);
    controls.appendChild(remove);
    tile.appendChild(controls);

    const nameEl = document.createElement('div');
    nameEl.className = 'card-name';
    nameEl.textContent = item.name;
    tile.appendChild(nameEl);

    return tile;
  }

  function bindScratchpadEvents() {
    $('#scratchpadToggleBtn').addEventListener('click', () => {
      if (!state.collection.length) { showUpload(); return; }
      showDeckBuilderView();
    });
    $('#scratchpadCopyBtn').addEventListener('click', copyScratchpadToClipboard);
    $('#scratchpadDownloadBtn').addEventListener('click', downloadScratchpadTxt);
    $('#scratchpadCopyPullBtn').addEventListener('click', copyScratchpadPullListToClipboard);
    $('#scratchpadDownloadPullBtn').addEventListener('click', downloadScratchpadPullListTxt);
    $('#scratchpadClearBtn').addEventListener('click', clearScratchpad);
    $('#ghostAddBtn').addEventListener('click', () => {
      addGhostToScratchpad($('#ghostNameInput').value);
      $('#ghostNameInput').value = '';
    });
    $('#ghostNameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addGhostToScratchpad(e.target.value);
        e.target.value = '';
      }
    });
  }

  // ---------------------------------------------------------------------
  // Undo toast — a brief, dismissable "undo" for destructive one-click actions.
  // ---------------------------------------------------------------------
  let undoToastTimer = null;
  function showUndoToast(message, restoreFn) {
    pendingUndo = restoreFn;
    undoToastMessage.textContent = message;
    undoToast.classList.remove('hidden');
    clearTimeout(undoToastTimer);
    undoToastTimer = setTimeout(() => {
      undoToast.classList.add('hidden');
      pendingUndo = null;
    }, 6000);
  }

  function bindUndoToastEvents() {
    undoToastBtn.addEventListener('click', () => {
      clearTimeout(undoToastTimer);
      undoToast.classList.add('hidden');
      if (pendingUndo) { pendingUndo(); pendingUndo = null; }
    });
  }

  // ---------------------------------------------------------------------
  // Saved search presets
  // ---------------------------------------------------------------------
  function serializeFilters() {
    const f = state.filters;
    return {
      colors: Array.from(f.colors), colorExact: f.colorExact,
      playstyles: Array.from(f.playstyles), tags: Array.from(f.tags),
      mechanicsAnd: Array.from(f.mechanicsAnd), mechanicsOr: Array.from(f.mechanicsOr),
      types: Array.from(f.types), rarities: Array.from(f.rarities),
      ownership: Array.from(f.ownership), deckStatus: Array.from(f.deckStatus),
      minValue: f.minValue, mvMin: f.mvMin, mvMax: f.mvMax,
      powMin: f.powMin, powMax: f.powMax, touMin: f.touMin, touMax: f.touMax,
      sets: Array.from(f.sets), yearMin: f.yearMin, yearMax: f.yearMax
    };
  }

  function applySerializedFilters(sf) {
    sf = sf || {};
    const f = state.filters;
    f.colors = new Set(sf.colors || []);
    f.colorExact = !!sf.colorExact;
    f.playstyles = new Set(sf.playstyles || []);
    f.tags = new Set(sf.tags || []);
    f.mechanicsAnd = new Set(sf.mechanicsAnd || []);
    f.mechanicsOr = new Set(sf.mechanicsOr || []);
    f.types = new Set(sf.types || []);
    f.rarities = new Set(sf.rarities || []);
    f.ownership = new Set(sf.ownership || []);
    f.deckStatus = new Set(sf.deckStatus || []);
    f.minValue = sf.minValue != null ? sf.minValue : null;
    f.mvMin = sf.mvMin != null ? sf.mvMin : null;
    f.mvMax = sf.mvMax != null ? sf.mvMax : null;
    f.powMin = sf.powMin != null ? sf.powMin : null;
    f.powMax = sf.powMax != null ? sf.powMax : null;
    f.touMin = sf.touMin != null ? sf.touMin : null;
    f.touMax = sf.touMax != null ? sf.touMax : null;
    f.sets = new Set(sf.sets || []);
    f.yearMin = sf.yearMin != null ? sf.yearMin : null;
    f.yearMax = sf.yearMax != null ? sf.yearMax : null;
  }

  // Re-syncs every filter-related DOM control (chips, toggles, range inputs)
  // to match state.filters — needed after loading a saved preset since those
  // controls aren't otherwise bound to state.
  function syncFilterUI() {
    const f = state.filters;
    document.querySelectorAll('.mana-toggle').forEach((btn) => btn.classList.toggle('active', f.colors.has(btn.dataset.color)));
    $('#colorExactToggle').checked = f.colorExact;
    document.querySelectorAll('#playstyleChips .chip').forEach((btn) => btn.classList.toggle('active', f.playstyles.has(btn.dataset.playstyle)));
    document.querySelectorAll('#tagChips .chip').forEach((btn) => btn.classList.toggle('active', f.tags.has(btn.dataset.tag)));
    document.querySelectorAll('#typeChips .chip').forEach((btn) => btn.classList.toggle('active', f.types.has(btn.dataset.type)));
    document.querySelectorAll('#rarityChips .chip').forEach((btn) => btn.classList.toggle('active', f.rarities.has(btn.dataset.rarity)));
    document.querySelectorAll('#setChips .chip').forEach((btn) => btn.classList.toggle('active', f.sets.has(btn.dataset.set)));
    document.querySelectorAll('#ownershipChips .chip').forEach((btn) => btn.classList.toggle('active', f.ownership.has(btn.dataset.own)));
    document.querySelectorAll('#deckStatusChips .chip').forEach((btn) => btn.classList.toggle('active', f.deckStatus.has(btn.dataset.deckstatus)));
    document.querySelectorAll('#mechanicsChips .chip').forEach((btn) => {
      const value = btn.dataset.mechanic;
      btn.classList.remove('chip-and', 'chip-or');
      if (f.mechanicsAnd.has(value)) { btn.dataset.state = 'and'; btn.classList.add('chip-and'); btn.textContent = `${btn.dataset.label} (AND)`; }
      else if (f.mechanicsOr.has(value)) { btn.dataset.state = 'or'; btn.classList.add('chip-or'); btn.textContent = `${btn.dataset.label} (OR)`; }
      else { btn.dataset.state = 'off'; btn.textContent = btn.dataset.label; }
    });
    minValueInput.value = f.minValue != null ? f.minValue : '';
    mvMinInput.value = f.mvMin != null ? f.mvMin : '';
    mvMaxInput.value = f.mvMax != null ? f.mvMax : '';
    powMinInput.value = f.powMin != null ? f.powMin : '';
    powMaxInput.value = f.powMax != null ? f.powMax : '';
    touMinInput.value = f.touMin != null ? f.touMin : '';
    touMaxInput.value = f.touMax != null ? f.touMax : '';
    yearMinInput.value = f.yearMin != null ? f.yearMin : '';
    yearMaxInput.value = f.yearMax != null ? f.yearMax : '';
  }

  function persistPresets() {
    localforage.setItem(PRESETS_KEY, state.presets).catch(() => {});
  }

  function renderPresetOptions() {
    const current = presetSelect.value;
    presetSelect.innerHTML = '<option value="">Saved searches…</option>';
    state.presets.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      presetSelect.appendChild(opt);
    });
    if (state.presets.some((p) => p.name === current)) presetSelect.value = current;
  }

  function bindPresetEvents() {
    $('#presetSaveBtn').addEventListener('click', () => {
      const name = window.prompt('Name this search:', presetSelect.value || '');
      if (!name || !name.trim()) return;
      const trimmed = name.trim();
      const preset = { name: trimmed, query: state.query, filters: serializeFilters() };
      const idx = state.presets.findIndex((p) => p.name === trimmed);
      if (idx >= 0) state.presets[idx] = preset; else state.presets.push(preset);
      persistPresets();
      renderPresetOptions();
      presetSelect.value = trimmed;
    });
    $('#presetLoadBtn').addEventListener('click', () => {
      const preset = state.presets.find((p) => p.name === presetSelect.value);
      if (!preset) return;
      state.query = preset.query || '';
      searchInput.value = state.query;
      applySerializedFilters(preset.filters);
      syncFilterUI();
      runSearch();
    });
    $('#presetDeleteBtn').addEventListener('click', () => {
      const name = presetSelect.value;
      if (!name) return;
      state.presets = state.presets.filter((p) => p.name !== name);
      persistPresets();
      renderPresetOptions();
    });
  }

  // ---------------------------------------------------------------------
  // Full collection backup/restore (JSON) — independent of a ManaBox CSV,
  // skips re-fetching from Scryfall entirely on restore.
  // ---------------------------------------------------------------------
  function buildBackupObject() {
    return {
      scrybox_backup: true,
      version: 1,
      exportedAt: new Date().toISOString(),
      collection: state.collection,
      scratchpad: state.scratchpad,
      excludedBinders: Array.from(state.excludedBinders),
      presets: state.presets
    };
  }

  function downloadBackup() {
    if (!state.collection.length) { setStatus('Nothing to back up yet — import a collection first.', true); return; }
    downloadTextFile(JSON.stringify(buildBackupObject()), `scrybox-backup-${timestampSlug()}.json`);
  }

  async function handleRestoreFile(file) {
    if (!file) return;
    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
      if (!data || !Array.isArray(data.collection)) throw new Error('That doesn\'t look like a Scrybox backup file.');
    } catch (err) {
      setStatus('Could not restore that file — ' + (err.message || 'invalid JSON.'), true);
      return;
    }

    state.collection = data.collection;
    state.scratchpad = Array.isArray(data.scratchpad) ? data.scratchpad : [];
    state.excludedBinders = new Set(Array.isArray(data.excludedBinders) ? data.excludedBinders : []);
    state.presets = Array.isArray(data.presets) ? data.presets : [];

    const meta = { count: state.collection.length, syncedAt: data.exportedAt || new Date().toISOString() };
    try {
      await localforage.setItem(STORAGE_KEY, state.collection);
      await localforage.setItem(META_KEY, meta);
      await localforage.setItem(SCRATCHPAD_KEY, state.scratchpad);
      await localforage.setItem(EXCLUDED_BINDERS_KEY, Array.from(state.excludedBinders));
      await localforage.setItem(PRESETS_KEY, state.presets);
    } catch (err) {
      // in-memory state is restored regardless; just won't persist across reload
    }

    renderScratchpad();
    renderPresetOptions();
    showApp(meta);
    runSearch();
    setStatus(`Restored ${state.collection.length.toLocaleString()} cards from backup.`);
  }

  function bindBackupEvents() {
    $('#backupDownloadBtn').addEventListener('click', downloadBackup);
    $('#backupRestoreInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      handleRestoreFile(file);
      e.target.value = '';
    });
  }

  // ---------------------------------------------------------------------
  // Grid/table view toggle + format legality highlighting
  // ---------------------------------------------------------------------
  function setResultsView(view) {
    state.resultsView = view;
    viewGridBtn.classList.toggle('active', view === 'grid');
    viewTableBtn.classList.toggle('active', view === 'table');
    resultsGrid.classList.toggle('hidden', view !== 'grid');
    resultsTableWrap.classList.toggle('hidden', view !== 'table');
    renderResults();
  }

  function bindViewToggleEvents() {
    viewGridBtn.addEventListener('click', () => setResultsView('grid'));
    viewTableBtn.addEventListener('click', () => setResultsView('table'));
    formatLegalitySelect.addEventListener('change', (e) => {
      state.legalityFormat = e.target.value;
      renderResults();
    });
    document.querySelectorAll('#resultsTable th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (state.sortBy === field) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortBy = field; state.sortDir = 'asc'; }
        sortSelect.value = field;
        $('#sortDirBtn').textContent = state.sortDir === 'asc' ? 'Asc ↑' : 'Desc ↓';
        state.page = 1;
        renderResults();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------
  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchInput.focus();
        return;
      }
      if ((e.key === 's' || e.key === 'S') && !typing) {
        e.preventDefault();
        if (state.view === 'deckBuilder') showCollectionView();
        else if (state.collection.length) showDeckBuilderView();
        return;
      }
      if (e.key === 'Escape' && typing && tag === 'input' && e.target === searchInput) {
        searchInput.blur();
      }
    });
  }

  // =========================================================================
  // AI deck grading — the old regex/heuristic Power/Fun/"Does The Thing"
  // scoring has been removed entirely. Instead, a real language model (your
  // own Anthropic API key, called directly from this browser) reads the full
  // decklist and grades it — either automatically via "Grade with AI", or
  // via a ready-made prompt you copy into any Claude conversation yourself.
  // =========================================================================

  function persistAiSettings() {
    localforage.setItem(AI_SETTINGS_KEY, state.aiSettings).catch(() => {});
  }

  function persistAiGrades() {
    localforage.setItem(AI_GRADES_KEY, state.aiGrades).catch(() => {});
  }

  function persistDeckCommanders() {
    localforage.setItem(DECK_COMMANDERS_KEY, state.deckCommanders).catch(() => {});
  }

  function persistAppSettings() {
    localforage.setItem(APP_SETTINGS_KEY, state.appSettings).catch(() => {});
  }

  // Toggles the ManaBox-inspired dark theme on/off across the whole app via
  // a data-theme attribute on <html>, which the CSS keys off of.
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.appSettings.manaboxTheme ? 'manabox' : 'default');
    manaboxThemeToggle.checked = !!state.appSettings.manaboxTheme;
  }

  // Single settings entry point — covers Appearance (theme) and AI Deck
  // Grading in one modal, so there's exactly one "Settings" button to find
  // instead of two near-identical gear icons.
  function openSettingsModal() {
    manaboxThemeToggle.checked = !!state.appSettings.manaboxTheme;
    aiApiKeyInput.value = state.aiSettings.apiKey || '';
    aiModelSelect.value = state.aiSettings.model || 'claude-sonnet-5';
    aiSettingsStatus.textContent = '';
    settingsModal.classList.remove('hidden');
  }

  function closeSettingsModal() {
    settingsModal.classList.add('hidden');
  }

  function bindGeneralSettingsEvents() {
    generalSettingsBtn.addEventListener('click', openSettingsModal);
    $('#settingsClose').addEventListener('click', closeSettingsModal);
    $('#settingsBackdrop').addEventListener('click', closeSettingsModal);
    manaboxThemeToggle.addEventListener('change', () => {
      state.appSettings.manaboxTheme = manaboxThemeToggle.checked;
      persistAppSettings();
      applyTheme();
    });
  }

  // Shows the pinned commander (if any) for a deck, and keeps the datalist of
  // candidate names (legendary creatures/planeswalkers actually in the deck)
  // up to date so the input can autocomplete against real cards.
  function renderDeckCommanderRow(deckName) {
    setCommanderRow.classList.add('hidden');
    const commander = (state.deckCommanders[deckName] || '').trim();
    if (commander) {
      deckCommanderDisplay.textContent = commander;
      deckCommanderDisplay.classList.remove('is-unset');
    } else {
      deckCommanderDisplay.textContent = '(not set — AI will guess)';
      deckCommanderDisplay.classList.add('is-unset');
    }

    const candidates = getDeckCards(deckName)
      .filter((c) => /legendary/i.test(c.type_line || '') && /(creature|planeswalker)/i.test(c.type_line || ''))
      .map((c) => c.name);
    setCommanderOptions.innerHTML = Array.from(new Set(candidates))
      .map((name) => `<option value="${escapeHtml(name)}"></option>`)
      .join('');
  }

  function bindSetCommanderEvents() {
    setCommanderBtn.addEventListener('click', () => {
      if (!(state.view === 'binderDetail' && state.activeBinder)) return;
      setCommanderInput.value = state.deckCommanders[state.activeBinder.name] || '';
      setCommanderRow.classList.remove('hidden');
      setCommanderInput.focus();
    });
    setCommanderCancelBtn.addEventListener('click', () => {
      setCommanderRow.classList.add('hidden');
    });
    setCommanderSaveBtn.addEventListener('click', () => {
      if (!(state.view === 'binderDetail' && state.activeBinder)) return;
      const deckName = state.activeBinder.name;
      const name = setCommanderInput.value.trim();
      if (name) state.deckCommanders[deckName] = name;
      else delete state.deckCommanders[deckName];
      persistDeckCommanders();
      renderDeckCommanderRow(deckName);
    });
    setCommanderClearBtn.addEventListener('click', () => {
      if (!(state.view === 'binderDetail' && state.activeBinder)) return;
      const deckName = state.activeBinder.name;
      delete state.deckCommanders[deckName];
      persistDeckCommanders();
      renderDeckCommanderRow(deckName);
    });
  }

  function bindAiSettingsEvents() {
    $('#aiSettingsSaveBtn').addEventListener('click', () => {
      state.aiSettings.apiKey = aiApiKeyInput.value.trim();
      state.aiSettings.model = aiModelSelect.value;
      persistAiSettings();
      aiSettingsStatus.textContent = state.aiSettings.apiKey ? 'Saved.' : 'Saved (no key set — grading will prompt you to add one).';
    });
    $('#aiSettingsClearBtn').addEventListener('click', () => {
      state.aiSettings.apiKey = '';
      aiApiKeyInput.value = '';
      persistAiSettings();
      aiSettingsStatus.textContent = 'Key cleared.';
    });
  }

  // The exact in-deck quantity (from this specific binder's entry), which
  // can differ from total owned quantity if the card is split across
  // multiple locations.
  function deckQtyFor(card, deckName) {
    const b = (card._binders || []).find((x) => x.name === deckName && x.type === 'deck');
    return b ? (b.qtyFoil + b.qtyNonfoil) : (card.qtyFoil + card.qtyNonfoil);
  }

  function buildDecklistLines(deckName) {
    const cards = getDeckCards(deckName).slice().sort((a, b) => a.name.localeCompare(b.name));
    return cards.map((c) => cardDetailLine(c, deckQtyFor(c, deckName)));
  }

  // strict=true -> ask for machine-parseable JSON only (used for the direct
  // API call). strict=false -> ask for a readable written breakdown (used
  // for the copy-paste-into-Claude-chat prompt).
  function buildGradingPrompt(deckName, strict) {
    const lines = buildDecklistLines(deckName);
    const intro =
      `You are grading a Magic: The Gathering Commander (EDH) deck called "${deckName}". Here is the full decklist ` +
      `(quantity, name, mana cost, color identity, type line, power/toughness or loyalty, oracle text):\n\n${lines.join('\n')}\n\n`;

    const commanderOverride = (state.deckCommanders[deckName] || '').trim();
    const commanderNote = commanderOverride
      ? `The commander of this deck is definitively: ${commanderOverride}. Use this exact card as the commander for your analysis — do not guess or substitute a different card, even if another legendary creature in the list looks like a plausible commander.\n\n`
      : '';

    const instructions =
      commanderNote +
      `Please grade this deck on three separate dimensions, each scored out of 100:\n\n` +
      `1. POWER — how strong/competitive is this deck? Weigh speed and mana curve, interaction density, card advantage, ramp, tutors, mana consistency, and overall card quality relative to the wider EDH card pool.\n\n` +
      `2. FUN — how enjoyable is this deck to play and to play against? Weigh variety, interactivity, table-friendliness, and whether it avoids being oppressive (heavy stax, mass land destruction, infinite combos that end the game abruptly) or a "solitaire" deck that ignores the table.\n\n` +
      `3. DOES THE THING — ${commanderOverride ? 'using the commander given above, identify' : "first identify the deck's commander(s) and"} its ACTUAL game plan. Important: a commander frequently has more than one theme working together at once (for example, a card that cares about several creature types AND grants +1/+1 counters is doing BOTH tribal synergy AND counters synergy — call out every theme you find, don't force it into a single bucket). Then judge how well the other 99 cards actually support and execute ALL of the identified themes, not just the first one you notice.`;

    const jsonSchema =
      `{"commander":"<card name or 'none identified'>","themes":["<theme 1>","<theme 2>"],` +
      `"power":{"score":<0-100 integer>,"reasoning":"<2-4 sentences>"},` +
      `"fun":{"score":<0-100 integer>,"reasoning":"<2-4 sentences>"},` +
      `"doesTheThing":{"score":<0-100 integer>,"reasoning":"<2-4 sentences that explicitly reference every theme identified and how well the deck supports each one>"}}`;

    if (!strict) {
      // Prose reply for a human to actually read, PLUS a trailing JSON block —
      // so the same reply can be pasted back into Scrybox and parsed automatically.
      return intro + instructions +
        `\n\nRespond conversationally with a clear heading for each of the three scores, your reasoning, and specifically list out every theme you identified for "Does The Thing" before scoring it.` +
        `\n\nThen, at the very end of your reply, on its own line, include ONLY a JSON object in exactly this shape (no markdown fences around it) so the reply can be pasted back into a tool that reads it automatically:\n${jsonSchema}`;
    }

    return intro + instructions + `\n\nRespond with ONLY a single JSON object in exactly this shape — no markdown code fences, no text before or after it:\n${jsonSchema}`;
  }

  function copyGradePrompt(deckName) {
    const text = buildGradingPrompt(deckName, false);
    copyTextToClipboard(text, deckGradeStatus);
  }

  // Pulls a JSON object out of a model response even if it added stray text
  // or wrapped it in a ```json fence despite being asked not to.
  function parseGradeResponse(text) {
    const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    let parsed = tryParse(text.trim());
    if (parsed) return parsed;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) { parsed = tryParse(fenced[1].trim()); if (parsed) return parsed; }
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) { parsed = tryParse(braceMatch[0]); if (parsed) return parsed; }
    return null;
  }

  async function gradeDeckWithAI(deckName) {
    if (!state.aiSettings.apiKey) {
      openSettingsModal();
      aiSettingsStatus.textContent = 'Add an API key first, then try "Grade with AI" again.';
      return;
    }
    const cards = getDeckCards(deckName);
    if (!cards.length) { deckGradeStatus.textContent = 'No cards in this deck to grade.'; deckGradeStatus.className = 'deck-grade-status error'; return; }

    deckGradeStatus.textContent = 'Grading… (calling Claude, this can take 10-20 seconds)';
    deckGradeStatus.className = 'deck-grade-status';
    gradeWithAiBtn.disabled = true;

    try {
      const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': state.aiSettings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: state.aiSettings.model || 'claude-sonnet-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: buildGradingPrompt(deckName, true) }]
        })
      });

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const body = await resp.json(); if (body.error && body.error.message) detail = body.error.message; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }

      const data = await resp.json();
      const text = (data.content || []).map((b) => b.text || '').join('');
      const parsed = parseGradeResponse(text);
      if (!parsed || !parsed.power || !parsed.fun || !parsed.doesTheThing) {
        console.error('Scrybox AI grading — unparseable response:', { stop_reason: data.stop_reason, text });
        const cutOff = data.stop_reason === 'max_tokens' ? ' (response got cut off before finishing — try again, or switch to a faster model in ⚙ AI Grading)' : '';
        const preview = text ? ` Raw reply started with: "${text.slice(0, 160).replace(/\s+/g, ' ')}${text.length > 160 ? '…' : ''}"` : ' Got an empty reply.';
        throw new Error(`Got a response but could not find valid scores in it.${cutOff}${preview}`);
      }

      state.aiGrades[deckName] = {
        commander: (state.deckCommanders[deckName] || '').trim() || parsed.commander || 'none identified',
        themes: Array.isArray(parsed.themes) ? parsed.themes : [],
        power: parsed.power,
        fun: parsed.fun,
        doesTheThing: parsed.doesTheThing,
        model: state.aiSettings.model,
        gradedAt: new Date().toISOString(),
        rawText: text
      };
      persistAiGrades();
      deckGradeStatus.textContent = '';
      renderDeckGradePanel(deckName);
    } catch (err) {
      deckGradeStatus.textContent = 'Grading failed: ' + err.message;
      deckGradeStatus.className = 'deck-grade-status error';
    } finally {
      gradeWithAiBtn.disabled = false;
    }
  }

  // Compact badge markup for a cached grade — used on folder tiles.
  function gradeBadgesHtml(grade) {
    return (
      `<span class="score-badge power" title="${escapeHtml(grade.power.reasoning || '')}">Power ${grade.power.score}/100</span>` +
      `<span class="score-badge fun" title="${escapeHtml(grade.fun.reasoning || '')}">Fun ${grade.fun.score}/100</span>` +
      `<span class="score-badge gameplan" title="${escapeHtml(grade.doesTheThing.reasoning || '')}">Does the Thing ${grade.doesTheThing.score}/100</span>`
    );
  }

  function renderDeckGradePanel(deckName) {
    resetPasteGradeRow();
    const grade = state.aiGrades[deckName];
    if (!grade) {
      deckGradeResults.classList.add('hidden');
      deckGradeResults.innerHTML = '';
      return;
    }
    const themesText = grade.themes.length ? grade.themes.join(', ') : '(no specific theme identified)';
    deckGradeResults.innerHTML = `
      <div class="deck-grade-meta">Commander: <strong>${escapeHtml(grade.commander)}</strong> · Themes: ${escapeHtml(themesText)} · graded ${formatSyncedAt(grade.gradedAt)} with ${escapeHtml(grade.model || '')}</div>
      <div class="deck-grade-score-row">
        <div class="deck-grade-score"><span class="dgs-label">Power</span><span class="dgs-value power">${grade.power.score}/100</span></div>
        <div class="deck-grade-score"><span class="dgs-label">Fun</span><span class="dgs-value fun">${grade.fun.score}/100</span></div>
        <div class="deck-grade-score"><span class="dgs-label">Does The Thing</span><span class="dgs-value thing">${grade.doesTheThing.score}/100</span></div>
      </div>
      <div class="deck-grade-reasoning"><strong>Power</strong>${escapeHtml(grade.power.reasoning || '')}</div>
      <div class="deck-grade-reasoning"><strong>Fun</strong>${escapeHtml(grade.fun.reasoning || '')}</div>
      <div class="deck-grade-reasoning"><strong>Does The Thing</strong>${escapeHtml(grade.doesTheThing.reasoning || '')}</div>
    `;
    deckGradeResults.classList.remove('hidden');
  }

  // Hides/clears the "paste Claude's reply" textarea — called whenever the
  // grade panel re-renders (e.g. switching decks) so stale text from a
  // previous deck never lingers.
  function resetPasteGradeRow() {
    pasteGradeRow.classList.add('hidden');
    pasteGradeInput.value = '';
  }

  // Parses a manually-pasted Claude reply (prose + trailing JSON block, or
  // strict JSON — parseGradeResponse handles both), validates it the same
  // way the automated API path does, and saves it into state.aiGrades.
  function pasteGradeFromText(deckName, text) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      deckGradeStatus.textContent = 'Paste Claude\'s reply into the box first.';
      deckGradeStatus.className = 'deck-grade-status error';
      return;
    }
    const parsed = parseGradeResponse(trimmed);
    if (!parsed || !parsed.power || !parsed.fun || !parsed.doesTheThing) {
      deckGradeStatus.textContent = 'Could not find valid scores in that text — make sure you pasted Claude\'s whole reply, including the JSON block at the end.';
      deckGradeStatus.className = 'deck-grade-status error';
      return;
    }

    state.aiGrades[deckName] = {
      commander: parsed.commander || 'none identified',
      themes: Array.isArray(parsed.themes) ? parsed.themes : [],
      power: parsed.power,
      fun: parsed.fun,
      doesTheThing: parsed.doesTheThing,
      model: 'pasted (manual)',
      gradedAt: new Date().toISOString(),
      rawText: trimmed
    };
    persistAiGrades();
    deckGradeStatus.textContent = 'Score updated from pasted reply.';
    deckGradeStatus.className = 'deck-grade-status';
    renderDeckGradePanel(deckName);
  }

  function bindDeckGradeEvents() {
    gradeWithAiBtn.addEventListener('click', () => {
      if (state.view === 'binderDetail' && state.activeBinder) gradeDeckWithAI(state.activeBinder.name);
    });
    copyGradePromptBtn.addEventListener('click', () => {
      if (state.view === 'binderDetail' && state.activeBinder) copyGradePrompt(state.activeBinder.name);
    });
    pasteGradeToggleBtn.addEventListener('click', () => {
      pasteGradeRow.classList.toggle('hidden');
      if (!pasteGradeRow.classList.contains('hidden')) pasteGradeInput.focus();
    });
    pasteGradeSubmitBtn.addEventListener('click', () => {
      if (state.view === 'binderDetail' && state.activeBinder) {
        pasteGradeFromText(state.activeBinder.name, pasteGradeInput.value);
      }
    });
  }

  // =========================================================================
  // Commander recommendations — pick any owned card as a "commander" and get
  // owned cards that are color-identity legal under it, ranked by a local
  // heuristic (shared creature types, playstyle/mechanic tags, keywords).
  // No network call for the base list. "Refine with AI" is opt-in and reuses
  // the same Anthropic settings as deck grading.
  // =========================================================================

  // Creature types (and similar subtypes) after the em dash in a type line,
  // e.g. "Legendary Creature — Elf Warrior" -> ['Elf', 'Warrior'].
  function extractSubtypes(typeLine) {
    const idx = (typeLine || '').indexOf('—');
    if (idx === -1) return [];
    return typeLine.slice(idx + 1).trim().split(/\s+/).filter(Boolean);
  }

  // True if `card` is castable under `commander`'s color identity — every
  // color in the card's identity must appear in the commander's.
  function isColorIdentityLegalUnder(commander, card) {
    const commanderColors = new Set((commander.color_identity || []).map((c) => c.toLowerCase()));
    return (card.color_identity || []).every((c) => commanderColors.has(c.toLowerCase()));
  }

  // Scores how well `card` correlates with `commander`'s playstyle, purely
  // from local data already on each card object (no network call).
  function scoreCommanderSynergy(commander, card) {
    let score = 0;
    const reasons = [];

    const commanderTypes = extractSubtypes(commander.type_line);
    const cardTypes = extractSubtypes(card.type_line);
    const sharedTypes = commanderTypes.filter((t) => cardTypes.includes(t));
    if (sharedTypes.length) {
      score += 3 * sharedTypes.length;
      reasons.push(`${sharedTypes.join('/')} tribal`);
    } else if (commanderTypes.length && commanderTypes.some((t) => (card.oracle_text || '').toLowerCase().includes(t.toLowerCase()))) {
      score += 2;
      reasons.push(`mentions ${commanderTypes[0]}`);
    }

    const sharedPlaystyles = Array.from(card._playstyles || []).filter((p) => (commander._playstyles || new Set()).has(p));
    if (sharedPlaystyles.length) {
      score += 2 * sharedPlaystyles.length;
      reasons.push(sharedPlaystyles.join('/'));
    }

    const sharedTags = Array.from(card._tags || []).filter((t) => (commander._tags || new Set()).has(t));
    if (sharedTags.length) {
      score += 2 * sharedTags.length;
      reasons.push(sharedTags.join('/'));
    }

    if (card._counters && commander._counters) {
      score += 2;
      reasons.push('+1/+1 counters');
    }

    const sharedKeywords = (card.keywords || []).filter((k) => (commander.keywords || []).includes(k));
    if (sharedKeywords.length) {
      score += sharedKeywords.length;
      reasons.push(sharedKeywords.slice(0, 3).join('/'));
    }

    return { score, reasons };
  }

  // Full scored pool of owned, color-identity-legal cards for this
  // commander — unfiltered/unsliced, since EDHREC data (added later,
  // asynchronously) can bring a card's score up from 0 and it needs to
  // still be in the pool when that happens.
  function computeCommanderRecommendations(commander) {
    return state.collection
      .filter((c) => c.id !== commander.id && c.name !== commander.name)
      .filter((c) => isColorIdentityLegalUnder(commander, c))
      .map((c) => {
        const { score, reasons } = scoreCommanderSynergy(commander, c);
        return { card: c, score, reasons };
      });
  }

  function topRecs(rows, n) {
    return rows.filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name))
      .slice(0, n || 40);
  }

  // EDHREC slug convention: lowercase, drop apostrophes/commas, collapse
  // everything else (spaces, existing hyphens) into single hyphens.
  function edhrecSlug(name) {
    return (name || '')
      .toLowerCase()
      .replace(/['’,]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Fetches EDHREC's "Top Cards" list for a commander — their own
  // aggregated, num_decks-sorted list of what's actually played with it.
  // This is an unofficial, undocumented public JSON endpoint (no official
  // EDHREC API exists), so failures (CORS, 404 for an unrecognized/obscure
  // commander, EDHREC being down) are expected and handled by the caller.
  async function fetchEdhrecTopCards(commanderName) {
    const slug = edhrecSlug(commanderName);
    if (!slug) throw new Error('could not determine an EDHREC slug for this card');
    const resp = await fetch(`https://json.edhrec.com/pages/commanders/${slug}.json`);
    if (resp.status === 404) throw new Error('this card isn\'t listed as a commander on EDHREC');
    if (!resp.ok) throw new Error(`EDHREC returned HTTP ${resp.status}`);
    const data = await resp.json();
    const lists = (data.container && data.container.json_dict && data.container.json_dict.cardlists) || [];
    const topCards = lists.find((l) => l.tag === 'topcards');
    if (!topCards || !Array.isArray(topCards.cardviews)) throw new Error('EDHREC response had no top-cards list');
    const map = new Map();
    topCards.cardviews.forEach((cv) => {
      map.set((cv.name || '').toLowerCase(), {
        num_decks: cv.num_decks || 0,
        potential_decks: cv.potential_decks || 0
      });
    });
    return map;
  }

  // Boosts/tags any row whose card shows up on EDHREC's list for this
  // commander, weighted by how large a fraction of EDHREC decks include it.
  function applyEdhrecSignal(rows, edhrecMap) {
    rows.forEach((r) => {
      const hit = edhrecMap.get(r.card.name.toLowerCase());
      if (!hit) return;
      const pct = hit.potential_decks ? Math.round((hit.num_decks / hit.potential_decks) * 100) : null;
      r.score += 3 + Math.round((pct || 0) / 20);
      r.edhrecPct = pct;
      r.reasons = [...r.reasons, pct != null ? `${pct}% of EDHREC decks` : 'EDHREC staple'];
    });
  }

  function findOwnedCardByName(name) {
    const target = (name || '').trim().toLowerCase();
    if (!target) return null;
    return state.collection.find((c) => c.name.toLowerCase() === target) || null;
  }

  // Shared by every "pick a commander" input in the app (Commander Recs,
  // per-deck commander override, Scratchpad's Deck Builder commander).
  function populateOwnedLegendaryDatalist(el) {
    const names = new Set();
    state.collection.forEach((c) => {
      const tl = (c.type_line || '').toLowerCase();
      if (tl.includes('legendary') && (tl.includes('creature') || tl.includes('planeswalker'))) names.add(c.name);
    });
    el.innerHTML = Array.from(names).sort().map((n) => `<option value="${escapeHtml(n)}"></option>`).join('');
  }

  function openCommanderPickerModal() {
    populateOwnedLegendaryDatalist(commanderPickerOptions);
    commanderPickerInput.value = '';
    commanderPickerStatus.textContent = '';
    commanderPickerModal.classList.remove('hidden');
    commanderPickerInput.focus();
  }

  function closeCommanderPickerModal() {
    commanderPickerModal.classList.add('hidden');
  }

  function closeCommanderRecsModal() {
    commanderRecsModal.classList.add('hidden');
  }

  function renderCommanderRecs() {
    const { commander, candidates } = state.commanderRecs;
    commanderRecsTitle.textContent = `Recommendations for ${commander.name}`;
    commanderRecsList.innerHTML = '';
    if (!candidates.length) {
      commanderRecsList.innerHTML = '<div class="stats-empty-note">No matches found in your collection yet — try "Refine with AI" or pick a different commander.</div>';
      return;
    }
    candidates.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'cmdr-rec-row';
      const qty = (r.card.qtyFoil || 0) + (r.card.qtyNonfoil || 0);
      const reasonsText = r.reasons && r.reasons.length ? r.reasons.join(' · ') : (r.reasoning || 'AI pick');
      row.innerHTML =
        `<div class="cmdr-rec-main">` +
        `<span class="cmdr-rec-name">${escapeHtml(r.card.name)}</span>` +
        `<span class="cmdr-rec-reasons">${escapeHtml(reasonsText)}</span>` +
        `</div>` +
        `<div class="cmdr-rec-meta">` +
        (typeof r.edhrecPct === 'number' ? `<span class="cmdr-rec-score cmdr-rec-edhrec">EDHREC ${r.edhrecPct}%</span>` : '') +
        (typeof r.score === 'number' ? `<span class="cmdr-rec-score">${r.score}</span>` : '') +
        `<span>×${qty}</span>` +
        `<span>$${priceOf(r.card).toFixed(2)}</span>` +
        `</div>`;
      commanderRecsList.appendChild(row);
    });
  }

  function openCommanderRecsForName(name) {
    const commander = findOwnedCardByName(name);
    if (!commander) {
      commanderPickerStatus.textContent = 'Card not found in your collection — pick a suggestion from the list.';
      commanderPickerStatus.className = 'ai-settings-status';
      return;
    }
    const token = ++state.commanderRecsToken;
    const allCandidates = computeCommanderRecommendations(commander);
    state.commanderRecs = { commander, allCandidates, candidates: topRecs(allCandidates) };
    closeCommanderPickerModal();
    commanderRecsModal.classList.remove('hidden');
    commanderRecsStatus.textContent = 'Checking EDHREC for what\'s actually played with this commander…';
    commanderRecsStatus.className = 'deck-grade-status';
    renderCommanderRecs();

    fetchEdhrecTopCards(commander.name).then((edhrecMap) => {
      if (token !== state.commanderRecsToken) return;
      applyEdhrecSignal(state.commanderRecs.allCandidates, edhrecMap);
      state.commanderRecs.candidates = topRecs(state.commanderRecs.allCandidates);
      commanderRecsStatus.textContent = 'Boosted with EDHREC\'s most-played cards for this commander.';
      commanderRecsStatus.className = 'deck-grade-status';
      renderCommanderRecs();
    }).catch((err) => {
      if (token !== state.commanderRecsToken) return;
      commanderRecsStatus.textContent = `Couldn't load EDHREC data (${err.message}) — showing local matches only.`;
      commanderRecsStatus.className = 'deck-grade-status error';
    });
  }

  // Sends the commander + the local top candidates (not your whole
  // collection, to keep the request small) to Claude for a smarter re-rank.
  async function refineCommanderRecsWithAI() {
    const { commander, candidates } = state.commanderRecs;
    if (!commander) return;
    if (!state.aiSettings.apiKey) {
      commanderRecsModal.classList.add('hidden');
      openSettingsModal();
      aiSettingsStatus.textContent = 'Add an API key first, then try "Refine with AI" again.';
      return;
    }
    if (!candidates.length) {
      commanderRecsStatus.textContent = 'No local candidates to refine.';
      commanderRecsStatus.className = 'deck-grade-status error';
      return;
    }

    commanderRecsStatus.textContent = 'Asking Claude to refine these picks…';
    commanderRecsStatus.className = 'deck-grade-status';
    commanderRecsRefineBtn.disabled = true;

    const commanderLine = cardDetailLine(commander, 1);
    const candidateLines = candidates.map((r) => cardDetailLine(r.card, (r.card.qtyFoil || 0) + (r.card.qtyNonfoil || 0)));
    const prompt =
      `You are helping build a Magic: The Gathering Commander (EDH) deck around this commander:\n\n${commanderLine}\n\n` +
      `Here are candidate cards already owned (color-identity legal, pre-filtered by a simple local heuristic):\n\n${candidateLines.join('\n')}\n\n` +
      `Pick the 15-20 candidates that best support this commander's actual game plan and rank them best-first. ` +
      `Respond with ONLY a single JSON object, no markdown fences, no text before or after it, in exactly this shape:\n` +
      `{"picks":[{"name":"<exact card name from the list>","reasoning":"<one short phrase, under 10 words>"}]}`;

    try {
      const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': state.aiSettings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: state.aiSettings.model || 'claude-sonnet-5',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const body = await resp.json(); if (body.error && body.error.message) detail = body.error.message; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }

      const data = await resp.json();
      const text = (data.content || []).map((b) => b.text || '').join('');
      const parsed = parseGradeResponse(text);
      if (!parsed || !Array.isArray(parsed.picks) || !parsed.picks.length) {
        throw new Error('Got a response but could not find picks in it.');
      }

      const byName = new Map(candidates.map((r) => [r.card.name.toLowerCase(), r.card]));
      const refined = parsed.picks
        .map((p) => {
          const card = byName.get((p.name || '').toLowerCase());
          if (!card) return null;
          return { card, reasoning: p.reasoning || '' };
        })
        .filter(Boolean);

      if (!refined.length) throw new Error('AI picks didn\'t match any candidate names.');

      state.commanderRecs.candidates = refined;
      commanderRecsStatus.textContent = `Refined by ${state.aiSettings.model}.`;
      renderCommanderRecs();
    } catch (err) {
      commanderRecsStatus.textContent = 'Refine failed: ' + err.message;
      commanderRecsStatus.className = 'deck-grade-status error';
    } finally {
      commanderRecsRefineBtn.disabled = false;
    }
  }

  function bindCommanderRecsEvents() {
    commanderRecsBtn.addEventListener('click', openCommanderPickerModal);
    $('#commanderPickerClose').addEventListener('click', closeCommanderPickerModal);
    $('#commanderPickerBackdrop').addEventListener('click', closeCommanderPickerModal);
    commanderPickerSubmitBtn.addEventListener('click', () => openCommanderRecsForName(commanderPickerInput.value));
    commanderPickerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') openCommanderRecsForName(commanderPickerInput.value);
    });
    $('#commanderRecsClose').addEventListener('click', closeCommanderRecsModal);
    $('#commanderRecsBackdrop').addEventListener('click', closeCommanderRecsModal);
    commanderRecsRefineBtn.addEventListener('click', refineCommanderRecsWithAI);
  }

  // =========================================================================
  // Scratchpad Deck Builder mode — set a commander for the scratchpad and
  // Scrybox (a) locks the Color Identity search filter to that commander so
  // browsing only shows legal cards, (b) surfaces clickable tag shortcuts to
  // jump straight to owned removal/ramp/draw/etc., and (c) tracks a simple
  // 99-card build checklist against cards already in the scratchpad. All of
  // this reuses the existing tag/playstyle heuristics already computed on
  // every card (tagCard()) — no new scoring system.
  // =========================================================================

  const DECK_BUILDER_TARGETS = [
    { key: 'lands', label: 'Lands', target: 36, test: (c) => (c.type_line || '').toLowerCase().includes('land') },
    { key: 'ramp', label: 'Ramp', target: 10, test: (c) => c._playstyles && c._playstyles.has('ramp') },
    { key: 'draw', label: 'Card Draw', target: 10, test: (c) => c._tags && c._tags.has('cardadvantage') },
    { key: 'removal', label: 'Removal', target: 10, test: (c) => c._tags && c._tags.has('removal') },
    { key: 'wipes', label: 'Board Wipes', target: 3, test: (c) => c._tags && c._tags.has('boardwipe') },
    { key: 'protection', label: 'Protection', target: 5, test: (c) => c._tags && c._tags.has('protection') }
  ];

  function persistScratchpadCommander() {
    localforage.setItem(SCRATCHPAD_COMMANDER_KEY, state.scratchpadCommander || '').catch(() => {});
  }

  // Applies the commander's color identity to the sidebar Color Identity
  // filter (Commander-style/subset mode, same as manually clicking the mana
  // symbols) and re-runs search so browsing is immediately scoped to legal cards.
  function applyCommanderColorLock(commander) {
    const colors = (commander.color_identity && commander.color_identity.length) ? commander.color_identity.map((c) => c.toLowerCase()) : ['c'];
    state.filters.colors = new Set(colors);
    state.filters.colorExact = false;
    syncFilterUI();
    runSearch();
  }

  // Clears other quick filters and jumps to exactly one tag/playstyle/type,
  // closing the scratchpad so the (now color-locked) results are visible.
  function jumpToDeckBuilderFilter(kind, value) {
    state.filters.tags = new Set(kind === 'tag' ? [value] : []);
    state.filters.playstyles = new Set(kind === 'playstyle' ? [value] : []);
    if (kind === 'type') {
      searchInput.value = `t:${value}`;
      state.query = searchInput.value;
    } else {
      searchInput.value = '';
      state.query = '';
    }
    syncFilterUI();
    showCollectionView();
  }

  function renderDeckBuilderTags(commander) {
    deckBuilderTags.innerHTML = '';
    const defs = [
      { label: 'Ramp', kind: 'playstyle', value: 'ramp' },
      { label: 'Card Draw', kind: 'tag', value: 'cardadvantage' },
      { label: 'Removal', kind: 'tag', value: 'removal' },
      { label: 'Board Wipes', kind: 'tag', value: 'boardwipe' },
      { label: 'Protection', kind: 'tag', value: 'protection' }
    ];
    const subtypes = extractSubtypes(commander.type_line);
    if (subtypes.length) defs.push({ label: `${subtypes[0]} Tribal`, kind: 'type', value: subtypes[0] });

    defs.forEach((d) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.textContent = d.label;
      btn.addEventListener('click', () => jumpToDeckBuilderFilter(d.kind, d.value));
      deckBuilderTags.appendChild(btn);
    });
  }

  // Tallies, from real (non-ghost) cards currently in the scratchpad, how
  // many match each build-checklist category. Ghost cards are skipped —
  // there's no local card data for something you don't own.
  function computeDeckBuilderCounts() {
    const counts = {};
    DECK_BUILDER_TARGETS.forEach((t) => { counts[t.key] = 0; });
    state.scratchpad.forEach((item) => {
      if (item.ghost) return;
      const card = state.collection.find((c) => c.id === item.key);
      if (!card) return;
      DECK_BUILDER_TARGETS.forEach((t) => { if (t.test(card)) counts[t.key] += item.qty; });
    });
    return counts;
  }

  function renderDeckBuilderChecklist() {
    const counts = computeDeckBuilderCounts();
    deckBuilderChecklist.innerHTML = '';
    DECK_BUILDER_TARGETS.forEach((t) => {
      const count = counts[t.key];
      const met = count >= t.target;
      const pct = count ? Math.min(100, Math.max(4, Math.round((count / t.target) * 100))) : 0;
      const row = document.createElement('div');
      row.className = 'dbc-row';
      row.innerHTML =
        `<span class="dbc-label">${escapeHtml(t.label)}</span>` +
        `<span class="dbc-track"><span class="dbc-fill${met ? ' dbc-met' : ''}" style="width:${pct}%"></span></span>` +
        `<span class="dbc-count">${count}/${t.target}${met ? ' ✓' : ''}</span>`;
      deckBuilderChecklist.appendChild(row);
    });
  }

  function renderScratchCommanderRow() {
    scratchSetCommanderRow.classList.add('hidden');
    populateOwnedLegendaryDatalist(scratchCommanderOptions);

    const name = state.scratchpadCommander;
    const commander = name ? findOwnedCardByName(name) : null;

    if (commander) {
      scratchCommanderDisplay.textContent = commander.name;
      scratchCommanderDisplay.classList.remove('is-unset');
      deckBuilderPanel.classList.remove('hidden');
      renderDeckBuilderTags(commander);
      renderDeckBuilderChecklist();
      renderCommanderSynergies(commander);
    } else {
      scratchCommanderDisplay.textContent = name
        ? `${name} (not found — re-sync or clear)`
        : '(none — set one to lock search to its colors and get a build checklist)';
      scratchCommanderDisplay.classList.add('is-unset');
      deckBuilderPanel.classList.add('hidden');
      commanderSynergiesPanel.classList.add('hidden');
    }
  }

  // -----------------------------------------------------------------------
  // Commander Synergies — tags the commander (and every owned card) against
  // a master list of common EDH synergy themes (tribal, lifegain, sacrifice,
  // dies triggers, artifacts/enchantments/tokens matter, spellslinger,
  // graveyard, discard, landfall, etc.), then shows a tab per theme the
  // commander actually has, listing your other owned cards that share it.
  // This is a broader "what does this card care about / what does it do
  // for the deck" categorization, not a literal oracle-text substring
  // match — e.g. Daxos's "whenever another creature enters or dies, gain
  // 1 life" gets tagged both "Lifegain" and "Enters/Dies Triggers", so it
  // surfaces other lifegain payoffs you own, not just cards with identical
  // wording.
  // -----------------------------------------------------------------------
  const SYNERGY_CATEGORIES = [
    { key: 'lifegain', label: 'Lifegain', test: (c) => /you gain \d+ life|you gain life|life equal to|whenever you gain life/i.test(c.oracle_text || '') },
    { key: 'sacrifice', label: 'Sacrifice', test: (c) => /sacrifice (a|an|another)?\s?(creature|artifact|permanent)|whenever you sacrifice/i.test(c.oracle_text || '') },
    { key: 'dies-trigger', label: 'Dies Triggers', test: (c) => /when(ever)?[^.]*\bdies\b/i.test(c.oracle_text || '') },
    { key: 'draw-payoff', label: 'Card Draw Payoff', test: (c) => /whenever you draw (a|your (second|third)) cards?/i.test(c.oracle_text || '') },
    { key: 'draw-enabler', label: 'Card Draw', test: (c) => /draw (a|two|three) cards?/i.test(c.oracle_text || '') },
    { key: 'etb', label: 'Enters the Battlefield', test: (c) => /whenever [^.]*\benters\b|when(ever)? [^.]*enters the battlefield/i.test(c.oracle_text || '') },
    { key: 'attack-trigger', label: 'Attack Triggers', test: (c) => /whenever [^.]*\battacks\b/i.test(c.oracle_text || '') },
    { key: 'combat-damage', label: 'Combat Damage Triggers', test: (c) => /deals combat damage to a player|deals combat damage to an opponent/i.test(c.oracle_text || '') },
    { key: 'counters', label: '+1/+1 Counters', test: (c) => /\+1\/\+1 counter/i.test(c.oracle_text || '') },
    { key: 'artifacts', label: 'Artifacts Matter', test: (c) => /artifact you control|whenever an artifact|number of artifacts/i.test(c.oracle_text || '') },
    { key: 'enchantments', label: 'Enchantments Matter', test: (c) => /enchantment you control|whenever an enchantment/i.test(c.oracle_text || '') },
    { key: 'tokens', label: 'Tokens Matter', test: (c) => /creates? [^.]*\btoken|whenever [^.]*\btoken\b[^.]*enters/i.test(c.oracle_text || '') },
    { key: 'spellslinger', label: 'Spells Matter', test: (c) => /whenever you cast (an?|your first) (instant or sorcery|noncreature spell|instant|sorcery)/i.test(c.oracle_text || '') },
    { key: 'graveyard', label: 'Graveyard Matters', test: (c) => /from (a|your|target player's) graveyard|whenever a card is put into (a|your)? ?graveyard|\bmill(s|ed)?\b/i.test(c.oracle_text || '') },
    { key: 'discard', label: 'Discard Matters', test: (c) => /discards? a card|whenever you discard/i.test(c.oracle_text || '') },
    { key: 'landfall', label: 'Landfall', test: (c) => /landfall|whenever a land enters the battlefield under your control/i.test(c.oracle_text || '') },
    { key: 'counterspell', label: 'Counterspells', test: (c) => /counter target spell|counter that spell/i.test(c.oracle_text || '') },
    { key: 'flying-matters', label: 'Flying Matters', test: (c) => (c.keywords || []).some((k) => k.toLowerCase() === 'flying') },
  ];

  function computeCommanderSynergies(commander) {
    if (!commander) return [];
    const results = [];

    SYNERGY_CATEGORIES.forEach((cat) => {
      if (!cat.test(commander)) return;
      const matches = state.collection.filter((c) => c.id !== commander.id && cat.test(c));
      results.push({ key: cat.key, label: cat.label, matches });
    });

    extractSubtypes(commander.type_line).forEach((subtype) => {
      const test = (c) => extractSubtypes(c.type_line).includes(subtype);
      const matches = state.collection.filter((c) => c.id !== commander.id && test(c));
      results.push({ key: `tribal:${subtype}`, label: `${subtype} Tribal`, matches });
    });

    return results;
  }

  function persistCommanderSynergyTags() {
    localforage.setItem(COMMANDER_SYNERGY_TAGS_KEY, state.commanderSynergyTags).catch(() => {});
  }

  // AI-suggested tags are saved by commander NAME (not card id/printing), so
  // they survive deleting and re-adding the card, re-syncing onto a
  // different printing, or reloading the app entirely. They're stored as
  // just {label, query} pairs — the actual matches are always re-run live
  // against the current collection below, never cached stale.
  async function computeCommanderSynergyTabs(commander) {
    let categories;
    let source;
    const saved = state.commanderSynergyTags[commander.name.toLowerCase()];
    if (saved && saved.length) {
      categories = [];
      for (const t of saved) {
        const matches = await runScryboxQuery(t.query, commander.id);
        categories.push({ key: `ai:${t.query}`, label: t.label || t.query, query: t.query, matches });
      }
      source = 'ai';
    } else {
      categories = computeCommanderSynergies(commander);
      source = 'local';
    }

    // Anything outside the commander's color identity can't go in the deck
    // regardless of how well it matches the theme, so filter it out here —
    // covers both the local heuristic and AI-suggested query results.
    categories.forEach((cat) => {
      cat.matches = cat.matches.filter((c) => isColorIdentityLegalUnder(commander, c));
    });

    return { categories, source };
  }

  async function renderCommanderSynergies(commander) {
    const token = ++state.commanderSynergiesToken;
    const { categories, source } = await computeCommanderSynergyTabs(commander);
    if (token !== state.commanderSynergiesToken) return; // commander changed again before this finished

    if (!categories.length) {
      commanderSynergiesPanel.classList.add('hidden');
      return;
    }
    commanderSynergiesPanel.classList.remove('hidden');
    if (state.commanderSynergiesActiveTab >= categories.length) state.commanderSynergiesActiveTab = 0;

    commanderSynergiesTabs.innerHTML = '';
    categories.forEach((t, idx) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'cmdr-syn-tab' + (idx === state.commanderSynergiesActiveTab ? ' active' : '');
      tab.textContent = `${t.label} (${t.matches.length})`;
      if (t.query) tab.title = t.query;
      tab.addEventListener('click', () => {
        state.commanderSynergiesActiveTab = idx;
        renderCommanderSynergies(commander);
      });
      commanderSynergiesTabs.appendChild(tab);
    });

    const active = categories[state.commanderSynergiesActiveTab];
    commanderSynergiesContent.innerHTML = '';
    if (active.query) {
      const queryLine = document.createElement('p');
      queryLine.className = 'fg-hint cmdr-syn-query';
      queryLine.textContent = `Search: ${active.query}`;
      commanderSynergiesContent.appendChild(queryLine);
    }
    if (!active.matches.length) {
      const empty = document.createElement('p');
      empty.className = 'fg-hint';
      empty.textContent = `No other owned cards match this theme yet.`;
      commanderSynergiesContent.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.className = 'results-grid cmdr-syn-grid';
      active.matches.forEach((card) => {
        const tile = document.createElement('div');
        tile.className = 'card-tile cmdr-syn-tile';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = card.image || '';
        img.alt = card.name;
        tile.appendChild(img);
        const nameEl = document.createElement('div');
        nameEl.className = 'card-name';
        nameEl.textContent = card.name;
        tile.appendChild(nameEl);
        tile.addEventListener('click', () => openModal({ versions: [card], totalQtyFoil: card.qtyFoil || 0, totalQtyNonfoil: card.qtyNonfoil || 0 }, 0));
        grid.appendChild(tile);
      });
      commanderSynergiesContent.appendChild(grid);
    }

    const refineBtn = $('#commanderSynergiesRefineBtn');
    if (refineBtn) refineBtn.classList.toggle('hidden', !categories.length);
    const resetBtn = $('#commanderSynergiesResetBtn');
    if (resetBtn) resetBtn.classList.toggle('hidden', source !== 'ai');
    const statusEl = $('#commanderSynergiesStatus');
    if (statusEl && source === 'local') { statusEl.textContent = ''; statusEl.className = 'deck-grade-status'; }
    else if (statusEl && source === 'ai' && !statusEl.textContent) { statusEl.textContent = 'Showing saved AI tags for this commander.'; statusEl.className = 'deck-grade-status'; }
  }

  // Runs a Scrybox search-syntax query (the same syntax the main search box
  // takes) against the owned collection and returns matching cards. Reuses
  // the exact same tokenize/parseToken/matchesToken pipeline as the main
  // search, plus liveScryfallSearch for otag:/atag:/function: operators, so
  // AI-suggested queries behave identically to something you'd type by hand.
  async function runScryboxQuery(query, excludeId) {
    if (!query || !query.trim()) return [];
    const owned = state.collection.filter((c) => (c.qtyFoil + c.qtyNonfoil) > 0 && c.id !== excludeId);
    if (LIVE_OPERATOR_RE.test(query)) {
      let ids;
      try {
        ids = await liveScryfallSearch(query);
      } catch (err) {
        return [];
      }
      return owned.filter((c) => ids.has(c.id));
    }
    const tokens = tokenize(query).map(parseToken);
    if (!tokens.length) return [];
    return owned.filter((c) => tokens.every((tok) => matchesToken(c, tok)));
  }

  // Asks Claude for a handful of Scrybox search queries (same syntax as the
  // main search box) that would surface cards synergizing with this
  // commander, then runs each query locally against the owned collection.
  // Only the commander's own card details are sent — never the collection —
  // so cost stays flat no matter how big your collection is, and matches
  // come from the real, live collection instead of the model trying to
  // recall exact card names (which is what caused "no themes found" errors).
  async function refineCommanderSynergiesWithAI() {
    const name = state.scratchpadCommander;
    const commander = name ? findOwnedCardByName(name) : null;
    if (!commander) return;
    if (!state.aiSettings.apiKey) {
      openSettingsModal();
      aiSettingsStatus.textContent = 'Add an API key first, then try "Suggest tags with AI" again.';
      return;
    }

    const refineBtn = $('#commanderSynergiesRefineBtn');
    const statusEl = $('#commanderSynergiesStatus');
    if (refineBtn) refineBtn.disabled = true;
    if (statusEl) { statusEl.textContent = 'Asking Claude for synergy search tags…'; statusEl.className = 'deck-grade-status'; }

    const prompt =
      `Magic: The Gathering commander:\n${cardDetailLine(commander, 1)}\n\n` +
      `I run a personal card-collection search tool with a query syntax similar to Scryfall's. Supported operators (all combinable, space-separated = AND, ` +
      `leading "-" negates, quote multi-word phrases):\n` +
      `- o:"phrase" — oracle text contains the phrase (case-insensitive substring, this is the main one you'll use)\n` +
      `- t:type — type line contains the word (e.g. t:bird, t:creature, t:artifact)\n` +
      `- tag:removal / tag:boardwipe / tag:cardadvantage / tag:protection — pre-computed functional tags\n` +
      `- c:wubrg / id:wubrg — color / color identity contains these colors\n` +
      `- kw:flying — has the named keyword ability\n` +
      `- otag:sacrifice-fodder / function:removal — live Scryfall Oracle/function tags for broad mechanical themes (use sparingly, these hit the network)\n\n` +
      `Come up with 4-8 distinct synergy themes for this commander (tribal type, mechanical payoffs, enablers it wants, etc. — think like an EDHREC ` +
      `synergy page), and for each one write ONE query using only the operators above that would find other cards supporting that theme. ` +
      `Do not reference any specific card names — you don't know my collection, only my search engine does. Keep queries simple (1-3 terms). ` +
      `Respond with ONLY a single JSON object, no markdown fences, no text before or after it, in exactly this shape:\n` +
      `{"themes":[{"label":"<short theme name, 2-4 words>","query":"<search query using only the operators above>"}]}`;

    try {
      const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': state.aiSettings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: state.aiSettings.model || 'claude-sonnet-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const body = await resp.json(); if (body.error && body.error.message) detail = body.error.message; } catch (e) { /* ignore */ }
        throw new Error(detail);
      }

      const data = await resp.json();
      const text = (data.content || []).map((b) => b.text || '').join('');
      const parsed = parseGradeResponse(text);
      const themes = parsed && Array.isArray(parsed.themes) ? parsed.themes.filter((t) => t && t.query) : null;
      if (!themes || !themes.length) {
        throw new Error(`Got a response but no usable theme queries were in it. Raw reply: ${text.slice(0, 160) || '(empty)'}`);
      }

      if (statusEl) statusEl.textContent = `Running ${themes.length} suggested searches…`;

      // Saved by name, not card id — survives deleting/re-adding this card
      // or a re-sync landing on a different printing.
      state.commanderSynergyTags[commander.name.toLowerCase()] = themes.map((t) => ({ label: t.label || t.query, query: t.query }));
      persistCommanderSynergyTags();
      state.commanderSynergiesActiveTab = 0;
      if (statusEl) { statusEl.textContent = `Suggested by ${state.aiSettings.model} — saved for this commander.`; statusEl.className = 'deck-grade-status'; }
      await renderCommanderSynergies(commander);
    } catch (err) {
      if (statusEl) { statusEl.textContent = 'Suggest failed: ' + err.message; statusEl.className = 'deck-grade-status error'; }
    } finally {
      if (refineBtn) refineBtn.disabled = false;
    }
  }

  function bindScratchCommanderEvents() {
    scratchSetCommanderBtn.addEventListener('click', () => {
      scratchCommanderInput.value = state.scratchpadCommander || '';
      scratchSetCommanderRow.classList.remove('hidden');
      scratchCommanderInput.focus();
    });
    scratchCommanderCancelBtn.addEventListener('click', () => {
      scratchSetCommanderRow.classList.add('hidden');
    });
    scratchCommanderSaveBtn.addEventListener('click', () => {
      const name = scratchCommanderInput.value.trim();
      state.scratchpadCommander = name;
      // Note: commanderSynergyTags is intentionally NOT cleared here — it's
      // keyed by commander name and persisted, so switching away and back
      // (or deleting/re-adding this card) doesn't lose saved AI tags.
      state.commanderSynergiesActiveTab = 0;
      persistScratchpadCommander();
      renderScratchCommanderRow();
      const commander = name ? findOwnedCardByName(name) : null;
      if (commander) applyCommanderColorLock(commander);
    });
    scratchCommanderClearBtn.addEventListener('click', () => {
      state.scratchpadCommander = '';
      state.commanderSynergiesActiveTab = 0;
      persistScratchpadCommander();
      renderScratchCommanderRow();
    });
    const commanderSynergiesRefineBtn = $('#commanderSynergiesRefineBtn');
    if (commanderSynergiesRefineBtn) {
      commanderSynergiesRefineBtn.addEventListener('click', refineCommanderSynergiesWithAI);
    }
    const commanderSynergiesResetBtn = $('#commanderSynergiesResetBtn');
    if (commanderSynergiesResetBtn) {
      commanderSynergiesResetBtn.addEventListener('click', () => {
        const name = state.scratchpadCommander;
        const commander = name ? findOwnedCardByName(name) : null;
        if (!commander) return;
        delete state.commanderSynergyTags[commander.name.toLowerCase()];
        persistCommanderSynergyTags();
        state.commanderSynergiesActiveTab = 0;
        renderCommanderSynergies(commander);
      });
    }
  }

  init();
})();
