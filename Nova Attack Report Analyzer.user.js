// ==UserScript==
// @name         Nova Attack Report Analyzer (1.0.0)
// @name:fa      نوا آنالایزر گزارش حملات
// @namespace    https://github.com/Logical-Developer/Nova-Attack-Report-Analyzer
// @version      1.0.0
// @description  Analyze Travian offensive reports. Build farm list from full-loot raids (Theutates Thunder) and blacklist villages with losses. Copy to clipboard or download as JSON.
// @description:fa  تحلیل گزارش‌های حمله تراوین. ساخت فارم لیست از غارت‌های کامل و بلک‌لیست دهکده‌های با تلفات.
// @author       Nova
// @match        *://*.travian.com/report/offensive*
// @grant        none
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/Logical-Developer/Nova-Attack-Report-Analyzer
// @supportURL   https://github.com/Logical-Developer/Nova-Attack-Report-Analyzer/issues
// @updateURL    https://raw.githubusercontent.com/Logical-Developer/Nova-Attack-Report-Analyzer/main/Nova-Attack-Report-Analyzer.user.js
// @downloadURL  https://raw.githubusercontent.com/Logical-Developer/Nova-Attack-Report-Analyzer/main/Nova-Attack-Report-Analyzer.user.js
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    debug: true,
    delayBetweenRequests: 600,
    delayBetweenCoordinateFetches: 400,
    storageKey: "nova_analyzer_cache_v1",
    coordsCacheKey: "nova_coords_cache_v1",
    fullLootThreshold: 0.95,
    farmListName: "Nova Full Loot",
    defaultTT: 3,
  };

  // ============================================================
  // THEME (matches other Nova plugins)
  // ============================================================
  const THEME = {
    bgPanel: "linear-gradient(180deg,#f9fbff,#e8eff9)",
    bgSection: "rgba(255,255,255,.55)",
    border: "#8a9ac0",
    borderLight: "#c0cde0",
    text: "#1a2050",
    textMuted: "#5a6a80",
    textDim: "#8a9aB0",
    titleColor: "#2a4a70",
    green: "linear-gradient(180deg,#7ab04a,#4a7a30)",
    greenBorder: "#2a5a10",
    blue: "linear-gradient(180deg,#6a9ee8,#3060b0)",
    blueBorder: "#204080",
    orange: "linear-gradient(180deg,#d09030,#a06020)",
    orangeBorder: "#603010",
    red: "linear-gradient(180deg,#d9534f,#a03020)",
    redBorder: "#601010",
    gray: "#e0e8f0",
    grayBorder: "#8a9ac0",
    cyan: "linear-gradient(180deg,#5bc0de,#3a99b8)",
    cyanBorder: "#1a6070",
  };

  // ============================================================
  // UTILS
  // ============================================================

  function log(...args) {
    if (CONFIG.debug) console.log("[Nova Analyzer]", ...args);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitForElement(selector, callback, interval = 500, timeout = 15000) {
    const startTime = Date.now();
    const timer = setInterval(() => {
      const element = document.querySelector(selector);
      if (element) {
        clearInterval(timer);
        callback(element);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(timer);
        log(`Timeout: ${selector}`);
      }
    }, interval);
  }

  // ============================================================
  // STORAGE
  // ============================================================

  function loadCache() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      return raw ? JSON.parse(raw) : { lastAnalysis: null, timestamp: null };
    } catch (e) {
      return { lastAnalysis: null, timestamp: null };
    }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(
        CONFIG.storageKey,
        JSON.stringify({
          lastAnalysis: data,
          timestamp: Date.now(),
        }),
      );
    } catch (e) {
      log("Failed to save cache:", e);
    }
  }

  function clearCache() {
    localStorage.removeItem(CONFIG.storageKey);
    log("Cache cleared.");
  }

  function loadCoordsCache() {
    try {
      const raw = localStorage.getItem(CONFIG.coordsCacheKey);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveCoordsCache(cache) {
    try {
      localStorage.setItem(CONFIG.coordsCacheKey, JSON.stringify(cache));
    } catch (e) {
      log("Failed to save coords cache:", e);
    }
  }

  // ============================================================
  // UI
  // ============================================================

  function injectStyles() {
    if (document.getElementById("nova-analyzer-styles")) return;
    const st = document.createElement("style");
    st.id = "nova-analyzer-styles";
    st.textContent = `
            .nova-btn {
                cursor: pointer; touch-action: manipulation;
                border-radius: 5px; font-weight: bold;
                font-family: Verdana, sans-serif;
                transition: filter .15s ease, transform .08s ease;
                display: inline-flex; align-items: center; justify-content: center;
                gap: 5px; white-space: nowrap;
                box-sizing: border-box;
            }
            .nova-btn:hover { filter: brightness(1.08); }
            .nova-btn:active { transform: translateY(1px); filter: brightness(.95); }
            .nova-btn:disabled { opacity: .55; cursor: not-allowed; filter: none; }
            .nova-btn-icon { font-size: 14px; line-height: 1; }
            .nova-toast {
                position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
                background: linear-gradient(180deg,#ffe9a8,#f0c860);
                border: 2px solid #7a5c30; border-radius: 8px;
                padding: 10px 18px; color: #5a2a08; font-weight: bold;
                font-size: 13px; z-index: 2147483647;
                box-shadow: 0 6px 20px rgba(0,0,0,.35);
                font-family: Verdana, sans-serif;
                max-width: 90vw; word-wrap: break-word;
                text-align: center; box-sizing: border-box;
                animation: novaToastIn .25s ease-out;
            }
            @keyframes novaToastIn {
                from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                to { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
            .nova-toast.success { background: linear-gradient(180deg,#d0f0b0,#8ac060); border-color: #4a7a30; color: #2a4a10; }
            .nova-toast.error { background: linear-gradient(180deg,#f0c0b0,#d08070); border-color: #a03020; color: #5a1010; }
            .nova-toast.info { background: linear-gradient(180deg,#c0dff0,#80b0d0); border-color: #3060a0; color: #1a3050; }
        `;
    document.head.appendChild(st);
  }

  function showToast(message, type = "", duration = 2200) {
    injectStyles();
    const existing = document.querySelector(".nova-toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.className = `nova-toast ${type}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .3s ease";
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  function createTestBox() {
    const boxId = "nova-analyzer-box";
    if (document.getElementById(boxId)) return;

    const box = document.createElement("div");
    box.id = boxId;
    box.style.cssText = `
            background: ${THEME.bgPanel};
            border: 2px solid ${THEME.border};
            border-radius: 10px;
            padding: 14px;
            margin-bottom: 14px;
            color: ${THEME.text};
            font-family: Verdana, sans-serif;
            font-size: 13px;
            box-shadow: 0 4px 14px rgba(0,0,0,.15);
            box-sizing: border-box;
        `;

    box.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
                <span style="font-weight:bold;font-size:16px;color:${THEME.titleColor};">🎯 Nova Attack Report Analyzer</span>
                <span style="font-size:10px;color:${THEME.textMuted};background:rgba(255,255,255,.6);padding:2px 7px;border-radius:10px;">v1.0.0</span>
            </div>

            <div style="margin-bottom:12px;padding:10px;background:${THEME.bgSection};border:1px solid ${THEME.borderLight};border-radius:6px;">
                <label style="color:${THEME.titleColor};font-weight:bold;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span>⚡ Theutates Thunder (t4) per target:</span>
                    <input type="number" id="nova-tt-count" value="${CONFIG.defaultTT}" min="1" max="9999"
                           style="width:70px;padding:5px 8px;font-size:14px;border:1px solid ${THEME.border};border-radius:5px;text-align:center;font-weight:bold;">
                </label>
                <div style="color:${THEME.textMuted};font-size:11px;margin-top:5px;line-height:1.4;">
                    Default is 3. Other troops (t1-t3, t5-t11) will be 0.
                </div>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
                <button id="nova-start-button" class="nova-btn" style="
                    background:${THEME.green};color:#fff;border:1px solid ${THEME.greenBorder};
                    padding:9px 16px;font-size:13px;
                ">
                    <span class="nova-btn-icon">▶</span> Start Analysis
                </button>
                <button id="nova-load-cache-button" class="nova-btn" style="
                    background:${THEME.blue};color:#fff;border:1px solid ${THEME.blueBorder};
                    padding:9px 16px;font-size:13px;
                ">
                    <span class="nova-btn-icon">↺</span> Load Cache
                </button>
                <button id="nova-clear-button" class="nova-btn" style="
                    background:${THEME.gray};color:${THEME.text};border:1px solid ${THEME.grayBorder};
                    padding:9px 14px;font-size:12px;
                ">
                    <span class="nova-btn-icon">🗑</span> Clear Cache
                </button>
                <span id="nova-progress" style="margin-left:auto;color:${THEME.titleColor};font-size:12px;font-weight:bold;align-self:center;"></span>
            </div>

            <div id="nova-result-buttons" style="display:none;flex-wrap:wrap;gap:6px;margin-bottom:12px;padding:10px;background:rgba(255,255,255,.5);border:1px dashed ${THEME.borderLight};border-radius:6px;">
                <div style="width:100%;font-size:11px;color:${THEME.textMuted};margin-bottom:6px;font-weight:bold;">
                    📋 Copy to clipboard (paste directly in Farm Manager):
                </div>
                <button id="nova-copy-farm-button" class="nova-btn" style="
                    background:${THEME.cyan};color:#fff;border:1px solid ${THEME.cyanBorder};
                    padding:8px 14px;font-size:12px;
                ">
                    <span class="nova-btn-icon">📋</span> Copy Farm List
                </button>
                <button id="nova-copy-blacklist-button" class="nova-btn" style="
                    background:${THEME.red};color:#fff;border:1px solid ${THEME.redBorder};
                    padding:8px 14px;font-size:12px;
                ">
                    <span class="nova-btn-icon">📋</span> Copy Blacklist
                </button>

                <div style="width:100%;font-size:11px;color:${THEME.textMuted};margin:8px 0 6px 0;font-weight:bold;">
                    💾 Download as JSON file:
                </div>
                <button id="nova-download-farm-button" class="nova-btn" style="
                    background:${THEME.orange};color:#fff;border:1px solid ${THEME.orangeBorder};
                    padding:8px 14px;font-size:12px;
                ">
                    <span class="nova-btn-icon">⬇</span> Download Farm List
                </button>
                <button id="nova-download-blacklist-button" class="nova-btn" style="
                    background:${THEME.orange};color:#fff;border:1px solid ${THEME.orangeBorder};
                    padding:8px 14px;font-size:12px;
                ">
                    <span class="nova-btn-icon">⬇</span> Download Blacklist
                </button>
            </div>

            <div id="nova-log-output" style="
                background:#1e1e1e;border:1px solid #333;padding:10px;
                border-radius:5px;max-height:280px;overflow-y:auto;
                white-space:pre-wrap;font-family:'Courier New',monospace;font-size:11.5px;
                color:#a9b7c6;line-height:1.5;
            ">Ready. Click "▶ Start Analysis" to begin.</div>
        `;
    return box;
  }

  function appendLog(message) {
    const logOutput = document.getElementById("nova-log-output");
    if (logOutput) {
      const time = new Date().toLocaleTimeString();
      logOutput.textContent += `\n[${time}] ${message}`;
      logOutput.scrollTop = logOutput.scrollHeight;
    }
  }

  function updateProgress(current, total, extra = "") {
    const progress = document.getElementById("nova-progress");
    if (progress) progress.textContent = `(${current}/${total}) ${extra}`;
  }

  function setResultButtonsVisible(visible) {
    const wrap = document.getElementById("nova-result-buttons");
    if (wrap) wrap.style.display = visible ? "flex" : "none";
  }

  function readTroopConfigFromUI() {
    const ttInput = document.getElementById("nova-tt-count");
    const ttCount = ttInput
      ? parseInt(ttInput.value) || CONFIG.defaultTT
      : CONFIG.defaultTT;
    return {
      t1: 0,
      t2: 0,
      t3: 0,
      t4: ttCount,
      t5: 0,
      t6: 0,
      t7: 0,
      t8: 0,
      t9: 0,
      t10: 0,
      t11: 0,
    };
  }

  // ============================================================
  // PHASE 1: READ REPORT LIST
  // ============================================================

  function readReportList() {
    appendLog("Reading report list...");
    const reportRows = document.querySelectorAll("#overview tbody tr");
    if (!reportRows || reportRows.length === 0) {
      appendLog("No reports found.");
      return [];
    }

    const reports = [];
    reportRows.forEach((row) => {
      const checkbox = row.querySelector("input.report");
      const reportId = checkbox ? checkbox.value : null;
      const linkElement = row.querySelector("td.sub div a");
      const reportLink = linkElement ? linkElement.getAttribute("href") : null;
      const reportSubject = linkElement
        ? linkElement.textContent.trim()
        : "Unknown";
      const typeIcon = row.querySelector("img.iReport");

      let reportType = "Unknown";
      if (typeIcon) {
        if (typeIcon.classList.contains("iReport1"))
          reportType = "WonWithoutLosses";
        else if (typeIcon.classList.contains("iReport2"))
          reportType = "WonWithLosses";
        else if (typeIcon.classList.contains("iReport3"))
          reportType = "LostAsAttacker";
      }

      if (reportId && reportLink) {
        reports.push({
          id: reportId,
          link: reportLink,
          subject: reportSubject,
          type: reportType,
        });
      }
    });

    appendLog(`Found ${reports.length} reports.`);
    return reports;
  }

  // ============================================================
  // PHASE 2: FETCH REPORT DETAILS
  // ============================================================

  async function fetchReportDetails(reportId) {
    const url = `/report/offensive?id=${reportId}&s=1`;
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      return parseReportDOM(doc);
    } catch (err) {
      log(`Error fetching report ${reportId}:`, err);
      return { error: err.message, id: reportId };
    }
  }

  // ============================================================
  // PHASE 3: PARSE REPORT DOM
  // ============================================================

  function parseReportDOM(doc) {
    const result = {
      outcome: null,
      attacker: {},
      defender: {},
      bounty: { resources: {}, total: 0, capacity: 0 },
      combatStats: {},
      coordsFromName: null,
    };

    const victoryDiv = doc.querySelector("div.victory");
    if (victoryDiv) {
      if (victoryDiv.querySelector(".lostWon")) result.outcome = "Lost";
      else if (victoryDiv.querySelector(".won")) result.outcome = "Won";
    }

    const attackerRole = doc.querySelector("div.role.attacker");
    if (attackerRole) {
      const playerLink = attackerRole.querySelector(".troopHeadline a.player");
      const villageLink = attackerRole.querySelector(
        ".troopHeadline a.village",
      );
      const allianceLink = attackerRole.querySelector(
        ".troopHeadline span.inline-block a",
      );

      result.attacker = {
        player: playerLink ? playerLink.textContent.trim() : null,
        village: villageLink ? villageLink.textContent.trim() : null,
        villageId: villageLink
          ? extractVillageId(villageLink.getAttribute("href"))
          : null,
        alliance: allianceLink ? allianceLink.textContent.trim() : null,
      };
    }

    const defenderRole = doc.querySelector("div.role.defender");
    if (defenderRole) {
      const playerLink = defenderRole.querySelector(".troopHeadline a.player");
      const villageLink = defenderRole.querySelector(
        ".troopHeadline a.village",
      );
      const allianceLink = defenderRole.querySelector(
        ".troopHeadline span.inline-block a",
      );

      const villageName = villageLink ? villageLink.textContent.trim() : "";
      result.defender = {
        player: playerLink ? playerLink.textContent.trim() : null,
        village: villageName,
        villageId: villageLink
          ? extractVillageId(villageLink.getAttribute("href"))
          : null,
        alliance: allianceLink ? allianceLink.textContent.trim() : null,
      };

      const nameCoords = extractCoordsFromName(villageName);
      if (nameCoords) result.coordsFromName = nameCoords;
    }

    const infoRows = doc.querySelectorAll(".additionalInformation tbody tr");
    infoRows.forEach((row) => {
      const th = row.querySelector("th");
      const td = row.querySelector("td");
      if (!th || !td) return;

      if (th.textContent.trim() === "Bounty") {
        const resValues = td.querySelectorAll(".inlineIcon.resources .value");
        const carryValue = td.querySelector(".inlineIcon.carry .value");
        if (resValues.length >= 4) {
          result.bounty.resources = {
            lumber: parseInt(resValues[0].textContent.replace(/\D/g, "")) || 0,
            clay: parseInt(resValues[1].textContent.replace(/\D/g, "")) || 0,
            iron: parseInt(resValues[2].textContent.replace(/\D/g, "")) || 0,
            crop: parseInt(resValues[3].textContent.replace(/\D/g, "")) || 0,
          };
          result.bounty.total = Object.values(result.bounty.resources).reduce(
            (a, b) => a + b,
            0,
          );
        }
        if (carryValue) {
          const parts = carryValue.textContent.split("/");
          if (parts.length === 2) {
            result.bounty.capacity = parseInt(parts[1].replace(/\D/g, "")) || 0;
          }
        }
      }
    });

    const statRows = doc.querySelectorAll(".combatStatistic tbody tr");
    statRows.forEach((row) => {
      const th = row.querySelector("th");
      const tds = row.querySelectorAll("td .value");
      if (!th || tds.length < 2) return;
      const label = th.textContent.trim();
      const atkVal = parseInt(tds[0].textContent.replace(/\D/g, "")) || 0;
      const defVal = parseInt(tds[1].textContent.replace(/\D/g, "")) || 0;
      result.combatStats[label] = { attacker: atkVal, defender: defVal };
    });

    return result;
  }

  function extractVillageId(url) {
    if (!url) return null;
    const match = url.match(/d=(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  // ============================================================
  // COORDINATE PARSING
  // ============================================================

  function parseCoord(str) {
    if (str === null || str === undefined) return NaN;
    let cleaned = String(str)
      .replace(/\u2212/g, "-")
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
      .replace(/[\u202A\u202B\u202C\u202D\u202E]/g, "")
      .replace(/[^\d-]/g, "");
    const match = cleaned.match(/-?\d+/);
    return match ? parseInt(match[0], 10) : NaN;
  }

  function extractCoordsFromName(name) {
    if (!name) return null;
    const cleanName = name.replace(
      /[\u202A\u202B\u202C\u202D\u202E\u200E\u200F\u2066\u2067\u2068\u2069]/g,
      "",
    );
    const match = cleanName.match(/\(\s*(-?\d+)\s*\|\s*(-?\d+)\s*\)/);
    if (match) {
      return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
    }
    return null;
  }

  // ============================================================
  // FETCH VILLAGE COORDINATES
  // ============================================================

  async function fetchVillageCoordinates(villageId) {
    const coordsCache = loadCoordsCache();
    if (coordsCache[villageId]) {
      log(
        `Coords cache hit for village ${villageId}: (${coordsCache[villageId].x}|${coordsCache[villageId].y})`,
      );
      return coordsCache[villageId];
    }

    const endpoints = [
      `/position.php?d=${villageId}`,
      `/karte.php?d=${villageId}`,
    ];

    for (const url of endpoints) {
      try {
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) continue;
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const coords = extractCoordsFromKarte(doc, villageId);
        if (coords && !isNaN(coords.x) && !isNaN(coords.y)) {
          coordsCache[villageId] = coords;
          saveCoordsCache(coordsCache);
          log(
            `Got coords for ${villageId} via ${url}: (${coords.x}|${coords.y})`,
          );
          return coords;
        }
      } catch (err) {
        log(`Failed ${url}: ${err.message}`);
      }
    }
    return null;
  }

  function extractCoordsFromKarte(doc, targetVillageId) {
    const posX = doc.querySelector('input[name="x"], #xCoord, #x');
    const posY = doc.querySelector('input[name="y"], #yCoord, #y');
    if (posX && posY) {
      const x = parseCoord(posX.value || posX.textContent);
      const y = parseCoord(posY.value || posY.textContent);
      if (!isNaN(x) && !isNaN(y)) return { x, y };
    }

    if (targetVillageId) {
      const targetEl = doc.querySelector(
        `[data-did="${targetVillageId}"], #village${targetVillageId}, .village${targetVillageId}, [data-village-id="${targetVillageId}"]`,
      );
      if (targetEl) {
        const x = parseCoord(
          targetEl.getAttribute("data-x") || targetEl.getAttribute("x"),
        );
        const y = parseCoord(
          targetEl.getAttribute("data-y") || targetEl.getAttribute("y"),
        );
        if (!isNaN(x) && !isNaN(y)) return { x, y };
      }
    }

    if (targetVillageId) {
      const scripts = doc.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent;
        const re = new RegExp(
          `[\\s\\S]{0,200}?d(?:id|ataId)?[\\s:='\"]+${targetVillageId}[\\s\\S]{0,200}?x[\\s:='\"]+(-?\\d+)[\\s\\S]{0,40}?y[\\s:='\"]+(-?\\d+)`,
        );
        const m = text.match(re);
        if (m) return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };

        const re2 = new RegExp(
          `[\\s\\S]{0,200}?d(?:id|ataId)?[\\s:='\"]+${targetVillageId}[\\s\\S]{0,200}?y[\\s:='\"]+(-?\\d+)[\\s\\S]{0,40}?x[\\s:='\"]+(-?\\d+)`,
        );
        const m2 = text.match(re2);
        if (m2) return { x: parseInt(m2[2], 10), y: parseInt(m2[1], 10) };
      }
    }

    return null;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  function isOasis(report) {
    const name = (report.defender.village || "").toLowerCase();
    if (name.includes("unoccupied oasis")) return true;
    if (!report.defender.player) return true;
    return false;
  }

  function isFullLoot(report) {
    if (!report.bounty || !report.bounty.capacity) return false;
    return (
      report.bounty.total / report.bounty.capacity >= CONFIG.fullLootThreshold
    );
  }

  function cleanVillageName(name) {
    if (!name) return "Unknown";
    return name
      .replace(
        /[\u202A\u202B\u202C\u202D\u202E\u200E\u200F\u2066\u2067\u2068\u2069]/g,
        "",
      )
      .trim();
  }

  function buildNameWithSuffix(name) {
    return cleanVillageName(name) + " \u202D\u202C";
  }

  // ============================================================
  // BUILD BLACKLIST
  // ============================================================

  function buildBlacklist(allResults) {
    const withLosses = allResults.filter(
      (r) => r.type === "WonWithLosses" || r.type === "LostAsAttacker",
    );

    const seen = new Set();
    const blacklist = [];

    withLosses.forEach((r) => {
      const vid = r.defender.villageId;
      if (!vid) return;
      if (seen.has(vid)) return;
      seen.add(vid);

      blacklist.push({
        villageId: vid,
        name: cleanVillageName(r.defender.village),
        player: r.defender.player || null,
        coords: r.defender.coords || r.coordsFromName || null,
        isOasis: isOasis(r),
        lastOutcome: r.outcome,
        lastType: r.type,
      });
    });

    return blacklist;
  }

  // ============================================================
  // BUILD FARM LIST
  // ============================================================

  function buildFarmList(allResults, originCoords, troops) {
    const fullLoot = allResults.filter((r) => isFullLoot(r));

    const uniqueTargets = {};
    fullLoot.forEach((r) => {
      const vid = r.defender.villageId;
      if (!vid) return;
      if (isOasis(r)) return;

      const ratio = r.bounty.total / r.bounty.capacity;
      if (!uniqueTargets[vid] || ratio > uniqueTargets[vid].ratio) {
        uniqueTargets[vid] = { report: r, ratio };
      }
    });

    const targets = [];
    Object.values(uniqueTargets).forEach(({ report: r }) => {
      const coords = r.defender.coords || r.coordsFromName || null;
      if (!coords) {
        log(`Skipping target ${r.defender.village}: no coords`);
        return;
      }

      let distance = 0;
      if (originCoords) {
        const dx = coords.x - originCoords.x;
        const dy = coords.y - originCoords.y;
        distance = Math.round(Math.sqrt(dx * dx + dy * dy));
      }

      targets.push({
        name: buildNameWithSuffix(r.defender.village),
        x: coords.x,
        y: coords.y,
        distance: distance,
        troops: { ...troops },
        heroFollow: false,
      });
    });

    targets.sort((a, b) => a.distance - b.distance);

    return {
      _format: "farm-list-v1",
      _exported: Date.now(),
      list: {
        name: CONFIG.farmListName,
        troops: {
          t1: 0,
          t2: 0,
          t3: 0,
          t4: 0,
          t5: 0,
          t6: 0,
          t7: 0,
          t8: 0,
          t9: 0,
          t10: 0,
          t11: 0,
        },
        heroFollow: false,
        targets: targets,
      },
    };
  }

  // ============================================================
  // MAIN ANALYSIS
  // ============================================================

  async function runAnalysis() {
    setResultButtonsVisible(false);
    const troopConfig = readTroopConfigFromUI();
    appendLog(`Troop config: TT (t4) = ${troopConfig.t4}`);

    const reports = readReportList();
    if (reports.length === 0) {
      appendLog("Nothing to analyze.");
      showToast("No reports found", "error");
      return;
    }

    appendLog(
      `--- Starting detailed analysis of ${reports.length} reports ---`,
    );

    const allResults = [];
    for (let i = 0; i < reports.length; i++) {
      const report = reports[i];
      updateProgress(i + 1, reports.length, "fetching reports");
      appendLog(
        `[${i + 1}/${reports.length}] ${report.subject.substring(0, 55)}...`,
      );

      const details = await fetchReportDetails(report.id);
      if (details && !details.error) {
        allResults.push({
          id: report.id,
          subject: report.subject,
          type: report.type,
          ...details,
        });
      } else {
        appendLog(`  Error: ${details ? details.error : "unknown"}`);
      }
      await sleep(CONFIG.delayBetweenRequests);
    }

    const uniqueVillageIds = new Set();
    allResults.forEach((r) => {
      if (r.defender && r.defender.villageId && !isOasis(r)) {
        uniqueVillageIds.add(r.defender.villageId);
      }
    });

    appendLog(
      `--- Fetching coordinates for ${uniqueVillageIds.size} unique villages ---`,
    );
    const coordsMap = {};
    const villageIdArray = Array.from(uniqueVillageIds);
    for (let i = 0; i < villageIdArray.length; i++) {
      const vid = villageIdArray[i];
      updateProgress(i + 1, villageIdArray.length, "fetching coords");
      const coords = await fetchVillageCoordinates(vid);
      if (coords) {
        coordsMap[vid] = coords;
        appendLog(`  Village ${vid} → (${coords.x}|${coords.y})`);
      } else {
        appendLog(`  Village ${vid} → coords not found`);
      }
      await sleep(CONFIG.delayBetweenCoordinateFetches);
    }

    allResults.forEach((r) => {
      if (
        r.defender &&
        r.defender.villageId &&
        coordsMap[r.defender.villageId]
      ) {
        r.defender.coords = coordsMap[r.defender.villageId];
      }
    });

    let originCoords = null;
    const activeVillageEl = document.querySelector("#villageName");
    if (activeVillageEl) {
      const dataX = activeVillageEl.getAttribute("data-x");
      const dataY = activeVillageEl.getAttribute("data-y");
      if (dataX && dataY) {
        originCoords = { x: parseInt(dataX), y: parseInt(dataY) };
        appendLog(`Origin village: (${originCoords.x}|${originCoords.y})`);
      }
    }

    const blacklist = buildBlacklist(allResults);
    const farmList = buildFarmList(allResults, originCoords, troopConfig);

    const output = {
      timestamp: new Date().toISOString(),
      totalReports: allResults.length,
      blacklist: blacklist,
      farmList: farmList,
    };

    saveCache(output);

    appendLog(`\n=== Analysis complete ===`);
    appendLog(`- Blacklist: ${blacklist.length} villages`);
    appendLog(
      `- Farm List: ${farmList.list.targets.length} targets (TT=${troopConfig.t4} each)`,
    );

    farmList.list.targets.forEach((t) => {
      appendLog(
        `  • ${t.name.trim()} (${t.x}|${t.y}) dist=${t.distance} t4=${t.troops.t4}`,
      );
    });

    setResultButtonsVisible(true);
    bindActionButtons(output);
    updateProgress(reports.length, reports.length, "done");

    if (farmList.list.targets.length > 0) {
      showToast(
        `✓ ${farmList.list.targets.length} targets, ${blacklist.length} blacklisted`,
        "success",
        3000,
      );
    } else {
      showToast("Analysis complete but no targets found", "info", 3000);
    }
  }

  // ============================================================
  // ACTION BUTTONS
  // ============================================================

  function bindActionButtons(output) {
    const copyFarm = document.getElementById("nova-copy-farm-button");
    const copyBlacklist = document.getElementById("nova-copy-blacklist-button");
    const downloadFarm = document.getElementById("nova-download-farm-button");
    const downloadBlacklist = document.getElementById(
      "nova-download-blacklist-button",
    );

    if (copyFarm) {
      copyFarm.onclick = async () => {
        try {
          const json = JSON.stringify(output.farmList, null, 2);
          await copyToClipboard(json);
          appendLog(
            `📋 Farm List copied to clipboard (${output.farmList.list.targets.length} targets)`,
          );
          showToast(
            `✓ Farm List copied (${output.farmList.list.targets.length} targets)`,
            "success",
          );
        } catch (e) {
          appendLog(`Copy failed: ${e.message}`);
          showToast("Copy failed — see log", "error");
        }
      };
    }

    if (copyBlacklist) {
      copyBlacklist.onclick = async () => {
        try {
          const json = JSON.stringify(output.blacklist, null, 2);
          await copyToClipboard(json);
          appendLog(
            `📋 Blacklist copied to clipboard (${output.blacklist.length} villages)`,
          );
          showToast(
            `✓ Blacklist copied (${output.blacklist.length} villages)`,
            "success",
          );
        } catch (e) {
          appendLog(`Copy failed: ${e.message}`);
          showToast("Copy failed — see log", "error");
        }
      };
    }

    if (downloadFarm) {
      downloadFarm.onclick = () => {
        downloadJson(output.farmList, `farm_list_${timestampSuffix()}.json`);
        appendLog("⬇ Farm List JSON downloaded.");
        showToast("✓ Farm List downloaded", "success");
      };
    }

    if (downloadBlacklist) {
      downloadBlacklist.onclick = () => {
        downloadJson(output.blacklist, `blacklist_${timestampSuffix()}.json`);
        appendLog("⬇ Blacklist JSON downloaded.");
        showToast("✓ Blacklist downloaded", "success");
      };
    }
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function timestampSuffix() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  // ============================================================
  // LOAD FROM CACHE
  // ============================================================

  function loadFromCache() {
    const cache = loadCache();
    if (!cache.lastAnalysis) {
      appendLog("No cache found. Run analysis first.");
      showToast("No cache found", "error");
      return;
    }
    const ts = new Date(cache.timestamp).toLocaleString();
    const data = cache.lastAnalysis;
    appendLog(`Loading cached analysis from ${ts}...`);
    appendLog(`- Blacklist: ${data.blacklist ? data.blacklist.length : 0}`);
    appendLog(
      `- Farm List: ${data.farmList && data.farmList.list ? data.farmList.list.targets.length : 0}`,
    );

    if (data.farmList && data.farmList.list && data.farmList.list.targets[0]) {
      const t = data.farmList.list.targets[0];
      appendLog(
        `  First target: ${t.name.trim()} (${t.x}|${t.y}) t4=${t.troops.t4}`,
      );
    }

    setResultButtonsVisible(true);
    bindActionButtons(data);
    showToast("✓ Loaded from cache", "success");
  }

  // ============================================================
  // MAIN
  // ============================================================

  function main() {
    log("Script started. v1.0.0");
    injectStyles();

    waitForElement("#reportsForm", (formElement) => {
      log("Reports form found. Injecting UI...");
      const testBox = createTestBox();
      if (!testBox) return;

      formElement.parentNode.insertBefore(testBox, formElement);

      document
        .getElementById("nova-start-button")
        .addEventListener("click", runAnalysis);
      document
        .getElementById("nova-load-cache-button")
        .addEventListener("click", loadFromCache);

      document
        .getElementById("nova-clear-button")
        .addEventListener("click", () => {
          if (confirm("Clear all cached analysis and coordinates?")) {
            clearCache();
            localStorage.removeItem(CONFIG.coordsCacheKey);
            appendLog("🗑 Cache cleared. Coordinates cache also cleared.");
            setResultButtonsVisible(false);
            showToast("Cache cleared", "info");
          }
        });
    });
  }

  main();
})();
