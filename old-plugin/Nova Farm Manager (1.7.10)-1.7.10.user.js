// ==UserScript==
// @name         Nova Farm Manager (1.7.10)
// @namespace    local.travian.nova.farmmanager
// @version      1.7.10
// @description  Farm Manager plugin for Nova-HB — dynamic TTL for large runs
// @match        https://*.travian.com/*
// @match        https://*.traviantop.com/*
// @match        https://*.international.travian.com/*
// @match        https://*.arabics.travian.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FM_VERSION = '1.7.10';
  const FM_NS = 'FarmManager';
  const DRIVER_PLUGIN = 'Heartbeat';
  const POLL_MS = 1000;
  const MAX_WIDTH = 600;
  const PENDING_RUN_KEY = 'fm_pending_run_v17';

  const FM_STORAGE_KEY = 'travian_farm_manager_data_v17';
  const FM_STORAGE_VERSION = 17;

  // ⭐ TTL settings
  const TTL_MIN_MS = 15 * 60 * 1000;         // حداقل 15 دقیقه
  const TTL_PER_TASK_MS = 45 * 1000;         // 45 ثانیه per task
  const ROTATION_PER_TASK_MS = 60 * 1000;    // 60 ثانیه per task برای rotation
  const ROTATION_EXTRA_MS = 120 * 1000;      // 2 دقیقه اضافه

  // ─────────────────────────────────────────────────────────────
  // Log Buffer
  // ─────────────────────────────────────────────────────────────
  const LOG_BUFFER_MAX = 200;
  const _logBuffer = [];

  function fmLog(level, ...args) {
    const ts = new Date().toISOString().slice(11, 23);
    const msg = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');
    const line = `[${ts}] [${level}] ${msg}`;
    _logBuffer.push(line);
    if (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.shift();
    const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    fn(`[FM]`, ...args);
  }

  function clearLogBuffer() {
    const n = _logBuffer.length;
    _logBuffer.length = 0;
    showToast('Log cleared (' + n + ' lines)', 'ok');
    fmLog('INFO', 'Log buffer cleared by user');
    if (_fmPanelRef && _fmPanelRef.isConnected) {
      const diag = _fmPanelRef.querySelector('.fm-diag');
      if (diag) diag.innerHTML = '';
    }
  }

  function getFullLog() {
    const header = [
      '═══════════════════════════════════════════',
      `  Nova Farm Manager v${FM_VERSION} — Log Dump`,
      `  Time: ${new Date().toISOString()}`,
      `  URL: ${location.href}`,
      `  UserAgent: ${navigator.userAgent}`,
      '═══════════════════════════════════════════',
      '',
    ].join('\n');

    let diagStr = '';
    try { diagStr = '\n\n──── DIAG ────\n' + JSON.stringify(window.FM?.diag?.() || {}, null, 2); } catch (e) {}
    let stateStr = '';
    try {
      const s = readFMData();
      stateStr = '\n\n──── FM STATE (summary) ────\n' + JSON.stringify({
        version: s._version,
        settings: s.settings,
        villages: Object.keys(s.byVillage || {}),
        currentVillageBucket: s.byVillage?.[String(window.TC?.village?.())] || null,
        runInProgress: s.runInProgress,
        pendingFinalReport: s._pendingFinalReport ? '(set)' : null,
        navigateToTt0AfterRun: s._navigateToTt0AfterRun,
        endOfRunHandled: s._endOfRunHandled,
        backupsCount: (s.backups || []).length,
        _heartbeatWasEnabled: s._heartbeatWasEnabled,
      }, null, 2);
    } catch (e) {}
    let novaStr = '';
    try {
      const ns = window.TC?.state?.();
      novaStr = '\n\n──── NOVA STATE (summary) ────\n' + JSON.stringify({
        heartbeat: ns?.heartbeat,
        currentJob: ns?.currentJob,
        tasks: (ns?.tasks || []).map(t => ({
          id: t.id, plugin: t.plugin, state: t.state,
          farm: t.payload?.farm || null,
        })),
      }, null, 2);
    } catch (e) {}
    let pendingStr = '';
    try {
      const raw = sessionStorage.getItem(PENDING_RUN_KEY);
      pendingStr = '\n\n──── PENDING_RUN_KEY ────\n' + (raw ? raw.slice(0, 500) : '(empty)');
    } catch (e) {}

    return header + _logBuffer.join('\n') + diagStr + stateStr + novaStr + pendingStr;
  }

  async function copyFullLog() {
    const txt = getFullLog();
    try {
      await navigator.clipboard.writeText(txt);
      showToast('Log copied (' + txt.length + ' chars)', 'ok');
      fmLog('INFO', 'Log copied, length=' + txt.length);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('Log copied (fallback)', 'ok');
        return true;
      } catch (e2) {
        fmLog('ERROR', 'Copy failed', e2);
        showToast('Copy failed — see console', 'warn');
        console.log(txt);
        return false;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Utils
  // ─────────────────────────────────────────────────────────────
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const now = () => Date.now();
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const uid = p => (p||'id') + '_' + Math.random().toString(36).slice(2,9);

  const cleanNum = s => String(s||'')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\ufeff]/g, '')
    .replace(/−/g, '-')
    .replace(/[^\d-]/g, '');
  const cleanInt = s => { const n = cleanNum(s); return n === '' ? null : parseInt(n, 10); };

  async function waitForTC(maxMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (window.TC && window.TC.registerPlugin && window.TC.patch && window.TC.enqueue) return window.TC;
      await delay(200);
    }
    return null;
  }

  function logNormal(min, max) {
    const u = Math.random() || 1e-9;
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const t = Math.min(1, Math.max(0, (z + 3) / 6));
    return Math.round(min + (max - min) * t);
  }

  function clearPendingRunKey() {
    try { sessionStorage.removeItem(PENDING_RUN_KEY); } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────
  // Storage
  // ─────────────────────────────────────────────────────────────
  function readFMData() {
    try {
      const raw = localStorage.getItem(FM_STORAGE_KEY);
      if (!raw) return defaultFarmData();
      const d = JSON.parse(raw);
      const def = defaultFarmData();
      for (const k in def) if (!(k in d)) d[k] = def[k];
      if (!d.settings) d.settings = def.settings;
      if (d.settings.soundEnabled === undefined) d.settings.soundEnabled = false;
      if (d.settings.notificationsEnabled === undefined) d.settings.notificationsEnabled = true;
      if (d.settings.restoreHeartbeatAfterRun === undefined) d.settings.restoreHeartbeatAfterRun = true;
      if (d.settings.profile === undefined) d.settings.profile = 'normal';
      if (!d.byVillage) d.byVillage = {};
      if (!d.runs) d.runs = [];
      if (d.runInProgress === undefined) d.runInProgress = null;
      if (!d.backups) d.backups = [];
      if (d._heartbeatWasEnabled === undefined) d._heartbeatWasEnabled = null;
      if (d._pendingFinalReport === undefined) d._pendingFinalReport = null;
      if (d._navigateToTt0AfterRun === undefined) d._navigateToTt0AfterRun = false;
      if (d._endOfRunHandled === undefined) d._endOfRunHandled = false;
      if (d._activeRunId === undefined) d._activeRunId = null;

      for (const vid in d.byVillage) {
        const bucket = d.byVillage[vid];
        if (bucket?.lists) {
          for (const l of bucket.lists) {
            if (!l.cooldown) {
              l.cooldown = {
                enabled: true, minAttacks: 7, maxAttacks: 10,
                minDelayMs: 3000, maxDelayMs: 5000,
              };
            }
          }
        }
      }
      return d;
    } catch (e) {
      fmLog('ERROR', 'read failed', e);
      return defaultFarmData();
    }
  }
  function writeFMData(d) {
    try {
      d._version = FM_STORAGE_VERSION;
      d._updatedAt = now();
      localStorage.setItem(FM_STORAGE_KEY, JSON.stringify(d));
    } catch (e) { fmLog('ERROR', 'write failed', e); }
  }
  function fmPatch(fn) {
    const d = readFMData();
    fn(d);
    writeFMData(d);
  }
  function defaultFarmData() {
    return {
      _version: FM_STORAGE_VERSION,
      _updatedAt: 0,
      enabled: true,
      settings: {
        waveDelayMs: 2500,
        maxWavesPerRun: 100,
        heroFollow: false,
        autoEnableHeartbeat: true,
        restoreHeartbeatAfterRun: true,
        soundEnabled: false,
        notificationsEnabled: true,
        profile: 'normal',
      },
      byVillage: {},
      runs: [],
      runInProgress: null,
      backups: [],
      _heartbeatWasEnabled: null,
      _pendingFinalReport: null,
      _navigateToTt0AfterRun: false,
      _endOfRunHandled: false,
      _activeRunId: null,
    };
  }
  function fmState() { return readFMData(); }

  function ensureVillageBucket(vid) {
    const vidStr = String(vid);
    let bucket = readFMData().byVillage[vidStr];
    if (bucket) return bucket;
    fmPatch(fm => {
      if (!fm.byVillage[vidStr]) {
        fm.byVillage[vidStr] = { lists: [], activeListId: null, lastRunAt: 0, snapshot: null, snapshotAt: 0 };
      }
    });
    return readFMData().byVillage[vidStr];
  }

  function makeBackup(reason) {
    fmPatch(fm => {
      const snapshot = {
        at: now(),
        reason: reason || 'auto',
        byVillage: JSON.parse(JSON.stringify(fm.byVillage)),
        settings: JSON.parse(JSON.stringify(fm.settings)),
      };
      fm.backups = fm.backups || [];
      fm.backups.unshift(snapshot);
      fm.backups = fm.backups.slice(0, 5);
    });
  }

  function exportListCompact(srcVid, listId, onlySelected) {
    const data = readFMData();
    const bucket = data.byVillage[String(srcVid)];
    const list = bucket?.lists.find(l => l.id === listId);
    if (!list) return null;
    let targets = list.targets;
    if (onlySelected) targets = targets.filter(t => t.selected !== false);
    return JSON.stringify({
      _format: 'farm-list-v1',
      _exported: now(),
      list: {
        name: list.name,
        troops: { ...list.troops },
        heroFollow: list.heroFollow === true,
        cooldown: list.cooldown ? { ...list.cooldown } : undefined,
        targets: targets.map(t => {
          const out = { name: t.name, x: t.x, y: t.y, distance: t.distance };
          if (t.troops && Object.values(t.troops).some(v => v > 0)) out.troops = { ...t.troops };
          if (t.heroFollow !== undefined) out.heroFollow = t.heroFollow;
          return out;
        }),
      },
    }, null, 2);
  }

  function parseImportText(text) {
    if (!text || !text.trim()) return { ok: false, error: 'Empty input' };
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.list && Array.isArray(parsed.list.targets)) return { ok: true, list: parsed.list };
        if (Array.isArray(parsed)) return { ok: true, list: { name: 'Imported', targets: parsed, troops: null, heroFollow: false } };
      } catch (e) {}
    }
    const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const targets = [];
    for (const line of lines) {
      const m = line.match(/(-?\d+)\s*[|,\s]\s*(-?\d+)/);
      if (!m) continue;
      const x = parseInt(m[1], 10);
      const y = parseInt(m[2], 10);
      if (isNaN(x) || isNaN(y)) continue;
      let name = line.replace(m[0], '').replace(/^[():,;\-\s]+|[():,;\-\s]+$/g, '').trim();
      if (!name) name = `${x}|${y}`;
      targets.push({ name, x, y });
    }
    if (!targets.length) return { ok: false, error: 'No coordinates found' };
    return { ok: true, list: { name: 'Imported', targets, troops: null, heroFollow: false } };
  }

  function previewImport(text, srcVid, mode, targetListId) {
    const parsed = parseImportText(text);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const data = readFMData();
    const bucket = data.byVillage[String(srcVid)];
    if (!bucket) return { ok: false, error: 'No village bucket' };

    let existingCoords = new Set();
    if (mode === 'existing' && targetListId) {
      const targetList = bucket.lists.find(l => l.id === targetListId);
      if (targetList) existingCoords = new Set(targetList.targets.map(t => `${t.x}|${t.y}`));
    }

    let newCount = 0, dupCount = 0, invalidCount = 0;
    const seenInFile = new Set();

    for (const t of parsed.list.targets) {
      if (typeof t.x !== 'number' || typeof t.y !== 'number') { invalidCount++; continue; }
      const key = `${t.x}|${t.y}`;
      if (existingCoords.has(key)) { dupCount++; continue; }
      if (seenInFile.has(key)) { dupCount++; continue; }
      seenInFile.add(key);
      newCount++;
    }

    return {
      ok: true,
      newCount, dupCount, invalidCount,
      totalInFile: parsed.list.targets.length,
      jsonListName: parsed.list.name || null,
    };
  }

  function importListToTarget(text, srcVid, mode, targetListId, newListName) {
    const parsed = parseImportText(text);
    if (!parsed.ok) return parsed;

    ensureVillageBucket(srcVid);
    const data = readFMData();
    const bucket = data.byVillage[String(srcVid)];

    let targetList;
    let finalName;
    let finalId;

    if (mode === 'new') {
      let baseName = (newListName && newListName.trim()) || parsed.list.name || 'Imported List';
      finalName = baseName;
      let counter = 1;
      const existingNames = new Set(bucket.lists.map(l => l.name));
      while (existingNames.has(finalName)) finalName = `${baseName} (${counter++})`;

      finalId = uid('L');
      targetList = {
        id: finalId,
        name: finalName,
        troops: parsed.list.troops || { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0,t11:0 },
        autoFill: 'fillAvailable',
        heroFollow: parsed.list.heroFollow === true,
        cooldown: parsed.list.cooldown || {
          enabled: true, minAttacks: 7, maxAttacks: 10, minDelayMs: 3000, maxDelayMs: 5000,
        },
        targets: [], createdAt: now(),
      };
    } else {
      targetList = bucket.lists.find(l => l.id === targetListId);
      if (!targetList) return { ok: false, error: 'Target list not found' };
      finalName = targetList.name;
      finalId = targetList.id;
    }

    const existingCoords = new Set(
      mode === 'existing'
        ? targetList.targets.map(t => `${t.x}|${t.y}`)
        : []
    );
    const seenInFile = new Set();

    let added = 0, dup = 0, invalid = 0;
    const newTargets = [];

    for (const t of parsed.list.targets) {
      if (typeof t.x !== 'number' || typeof t.y !== 'number') { invalid++; continue; }
      const key = `${t.x}|${t.y}`;
      if (existingCoords.has(key)) { dup++; continue; }
      if (seenInFile.has(key)) { dup++; continue; }
      seenInFile.add(key);

      const newTarget = {
        id: uid('T'),
        name: t.name || `${t.x}|${t.y}`,
        x: t.x, y: t.y,
        player: t.player || null, playerId: t.playerId || null,
        tribe: null, population: null,
        distance: (typeof t.distance === 'number') ? t.distance : null,
        isOasis: false, addedAt: now(),
        status: 'pending', lastRaid: null, lastSkipReason: null, partialRemaining: null,
        troops: t.troops || null,
        heroFollow: t.heroFollow,
        selected: true,
        invalid: false,
      };
      newTargets.push(newTarget);
      added++;
    }

    if (mode === 'new') {
      targetList.targets = newTargets;
      fmPatch(fm => {
        fm.byVillage[String(srcVid)].lists.push(targetList);
        fm.byVillage[String(srcVid)].activeListId = targetList.id;
      });
    } else {
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(l => l.id === targetListId);
        if (ll) ll.targets = ll.targets.concat(newTargets);
        fm.byVillage[String(srcVid)].activeListId = targetListId;
      });
    }

    return {
      ok: true, listId: finalId, listName: finalName,
      added, dup, invalid, mode,
      jsonListName: parsed.list.name || null,
    };
  }

  function importListFromText(text, srcVid) {
    const res = importListToTarget(text, srcVid, 'new', null, null);
    if (!res.ok) return res;
    return { ok: true, listId: res.listId, listName: res.listName, targetCount: res.added, skipped: res.dup + res.invalid };
  }

  function migrateFromNovaState(TC) {
    try {
      const s = TC.state();
      const old = s.plugins?.[FM_NS];
      if (!old) return false;
      const existing = readFMData();
      const hasData = Object.keys(existing.byVillage || {}).length > 0;
      if (hasData) return false;
      fmPatch(fm => {
        fm.enabled = old.enabled !== false;
        if (old.settings) fm.settings = { ...fm.settings, ...old.settings };
        fm.byVillage = old.byVillage || {};
        fm.runs = old.runs || [];
        fm.runInProgress = old.runInProgress || null;
      });
      fmLog('INFO', 'migrated from Nova state →', FM_STORAGE_KEY);
      return true;
    } catch (e) { fmLog('WARN', 'migration failed', e); return false; }
  }

  // ─────────────────────────────────────────────────────────────
  // Troops
  // ─────────────────────────────────────────────────────────────
  const TROOP_LABELS = {
    t1: 'Phalanx', t2: 'Swordsman', t3: 'Pathfinder', t4: 'Theutates Thunder',
    t5: 'Druidrider', t6: 'Haeduan', t7: 'Ram', t8: 'Trebuchet',
    t9: 'Chieftain', t10: 'Settler', t11: 'Hero',
  };
  const TROOP_ICON_CLASS = {
    t1: 'u21', t2: 'u22', t3: 'u23', t4: 'u24', t5: 'u25', t6: 'u26',
    t7: 'u27', t8: 'u28', t9: 'u29', t10: 'u30', t11: 'uhero',
  };
  function troopIconHTML(k, size = 16) {
    return `<img class="unit ${TROOP_ICON_CLASS[k]}" src="/img/x.gif" alt="${esc(TROOP_LABELS[k])}" title="${esc(TROOP_LABELS[k])}" style="width:${size}px;height:${size}px;vertical-align:middle;">`;
  }
  function troopsInlineHTML(troops, size = 16) {
    if (!troops) return '';
    const parts = [];
    for (const k of Object.keys(TROOP_LABELS)) {
      const v = troops[k] | 0;
      if (!v) continue;
      parts.push(`<span style="display:inline-flex;align-items:center;gap:2px;margin-right:5px;" title="${esc(TROOP_LABELS[k])} ${v}">${troopIconHTML(k, size)}<b style="font-size:10px;color:#2a5a10;">${v}</b></span>`);
    }
    return parts.join('');
  }
  function troopGridHTML(troops, heroFollow, size = 18, prefix = 'fm-t-') {
    const items = Object.keys(TROOP_LABELS).map(k => {
      const isHero = k === 't11';
      const disabled = isHero && !heroFollow;
      const v = troops[k] | 0;
      return `
        <label title="${esc(TROOP_LABELS[k])}" style="display:flex;align-items:center;gap:2px;font-size:11px;padding:2px 1px;">
          <span style="display:inline-block;width:14px;font-weight:bold;text-align:right;">${k.replace('t','')}</span>
          ${troopIconHTML(k, size)}
          <input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
            class="${prefix}${k}" value="${v}" maxlength="5"
            style="width:48px;padding:2px 4px;font-size:11px;text-align:center;border:1px solid #8a9ac0;border-radius:3px;box-sizing:border-box;${disabled ? 'background:#e8e8e8;color:#888;' : ''}"
            ${disabled ? 'disabled' : ''}>
        </label>
      `;
    }).join('');
    return `<div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:2px;">${items}</div>`;
  }
  function numericInputHTML(cls, value, width = 44, disabled = false) {
    return `<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
      class="${cls}" value="${value}" maxlength="5"
      style="width:${width}px;padding:2px 4px;font-size:11px;text-align:center;border:1px solid #8a9ac0;border-radius:3px;box-sizing:border-box;${disabled ? 'background:#e8e8e8;color:#888;' : ''}"
      ${disabled ? 'disabled' : ''}>`;
  }
  function attachNumericFilter(root) {
    root.querySelectorAll('input[inputmode="numeric"]').forEach(inp => {
      if (inp.dataset.fmNumAttached) return;
      inp.dataset.fmNumAttached = '1';
      inp.addEventListener('input', () => {
        const cleaned = inp.value.replace(/[^\d]/g, '').slice(0, 5);
        if (cleaned !== inp.value) inp.value = cleaned;
      });
    });
  }
  function troopCountLabel(list) {
    const parts = [];
    for (const k of Object.keys(TROOP_LABELS)) {
      const v = list.troops[k] || 0;
      if (!v) continue;
      parts.push(`${v}×${k.replace('t','')}`);
    }
    return parts.length ? parts.join('+') : '0';
  }
  function makeList(name) {
    return {
      id: uid('L'), name: name || 'New List',
      troops: { t1:0,t2:0,t3:0,t4:0,t5:0,t6:0,t7:0,t8:0,t9:0,t10:0,t11:0 },
      autoFill: 'fillAvailable', heroFollow: false, targets: [], createdAt: now(),
      cooldown: { enabled: true, minAttacks: 7, maxAttacks: 10, minDelayMs: 3000, maxDelayMs: 5000 },
    };
  }
  function makeTarget(v) {
    return {
      id: uid('T'), name: v.name, x: v.x, y: v.y,
      player: v.player || null, playerId: v.playerId || null,
      tribe: v.tribe || null, population: v.population || null,
      distance: (typeof v.distance === 'number') ? v.distance : null,
      isOasis: !!v.isOasis, addedAt: now(),
      status: 'pending', lastRaid: null, lastSkipReason: null, partialRemaining: null,
      troops: null, selected: true, invalid: false,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Human behavior
  // ─────────────────────────────────────────────────────────────
  const PROFILES = {
    fast:     { charDelay: [15, 50],   microDelay: [80, 200],   betweenTasks: [0, 0] },
    normal:   { charDelay: [40, 130],  microDelay: [150, 500],  betweenTasks: [0, 0] },
    paranoid: { charDelay: [80, 250],  microDelay: [400, 1200], betweenTasks: [3000, 8000] },
  };
  function profileSettings() {
    const p = readFMData().settings.profile || 'normal';
    return PROFILES[p] || PROFILES.normal;
  }
  async function humanType(input, value) {
    const prof = profileSettings();
    input.focus();
    await delay(logNormal(...prof.microDelay));
    if (input.value) {
      input.select();
      await delay(logNormal(...prof.charDelay));
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const ch of String(value)) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      await delay(logNormal(...prof.charDelay));
      input.value += ch;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
      await delay(logNormal(...prof.charDelay));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function humanTabToNext(current) {
    const prof = profileSettings();
    await delay(logNormal(...prof.charDelay));
    current.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
    await delay(logNormal(...prof.charDelay));
  }
  async function humanClickNoNav(el) {
    if (!el || !el.isConnected) return { ok: false };
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return { ok: false };
    if (el.disabled) return { ok: false };
    const prof = profileSettings();
    await delay(logNormal(...prof.microDelay));
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await delay(logNormal(...prof.microDelay));
    const rect = el.getBoundingClientRect();
    const tx = rect.left + rect.width * (0.25 + Math.random() * 0.5);
    const ty = rect.top + rect.height * (0.25 + Math.random() * 0.5);
    const from = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const c1 = { x: from.x + (tx - from.x) * 0.3 + (Math.random() - 0.5) * 60, y: from.y + (ty - from.y) * 0.3 + (Math.random() - 0.5) * 60 };
    const c2 = { x: from.x + (tx - from.x) * 0.7 + (Math.random() - 0.5) * 60, y: from.y + (ty - from.y) * 0.7 + (Math.random() - 0.5) * 60 };
    const steps = 4 + Math.floor(Math.random() * 3);
    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1), mt = 1 - t;
      const px = mt*mt*mt*from.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*tx + (Math.random() - 0.5) * 3;
      const py = mt*mt*mt*from.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*ty + (Math.random() - 0.5) * 3;
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: px, clientY: py }));
      await delay(logNormal(15, 50));
    }
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: tx, clientY: ty }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, clientX: tx, clientY: ty }));
    await delay(logNormal(...prof.microDelay));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1, clientX: tx, clientY: ty }));
    await delay(logNormal(...prof.charDelay));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: tx, clientY: ty }));
    await delay(logNormal(...prof.charDelay));
    el.click();
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // Sound + Toast + Notifications
  // ─────────────────────────────────────────────────────────────
  function playAlarm() {
    const fm = readFMData();
    if (!fm.settings.soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = ctx.currentTime;
      [0, 0.25, 0.5].forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'square';
        osc.frequency.value = i === 2 ? 1400 : 900;
        gain.gain.setValueAtTime(0, t0 + offset);
        gain.gain.linearRampToValueAtTime(0.12, t0 + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.15);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.15);
      });
    } catch (e) {}
  }
  function showToast(msg, kind) {
    let el = document.getElementById('fm-toast');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = 'fm-toast';
    const bg = kind === 'warn' ? 'linear-gradient(180deg,#ffe0b0,#f0b060)' : 'linear-gradient(180deg,#c4e8a8,#7ab04a)';
    el.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);background:${bg};border:2px solid #4a5a30;border-radius:8px;padding:10px 18px;color:#1a2a10;font-family:Verdana,sans-serif;font-size:13px;font-weight:bold;z-index:2147483600;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:80vw;text-align:center;`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; }, 4500);
    setTimeout(() => el.remove(), 5000);
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${String(mm).padStart(2, '0')}m`;
  }

  // ═════════════════════════════════════════════════════════════
  // COOL DOWN SYSTEM
  // ═════════════════════════════════════════════════════════════
  let _cooldownActive = false;
  let _cooldownTimer = null;
  let _cooldownRemaining = 0;
  let _cooldownDurationMs = 0;

  let _fmPanelRef = null;
  let _fmMapBoxRef = null;

  function pickCooldownAttacks(list) {
    const cd = list?.cooldown || {};
    const min = Math.max(1, cd.minAttacks || 7);
    const max = Math.max(min, cd.maxAttacks || 10);
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  function pickCooldownDelayMs(list) {
    const cd = list?.cooldown || {};
    const min = Math.max(1000, cd.minDelayMs || 3000);
    const max = Math.max(min, cd.maxDelayMs || 5000);
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  function isCooldownActive() { return _cooldownActive; }

  function openCooldownModal(durationMs, listName) {
    const old = document.getElementById('fm-cooldown-overlay');
    if (old) old.remove();

    _cooldownActive = true;
    _cooldownDurationMs = durationMs;
    _cooldownRemaining = Math.ceil(durationMs / 1000);

    const overlay = document.createElement('div');
    overlay.id = 'fm-cooldown-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;';

    const run = fmState().runInProgress;
    const total = run?.planned || 0;
    const done = run ? (run.sent + run.failed + run.skipped) : 0;
    const remaining = Math.max(0, total - done);
    const pct = total ? Math.round(done / total * 100) : 0;

    const modal = document.createElement('div');
    modal.style.cssText = `background:linear-gradient(180deg,#f9fbff,#e8eff9);border:2px solid #8a9ac0;border-radius:10px;padding:20px;font-family:Verdana,sans-serif;font-size:13px;color:#1a2050;max-width:440px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.55);text-align:center;`;
    modal.innerHTML = `
      <div style="font-weight:bold;font-size:16px;color:#2a4a70;margin-bottom:4px;">⏸ Cool Down</div>
      <div style="font-size:10px;color:#6a7a98;margin-bottom:14px;">List: ${esc(listName || '-')} · v${FM_VERSION}</div>
      <div id="fm-cd-circle" style="width:120px;height:120px;margin:0 auto 14px;border-radius:50%;background:conic-gradient(#7ab04a 0%, #7ab04a 0%, #e0e0e0 0%);display:flex;align-items:center;justify-content:center;position:relative;">
        <div style="width:100px;height:100px;border-radius:50%;background:#f9fbff;display:flex;align-items:center;justify-content:center;flex-direction:column;">
          <span id="fm-cd-count" style="font-size:32px;font-weight:bold;color:#2a4a70;font-family:'Courier New',monospace;">${_cooldownRemaining}</span>
          <span style="font-size:9px;color:#6a7a98;">seconds</span>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <div style="height:10px;background:#e0e0e0;border-radius:5px;overflow:hidden;margin-bottom:6px;">
          <div id="fm-cd-progress" style="width:${pct}%;height:100%;background:linear-gradient(90deg,#7ab04a,#4a7a30);transition:width .5s;"></div>
        </div>
        <div style="font-family:'Courier New',monospace;font-size:11px;color:#4a5a70;">
          Sent: <b>${run?.sent || 0}</b> · Failed: <b>${run?.failed || 0}</b> · Skipped: <b>${run?.skipped || 0}</b>
        </div>
        <div style="font-family:'Courier New',monospace;font-size:11px;color:#4a5a70;margin-top:2px;">
          Progress: <b>${done}/${total}</b> (${pct}%) · Remaining: <b>${remaining}</b>
        </div>
      </div>
      <button type="button" id="fm-cd-cancel" style="padding:8px 20px;background:linear-gradient(180deg,#d04a30,#a03020);color:#fff;border:1px solid #601010;border-radius:5px;font-weight:bold;cursor:pointer;font-size:13px;">⏹ Cancel Raid</button>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.getElementById('fm-cd-cancel').onclick = () => {
      fmLog('INFO', 'Cooldown cancelled by user');
      cancelCurrentRun();
      closeCooldownModal();
      clearCooldownFreeze();
      showToast('Raid cancelled', 'warn');
    };

    const totalSec = Math.ceil(durationMs / 1000);
    _cooldownTimer = setInterval(() => {
      _cooldownRemaining--;
      const el = document.getElementById('fm-cd-count');
      if (el) el.textContent = Math.max(0, _cooldownRemaining);

      const elapsedPct = totalSec > 0 ? ((totalSec - _cooldownRemaining) / totalSec) * 100 : 0;
      const circle = document.getElementById('fm-cd-circle');
      if (circle) circle.style.background = `conic-gradient(#7ab04a 0%, #7ab04a ${elapsedPct}%, #e0e0e0 ${elapsedPct}%)`;

      const r2 = fmState().runInProgress;
      if (r2) {
        const d2 = r2.sent + r2.failed + r2.skipped;
        const t2 = r2.planned;
        const p2 = t2 ? Math.round(d2 / t2 * 100) : 0;
        const pb = document.getElementById('fm-cd-progress');
        if (pb) pb.style.width = p2 + '%';
      }
      if (_cooldownRemaining <= 0) {
        clearInterval(_cooldownTimer);
        _cooldownTimer = null;
        closeCooldownModal();
        clearCooldownFreeze();
        fmLog('INFO', 'Cooldown complete — resuming');
      }
    }, 1000);

    setCooldownFreeze();
    fmLog('INFO', `Cool down ${_cooldownRemaining}s started (duration=${durationMs}ms)`);
  }

  function closeCooldownModal() {
    _cooldownActive = false;
    const overlay = document.getElementById('fm-cooldown-overlay');
    if (overlay) overlay.remove();
    if (_cooldownTimer) { clearInterval(_cooldownTimer); _cooldownTimer = null; }
  }

  function setCooldownFreeze() {
    try {
      window.TC?.patch?.(s => {
        if (!s.heartbeat) return;
        s.heartbeat._frozenAt = now();
        s.heartbeat._frozenReason = 'fm-cooldown';
      });
    } catch (e) { fmLog('WARN', 'setCooldownFreeze failed', e); }
  }
  function clearCooldownFreeze() {
    try {
      window.TC?.patch?.(s => {
        if (!s.heartbeat) return;
        if (s.heartbeat._frozenReason === 'fm-cooldown') {
          s.heartbeat._frozenAt = null;
          s.heartbeat._frozenReason = null;
        }
      });
    } catch (e) { fmLog('WARN', 'clearCooldownFreeze failed', e); }
  }

  function cancelCurrentRun() {
    clearPendingRunKey();
    fmPatch(fm => {
      fm.runInProgress = null;
      fm._heartbeatWasEnabled = null;
      fm._pendingFinalReport = null;
      fm._navigateToTt0AfterRun = false;
      fm._endOfRunHandled = true;
      fm._activeRunId = null;
    });
    try {
      const s = window.TC.state();
      const ids = (s.tasks || []).filter(t => t.payload?.farm).map(t => t.id);
      ids.forEach(id => window.TC.cancel(id));
      if (s.currentJob?.payload?.farm) window.TC.cancel(s.currentJob.id);
    } catch (e) { fmLog('WARN', 'cancel tasks failed', e); }
  }

  // ═════════════════════════════════════════════════════════════
  // HB Restore
  // ═════════════════════════════════════════════════════════════
  function restoreHeartbeatAfterRun() {
    const fmFresh = readFMData();
    const wasEnabled = fmFresh._heartbeatWasEnabled;

    if (wasEnabled === null || wasEnabled === undefined) {
      fmLog('INFO', 'HB restore: already done or unknown, skip');
      return;
    }

    if (fmFresh.settings.restoreHeartbeatAfterRun === false) {
      fmLog('INFO', 'HB restore disabled by settings');
      fmPatch(fm => { fm._heartbeatWasEnabled = null; });
      return;
    }

    if (wasEnabled !== false) {
      fmLog('INFO', `HB was ON before run — leaving ON`);
      fmPatch(fm => { fm._heartbeatWasEnabled = null; });
      return;
    }

    try {
      window.TC.heartbeat.setOn(false);
      fmLog('INFO', '✓ Heartbeat restored to OFF');
    } catch (e) { fmLog('WARN', 'restore HB failed', e); }

    fmPatch(fm => { fm._heartbeatWasEnabled = null; });
  }

  // ═════════════════════════════════════════════════════════════
  // Troop computation
  // ═════════════════════════════════════════════════════════════
  function getReservedInRun(runId, sourceVid, excludeTargetId) {
    const fm = fmState();
    const run = fm.runInProgress;
    if (!run || run.id !== runId) return {};

    const bucket = fm.byVillage[sourceVid];
    if (!bucket) return {};
    const list = bucket.lists.find(l => l.id === run.listId);
    if (!list) return {};

    const reserved = {};
    const runStartedAt = run.startedAt || 0;

    for (const t of list.targets) {
      if (t.id === excludeTargetId) continue;
      if (t.status !== 'sent' && t.status !== 'partial') continue;
      if (!t.lastRaid || t.lastRaid.at < runStartedAt) continue;

      const usedTroops = t.troops || list.troops;
      for (const [k, v] of Object.entries(usedTroops)) {
        reserved[k] = (reserved[k] | 0) + (v | 0);
      }
    }

    return reserved;
  }

  function computeTroopsToSend(farm) {
    const bucket = fmState().byVillage[farm.sourceVid];
    const snapshot = bucket?.snapshot || null;
    const want = farm.troops || {};
    const reserved = getReservedInRun(farm.runId, farm.sourceVid, farm.targetId);
    const out = {};
    let partial = false;
    let noTroops = false;
    const remaining = {};

    for (const k of Object.keys(TROOP_LABELS)) {
      const wantN = Math.max(0, want[k] | 0);
      if (!wantN) { out[k] = 0; continue; }
      const have = snapshot ? (snapshot[k] | 0) : Infinity;
      const used = reserved[k] | 0;
      const available = have === Infinity ? wantN : Math.max(0, have - used);
      if (wantN <= available) out[k] = wantN;
      else if (available > 0) {
        out[k] = available;
        remaining[k] = wantN - available;
        partial = true;
      } else {
        out[k] = 0;
        remaining[k] = wantN;
        if (have !== Infinity && have <= used) noTroops = true;
        partial = true;
      }
    }
    if (farm.heroFollow && want.t11 > 0) {
      const haveHero = snapshot ? (snapshot.t11 | 0) : 1;
      if (haveHero > 0 && !(reserved.t11 > 0)) out.t11 = 1;
      else { out.t11 = 0; remaining.t11 = 1; partial = true; }
    } else {
      out.t11 = 0;
    }

    const total = Object.values(out).reduce((a, b) => a + b, 0);
    if (total === 0) {
      return {
        ok: false,
        reason: noTroops ? 'no-troops-available' : 'insufficient-troops',
        remaining: partial ? remaining : null,
      };
    }
    return { ok: true, troops: out, partial, remaining: partial ? remaining : null };
  }

  // ═════════════════════════════════════════════════════════════
  // ATOMIC RESULT + MAYBE FINISH
  // ═════════════════════════════════════════════════════════════
  function applyResultAndMaybeFinish(farm, status, reason, extra = {}) {
    let reportData = null;
    fmPatch(fm => {
      const b = fm.byVillage[farm.sourceVid]; if (!b) return;
      const list = b.lists.find(l => l.id === farm.listId); if (!list) return;
      const t = list.targets.find(x => x.id === farm.targetId); if (!t) return;

      t.status = status;
      t.lastRaid = { at: now(), status, reason: reason || null, ...extra };
      if (extra.partialRemaining) t.partialRemaining = extra.partialRemaining;
      else if (status === 'sent') t.partialRemaining = null;
      if (status === 'skipped') t.lastSkipReason = reason || 'unknown';

      if (fm.runInProgress && fm.runInProgress.id === farm.runId) {
        const r = fm.runInProgress;
        if (status === 'sent') {
          r.sent += 1;
          r._sentSinceCooldown = (r._sentSinceCooldown || 0) + 1;
        } else if (status === 'skipped' || status === 'failed') {
          r.skipped += 1;
        }
        r.currentTarget = null;
        r.currentState = null;

        const done = r.sent + r.failed + r.skipped;
        if (done >= r.planned) {
          const elapsedMs = now() - r.startedAt;
          reportData = {
            sent: r.sent, failed: r.failed, skipped: r.skipped,
            planned: r.planned, elapsedMs,
            listName: r.listName, sourceVid: r.sourceVid,
            stoppedByTroops: false,
          };
          fm.runInProgress = null;
          fm._pendingFinalReport = reportData;
          fm._navigateToTt0AfterRun = true;
          fm._endOfRunHandled = true;
          fm._activeRunId = null;
        }
      }
    });

    if (reportData) {
      clearPendingRunKey();
      restoreHeartbeatAfterRun();
      fmLog('INFO', 'Run complete', reportData);
    }
    return reportData;
  }

  function markTargetInvalidAndMaybeFinish(farm, reason) {
    let reportData = null;
    fmPatch(fm => {
      const b = fm.byVillage[farm.sourceVid]; if (!b) return;
      const list = b.lists.find(l => l.id === farm.listId); if (!list) return;
      const t = list.targets.find(x => x.id === farm.targetId); if (!t) return;

      t.status = 'failed';
      t.invalid = true;
      t.selected = false;
      t.lastRaid = { at: now(), status: 'failed', reason: reason || 'invalid' };

      if (fm.runInProgress && fm.runInProgress.id === farm.runId) {
        const r = fm.runInProgress;
        r.skipped += 1;
        r.currentTarget = null;
        r.currentState = null;

        const done = r.sent + r.failed + r.skipped;
        if (done >= r.planned) {
          const elapsedMs = now() - r.startedAt;
          reportData = {
            sent: r.sent, failed: r.failed, skipped: r.skipped,
            planned: r.planned, elapsedMs,
            listName: r.listName, sourceVid: r.sourceVid,
            stoppedByTroops: false,
          };
          fm.runInProgress = null;
          fm._pendingFinalReport = reportData;
          fm._navigateToTt0AfterRun = true;
          fm._endOfRunHandled = true;
          fm._activeRunId = null;
        }
      }
    });

    try {
      const s = window.TC.state();
      const tasks = s.tasks || [];
      let cancelled = 0;
      for (const t of tasks) {
        const f = t.payload?.farm;
        if (!f) continue;
        if (f.targetId === farm.targetId && f.runId === farm.runId) {
          try { window.TC.cancel(t.id); cancelled++; } catch (e) {}
        }
      }
      if (cancelled > 0) {
        fmLog('INFO', `Cancelled ${cancelled} queued task(s) for invalid target ${farm.targetName}`);
      }
      const cj = s.currentJob;
      if (cj?.payload?.farm?.targetId === farm.targetId &&
          cj?.payload?.farm?.runId === farm.runId) {
        try { window.TC.cancel(cj.id); } catch (e) {}
      }
    } catch (e) { fmLog('WARN', 'cancel invalid task failed', e); }

    if (reportData) {
      clearPendingRunKey();
      restoreHeartbeatAfterRun();
      fmLog('INFO', 'Run complete (invalid last)', reportData);
    }
    return reportData;
  }

  function stopRunDueToNoTroops(farm, reason) {
    let reportData = null;
    fmPatch(fm => {
      const b = fm.byVillage[farm.sourceVid]; if (!b) return;
      const list = b.lists.find(l => l.id === farm.listId); if (!list) return;

      if (fm.runInProgress && fm.runInProgress.id === farm.runId) {
        const r = fm.runInProgress;
        const elapsedMs = now() - r.startedAt;
        const pendingLeft = r.planned - r.sent - r.failed - r.skipped;
        reportData = {
          sent: r.sent, failed: r.failed, skipped: r.skipped,
          planned: r.planned, elapsedMs,
          listName: r.listName, sourceVid: r.sourceVid,
          stoppedByTroops: true,
          remaining: pendingLeft,
        };
        fm.runInProgress = null;
        fm._pendingFinalReport = reportData;
        fm._navigateToTt0AfterRun = true;
        fm._endOfRunHandled = true;
        fm._activeRunId = null;
      }
    });

    try {
      const s = window.TC.state();
      const ids = (s.tasks || [])
        .filter(t => t.payload?.farm?.runId === farm.runId)
        .map(t => t.id);
      ids.forEach(id => window.TC.cancel(id));
      if (s.currentJob?.payload?.farm?.runId === farm.runId) {
        window.TC.cancel(s.currentJob.id);
      }
      fmLog('INFO', `Stopped run: cancelled ${ids.length} queued tasks (out of troops)`);
    } catch (e) { fmLog('WARN', 'cancel tasks failed', e); }

    if (reportData) {
      clearPendingRunKey();
      restoreHeartbeatAfterRun();
      fmLog('WARN', 'Run paused (out of troops)', reportData);
    }
    return reportData;
  }

  function checkPendingReport() {
    const fm = fmState();
    if (!fm._pendingFinalReport && !fm._navigateToTt0AfterRun) return;

    const u = new URL(location.href);
    const onRallyTt0 = isRallyTt0();

    if (onRallyTt0) {
      restoreHeartbeatAfterRun();

      if (fm._pendingFinalReport) {
        const data = fm._pendingFinalReport;
        fmPatch(fmm => {
          fmm._pendingFinalReport = null;
          fmm._navigateToTt0AfterRun = false;
        });
        fmLog('INFO', 'Showing pending final report');
        setTimeout(() => {
          showFinalReport(data);
          notifyRunComplete(data);
        }, 300);
      }
      return;
    }

    if (isRallySend() && fm._navigateToTt0AfterRun) {
      let sid = null;
      if (fm._pendingFinalReport?.sourceVid) sid = fm._pendingFinalReport.sourceVid;
      else sid = String(window.TC.village());
      fmLog('INFO', `Navigating to tt=0 (sid=${sid}) to show report`);
      try { location.href = `/build.php?id=39&gid=16&tt=0&newdid=${sid}`; } catch (e) {}
    }
  }

  function notifyRunComplete(runData) {
    const fm = readFMData();
    const { sent, failed, skipped, planned, elapsedMs, stoppedByTroops, remaining } = runData;
    const durStr = fmtDuration(Math.round(elapsedMs / 1000));

    let title, body, toastKind;
    if (stoppedByTroops) {
      title = '⏸ Farm Run Paused — Out of Troops';
      body = `${sent}/${planned} sent · ${remaining || (planned - sent - failed - skipped)} targets remaining · ${durStr}`;
      toastKind = 'warn';
    } else if (failed === 0 && skipped === 0) {
      title = 'Farm Run Complete';
      body = `${sent}/${planned} sent · ${durStr}`;
      toastKind = 'ok';
    } else {
      title = failed > 0 ? 'Farm Run Finished (with failures)' : 'Farm Run Finished';
      body = `${sent}/${planned} sent${failed ? ` · ${failed} failed` : ''}${skipped ? ` · ${skipped} skipped` : ''} · ${durStr}`;
      toastKind = failed > 0 ? 'warn' : 'ok';
    }

    if (fm.settings.notificationsEnabled) {
      showToast(`${title} — ${body}`, toastKind);
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
          try { new Notification(title, { body, icon: '/favicon.ico' }); } catch (e) {}
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().then(p => {
            if (p === 'granted') try { new Notification(title, { body }); } catch (e) {}
          });
        }
      }
    }
    playAlarm();
  }

  // ═════════════════════════════════════════════════════════════
  // FINAL REPORT MODAL
  // ═════════════════════════════════════════════════════════════
  function showFinalReport(runData) {
    const { sent, failed, skipped, planned, elapsedMs, listName, sourceVid, stoppedByTroops, remaining } = runData;
    const old = document.getElementById('fm-final-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'fm-final-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;';

    let headerColor, headerBg, title;
    if (stoppedByTroops) {
      headerColor = '#a06020';
      headerBg = 'rgba(240,180,80,.35)';
      title = '⏸ Farm Run Paused — Out of Troops';
    } else if (failed === 0 && skipped === 0) {
      headerColor = '#4a7a30';
      headerBg = 'rgba(120,200,80,.30)';
      title = '✅ Farm Run Complete';
    } else if (failed > 0) {
      headerColor = '#a03020';
      headerBg = 'rgba(200,80,60,.30)';
      title = '⚠ Farm Run Finished (with errors)';
    } else {
      headerColor = '#a06020';
      headerBg = 'rgba(200,140,60,.30)';
      title = '✔ Farm Run Finished';
    }

    let villageLabel = sourceVid;
    try { villageLabel = window.TC.villageLabel(sourceVid) || sourceVid; } catch (e) {}

    const pendingLeft = stoppedByTroops ? (remaining != null ? remaining : (planned - sent - failed - skipped)) : 0;

    const modal = document.createElement('div');
    modal.style.cssText = `background:linear-gradient(180deg,#f9fbff,#e8eff9);border:2px solid #8a9ac0;border-radius:10px;padding:20px;font-family:Verdana,sans-serif;font-size:13px;color:#1a2050;max-width:520px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.55);text-align:center;`;

    let extraInfo = '';
    if (stoppedByTroops) {
      extraInfo = `
        <div style="background:rgba(255,240,200,.5);border-radius:6px;padding:10px;margin-bottom:12px;text-align:left;font-size:11px;line-height:1.5;">
          <b style="color:#8a5010;">Why stopped?</b><br>
          All available troops were used. Remaining targets are kept as <b>pending</b>.<br>
          When you have more troops, click <b>Start Raid</b> again (or Resume) to continue from where it stopped.
        </div>
      `;
    }

    modal.innerHTML = `
      <div style="background:${headerBg};border-radius:6px;padding:12px;margin-bottom:14px;">
        <div style="font-weight:bold;font-size:16px;color:${headerColor};">${esc(title)}</div>
        <div style="font-size:10px;color:#5a6a80;margin-top:4px;">List: <b>${esc(listName || '-')}</b> · Source: <b>${esc(villageLabel)}</b></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:8px;margin-bottom:14px;">
        <div style="padding:10px;background:rgba(200,240,200,.4);border-radius:5px;">
          <div style="font-size:22px;font-weight:bold;color:#2a7a2a;">${sent}</div>
          <div style="font-size:9px;color:#4a7a30;">Sent</div>
        </div>
        <div style="padding:10px;background:rgba(240,200,200,.4);border-radius:5px;">
          <div style="font-size:22px;font-weight:bold;color:#a03020;">${failed}</div>
          <div style="font-size:9px;color:#7a2010;">Failed</div>
        </div>
        <div style="padding:10px;background:rgba(240,220,180,.4);border-radius:5px;">
          <div style="font-size:22px;font-weight:bold;color:#a06020;">${skipped}</div>
          <div style="font-size:9px;color:#7a4020;">Skipped</div>
        </div>
      </div>
      ${stoppedByTroops ? `
        <div style="display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:14px;">
          <div style="padding:10px;background:rgba(255,220,150,.5);border-radius:5px;">
            <div style="font-size:22px;font-weight:bold;color:#a06020;">${pendingLeft}</div>
            <div style="font-size:9px;color:#7a4020;">Targets Pending (will resume later)</div>
          </div>
        </div>
      ` : ''}
      <div style="font-family:'Courier New',monospace;font-size:11px;color:#4a5a70;margin-bottom:14px;text-align:left;padding:0 8px;">
        <div>Total planned: <b>${planned}</b></div>
        <div>Duration: <b>${fmtDuration(Math.round(elapsedMs / 1000))}</b></div>
        <div>Success rate: <b>${planned ? Math.round(sent / planned * 100) : 0}%</b></div>
      </div>
      ${extraInfo}
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" id="fm-final-close" style="flex:1;min-width:120px;padding:10px 20px;background:linear-gradient(180deg,#7ab04a,#4a7a30);color:#fff;border:1px solid #2a5a10;border-radius:5px;font-weight:bold;cursor:pointer;font-size:13px;">✓ Close</button>
        <button type="button" id="fm-final-copylog" style="padding:10px 14px;background:#e0e8f0;border:1px solid #8a9ac0;border-radius:5px;font-weight:bold;cursor:pointer;font-size:12px;">📋 Copy Log</button>
        <button type="button" id="fm-final-clearlog" style="padding:10px 14px;background:#f0d0c0;border:1px solid #b07050;border-radius:5px;font-weight:bold;cursor:pointer;font-size:12px;">🗑 Clear Log</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.getElementById('fm-final-close').onclick = () => {
      closeFinalReportModal();
    };
    document.getElementById('fm-final-copylog').onclick = () => copyFullLog();
    document.getElementById('fm-final-clearlog').onclick = () => clearLogBuffer();
  }

  function closeFinalReportModal() {
    const overlay = document.getElementById('fm-final-overlay');
    if (overlay) overlay.remove();
  }

  // ─────────────────────────────────────────────────────────────
  // Map dialog
  // ─────────────────────────────────────────────────────────────
  function extractMapTarget(tileEl) {
    if (!tileEl) return null;
    const isOasis = tileEl.classList.contains('oasis');
    const titleEl = tileEl.querySelector('h1.titleInHeader');
    let name = '';
    if (titleEl) {
      const clone = titleEl.cloneNode(true);
      clone.querySelectorAll('span.mainVillage, span.coordinates, span.clear, a').forEach(e => e.remove());
      name = clone.textContent.replace(/\s+/g,' ').trim();
    }
    const xEl = tileEl.querySelector('.coordinates .coordinateX');
    const yEl = tileEl.querySelector('.coordinates .coordinateY');
    const x = xEl ? cleanInt(xEl.textContent) : null;
    const y = yEl ? cleanInt(yEl.textContent) : null;
    if (x === null || y === null) return null;

    let player = null, playerId = null;
    const pLink = tileEl.querySelector('#village_info td.player a[href*="/profile/"]');
    if (pLink) {
      player = pLink.textContent.trim();
      const m = pLink.getAttribute('href').match(/\/profile\/(\d+)/);
      if (m) playerId = m[1];
    }

    let tribe = null, population = null, distance = null;
    for (const r of tileEl.querySelectorAll('#village_info tr')) {
      const th = r.querySelector('th');
      const td = r.querySelector('td');
      if (!th || !td) continue;
      const key = th.textContent.trim().toLowerCase();
      if (key === 'tribe') tribe = td.textContent.trim();
      if (key === 'population') {
        const pop = parseInt(td.textContent.trim(), 10);
        if (!isNaN(pop)) population = pop;
      }
      if (key === 'distance') {
        const m = td.textContent.match(/(\d+)/);
        if (m) distance = parseInt(m[1], 10);
      }
    }
    return { name, x, y, player, playerId, tribe, population, distance, isOasis };
  }

  function injectFarmBoxOnMap() {
    const dialog = document.querySelector('.dialogWrapper[data-context="map"]');
    if (!dialog) {
      if (_fmMapBoxRef && _fmMapBoxRef.isConnected) _fmMapBoxRef.remove();
      _fmMapBoxRef = null;
      return;
    }
    const tile = dialog.querySelector('#tileDetails');
    if (!tile) return;
    if (tile.classList.contains('oasis')) return;
    const target = extractMapTarget(tile);
    if (!target) return;
    const srcVid = window.TC.village();
    if (!srcVid) return;

    if (_fmMapBoxRef && _fmMapBoxRef.isConnected && dialog.contains(_fmMapBoxRef)) return;
    if (_fmMapBoxRef && _fmMapBoxRef.isConnected) _fmMapBoxRef.remove();
    dialog.querySelectorAll('.fm-map-box').forEach(p => { if (p !== _fmMapBoxRef) p.remove(); });
    _fmMapBoxRef = null;

    ensureVillageBucket(srcVid);

    const box = document.createElement('div');
    box.className = 'fm-map-box';
    box.style.cssText = `margin:12px 0 0 0;padding:12px;background:linear-gradient(180deg,#f5f8ff,#e3ecf7);border:1px solid #8a9ac0;border-radius:5px;font-family:Verdana,sans-serif;font-size:12px;color:#1a2050;box-sizing:border-box;max-width:${MAX_WIDTH}px;width:100%;`;
    box.innerHTML = `
      <div style="font-weight:bold;color:#2a4a70;margin-bottom:8px;display:flex;align-items:center;gap:6px;font-size:13px;">
        <span>Farm Manager (v${FM_VERSION})</span>
        <span style="font-size:10px;color:#6a7a98;font-weight:normal;">source: ${esc(window.TC.villageLabel(srcVid))}</span>
      </div>
      <div class="fm-map-fields">
        <label style="display:block;margin-bottom:6px;">
          <span style="display:inline-block;width:55px;font-weight:bold;">List:</span>
          <select class="fm-map-list" style="width:calc(100% - 110px);padding:3px;font-size:12px;"></select>
          <a href="#" class="fm-map-newlist" style="font-size:11px;margin-left:6px;color:#2a5a10;font-weight:bold;text-decoration:none;">+ new</a>
        </label>
        <div class="fm-map-status" style="margin-bottom:6px;font-size:10px;font-style:italic;color:#8a7050;"></div>
        <div class="fm-map-troops" style="margin-top:8px;padding:8px;background:rgba(255,255,255,.55);border-radius:4px;"></div>
        <label style="display:block;margin-top:8px;font-size:11px;">
          <input type="checkbox" class="fm-map-hero"> Hero follows
        </label>
        <div style="margin-top:10px;display:flex;gap:8px;">
          <button type="button" class="fm-map-add" style="flex:1;padding:6px 10px;background:linear-gradient(180deg,#7ab04a,#4a7a30);color:#fff;border:1px solid #2a5a10;border-radius:4px;font-weight:bold;cursor:pointer;font-size:12px;">Add to list</button>
          <button type="button" class="fm-map-cancel" style="padding:6px 12px;background:#ddd;border:1px solid #999;border-radius:4px;cursor:pointer;font-size:12px;">Cancel</button>
        </div>
        <div class="fm-map-msg" style="margin-top:8px;font-size:11px;color:#4a7a30;display:none;"></div>
      </div>
    `;

    box.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn && btn.type !== 'button') btn.type = 'button';
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) {
          e.preventDefault(); e.stopPropagation();
        }
      }
    }, true);

    tile.parentNode.insertBefore(box, tile.nextSibling);
    _fmMapBoxRef = box;

    const listSelect = box.querySelector('.fm-map-list');
    const statusEl = box.querySelector('.fm-map-status');
    const troopsBox = box.querySelector('.fm-map-troops');
    const heroChk = box.querySelector('.fm-map-hero');
    const msg = box.querySelector('.fm-map-msg');
    const addBtn = box.querySelector('.fm-map-add');

    function getBucket() { return fmState().byVillage[String(srcVid)]; }
    function currentList() {
      const b = getBucket();
      return b.lists.find(l => l.id === listSelect.value) || b.lists[0];
    }
    function targetInList(list) {
      if (!list) return null;
      return list.targets.find(t => t.x === target.x && t.y === target.y) || null;
    }
    function listsContainingVillage() {
      const b = getBucket();
      return b.lists.filter(l => l.targets.some(t => t.x === target.x && t.y === target.y));
    }

    function refreshListOptions(selectedId) {
      const b = getBucket();
      if (!b.lists.length) {
        const l = makeList('List 1');
        fmPatch(fm => {
          const bb = fm.byVillage[String(srcVid)];
          bb.lists.push(l); bb.activeListId = l.id;
        });
      }
      const b2 = getBucket();
      listSelect.innerHTML = b2.lists.map(l =>
        `<option value="${esc(l.id)}" ${l.id === (selectedId || b2.activeListId) ? 'selected' : ''}>${esc(l.name)} (${l.targets.length})</option>`
      ).join('');
      renderStatus();
      renderTroopFields();
    }

    function renderStatus() {
      const listsWith = listsContainingVillage();
      if (listsWith.length === 0) { statusEl.textContent = ''; statusEl.style.display = 'none'; return; }
      statusEl.style.display = 'block';
      const names = listsWith.map(l => esc(l.name)).join(', ');
      statusEl.innerHTML = `Already in: <b>${names}</b>`;
    }

    function renderTroopFields() {
      const l = currentList();
      if (!l) { troopsBox.innerHTML = ''; return; }
      const inList = targetInList(l);
      let troops, hf;
      if (inList) {
        troops = inList.troops || l.troops;
        hf = inList.heroFollow !== undefined ? inList.heroFollow : (l.heroFollow === true);
      } else {
        troops = l.troops;
        hf = l.heroFollow === true;
      }
      heroChk.checked = hf;
      troopsBox.innerHTML = troopGridHTML(troops, hf, 18);
      attachNumericFilter(troopsBox);
      const heroInp = troopsBox.querySelector('.fm-t-t11');
      if (heroInp) { heroInp.disabled = !hf; if (!hf) heroInp.value = 0; }
      if (inList) {
        addBtn.textContent = 'Edit item';
        addBtn.style.background = 'linear-gradient(180deg,#d09030,#a06020)';
        addBtn.style.borderColor = '#603010';
      } else {
        addBtn.textContent = 'Add to list';
        addBtn.style.background = 'linear-gradient(180deg,#7ab04a,#4a7a30)';
        addBtn.style.borderColor = '#2a5a10';
      }
    }

    listSelect.onchange = () => {
      fmPatch(fm => { fm.byVillage[String(srcVid)].activeListId = listSelect.value; });
      renderStatus();
      renderTroopFields();
      msg.style.display = 'none';
    };
    heroChk.onchange = () => {
      const l = currentList();
      if (!l) return;
      const on = heroChk.checked;
      const inList = targetInList(l);
      if (!inList) {
        fmPatch(fm => {
          const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
          if (ll) ll.heroFollow = on;
        });
      }
      const heroInp = troopsBox.querySelector('.fm-t-t11');
      if (heroInp) {
        heroInp.disabled = !on;
        if (!on) heroInp.value = 0;
        else if (!parseInt(heroInp.value, 10)) heroInp.value = 1;
      }
    };
    box.querySelector('.fm-map-newlist').addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const name = prompt('New list name:', 'List ' + getBucket().lists.length + 1);
      if (!name) return false;
      const l = makeList(name.trim());
      fmPatch(fm => { fm.byVillage[String(srcVid)].lists.push(l); });
      refreshListOptions(l.id);
      return false;
    });
    box.querySelector('.fm-map-cancel').addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      box.remove();
      _fmMapBoxRef = null;
      return false;
    });

    addBtn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const l = currentList();
      if (!l) { msg.style.display = 'block'; msg.textContent = 'No list'; return false; }
      const troops = {};
      Object.keys(TROOP_LABELS).forEach(k => {
        const inp = troopsBox.querySelector('.fm-t-' + k);
        let v = inp ? parseInt(inp.value, 10) : 0;
        if (isNaN(v) || v < 0) v = 0;
        troops[k] = v;
      });
      if (troops.t11 && !heroChk.checked) troops.t11 = 0;
      const existing = targetInList(l);
      if (existing) {
        fmPatch(fm => {
          const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
          if (!ll) return;
          const tt = ll.targets.find(x => x.id === existing.id);
          if (!tt) return;
          const isSameAsTemplate = Object.keys(TROOP_LABELS).every(k => (troops[k]|0) === (ll.troops[k]|0))
            && (heroChk.checked === (ll.heroFollow === true));
          tt.troops = isSameAsTemplate ? null : { ...troops };
          tt.heroFollow = heroChk.checked;
        });
        msg.style.display = 'block';
        msg.style.color = '#4a7a30';
        msg.textContent = `Updated in ${l.name}`;
        setTimeout(() => {
          const cancelBtn = dialog.querySelector('.dialogCancelButton');
          if (cancelBtn) cancelBtn.click();
        }, 500);
        return false;
      }
      const t = makeTarget(target);
      t.troops = { ...troops };
      t.heroFollow = heroChk.checked;
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
        if (ll) ll.targets.push(t);
      });
      msg.style.display = 'block';
      msg.style.color = '#4a7a30';
      msg.textContent = `Added: ${target.name}${target.distance != null ? ' (' + target.distance + 'f)' : ''} → ${l.name}`;
      setTimeout(() => {
        const cancelBtn = dialog.querySelector('.dialogCancelButton');
        if (cancelBtn) cancelBtn.click();
      }, 500);
      return false;
    });

    refreshListOptions();
  }

  // ─────────────────────────────────────────────────────────────
  // Rally Page Detection
  // ─────────────────────────────────────────────────────────────
  function isRallyOverview() {
    const u = new URL(location.href);
    return u.pathname.includes('build.php')
        && u.searchParams.get('gid') === '16'
        && u.searchParams.get('tt') === '1';
  }
  function isRallyManagement() {
    const u = new URL(location.href);
    if (!u.pathname.includes('build.php')) return false;
    if (u.searchParams.get('gid') !== '16') return false;
    const tt = u.searchParams.get('tt');
    return tt === '0' || tt === null || tt === '';
  }
  function isRallySend() {
    const u = new URL(location.href);
    return u.pathname.includes('build.php')
        && u.searchParams.get('gid') === '16'
        && u.searchParams.get('tt') === '2';
  }
  function isRallyTt0() {
    const u = new URL(location.href);
    if (!u.pathname.includes('build.php')) return false;
    if (u.searchParams.get('gid') !== '16') return false;
    const tt = u.searchParams.get('tt');
    return tt === '0' || tt === null || tt === '';
  }
  function shouldShowFarmPanel() {
    return isRallyTt0();
  }

  function openEditTargetDialog(srcVid, listId, targetId, onSave) {
    const data = readFMData();
    const list = data.byVillage[String(srcVid)]?.lists.find(l => l.id === listId);
    const target = list?.targets.find(t => t.id === targetId);
    if (!target) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;';
    const dialog = document.createElement('div');
    dialog.style.cssText = `background:linear-gradient(180deg,#f9fbff,#e8eff9);border:1px solid #8a9ac0;border-radius:6px;padding:14px;font-family:Verdana,sans-serif;font-size:12px;color:#1a2050;max-width:${MAX_WIDTH}px;width:100%;box-shadow:0 6px 30px rgba(0,0,0,.4);`;
    const currentTroops = target.troops || list.troops;
    const currentHeroFollow = target.heroFollow !== undefined ? target.heroFollow : (list.heroFollow === true);
    dialog.innerHTML = `
      <div style="font-weight:bold;color:#2a4a70;margin-bottom:8px;font-size:14px;">
        Edit (v${FM_VERSION}): ${esc(target.name)} (${target.x}|${target.y})
      </div>
      <div style="margin-bottom:6px;font-size:10px;color:#5a6a80;">
        Override troops for this target. Leave as is to use list template.
      </div>
      <div class="fm-edit-troops" style="padding:8px;background:rgba(255,255,255,.6);border-radius:4px;margin-bottom:8px;"></div>
      <label style="display:block;font-size:11px;margin-bottom:8px;">
        <input type="checkbox" class="fm-edit-hero" ${currentHeroFollow ? 'checked' : ''}> Hero follows
      </label>
      <div style="margin-bottom:8px;font-size:11px;">
        <label>Notes: <input type="text" class="fm-edit-notes" value="${esc(target.notes || '')}" maxlength="100" style="width:calc(100% - 50px);padding:3px;font-size:11px;"></label>
      </div>
      <div style="display:flex;gap:6px;">
        <button type="button" class="fm-edit-save" style="flex:1;padding:6px 10px;background:linear-gradient(180deg,#7ab04a,#4a7a30);color:#fff;border:1px solid #2a5a10;border-radius:4px;font-weight:bold;cursor:pointer;">Save</button>
        <button type="button" class="fm-edit-reset" style="padding:6px 10px;background:#f0d0c0;border:1px solid #b07050;border-radius:4px;cursor:pointer;">Reset to template</button>
        <button type="button" class="fm-edit-cancel" style="padding:6px 10px;background:#ddd;border:1px solid #999;border-radius:4px;cursor:pointer;">Cancel</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const troopsBox = dialog.querySelector('.fm-edit-troops');
    troopsBox.innerHTML = troopGridHTML(currentTroops, currentHeroFollow, 18, 'fm-edit-t-');
    attachNumericFilter(troopsBox);
    const heroChk = dialog.querySelector('.fm-edit-hero');
    heroChk.onchange = () => {
      const on = heroChk.checked;
      const heroInp = troopsBox.querySelector('.fm-edit-t-t11');
      if (heroInp) {
        heroInp.disabled = !on;
        if (!on) heroInp.value = 0;
        else if (!parseInt(heroInp.value, 10)) heroInp.value = 1;
      }
    };
    dialog.querySelector('.fm-edit-save').onclick = () => {
      const troops = {};
      Object.keys(TROOP_LABELS).forEach(k => {
        const inp = troopsBox.querySelector('.fm-edit-t-' + k);
        let v = inp ? parseInt(inp.value, 10) : 0;
        if (isNaN(v) || v < 0) v = 0;
        troops[k] = v;
      });
      if (!heroChk.checked) troops.t11 = 0;
      const notes = dialog.querySelector('.fm-edit-notes').value.trim();
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(l => l.id === listId);
        if (!ll) return;
        const t = ll.targets.find(x => x.id === targetId);
        if (!t) return;
        const isSameAsTemplate = Object.keys(TROOP_LABELS).every(k => (troops[k]|0) === (ll.troops[k]|0))
          && (heroChk.checked === (ll.heroFollow === true));
        t.troops = isSameAsTemplate ? null : { ...troops };
        t.heroFollow = heroChk.checked;
        t.notes = notes;
        t.invalid = false;
      });
      overlay.remove();
      if (onSave) onSave();
    };
    dialog.querySelector('.fm-edit-reset').onclick = () => {
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(l => l.id === listId);
        if (!ll) return;
        const t = ll.targets.find(x => x.id === targetId);
        if (!t) return;
        t.troops = null;
        t.heroFollow = undefined;
      });
      overlay.remove();
      if (onSave) onSave();
    };
    dialog.querySelector('.fm-edit-cancel').onclick = () => overlay.remove();
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  }

  function openImportModal(srcVid, onDone) {
    let overlay = document.getElementById('fm-import-overlay');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'fm-import-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;';
    const modal = document.createElement('div');
    modal.style.cssText = `background:linear-gradient(180deg,#f9fbff,#e8eff9);border:2px solid #8a9ac0;border-radius:8px;padding:16px;font-family:Verdana,sans-serif;font-size:12px;color:#1a2050;max-width:600px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.5);max-height:90vh;overflow-y:auto;`;
    const bucket = fmState().byVillage[String(srcVid)];
    const listsOptions = (bucket.lists || []).map(l =>
      `<option value="${esc(l.id)}">${esc(l.name)} (${l.targets.length})</option>`
    ).join('');
    modal.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
        <span style="font-weight:bold;font-size:16px;color:#2a4a70;">Import List (v${FM_VERSION})</span>
        <a href="#" class="fm-import-close" style="margin-left:auto;text-decoration:none;color:#a03020;font-size:22px;font-weight:bold;line-height:1;">×</a>
      </div>
      <div style="margin-bottom:12px;padding:10px;background:rgba(255,255,255,.5);border-radius:4px;">
        <div style="font-weight:bold;color:#2a4a70;font-size:11px;margin-bottom:6px;">📁 From File</div>
        <input type="file" class="fm-import-file" accept=".json,.txt,application/json,text/plain" style="font-size:11px;">
        <div class="fm-import-file-info" style="margin-top:6px;font-size:10px;color:#6a7a98;"></div>
      </div>
      <div style="margin-bottom:12px;padding:10px;background:rgba(255,255,255,.5);border-radius:4px;">
        <div style="font-weight:bold;color:#2a4a70;font-size:11px;margin-bottom:6px;">📋 Or Paste Text</div>
        <div style="font-size:10px;color:#6a7a98;margin-bottom:6px;">
          Formats: JSON (farm-list-v1) · Plain text <code>-78|-78 VillageName</code>
        </div>
        <textarea class="fm-import-text" placeholder="-78|-78 Aldeia do Griever
-77|-76 Got's village 02" style="width:100%;height:120px;padding:6px;font-family:'Courier New',monospace;font-size:11px;border:1px solid #8a9ac0;border-radius:3px;box-sizing:border-box;resize:vertical;"></textarea>
      </div>
      <div style="margin-bottom:12px;padding:10px;background:rgba(255,255,255,.5);border-radius:4px;">
        <div style="font-weight:bold;color:#2a4a70;font-size:11px;margin-bottom:8px;">🎯 Target List</div>
        <label style="display:block;margin-bottom:6px;">
          <input type="radio" name="fm-import-mode" value="new" checked>
          <b>New list</b>
        </label>
        <div style="margin-left:24px;margin-bottom:8px;">
          <label style="font-size:11px;">Name:
            <input type="text" class="fm-import-newlist-name" placeholder="Imported List" style="width:200px;padding:3px;font-size:11px;border:1px solid #8a9ac0;border-radius:3px;">
          </label>
        </div>
        <label style="display:block;margin-bottom:6px;">
          <input type="radio" name="fm-import-mode" value="existing" ${bucket.lists.length ? '' : 'disabled'}>
          <b>Add to existing list</b> ${bucket.lists.length ? '' : '<span style="color:#888;font-size:10px;">(no lists)</span>'}
        </label>
        <div style="margin-left:24px;">
          <select class="fm-import-target-list" style="width:100%;padding:3px;font-size:11px;border:1px solid #8a9ac0;border-radius:3px;" disabled>
            ${listsOptions}
          </select>
        </div>
      </div>
      <div class="fm-import-preview" style="margin-bottom:12px;padding:10px;background:rgba(200,220,240,.4);border-radius:4px;display:none;font-size:11px;">
        <div style="font-weight:bold;color:#2a4a70;margin-bottom:6px;">ℹ Preview:</div>
        <div class="fm-import-preview-content"></div>
      </div>
      <div class="fm-import-msg" style="margin-bottom:8px;font-size:11px;padding:6px;border-radius:3px;display:none;"></div>
      <div style="display:flex;gap:6px;">
        <button type="button" class="fm-import-do" style="flex:1;padding:8px 12px;background:linear-gradient(180deg,#7ab04a,#4a7a30);color:#fff;border:1px solid #2a5a10;border-radius:4px;font-weight:bold;cursor:pointer;font-size:13px;">✓ Import</button>
        <button type="button" class="fm-import-cancel" style="padding:8px 12px;background:#ddd;border:1px solid #999;border-radius:4px;cursor:pointer;">Cancel</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const fileInput = modal.querySelector('.fm-import-file');
    const fileInfo = modal.querySelector('.fm-import-file-info');
    const textArea = modal.querySelector('.fm-import-text');
    const msgEl = modal.querySelector('.fm-import-msg');
    const previewEl = modal.querySelector('.fm-import-preview');
    const previewContent = modal.querySelector('.fm-import-preview-content');
    const newListNameInput = modal.querySelector('.fm-import-newlist-name');
    const targetListSelect = modal.querySelector('.fm-import-target-list');
    const modeRadios = modal.querySelectorAll('input[name="fm-import-mode"]');

    function currentMode() {
      for (const r of modeRadios) if (r.checked) return r.value;
      return 'new';
    }
    function currentTargetListId() {
      return currentMode() === 'existing' ? targetListSelect.value : null;
    }
    function updateModeUI() {
      const m = currentMode();
      newListNameInput.disabled = (m !== 'new');
      targetListSelect.disabled = (m !== 'existing');
    }
    function refreshPreview() {
      const text = textArea.value.trim();
      if (!text) { previewEl.style.display = 'none'; return; }
      const mode = currentMode();
      const targetId = currentTargetListId();
      if (mode === 'existing' && !targetId) { previewEl.style.display = 'none'; return; }
      const preview = previewImport(text, srcVid, mode, targetId);
      if (!preview.ok) { previewEl.style.display = 'none'; return; }
      previewEl.style.display = 'block';
      let html = '';
      html += `<div style="color:#2a5a10;">✓ <b>${preview.newCount}</b> new targets will be added</div>`;
      if (preview.dupCount > 0) html += `<div style="color:#8a7050;">⚠ <b>${preview.dupCount}</b> duplicates (will skip)</div>`;
      if (preview.invalidCount > 0) html += `<div style="color:#a03020;">✗ <b>${preview.invalidCount}</b> invalid entries</div>`;
      html += `<div style="color:#5a6a80;margin-top:4px;">Total in file: <b>${preview.totalInFile}</b></div>`;
      if (mode === 'existing' && preview.jsonListName && targetId) {
        const targetList = fmState().byVillage[String(srcVid)]?.lists?.find(l => l.id === targetId);
        if (targetList && preview.jsonListName !== targetList.name) {
          html += `<div style="color:#8a7050;margin-top:6px;padding:4px 6px;background:rgba(255,220,180,.4);border-radius:3px;font-size:10px;">ℹ JSON name: "<b>${esc(preview.jsonListName)}</b>" (ignored — targets go to "<b>${esc(targetList.name)}</b>")</div>`;
        }
      }
      previewContent.innerHTML = html;
    }

    for (const r of modeRadios) r.onchange = () => { updateModeUI(); refreshPreview(); };
    targetListSelect.onchange = refreshPreview;
    textArea.oninput = refreshPreview;

    fileInput.onchange = () => {
      const f = fileInput.files?.[0];
      if (!f) { fileInfo.textContent = ''; return; }
      fileInfo.textContent = `Selected: ${f.name} (${f.size} bytes)`;
      const reader = new FileReader();
      reader.onload = () => {
        textArea.value = reader.result;
        fileInfo.textContent = `Selected: ${f.name} — loaded below`;
        refreshPreview();
      };
      reader.readAsText(f);
    };

    function showMsg(text, ok) {
      msgEl.style.display = 'block';
      msgEl.style.background = ok ? 'rgba(200,240,200,.6)' : 'rgba(240,200,200,.6)';
      msgEl.style.color = ok ? '#2a5a10' : '#7a2010';
      msgEl.textContent = text;
    }

    modal.querySelector('.fm-import-do').onclick = () => {
      const text = textArea.value.trim();
      if (!text) { showMsg('Nothing to import', false); return; }
      const mode = currentMode();
      const targetId = currentTargetListId();
      const newName = newListNameInput.value.trim();
      if (mode === 'existing' && !targetId) { showMsg('Please select a target list', false); return; }
      const res = importListToTarget(text, srcVid, mode, targetId, newName);
      if (!res.ok) { showMsg('Failed: ' + res.error, false); return; }
      let resultMsg = `Imported to "${res.listName}" — ${res.added} added`;
      if (res.dup > 0) resultMsg += `, ${res.dup} skipped (duplicates)`;
      if (res.invalid > 0) resultMsg += `, ${res.invalid} invalid`;
      showMsg(resultMsg, true);
      if (onDone) setTimeout(() => { overlay.remove(); onDone(); }, 1000);
    };

    modal.querySelector('.fm-import-cancel').onclick = () => overlay.remove();
    modal.querySelector('.fm-import-close').onclick = (e) => { e.preventDefault(); overlay.remove(); };
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    updateModeUI();
  }

  // ─────────────────────────────────────────────────────────────
  // Rally Panel — only in tt=0
  // ─────────────────────────────────────────────────────────────
  function injectFarmPanel() {
    if (!shouldShowFarmPanel()) {
      if (_fmPanelRef && _fmPanelRef.isConnected) _fmPanelRef.remove();
      _fmPanelRef = null;
      return;
    }

    const container = document.getElementById('build');
    if (!container) return;

    if (_fmPanelRef && _fmPanelRef.isConnected && container.contains(_fmPanelRef)) return;

    if (_fmPanelRef && _fmPanelRef.isConnected) {
      fmLog('INFO', 'Removing stale farm panel');
      _fmPanelRef.remove();
    }
    document.querySelectorAll('.fm-panel').forEach(p => p.remove());
    _fmPanelRef = null;

    const srcVid = window.TC.village();
    if (!srcVid) return;
    ensureVillageBucket(srcVid);

    const wrap = document.createElement('div');
    wrap.className = 'data fm-panel';
    wrap.style.cssText = 'margin:14px 0;padding:12px;background:linear-gradient(180deg,#f9fbff,#e8eff9);border:1px solid #8a9ac0;border-radius:6px;font-family:Verdana,sans-serif;font-size:12px;color:#1a2050;';
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
        <span style="font-weight:bold;font-size:14px;color:#2a4a70;">Farm Manager (v${FM_VERSION})</span>
        <span style="font-size:10px;color:#6a7a98;">source: ${esc(window.TC.villageLabel(srcVid))}</span>
        <button class="fm-btn fm-btn-copylog" title="Copy full log + state + diag" style="margin-left:auto;padding:2px 8px;background:linear-gradient(180deg,#a0c0e0,#6080b0);color:#fff;border:1px solid #4060a0;border-radius:3px;cursor:pointer;font-size:10px;">📋 Copy Log</button>
        <button class="fm-btn fm-btn-clearlog" title="Clear FM log buffer" style="padding:2px 8px;background:linear-gradient(180deg,#f0c0a0,#d09070);color:#fff;border:1px solid #a06040;border-radius:3px;cursor:pointer;font-size:10px;">🗑 Clear Log</button>
      </div>
      <div class="fm-tabs" style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap;"></div>
      <div class="fm-list-toolbar" style="display:flex;gap:6px;margin-bottom:8px;align-items:center;flex-wrap:wrap;">
        <button class="fm-btn fm-btn-new" style="padding:3px 8px;background:linear-gradient(180deg,#7ab04a,#4a7a30);color:#fff;border:1px solid #2a5a10;border-radius:3px;cursor:pointer;font-weight:bold;">+ New List</button>
        <button class="fm-btn fm-btn-rename" style="padding:3px 8px;background:#e0e8f0;border:1px solid #8a9ac0;border-radius:3px;cursor:pointer;">Rename</button>
        <button class="fm-btn fm-btn-delete" style="padding:3px 8px;background:#f0d0c0;border:1px solid #b07050;border-radius:3px;cursor:pointer;">Delete</button>
        <button class="fm-btn fm-btn-export" style="padding:3px 8px;background:#e0e8f0;border:1px solid #8a9ac0;border-radius:3px;cursor:pointer;">Export</button>
        <button class="fm-btn fm-btn-import" style="padding:3px 8px;background:#e0e8f0;border:1px solid #8a9ac0;border-radius:3px;cursor:pointer;">Import</button>
        <label style="margin-left:auto;font-size:10px;">
          <input type="checkbox" class="fm-hero-global"> Hero follows
        </label>
      </div>
      <div class="fm-profile-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:10px;padding:6px 8px;background:rgba(255,255,255,.5);border-radius:3px;flex-wrap:wrap;">
        <label>Behavior: <select class="fm-profile-select" style="padding:2px 4px;font-size:11px;"><option value="fast">Fast</option><option value="normal">Normal</option><option value="paranoid">Paranoid</option></select></label>
        <label><input type="checkbox" class="fm-sound-toggle"> Sound on complete</label>
        <label><input type="checkbox" class="fm-notif-toggle"> Desktop notifications</label>
        <label title="If Heartbeat was OFF before the run, turn it back OFF when done"><input type="checkbox" class="fm-hb-restore-toggle"> Restore HB after run</label>
      </div>
      <div class="fm-cooldown-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:10px;padding:6px 8px;background:rgba(255,240,220,.5);border-radius:3px;flex-wrap:wrap;">
        <label style="font-weight:bold;">⏸ Cool Down:</label>
        <label><input type="checkbox" class="fm-cd-enabled"> Enabled</label>
        <label>Every
          <input type="number" class="fm-cd-min" min="1" max="50" value="7" style="width:44px;padding:2px 4px;font-size:10px;border:1px solid #8a9ac0;border-radius:3px;">
          -
          <input type="number" class="fm-cd-max" min="1" max="50" value="10" style="width:44px;padding:2px 4px;font-size:10px;border:1px solid #8a9ac0;border-radius:3px;">
          attacks
        </label>
        <label>Wait
          <input type="number" class="fm-cd-mindelay" min="1" max="60" value="3" style="width:44px;padding:2px 4px;font-size:10px;border:1px solid #8a9ac0;border-radius:3px;">
          -
          <input type="number" class="fm-cd-maxdelay" min="1" max="60" value="5" style="width:44px;padding:2px 4px;font-size:10px;border:1px solid #8a9ac0;border-radius:3px;">
          sec
        </label>
      </div>
      <div class="fm-troop-editor" style="padding:6px 8px;background:rgba(255,255,255,.5);border-radius:3px;margin-bottom:8px;"></div>
      <div class="fm-targets-toolbar" style="display:flex;gap:6px;align-items:center;margin-bottom:4px;font-size:10px;flex-wrap:wrap;">
        <button class="fm-btn fm-btn-selall" style="padding:2px 6px;background:#e0e8f0;border:1px solid #8a9ac0;border-radius:3px;cursor:pointer;font-size:10px;">Select all</button>
        <button class="fm-btn fm-btn-selnone" style="padding:2px 6px;background:#e0e8f0;border:1px solid #8a9ac0;border-radius:3px;cursor:pointer;font-size:10px;">Select none</button>
        <span style="margin-left:auto;color:#5a6a80;" class="fm-selected-info"></span>
        <label style="margin-left:8px;display:flex;gap:4px;align-items:center;">
          <span>Search:</span>
          <input type="text" class="fm-search-x" placeholder="X" inputmode="numeric" style="width:48px;padding:2px 4px;font-size:10px;border:1px solid #8a9ac0;border-radius:3px;">
          <input type="text" class="fm-search-y" placeholder="Y" inputmode="numeric" style="width:48px;padding:2px 4px;font-size:10px;border:1px solid #8a9ac0;border-radius:3px;">
          <button class="fm-btn-search" style="padding:2px 8px;background:linear-gradient(180deg,#a0c0e0,#6080b0);color:#fff;border:1px solid #4060a0;border-radius:3px;cursor:pointer;font-size:10px;">🔍 Search</button>
          <button class="fm-btn-search-clear" style="padding:2px 6px;background:#e0e0e0;border:1px solid #999;border-radius:3px;cursor:pointer;font-size:10px;">✕</button>
        </label>
      </div>
      <div class="fm-targets-wrap" style="max-height:400px;overflow-y:auto;border:1px solid #c0cde0;border-radius:3px;background:#fff;"></div>
      <div class="fm-runbar" style="margin-top:10px;display:flex;gap:6px;align-items:center;">
        <button class="fm-btn fm-btn-start" style="flex:1;padding:6px 10px;background:linear-gradient(180deg,#d04a30,#a03020);color:#fff;border:1px solid #601010;border-radius:4px;font-weight:bold;cursor:pointer;">Start Raid</button>
        <button class="fm-btn fm-btn-resume" style="flex:1;padding:6px 10px;background:linear-gradient(180deg,#d09030,#a06020);color:#fff;border:1px solid #603010;border-radius:4px;font-weight:bold;cursor:pointer;display:none;">Resume</button>
        <button class="fm-btn fm-btn-restart" style="padding:6px 10px;background:#e0e0e0;border:1px solid #999;border-radius:4px;cursor:pointer;display:none;">Restart All</button>
      </div>
      <div class="fm-progress" style="margin-top:8px;font-size:10px;font-family:'Courier New',monospace;color:#4a5a70;"></div>
      <div class="fm-diag" style="margin-top:6px;font-size:9px;font-family:'Courier New',monospace;color:#8a4a20;background:rgba(255,240,220,.5);padding:4px 6px;border-radius:3px;"></div>
    `;

    container.insertBefore(wrap, container.firstChild);
    _fmPanelRef = wrap;

    const tabsEl = wrap.querySelector('.fm-tabs');
    const troopEditor = wrap.querySelector('.fm-troop-editor');
    const targetsWrap = wrap.querySelector('.fm-targets-wrap');
    const selInfoEl = wrap.querySelector('.fm-selected-info');
    const progressEl = wrap.querySelector('.fm-progress');
    const diagEl = wrap.querySelector('.fm-diag');
    const btnStart = wrap.querySelector('.fm-btn-start');
    const btnResume = wrap.querySelector('.fm-btn-resume');
    const btnRestart = wrap.querySelector('.fm-btn-restart');
    const btnNew = wrap.querySelector('.fm-btn-new');
    const btnRename = wrap.querySelector('.fm-btn-rename');
    const btnDelete = wrap.querySelector('.fm-btn-delete');
    const btnExport = wrap.querySelector('.fm-btn-export');
    const btnImport = wrap.querySelector('.fm-btn-import');
    const btnCopyLog = wrap.querySelector('.fm-btn-copylog');
    const btnClearLog = wrap.querySelector('.fm-btn-clearlog');
    const btnSelAll = wrap.querySelector('.fm-btn-selall');
    const btnSelNone = wrap.querySelector('.fm-btn-selnone');
    const heroGlobal = wrap.querySelector('.fm-hero-global');
    const profileSelect = wrap.querySelector('.fm-profile-select');
    const soundToggle = wrap.querySelector('.fm-sound-toggle');
    const notifToggle = wrap.querySelector('.fm-notif-toggle');
    const hbRestoreToggle = wrap.querySelector('.fm-hb-restore-toggle');
    const searchX = wrap.querySelector('.fm-search-x');
    const searchY = wrap.querySelector('.fm-search-y');

    const cdEnabled = wrap.querySelector('.fm-cd-enabled');
    const cdMin = wrap.querySelector('.fm-cd-min');
    const cdMax = wrap.querySelector('.fm-cd-max');
    const cdMinDelay = wrap.querySelector('.fm-cd-mindelay');
    const cdMaxDelay = wrap.querySelector('.fm-cd-maxdelay');

    let activeListId = fmState().byVillage[String(srcVid)].activeListId;

    function getBucket() { return fmState().byVillage[String(srcVid)]; }
    function activeList() {
      const b = getBucket();
      if (!b.lists.length) return null;
      return b.lists.find(l => l.id === activeListId) || b.lists[0];
    }
    function setActive(id) {
      activeListId = id;
      fmPatch(fm => { fm.byVillage[String(srcVid)].activeListId = id; });
      renderAll();
    }
    function sortedTargets(list) {
      const arr = list.targets.slice();
      arr.sort((a, b) => {
        const da = a.distance == null ? 1e9 : a.distance;
        const db = b.distance == null ? 1e9 : b.distance;
        if (da !== db) return da - db;
        return (a.addedAt || 0) - (b.addedAt || 0);
      });
      return arr;
    }

    btnCopyLog.onclick = () => copyFullLog();
    btnClearLog.onclick = () => clearLogBuffer();

    function renderTabs() {
      const b = getBucket();
      if (!b.lists.length) {
        tabsEl.innerHTML = '<span style="font-size:10px;color:#8a7050;font-style:italic;">No lists yet — create one</span>';
        return;
      }
      tabsEl.innerHTML = b.lists.map(l => `
        <div class="fm-tab" data-id="${esc(l.id)}" style="
          padding:4px 10px;border:1px solid ${l.id===activeListId?'#2a5a10':'#8a9ac0'};
          background:${l.id===activeListId?'linear-gradient(180deg,#a0d070,#6aa040)':'#f0f5ff'};
          color:${l.id===activeListId?'#fff':'#2a4a70'};
          border-radius:3px;cursor:pointer;font-size:10px;font-weight:bold;"
          title="Double-click to rename">
          ${esc(l.name)} <span style="opacity:.7;">(${l.targets.length})</span>
        </div>
      `).join('');
      tabsEl.querySelectorAll('.fm-tab').forEach(el => {
        el.onclick = () => setActive(el.dataset.id);
        el.ondblclick = (e) => {
          e.preventDefault();
          const l = getBucket().lists.find(x => x.id === el.dataset.id);
          if (!l) return;
          startInlineRename(el, l);
        };
      });
    }

    function startInlineRename(el, list) {
      const originalHTML = el.innerHTML;
      el.innerHTML = '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = list.name;
      input.maxLength = 40;
      input.style.cssText = 'padding:2px 4px;font-size:10px;border:1px solid #2a5a10;border-radius:3px;width:110px;font-family:Verdana,sans-serif;';
      el.appendChild(input);
      input.focus();
      input.select();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const newName = input.value.trim();
        if (newName && newName !== list.name) {
          fmPatch(fm => {
            const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === list.id);
            if (ll) ll.name = newName;
          });
          fmLog('INFO', 'List renamed:', list.name, '→', newName);
        }
        renderAll();
      };
      input.onblur = commit;
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          committed = true;
          el.innerHTML = originalHTML;
          el.onclick = () => setActive(el.dataset.id);
          el.ondblclick = (e) => {
            e.preventDefault();
            const l2 = getBucket().lists.find(x => x.id === el.dataset.id);
            if (l2) startInlineRename(el, l2);
          };
        }
      };
    }

    function loadCooldownUI() {
      const l = activeList();
      if (!l) return;
      const cd = l.cooldown || { enabled: true, minAttacks: 7, maxAttacks: 10, minDelayMs: 3000, maxDelayMs: 5000 };
      cdEnabled.checked = cd.enabled !== false;
      cdMin.value = cd.minAttacks || 7;
      cdMax.value = cd.maxAttacks || 10;
      cdMinDelay.value = Math.round((cd.minDelayMs || 3000) / 1000);
      cdMaxDelay.value = Math.round((cd.maxDelayMs || 5000) / 1000);
    }
    function saveCooldownUI() {
      const l = activeList();
      if (!l) return;
      const minA = Math.max(1, Math.min(50, parseInt(cdMin.value, 10) || 7));
      const maxA = Math.max(minA, Math.min(50, parseInt(cdMax.value, 10) || 10));
      const minD = Math.max(1, Math.min(60, parseInt(cdMinDelay.value, 10) || 3));
      const maxD = Math.max(minD, Math.min(60, parseInt(cdMaxDelay.value, 10) || 5));
      cdMin.value = minA; cdMax.value = maxA;
      cdMinDelay.value = minD; cdMaxDelay.value = maxD;
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
        if (ll) {
          ll.cooldown = {
            enabled: cdEnabled.checked,
            minAttacks: minA, maxAttacks: maxA,
            minDelayMs: minD * 1000, maxDelayMs: maxD * 1000,
          };
        }
      });
    }
    cdEnabled.onchange = saveCooldownUI;
    cdMin.onchange = saveCooldownUI;
    cdMax.onchange = saveCooldownUI;
    cdMinDelay.onchange = saveCooldownUI;
    cdMaxDelay.onchange = saveCooldownUI;

    function renderTroopEditor() {
      const l = activeList();
      if (!l) { troopEditor.innerHTML = ''; return; }
      const hf = l.heroFollow === true;
      heroGlobal.checked = hf;
      troopEditor.innerHTML = `
        <div style="font-size:10px;color:#5a6a80;margin-bottom:4px;">
          Troops per attack (template):
          <b class="fm-troop-count" style="color:#2a5a10;margin-left:6px;">${esc(troopCountLabel(l))}</b>
        </div>
        ${Object.keys(TROOP_LABELS).map(k => {
          const isHero = k === 't11';
          return `
            <label title="${esc(TROOP_LABELS[k])}" style="display:inline-flex;align-items:center;width:24%;margin:2px 0;font-size:10px;box-sizing:border-box;padding-right:4px;">
              <span style="display:inline-block;width:16px;font-weight:bold;">${k.replace('t','')}</span>
              ${troopIconHTML(k, 16)}
              <span style="margin-left:2px;">${numericInputHTML('fm-t-' + k, l.troops[k]||0, 40, isHero && !hf)}</span>
            </label>
          `;
        }).join('')}
      `;
      attachNumericFilter(troopEditor);
      troopEditor.querySelectorAll('input').forEach(inp => {
        inp.onchange = () => {
          const k = inp.className.replace('fm-t-','');
          const v = Math.max(0, parseInt(inp.value, 10) || 0);
          fmPatch(fm => {
            const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
            if (ll) ll.troops[k] = v;
          });
          const labelEl = troopEditor.querySelector('.fm-troop-count');
          if (labelEl) labelEl.textContent = troopCountLabel(l);
        };
      });
      loadCooldownUI();
    }

    function renderTargets() {
      const l = activeList();
      if (!l) { targetsWrap.innerHTML = '<div style="padding:20px;text-align:center;color:#8a7050;font-style:italic;">No list selected</div>'; return; }
      if (!l.targets.length) {
        targetsWrap.innerHTML = '<div style="padding:20px;text-align:center;color:#8a7050;font-style:italic;">Empty — add villages from the map</div>';
        return;
      }
      const sorted = sortedTargets(l);
      targetsWrap.innerHTML = sorted.map(t => {
        const isInvalid = t.invalid === true;
        const badge = isInvalid ? '⊘' :
                      t.status === 'sent' ? 'OK' :
                      t.status === 'partial' ? '!' :
                      t.status === 'failed' ? 'X' :
                      t.status === 'skipped' ? '–' : '·';
        const last = t.lastRaid ? ` · ${t.lastRaid.status} @ ${new Date(t.lastRaid.at).toLocaleTimeString()}` : '';
        const partial = t.partialRemaining ? ` · remaining: ${Object.entries(t.partialRemaining).filter(([,v])=>v>0).map(([k,v])=>`${k}:${v}`).join(',')}` : '';
        const distStr = t.distance != null ? `<span style="color:#8a7050;font-weight:bold;">· ${t.distance}f</span>` : '';
        const playerStr = t.player ? `<span style="color:#6a7a98;">· ${esc(t.player)}</span>` : '';
        const invalidStr = isInvalid ? `<span style="color:#a03020;font-weight:bold;font-style:italic;">· INVALID</span>` : '';
        const troopsForDisplay = t.troops || l.troops;
        const troopsHtml = troopsInlineHTML(troopsForDisplay, 16);
        const karteHref = `/karte.php?x=${t.x}&y=${t.y}`;
        const bg = isInvalid ? 'rgba(240,220,220,.5)' : (t.status==='sent'?'rgba(200,240,200,.4)':t.status==='failed'?'rgba(240,200,200,.4)':t.status==='partial'?'rgba(240,220,180,.4)':'transparent');
        return `
          <div class="fm-target" data-id="${esc(t.id)}" style="
            display:flex;align-items:center;gap:6px;padding:4px 6px;
            border-bottom:1px dashed #c0cde0;font-size:10px;background:${bg};">
            <input type="checkbox" class="fm-target-cb" ${t.selected !== false ? 'checked' : ''} style="margin:0;cursor:pointer;">
            <span style="font-family:monospace;font-weight:bold;width:20px;text-align:center;">${badge}</span>
            <span style="flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden;">
              <a href="${esc(karteHref)}" target="_blank" style="color:#2a4a70;text-decoration:none;font-weight:bold;white-space:normal;word-break:break-word;" title="Open on map">${esc(t.name)}</a>
              <span style="color:#6a7a98;flex-shrink:0;">(${t.x}|${t.y})</span>
              ${distStr}${playerStr}${invalidStr}${last}${partial}
            </span>
            <span style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;">${troopsHtml}</span>
            <button class="fm-target-edit" title="Edit" style="padding:0 5px;background:#e0e8f0;border:1px solid #8a9ac0;border-radius:3px;cursor:pointer;font-size:10px;">✎</button>
            <button class="fm-target-remove" title="Remove" style="padding:0 5px;background:#f0d0c0;border:1px solid #b07050;border-radius:3px;cursor:pointer;font-size:10px;">x</button>
          </div>
        `;
      }).join('');

      targetsWrap.querySelectorAll('.fm-target').forEach(rowEl => {
        const id = rowEl.dataset.id;
        const cb = rowEl.querySelector('.fm-target-cb');
        if (cb) {
          cb.onchange = () => {
            fmPatch(fm => {
              const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
              if (!ll) return;
              const t = ll.targets.find(x => x.id === id);
              if (t) { t.selected = cb.checked; if (cb.checked) t.invalid = false; }
            });
            renderSelectedInfo();
            renderRunbar();
          };
        }
        const editBtn = rowEl.querySelector('.fm-target-edit');
        if (editBtn) {
          editBtn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            openEditTargetDialog(srcVid, l.id, id, () => { renderTargets(); renderRunbar(); });
          };
        }
        const removeBtn = rowEl.querySelector('.fm-target-remove');
        if (removeBtn) {
          removeBtn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!confirm('Remove this target?')) return;
            fmPatch(fm => {
              const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
              if (ll) ll.targets = ll.targets.filter(t => t.id !== id);
            });
            renderAll();
          };
        }
      });
      renderSelectedInfo();
    }

    function renderSelectedInfo() {
      const l = activeList();
      if (!l) { selInfoEl.textContent = ''; return; }
      const selected = l.targets.filter(t => t.selected !== false && !t.invalid);
      const invalid = l.targets.filter(t => t.invalid).length;
      selInfoEl.textContent = `${selected.length} / ${l.targets.length} selected${invalid ? ' (' + invalid + ' invalid)' : ''}`;
    }

    function renderRunbar() {
      const l = activeList();
      if (!l) { btnStart.style.display = 'none'; btnResume.style.display = 'none'; btnRestart.style.display = 'none'; return; }
      const selected = l.targets.filter(t => t.selected !== false && t.status !== 'sent' && !t.invalid);
      const allPending = l.targets.filter(t => t.status !== 'sent' && !t.invalid);
      const hasPending = allPending.length > 0;
      const hasDone = l.targets.some(t => t.status === 'sent');
      if (hasPending) {
        btnStart.style.display = hasDone ? 'none' : 'block';
        btnResume.style.display = hasDone ? 'block' : 'none';
        btnRestart.style.display = hasDone ? 'block' : 'none';
        btnStart.textContent = `Start Raid (${selected.length})`;
        btnResume.textContent = `Resume (${selected.length} remaining)`;
      } else if (l.targets.length > 0) {
        btnStart.style.display = 'none';
        btnResume.style.display = 'none';
        btnRestart.style.display = 'block';
      } else {
        btnStart.style.display = 'block';
        btnResume.style.display = 'none';
        btnRestart.style.display = 'none';
        btnStart.textContent = 'Start Raid (0)';
      }
    }

    function renderProgress() {
      const fm = fmState();
      if (!fm.runInProgress) { progressEl.textContent = ''; return; }
      const r = fm.runInProgress;
      const total = r.planned;
      const done = r.sent + r.failed + r.skipped;
      const pct = total ? Math.round(done / total * 100) : 0;
      progressEl.innerHTML = `
        <div style="height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#7ab04a,#4a7a30);"></div>
        </div>
        <div style="margin-top:3px;">
          Run ${esc(r.id.slice(-6))} — ${r.sent}/${total} sent · ${r.failed} failed · ${r.skipped} skipped
          ${r.currentTarget ? `<br>current: ${esc(r.currentTarget)} · ${esc(r.currentState || '')}` : ''}
        </div>
      `;
    }

    function renderDiag() {
      const s = window.TC.state();
      const fm = fmState();
      const lines = [];
      lines.push(`HB=${s.heartbeat?.enabled} | frozen=${s.heartbeat?._frozenAt ? 'YES('+s.heartbeat._frozenReason+')' : 'no'}`);
      lines.push(`job=${s.currentJob ? s.currentJob.plugin+'/'+s.currentJob.state : 'null'}`);
      lines.push(`queuedFarm=${(s.tasks||[]).filter(t => t.payload?.farm).length} | allTasks=${(s.tasks||[]).length}`);
      lines.push(`page=${window.TC.page()} | tt=${new URL(location.href).searchParams.get('tt')||'-'}`);
      if (fm.runInProgress) {
        lines.push(`run=${fm.runInProgress.id.slice(-6)} state=${fm.runInProgress.currentState||'-'}`);
        const cd = fm.runInProgress._sentSinceCooldown || 0;
        const cdTh = fm.runInProgress._cooldownThreshold || '?';
        lines.push(`cooldown: ${cd}/${cdTh}${_cooldownActive ? ' [ACTIVE]' : ''}`);
      }
      lines.push(`panels=${document.querySelectorAll('.fm-panel').length}`);
      if (fm._pendingFinalReport) lines.push(`pendingReport=YES navigateTt0=${fm._navigateToTt0AfterRun}`);
      const pendingKey = sessionStorage.getItem(PENDING_RUN_KEY);
      lines.push(`pendingKey=${pendingKey ? 'YES' : 'no'}`);
      lines.push(`heartbeatWasEnabled=${fm._heartbeatWasEnabled}`);
      diagEl.innerHTML = lines.map(l => esc(l)).join('<br>');
    }

    function renderAll() {
      renderTabs(); renderTroopEditor(); renderTargets(); renderRunbar(); renderProgress(); renderDiag();
    }

    const fms = fmState();
    profileSelect.value = fms.settings.profile || 'normal';
    soundToggle.checked = fms.settings.soundEnabled === true;
    notifToggle.checked = fms.settings.notificationsEnabled !== false;
    hbRestoreToggle.checked = fms.settings.restoreHeartbeatAfterRun !== false;

    btnNew.onclick = () => {
      const name = prompt('New list name:', 'List ' + (getBucket().lists.length + 1));
      if (!name) return;
      const l = makeList(name.trim());
      fmPatch(fm => {
        fm.byVillage[String(srcVid)].lists.push(l);
        fm.byVillage[String(srcVid)].activeListId = l.id;
      });
      setActive(l.id);
    };
    btnRename.onclick = () => {
      const l = activeList();
      if (!l) return;
      const name = prompt('New name:', l.name);
      if (!name || name === l.name) return;
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
        if (ll) ll.name = name.trim();
      });
      renderAll();
    };
    btnDelete.onclick = () => {
      const l = activeList();
      if (!l) return;
      if (!confirm(`Delete list "${l.name}" with ${l.targets.length} targets?`)) return;
      fmPatch(fm => {
        const b = fm.byVillage[String(srcVid)];
        b.lists = b.lists.filter(x => x.id !== l.id);
        b.activeListId = b.lists[0]?.id || null;
      });
      activeListId = getBucket().lists[0]?.id || null;
      renderAll();
    };

    btnExport.onclick = () => {
      const l = activeList();
      if (!l || !l.targets.length) { alert('Nothing to export'); return; }
      const onlySel = confirm('Export only SELECTED targets?\n\nOK = selected only\nCancel = all targets');
      const json = exportListCompact(srcVid, l.id, onlySel);
      if (!json) { alert('Export failed'); return; }
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (l.name || 'list').replace(/[^a-z0-9_-]/gi, '_');
      a.download = `farm-list-${safeName}-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      window.TC.flash?.(`Exported ${onlySel ? 'selected' : 'all'} targets`);
    };

    btnImport.onclick = () => {
      openImportModal(srcVid, () => {
        activeListId = fmState().byVillage[String(srcVid)].activeListId;
        renderAll();
      });
    };

    btnSelAll.onclick = () => {
      const l = activeList();
      if (!l) return;
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
        if (ll) ll.targets.forEach(t => { t.selected = true; t.invalid = false; });
      });
      renderTargets(); renderRunbar();
    };
    btnSelNone.onclick = () => {
      const l = activeList();
      if (!l) return;
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
        if (ll) ll.targets.forEach(t => t.selected = false);
      });
      renderTargets(); renderRunbar();
    };
    heroGlobal.onchange = () => {
      const l = activeList();
      if (!l) return;
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
        if (ll) ll.heroFollow = heroGlobal.checked;
      });
      renderTroopEditor();
    };
    profileSelect.onchange = () => {
      fmPatch(fm => { fm.settings.profile = profileSelect.value; });
      showToast(`Behavior: ${profileSelect.value}`, 'ok');
    };
    soundToggle.onchange = () => {
      fmPatch(fm => { fm.settings.soundEnabled = soundToggle.checked; });
      if (soundToggle.checked) playAlarm();
    };
    notifToggle.onchange = () => {
      fmPatch(fm => { fm.settings.notificationsEnabled = notifToggle.checked; });
      if (notifToggle.checked && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
    };
    hbRestoreToggle.onchange = () => {
      fmPatch(fm => { fm.settings.restoreHeartbeatAfterRun = hbRestoreToggle.checked; });
      showToast(`Restore HB: ${hbRestoreToggle.checked ? 'ON' : 'OFF'}`, 'ok');
    };

    wrap.querySelector('.fm-btn-search').onclick = () => {
      const x = parseInt(searchX.value, 10);
      const y = parseInt(searchY.value, 10);
      if (isNaN(x) || isNaN(y)) { showToast('Enter X and Y', 'warn'); return; }
      const l = activeList();
      if (!l) return;
      const t = l.targets.find(t => t.x === x && t.y === y);
      if (!t) { showToast(`Not found: (${x}|${y})`, 'warn'); return; }
      const el = wrap.querySelector(`.fm-target[data-id="${t.id}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.outline = '3px solid #ffb020';
        setTimeout(() => { el.style.outline = ''; }, 2500);
      }
      showToast(`Found: ${t.name}`, 'ok');
    };
    wrap.querySelector('.fm-btn-search-clear').onclick = () => { searchX.value = ''; searchY.value = ''; };

    btnStart.onclick = () => startRun('start');
    btnResume.onclick = () => startRun('resume');
    btnRestart.onclick = () => {
      const l = activeList();
      if (!l) return;
      if (!confirm(`Reset all ${l.targets.length} targets to pending?`)) return;
      fmPatch(fm => {
        const ll = fm.byVillage[String(srcVid)].lists.find(x => x.id === l.id);
        if (ll) ll.targets.forEach(t => {
          t.status = 'pending'; t.lastRaid = null; t.partialRemaining = null; t.lastSkipReason = null; t.invalid = false;
        });
      });
      renderAll();
    };

    function startRun(mode) {
      const l = activeList();
      if (!l || !l.targets.length) { alert('No targets in list'); return; }

      makeBackup('before-run');

      let candidates = l.targets.filter(t => t.selected !== false && t.invalid !== true);
      if (!candidates.length) { alert('All targets are invalid or unselected'); return; }

      let targets;
      if (mode === 'resume') {
        targets = candidates.filter(t => t.status === 'pending' || t.status === 'skipped' || t.status === 'partial');
      } else {
        targets = candidates.filter(t => t.status !== 'sent');
      }
      if (!targets.length) { alert('Nothing to send'); return; }

      targets = targets.filter(t => t.invalid !== true);
      if (!targets.length) { alert('All targets are invalid'); return; }

      targets.sort((a, b) => {
        const da = a.distance == null ? 1e9 : a.distance;
        const db = b.distance == null ? 1e9 : b.distance;
        if (da !== db) return da - db;
        return (a.addedAt || 0) - (b.addedAt || 0);
      });

      if (mode === 'start') {
        const snapshot = fmState().byVillage[String(srcVid)].snapshot;
        if (snapshot) {
          const need = {};
          for (const k of Object.keys(TROOP_LABELS)) {
            need[k] = l.troops[k] | 0;
          }
          let maxByTroop = Infinity;
          let limitingKey = null;
          for (const k of Object.keys(need)) {
            if (need[k] <= 0) continue;
            const have = snapshot[k] | 0;
            const canDo = Math.floor(have / need[k]);
            if (canDo < maxByTroop) { maxByTroop = canDo; limitingKey = k; }
          }
          if (maxByTroop < targets.length && maxByTroop >= 0) {
            const skipped = targets.length - maxByTroop;
            const limName = limitingKey ? TROOP_LABELS[limitingKey] : 'troops';
            const msg = `Only enough ${limName} for ${maxByTroop} of ${targets.length} targets.\n\n` +
                        `${skipped} targets will remain pending and can be resumed when you have more troops.\n\n` +
                        `Continue with ${maxByTroop} targets?`;
            if (!confirm(msg)) return;
            targets = targets.slice(0, maxByTroop);
          }
        }
      }

      const s0 = window.TC.state();
      const heartbeatBefore = s0.heartbeat?.enabled === true;
      fmPatch(fm => {
        fm._heartbeatWasEnabled = heartbeatBefore;
        fm._navigateToTt0AfterRun = false;
        fm._endOfRunHandled = false;
        fm._pendingFinalReport = null;
      });

      if (!heartbeatBefore && fmState()?.settings?.autoEnableHeartbeat !== false) {
        try { window.TC.heartbeat.setOn(true); } catch (e) {}
        window.TC.log?.('farm', 'auto-enabled Heartbeat');
        fmLog('INFO', 'Heartbeat was OFF → auto-enabled');
      } else {
        fmLog('INFO', 'Heartbeat was ON → will stay ON');
      }

      const runId = uid('run');
      const runData = {
        id: runId, sourceVid: String(srcVid),
        listId: l.id, listName: l.name,
        startedAt: now(), planned: targets.length,
        sent: 0, failed: 0, skipped: 0,
        targetIds: targets.map(t => t.id),
        currentTarget: null, currentState: 'preparing',
        troops: { ...l.troops },
        heroFollow: l.heroFollow === true,
        autoFill: l.autoFill || 'fillAvailable',
        listSnapshot: targets.map(t => ({
          id: t.id, name: t.name, x: t.x, y: t.y,
          troops: t.troops || null, distance: t.distance,
          heroFollow: t.heroFollow,
        })),
        _sentSinceCooldown: 0,
        _cooldownThreshold: pickCooldownAttacks(l),
      };

      fmPatch(fm => { fm.runInProgress = runData; fm._activeRunId = runId; });

      // ⭐ nextRotationAt پویا: 60s per task + 2min
      const rotationEstimate = targets.length * ROTATION_PER_TASK_MS + ROTATION_EXTRA_MS;
      window.TC.patch(s => {
        s.heartbeat.nextRotationAt = now() + rotationEstimate;
      });
      fmLog('INFO', `startRun: planned=${targets.length}, rotationEstimate=${Math.round(rotationEstimate/60000)}min`);

      const u = new URL(location.href);
      const isOnRally = u.pathname.includes('build.php')
                     && u.searchParams.get('gid') === '16'
                     && u.searchParams.get('tt') === '2';
      const sameVillage = String(window.TC.village()) === String(srcVid);

      if (isOnRally && sameVillage) {
        enqueueRunTasks(runData);
        renderAll();
        return;
      }

      try { sessionStorage.setItem(PENDING_RUN_KEY, JSON.stringify(runData)); } catch {}
      window.TC.flash?.('Navigating to Send Troops...');
      window.TC.log?.('farm', `startRun → tt=2 (${targets.length} targets)`);
      fmLog('INFO', `startRun → tt=2 (${targets.length} targets)`);
      location.href = `/build.php?id=39&gid=16&tt=2&newdid=${srcVid}`;
    }

    renderAll();
    const poll = setInterval(() => {
      if (!document.body.contains(wrap)) { clearInterval(poll); return; }
      renderProgress(); renderDiag();
    }, 1000);
  }

  // ─────────────────────────────────────────────────────────────
  // Enqueue / resume — v1.7.10 با TTL پویا
  // ─────────────────────────────────────────────────────────────
  function enqueueRunTasks(runData) {
    let count = 0;

    // ⭐ TTL پویا: 45s per task، حداقل 15 دقیقه
    const dynamicTtl = Math.max(
      TTL_MIN_MS,
      runData.listSnapshot.length * TTL_PER_TASK_MS
    );
    const ttlMin = Math.round(dynamicTtl / 60000);
    fmLog('INFO', `enqueueRunTasks: ${runData.listSnapshot.length} tasks, TTL=${ttlMin}min`);

    for (const t of runData.listSnapshot) {
      const bucket = fmState().byVillage[runData.sourceVid];
      const list = bucket?.lists?.find(l => l.id === runData.listId);
      const targetObj = list?.targets?.find(x => x.id === t.id);
      if (targetObj?.invalid === true) {
        fmLog('INFO', `Skipping invalid target in enqueue: ${t.name} (${t.x}|${t.y})`);
        continue;
      }

      const taskId = `fm_${runData.id}_${t.id}`;
      const res = window.TC.enqueue({
        id: taskId,
        plugin: DRIVER_PLUGIN,
        priority: 9,
        villageId: runData.sourceVid,
        target: {
          page: 'build',
          village: runData.sourceVid,
          params: { gid: '16', tt: '2' },
        },
        payload: {
          rotation: true,
          farm: {
            runId: runData.id,
            listId: runData.listId,
            listName: runData.listName,
            sourceVid: runData.sourceVid,
            targetId: t.id,
            targetName: t.name,
            x: t.x, y: t.y,
            troops: t.troops || runData.troops,
            heroFollow: (t.heroFollow !== undefined) ? t.heroFollow : runData.heroFollow,
            autoFill: runData.autoFill,
          },
        },
        ttlMs: dynamicTtl,  // ⭐ پویا
      });
      if (res) count++;
    }
    window.TC.flash?.(`Farm: ${count}/${runData.listSnapshot.length} tasks queued (TTL ${ttlMin}min)`);
    window.TC.log?.('farm', `enqueued ${count} tasks (TTL ${ttlMin}min)`);
    fmLog('INFO', `enqueued ${count} tasks, TTL=${ttlMin}min`);
    window.TC.patch(s => {
      s.heartbeat.nextRotationAt = Math.max(s.heartbeat.nextRotationAt || 0, now() + dynamicTtl);
    });
  }

  function resumeRunIfPending() {
    const fmNow = fmState();
    if (fmNow._endOfRunHandled) {
      fmLog('INFO', 'resumeRunIfPending: endOfRunHandled=true → clearing pending & skip');
      clearPendingRunKey();
      return;
    }
    if (fmNow.runInProgress) {
      const r = fmNow.runInProgress;
      const done = r.sent + r.failed + r.skipped;
      if (done >= r.planned) {
        fmLog('INFO', 'resumeRunIfPending: runInProgress done → clearing pending & skip');
        clearPendingRunKey();
        return;
      }
    }
    let raw;
    try { raw = sessionStorage.getItem(PENDING_RUN_KEY); } catch { return; }
    if (!raw) return;
    let runData;
    try { runData = JSON.parse(raw); } catch {
      clearPendingRunKey();
      return;
    }
    if (fmNow._activeRunId && fmNow._activeRunId !== runData.id) {
      fmLog('WARN', `resumeRunIfPending: activeRunId mismatch (${fmNow._activeRunId} !== ${runData.id}) → skip`);
      clearPendingRunKey();
      return;
    }
    const u = new URL(location.href);
    const isOnRally = u.pathname.includes('build.php')
                   && u.searchParams.get('gid') === '16'
                   && u.searchParams.get('tt') === '2';
    const sameVillage = String(window.TC.village()) === String(runData.sourceVid);
    if (!isOnRally || !sameVillage) {
      try { location.href = `/build.php?id=39&gid=16&tt=2&newdid=${runData.sourceVid}`; } catch {}
      return;
    }
    const s = window.TC.state();
    const hasFarmTasks = (s.tasks || []).some(t => t.payload?.farm?.runId === runData.id)
                     || (s.currentJob?.payload?.farm?.runId === runData.id);
    if (hasFarmTasks) {
      clearPendingRunKey();
      return;
    }
    const done = (runData.sent || 0) + (runData.failed || 0) + (runData.skipped || 0);
    if (done >= (runData.planned || 0) && runData.planned > 0) {
      fmLog('INFO', 'resumeRunIfPending: all done → clearing pending & skip');
      clearPendingRunKey();
      return;
    }
    clearPendingRunKey();
    fmPatch(fm => { fm.runInProgress = runData; fm._activeRunId = runData.id; });
    window.TC.log?.('farm', `resume on tt=2 → enqueue ${runData.listSnapshot.length}`);
    enqueueRunTasks(runData);
  }

  // ─────────────────────────────────────────────────────────────
  // Snapshot
  // ─────────────────────────────────────────────────────────────
  function readOwnTroopsSnapshot() {
    const tables = $$('.rallyPointOverviewContainer table.troop_details');
    const out = {};
    for (const tbl of tables) {
      const role = tbl.querySelector('thead td.troopHeadline a')?.textContent || '';
      if (!/Own troops/i.test(role)) continue;
      const vid = tbl.dataset.did || tbl.dataset.vid;
      if (!vid) continue;
      const cells = $$('tbody.units.last tr td.unit', tbl);
      const troops = {};
      const order = ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10','t11'];
      for (let i = 0; i < order.length; i++) {
        const c = cells[i];
        troops[order[i]] = c ? parseInt(c.textContent.replace(/[^\d]/g,''), 10) || 0 : 0;
      }
      out[String(vid)] = troops;
    }
    return out;
  }
  function captureSnapshot() {
    if (!isRallyOverview()) return null;
    const snap = readOwnTroopsSnapshot();
    const srcVid = window.TC.village();
    if (!srcVid || !snap[String(srcVid)]) return null;
    fmPatch(fm => {
      const b = fm.byVillage[String(srcVid)];
      if (b) { b.snapshot = snap[String(srcVid)]; b.snapshotAt = now(); }
    });
    return snap[String(srcVid)];
  }

  // ─────────────────────────────────────────────────────────────
  // Core handler
  // ─────────────────────────────────────────────────────────────
  function detectSendTroopsForm() {
    return !!(document.querySelector('#troops input[name="troop[t1]"]') && document.getElementById('ok'));
  }
  function detectConfirmForm() {
    return !!document.getElementById('confirmSendTroops');
  }
  function detectInvalidVillageError() {
    const errEls = $$('.error, .errorMessage, .message.error, [class*="error"], [class*="Error"]');
    for (const el of errEls) {
      const t = (el.textContent || '').toLowerCase();
      if (t.includes('no village at these coordinates') ||
          t.includes('there is no village') ||
          t.includes('village not found')) {
        return true;
      }
    }
    const body = document.body.textContent || '';
    if (/there is no village at these coordinates/i.test(body)) return true;
    return false;
  }

  async function handleFarmArrive({ job, target, payload }) {
    const farm = payload.farm;
    if (!farm) return { type: 'fail', reason: 'no-farm-payload' };

    const u = new URL(location.href);
    const isRallySend = u.searchParams.get('gid') === '16' && u.searchParams.get('tt') === '2';

    const fmGuard = fmState();
    if (fmGuard._endOfRunHandled) {
      fmLog('WARN', `handleFarmArrive: endOfRunHandled=true → ignoring task ${farm.targetName}`);
      return { type: 'done', reason: 'end-of-run-guard' };
    }

    if (isCooldownActive()) {
      return { type: 'wait', delayMs: 500, reason: 'cool-down-active' };
    }

    if (isRallySend && detectInvalidVillageError()) {
      fmLog('INFO', `Invalid village: (${farm.x}|${farm.y}) → marking INVALID`);
      const report = markTargetInvalidAndMaybeFinish(farm, 'no-village-at-coordinates');
      showToast(`Invalid: (${farm.x}|${farm.y}) — disabled`, 'warn');

      const fmAfter = fmState();
      if (fmAfter._navigateToTt0AfterRun || report) {
        fmLog('INFO', 'Run finished after invalid — navigating to tt=0');
        try { location.href = `/build.php?id=39&gid=16&tt=0&newdid=${farm.sourceVid}`; } catch (e) {}
      } else {
        fmLog('INFO', 'Navigating to tt=2 to reset form');
        try { location.href = `/build.php?id=39&gid=16&tt=2&newdid=${farm.sourceVid}`; } catch (e) {}
      }
      return { type: 'done', reason: 'invalid-village' };
    }

    if (!isRallySend) {
      try { location.href = `/build.php?id=39&gid=16&tt=2&newdid=${farm.sourceVid}`; } catch (e) {}
      return { type: 'wait', delayMs: 2500, reason: 'navigating-to-tt2' };
    }

    const sendFormExists = detectSendTroopsForm();
    const confirmFormExists = detectConfirmForm();

    if (sendFormExists && !confirmFormExists) {
      const fmNow = fmState();
      const list = fmNow.byVillage?.[farm.sourceVid]?.lists?.find(l => l.id === farm.listId);
      const run = fmNow.runInProgress;

      if (list?.cooldown?.enabled !== false && run) {
        const sentSince = run._sentSinceCooldown || 0;
        const threshold = run._cooldownThreshold || pickCooldownAttacks(list);

        if (sentSince >= threshold) {
          const durationMs = pickCooldownDelayMs(list);
          fmPatch(fm => {
            if (fm.runInProgress) {
              fm.runInProgress._sentSinceCooldown = 0;
              fm.runInProgress._cooldownThreshold = pickCooldownAttacks(list);
            }
          });
          fmLog('INFO', `Cooldown triggered BEFORE task ${farm.targetName} (sent=${sentSince}, threshold=${threshold})`);
          openCooldownModal(durationMs, list.name);
          return { type: 'wait', delayMs: 500, reason: 'starting-cool-down' };
        }
      }
    }

    fmPatch(fm => {
      if (fm.runInProgress) {
        fm.runInProgress.currentTarget = farm.targetName;
        fm.runInProgress.currentState = 'filling';
      }
    });

    if (confirmFormExists) {
      const confirmBtn = document.getElementById('confirmSendTroops');
      if (!confirmBtn) return { type: 'wait', delayMs: 500, reason: 'no-confirm-btn' };

      const report = applyResultAndMaybeFinish(farm, 'sent', null, { submittedAt: now() });
      fmLog('INFO', 'confirm clicked: ' + farm.targetName);

      window.TC.patch(s => {
        s.heartbeat.nextRotationAt = Math.max(s.heartbeat.nextRotationAt || 0, now() + 5 * 60 * 1000);
      });

      await humanClickNoNav(confirmBtn);

      const fmAfter = fmState();
      if (fmAfter._navigateToTt0AfterRun || report || !fmAfter.runInProgress) {
        fmLog('INFO', 'Run finished after last confirm — navigating to tt=0');
        try { location.href = `/build.php?id=39&gid=16&tt=0&newdid=${farm.sourceVid}`; } catch (e) {}
        return { type: 'done', reason: 'confirmed-and-finished' };
      }
      return { type: 'done', reason: 'confirmed' };
    }

    if (!sendFormExists) {
      return { type: 'wait', delayMs: 1000, reason: 'no-form' };
    }

    const plan = computeTroopsToSend(farm);
    if (!plan.ok) {
      const reason = plan.reason || 'insufficient-troops';

      if (reason === 'no-troops-available') {
        fmLog('WARN', `No troops available for ${farm.targetName} → STOPPING run`);
        const report = stopRunDueToNoTroops(farm, reason);
        showToast('⏸ Out of troops — run paused', 'warn');

        try { location.href = `/build.php?id=39&gid=16&tt=0&newdid=${farm.sourceVid}`; } catch (e) {}
        return { type: 'done', reason: 'stopped-no-troops' };
      }

      const report = applyResultAndMaybeFinish(farm, 'skipped', reason);
      fmLog('INFO', 'skip ' + farm.targetName + ': ' + reason);

      const fmSkip = fmState();
      if (fmSkip._navigateToTt0AfterRun || report || !fmSkip.runInProgress) {
        try { location.href = `/build.php?id=39&gid=16&tt=0&newdid=${farm.sourceVid}`; } catch (e) {}
        return { type: 'done', reason: 'skipped-and-finished' };
      }
      return { type: 'done', reason: 'skipped:' + reason };
    }

    const troopKeys = Object.keys(TROOP_LABELS).filter(k => (plan.troops[k] | 0) > 0 || k === 't11');
    for (const k of troopKeys) {
      const inp = document.querySelector(`#troops input[name="troop[${k}]"]`);
      if (!inp || inp.disabled) continue;
      await humanType(inp, String(plan.troops[k] | 0));
      await humanTabToNext(inp);
    }

    const xInp = document.getElementById('xCoordInput');
    const yInp = document.getElementById('yCoordInput');
    if (!xInp || !yInp) return { type: 'fail', reason: 'no-coords-input' };
    await humanType(xInp, String(farm.x));
    await humanType(yInp, String(farm.y));

    const raidRadio = document.querySelector('input[name="eventType"][value="4"]');
    if (!raidRadio) return { type: 'fail', reason: 'no-raid-radio' };
    if (!raidRadio.checked) await humanClickNoNav(raidRadio);

    await delay(logNormal(200, 500));
    if (parseInt(xInp.value, 10) !== farm.x || parseInt(yInp.value, 10) !== farm.y) {
      return { type: 'fail', reason: 'coords-mismatch' };
    }

    const okBtn = document.getElementById('ok');
    if (!okBtn) return { type: 'fail', reason: 'no-ok-btn' };

    fmPatch(fm => { if (fm.runInProgress) fm.runInProgress.currentState = 'submitting'; });
    fmLog('INFO', 'submitting ' + farm.targetName + ' → awaiting confirm');
    await humanClickNoNav(okBtn);

    return { type: 'transition', state: 'EXECUTING' };
  }

  function installHeartbeatWrapper(TC) {
    TC.registerPlugin('Heartbeat', {
      onArrive: async (ctx) => {
        if (ctx.payload?.farm) return await handleFarmArrive(ctx);
        TC.captureCurrentVillage();
        return { type: 'done', reason: 'captured' };
      }
    });
    TC.log?.('sys', `Heartbeat wrapper installed (v${FM_VERSION})`);
    fmLog('INFO', 'Heartbeat wrapper installed');
  }

  function findActiveFarmTask() {
    const s = window.TC.state();
    const tasks = s.tasks || [];
    const n = now();
    return tasks.find(t => t.payload?.farm && t.expiresAt > n)
        || (s.currentJob?.payload?.farm ? s.currentJob : null);
  }
  function installFreezeOverride(TC) {
    TC.freezeOverride.register(FM_NS, (pt, u) => {
      if (_cooldownActive) return true;
      if (pt !== 'build') return false;
      if (u.searchParams.get('gid') !== '16') return false;
      if (u.searchParams.get('tt') !== '2') return false;
      return !!findActiveFarmTask();
    }, 'FarmManager raid in progress');
  }

  // ─────────────────────────────────────────────────────────────
  // Debug tab
  // ─────────────────────────────────────────────────────────────
  function registerFarmDebugTab(TC) {
    if (!TC.tests?.register) return;
    TC.tests.register('farm', {
      label: 'Farm',
      render: renderFarmDebug,
      onMount: bindFarmDebug,
    });
  }
  function renderFarmDebug() {
    const fm = fmState();
    if (!fm) return '<div style="padding:8px;color:#888;">No FarmManager state</div>';
    const s = window.TC.state();
    const curVid = window.TC.village();
    const bucket = fm.byVillage[String(curVid)] || { lists: [], snapshot: null };
    const run = fm.runInProgress;
    const job = s.currentJob;
    const farmTasks = (s.tasks || []).filter(t => t.payload?.farm);
    const pendingKey = sessionStorage.getItem(PENDING_RUN_KEY);

    let html = '';
    html += `
      <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;font-size:9px;">
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">v${FM_VERSION}</span>
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">vid: ${esc(curVid || '?')}</span>
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">lists: ${bucket.lists?.length || 0}</span>
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">queued: ${farmTasks.length}</span>
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">HB: ${s.heartbeat?.enabled ? 'ON' : 'OFF'}</span>
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">panels: ${document.querySelectorAll('.fm-panel').length}</span>
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">pending: ${pendingKey ? 'YES' : 'no'}</span>
        <span style="padding:2px 6px;background:rgba(58,74,128,.15);border-radius:8px;">hbWas: ${fm._heartbeatWasEnabled === null ? 'null' : fm._heartbeatWasEnabled}</span>
        ${_cooldownActive ? `<span style="padding:2px 6px;background:rgba(255,180,80,.45);border-radius:8px;font-weight:bold;">CD: ${_cooldownRemaining}s</span>` : ''}
        ${job?.payload?.farm ? `<span style="padding:2px 6px;background:rgba(255,180,80,.45);border-radius:8px;font-weight:bold;">JOB: ${esc(job.state || '?')}</span>` : ''}
      </div>
    `;
    html += `<div style="margin-top:6px;padding:6px 8px;background:rgba(255,255,255,.5);border-radius:4px;border-left:3px solid #3a4a80;">
      <div style="font-weight:bold;color:#3a4a80;font-size:10px;">Page</div>
      <div style="font-family:monospace;font-size:9px;margin-top:2px;">
        page=${esc(window.TC.page())} | gid=${esc(new URL(location.href).searchParams.get('gid')||'-')} | tt=${esc(new URL(location.href).searchParams.get('tt')||'-')}<br>
        form1=${detectSendTroopsForm()} | form2=${detectConfirmForm()}
      </div>
    </div>`;
    if (run) {
      html += `<div style="margin-top:6px;padding:6px 8px;background:rgba(120,200,80,.15);border-radius:4px;border-left:3px solid #4a7a30;">
        <div style="font-weight:bold;color:#1a5a10;font-size:10px;">Run ${esc(run.id.slice(-6))}</div>
        <div style="font-family:monospace;font-size:9px;margin-top:2px;">
          ${run.sent}/${run.planned} sent · ${run.failed} failed · ${run.skipped} skipped<br>
          current: ${esc(run.currentTarget || '-')} [${esc(run.currentState || '-')}]<br>
          cooldown counter: ${run._sentSinceCooldown || 0}/${run._cooldownThreshold || '?'}
        </div>
      </div>`;
    }
    if (fm._pendingFinalReport) {
      html += `<div style="margin-top:6px;padding:6px 8px;background:rgba(200,140,60,.15);border-radius:4px;border-left:3px solid #a06020;">
        <div style="font-weight:bold;color:#7a4020;font-size:10px;">Pending Final Report</div>
        <div style="font-family:monospace;font-size:9px;margin-top:2px;">
          ${fm._pendingFinalReport.sent} sent · ${fm._pendingFinalReport.failed} failed · ${fm._pendingFinalReport.skipped} skipped<br>
          stoppedByTroops=${!!fm._pendingFinalReport.stoppedByTroops}<br>
          navigateToTt0=${fm._navigateToTt0AfterRun} · endOfRun=${fm._endOfRunHandled}
        </div>
      </div>`;
    }
    html += `
      <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;font-size:9px;">
        <span data-fm-action="copy" style="cursor:pointer;padding:2px 6px;background:rgba(58,74,128,.20);border-radius:3px;">copy state</span>
        <span data-fm-action="copylog" style="cursor:pointer;padding:2px 6px;background:rgba(58,74,128,.20);border-radius:3px;">📋 copy log</span>
        <span data-fm-action="clearlog" style="cursor:pointer;padding:2px 6px;background:rgba(200,140,60,.30);border-radius:3px;">🗑 clear log</span>
        <span data-fm-action="clear-run" style="cursor:pointer;padding:2px 6px;background:rgba(200,64,48,.30);border-radius:3px;">clear run</span>
        <span data-fm-action="cancel-tasks" style="cursor:pointer;padding:2px 6px;background:rgba(200,64,48,.30);border-radius:3px;">cancel tasks</span>
        <span data-fm-action="reset-rot" style="cursor:pointer;padding:2px 6px;background:rgba(120,90,180,.30);border-radius:3px;">reset rotation</span>
        <span data-fm-action="clear-cd" style="cursor:pointer;padding:2px 6px;background:rgba(200,140,60,.30);border-radius:3px;">clear cooldown</span>
        <span data-fm-action="clear-pending" style="cursor:pointer;padding:2px 6px;background:rgba(200,64,48,.30);border-radius:3px;">clear pending key</span>
      </div>
    `;
    return html;
  }
  function bindFarmDebug(root) {
    root.querySelectorAll('[data-fm-action]').forEach(el => {
      el.onclick = () => {
        const act = el.dataset.fmAction;
        if (act === 'copy') {
          const txt = JSON.stringify(fmState(), null, 2);
          navigator.clipboard.writeText(txt).then(() => window.TC.flash?.('copied')).catch(() => console.log(txt));
        } else if (act === 'copylog') {
          copyFullLog();
        } else if (act === 'clearlog') {
          clearLogBuffer();
        } else if (act === 'clear-run') {
          fmPatch(fm => { fm.runInProgress = null; fm._pendingFinalReport = null; fm._navigateToTt0AfterRun = false; fm._activeRunId = null; fm._heartbeatWasEnabled = null; });
          clearPendingRunKey();
          window.TC.flash?.('run cleared');
        } else if (act === 'cancel-tasks') {
          cancelCurrentRun();
          window.TC.flash?.('tasks cancelled');
        } else if (act === 'reset-rot') {
          window.TC.patch(s => { s.heartbeat.nextRotationAt = now() + 5000; });
          window.TC.flash?.('rotation reset');
        } else if (act === 'clear-cd') {
          closeCooldownModal();
          clearCooldownFreeze();
          window.TC.flash?.('cooldown cleared');
        } else if (act === 'clear-pending') {
          clearPendingRunKey();
          window.TC.flash?.('pending key cleared');
        }
      };
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Styles + live
  // ─────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('fm-style')) return;
    const st = document.createElement('style');
    st.id = 'fm-style';
    st.textContent = `
      .fm-btn { font-family: Verdana, sans-serif; }
      .fm-target:hover { background: rgba(200,220,240,.25) !important; }
      .fm-troop-editor input, .fm-map-troops input, .fm-edit-troops input { -moz-appearance: textfield; }
      .fm-troop-editor input::-webkit-outer-spin-button,
      .fm-troop-editor input::-webkit-inner-spin-button,
      .fm-map-troops input::-webkit-outer-spin-button,
      .fm-map-troops input::-webkit-inner-spin-button,
      .fm-edit-troops input::-webkit-outer-spin-button,
      .fm-edit-troops input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .fm-troop-editor img.unit,
      .fm-map-troops img.unit,
      .fm-target img.unit,
      .fm-edit-troops img.unit { vertical-align: middle; width: 16px; height: 16px; }
      .fm-target a { text-decoration: none; }
      .fm-target a:hover { text-decoration: underline; }
      .fm-tab input { font-family: Verdana, sans-serif; }
    `;
    document.head.appendChild(st);
  }

  let _lastMapDialogSig = '';
  function mapDialogSignature() {
    const t = document.querySelector('.dialogWrapper[data-context="map"] #tileDetails h1');
    return t ? t.textContent.slice(0, 80) : '';
  }

  let _mapObserverAttached = false;
  function attachMapObserver() {
    if (_mapObserverAttached) return;
    _mapObserverAttached = true;
    let _pending = false;
    const obs = new MutationObserver(() => {
      if (_pending) return;
      _pending = true;
      setTimeout(() => {
        _pending = false;
        if (document.querySelector('.dialogWrapper[data-context="map"] #tileDetails')) {
          injectFarmBoxOnMap();
        }
      }, 200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  let _rallyObserverAttached = false;
  function attachRallyObserver() {
    if (_rallyObserverAttached) return;
    _rallyObserverAttached = true;
    let _pending = false;
    const obs = new MutationObserver(() => {
      if (_pending) return;
      _pending = true;
      setTimeout(() => {
        _pending = false;
        if (shouldShowFarmPanel()) injectFarmPanel();
      }, 200);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function live() {
    try {
      const sig = mapDialogSignature();
      if (sig && sig !== _lastMapDialogSig) {
        _lastMapDialogSig = sig;
        setTimeout(injectFarmBoxOnMap, 80);
      } else if (sig === '') {
        _lastMapDialogSig = '';
      }
      injectFarmBoxOnMap();
      injectFarmPanel();
      checkPendingReport();
      if (isRallyOverview()) captureSnapshot();
      if (isRallySend()) resumeRunIfPending();
    } catch (e) { fmLog('ERROR', 'live error', e); }
    setTimeout(live, POLL_MS);
  }

  // ─────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────
  (async function boot() {
    fmLog('INFO', 'booting v' + FM_VERSION);
    const TC = await waitForTC(25000);
    if (!TC) {
      fmLog('WARN', 'Nova-HB not found');
      return;
    }
    fmLog('INFO', 'Nova found, registering...');
    injectStyles();

    migrateFromNovaState(TC);
    fmPatch(fm => { fm.enabled = true; });

    installHeartbeatWrapper(TC);
    installFreezeOverride(TC);
    registerFarmDebugTab(TC);

    window.FM = {
      version: FM_VERSION,
      state: fmState,
      patch: fmPatch,
      storageKey: FM_STORAGE_KEY,
      log: getFullLog,
      copyLog: copyFullLog,
      clearLog: clearLogBuffer,
      logBuffer: () => _logBuffer.slice(),
      start: (mode) => {
        const btn = document.querySelector(mode === 'resume' ? '.fm-btn-resume' : '.fm-btn-start');
        if (btn) btn.click();
      },
      snapshot: () => fmState()?.byVillage?.[TC.village()]?.snapshot,
      readSnapshot: captureSnapshot,
      export: (listId, onlySelected) => exportListCompact(TC.village(), listId, onlySelected),
      import: (text) => importListFromText(text, TC.village()),
      importTo: (text, mode, listId, newName) => importListToTarget(text, TC.village(), mode, listId, newName),
      previewImport: (text, mode, listId) => previewImport(text, TC.village(), mode, listId),
      backup: makeBackup,
      sound: (on) => { fmPatch(fm => { fm.settings.soundEnabled = !!on; }); if (on) playAlarm(); },
      heartbeatRestore: (on) => { fmPatch(fm => { fm.settings.restoreHeartbeatAfterRun = !!on; }); },
      cooldown: {
        isActive: isCooldownActive,
        remaining: () => _cooldownRemaining,
        clear: () => { closeCooldownModal(); clearCooldownFreeze(); },
      },
      panelCount: () => document.querySelectorAll('.fm-panel').length,
      removeStalePanels: () => {
        document.querySelectorAll('.fm-panel').forEach(p => {
          if (p !== _fmPanelRef) p.remove();
        });
      },
      clearPendingRunKey: clearPendingRunKey,
      restoreHbNow: restoreHeartbeatAfterRun,
      forceNavigateTt0: () => {
        const fm = fmState();
        let sid = fm.runInProgress?.sourceVid || fm._pendingFinalReport?.sourceVid || String(TC.village());
        try { location.href = `/build.php?id=39&gid=16&tt=0&newdid=${sid}`; } catch (e) {}
      },
      diag: () => {
        const s = TC.state();
        const fm = fmState();
        let pendingKeyRaw = null;
        try { pendingKeyRaw = sessionStorage.getItem(PENDING_RUN_KEY); } catch (e) {}
        return {
          version: FM_VERSION,
          heartbeatOn: s.heartbeat?.enabled,
          heartbeatFrozen: s.heartbeat?._frozenAt ? s.heartbeat._frozenReason : null,
          nextRotationAt: s.heartbeat?.nextRotationAt,
          currentJob: s.currentJob ? `${s.currentJob.plugin}/${s.currentJob.state}` : null,
          queuedFarm: (s.tasks || []).filter(t => t.payload?.farm).length,
          allTasks: (s.tasks || []).length,
          page: TC.page(),
          tt: new URL(location.href).searchParams.get('tt'),
          storageVillages: Object.keys(fm.byVillage || {}).length,
          backups: (fm.backups || []).length,
          cooldownActive: _cooldownActive,
          cooldownRemaining: _cooldownRemaining,
          pendingFinalReport: !!fm._pendingFinalReport,
          navigateToTt0AfterRun: !!fm._navigateToTt0AfterRun,
          endOfRunHandled: !!fm._endOfRunHandled,
          activeRunId: fm._activeRunId,
          heartbeatWasEnabled: fm._heartbeatWasEnabled,
          pendingRunKeyPresent: !!pendingKeyRaw,
          fmPanelPresent: !!document.querySelector('.fm-panel'),
          fmPanelCount: document.querySelectorAll('.fm-panel').length,
          fmPanelRefConnected: _fmPanelRef ? _fmPanelRef.isConnected : null,
          mapBoxPresent: !!document.querySelector('.fm-map-box'),
          logBufferSize: _logBuffer.length,
          runInProgress: fm.runInProgress ? {
            id: fm.runInProgress.id,
            sent: fm.runInProgress.sent,
            failed: fm.runInProgress.failed,
            skipped: fm.runInProgress.skipped,
            planned: fm.runInProgress.planned,
            sentSinceCooldown: fm.runInProgress._sentSinceCooldown || 0,
            cooldownThreshold: fm.runInProgress._cooldownThreshold || 0,
          } : null,
        };
      },
      clearFarmData: () => {
        if (!confirm('Clear Farm Manager data (Nova untouched)?')) return;
        try { localStorage.removeItem(FM_STORAGE_KEY); } catch {}
        clearPendingRunKey();
        location.reload();
      },
      clearNovaState: () => {
        if (!confirm('Clear Nova HB state (Farm data preserved)?')) return;
        try { localStorage.removeItem('travian_nova_hb_v1'); } catch {}
        try { sessionStorage.clear(); } catch {}
        location.reload();
      },
    };

    attachMapObserver();
    attachRallyObserver();
    live();
    fmLog('INFO', 'ready v' + FM_VERSION);
  })();

})();