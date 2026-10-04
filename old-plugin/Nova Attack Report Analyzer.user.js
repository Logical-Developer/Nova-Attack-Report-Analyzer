// ==UserScript==
// @name         Nova Attack Report Analyzer (Ver 0.8)
// @namespace    http://tampermonkey.net/
// @version      0.8
// @description  Build farm list from full-loot raids (Theutates Thunder) and blacklist villages with losses.
// @author       Nova
// @match        *://*.travian.com/report/offensive*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        debug: true,
        delayBetweenRequests: 600,
        delayBetweenCoordinateFetches: 400,
        storageKey: 'nova_analyzer_cache_v8',
        coordsCacheKey: 'nova_coords_cache_v8',
        fullLootThreshold: 0.95,   // 95% or more
        farmListName: 'Nova Full Loot',
        defaultTT: 3,              // Default Theutates Thunder count per target
    };

    // ============================================================
    // UTILS
    // ============================================================

    function log(...args) {
        if (CONFIG.debug) console.log('[Nova Analyzer]', ...args);
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function waitForElement(selector, callback, interval = 500, timeout = 15000) {
        const startTime = Date.now();
        const timer = setInterval(() => {
            const element = document.querySelector(selector);
            if (element) { clearInterval(timer); callback(element); }
            else if (Date.now() - startTime > timeout) { clearInterval(timer); log(`Timeout: ${selector}`); }
        }, interval);
    }

    // ============================================================
    // STORAGE
    // ============================================================

    function loadCache() {
        try {
            const raw = localStorage.getItem(CONFIG.storageKey);
            return raw ? JSON.parse(raw) : { lastAnalysis: null, timestamp: null };
        } catch (e) { return { lastAnalysis: null, timestamp: null }; }
    }

    function saveCache(data) {
        try {
            localStorage.setItem(CONFIG.storageKey, JSON.stringify({
                lastAnalysis: data,
                timestamp: Date.now()
            }));
        } catch (e) { log('Failed to save cache:', e); }
    }

    function clearCache() {
        localStorage.removeItem(CONFIG.storageKey);
        log('Cache cleared.');
    }

    function loadCoordsCache() {
        try {
            const raw = localStorage.getItem(CONFIG.coordsCacheKey);
            return raw ? JSON.parse(raw) : {};
        } catch (e) { return {}; }
    }

    function saveCoordsCache(cache) {
        try {
            localStorage.setItem(CONFIG.coordsCacheKey, JSON.stringify(cache));
        } catch (e) { log('Failed to save coords cache:', e); }
    }

    // ============================================================
    // UI
    // ============================================================

    function createTestBox() {
        const boxId = 'nova-analyzer-box';
        if (document.getElementById(boxId)) return;

        const box = document.createElement('div');
        box.id = boxId;
        box.style.cssText = `
            background: #2c2c2c; border: 1px solid #555; border-radius: 5px;
            padding: 12px; margin-bottom: 10px; color: #eee;
            font-family: Arial, sans-serif; font-size: 13px;
        `;

        box.innerHTML = `
            <h3 style="margin: 0 0 10px 0; color: #f0ad4e;">Nova Attack Report Analyzer v0.8</h3>

            <div style="margin-bottom: 10px; padding: 8px; background: #1e1e1e; border-radius: 4px;">
                <label style="color: #f0ad4e; font-weight: bold;">
                    Theutates Thunder (t4) per target:
                    <input type="number" id="nova-tt-count" value="${CONFIG.defaultTT}" min="1" max="9999"
                           style="width: 70px; margin-left: 6px; padding: 3px; font-size: 14px;">
                </label>
                <div style="color: #aaa; font-size: 11px; margin-top: 4px;">
                    Default is 3. All other troops (t1-t3, t5-t11) will be 0.
                </div>
            </div>

            <div style="margin-bottom: 10px; display: flex; flex-wrap: wrap; gap: 6px;">
                <button id="nova-start-button" style="
                    background: #5cb85c; color: white; border: none;
                    padding: 7px 14px; border-radius: 4px; cursor: pointer;
                    font-weight: bold;
                ">Start Analysis</button>
                <button id="nova-load-cache-button" style="
                    background: #0275d8; color: white; border: none;
                    padding: 7px 14px; border-radius: 4px; cursor: pointer;
                    font-weight: bold;
                ">Load from Cache</button>
                <button id="nova-download-farm-button" style="
                    background: #f0ad4e; color: white; border: none;
                    padding: 7px 14px; border-radius: 4px; cursor: pointer;
                    font-weight: bold; display: none;
                ">Download Farm List</button>
                <button id="nova-download-blacklist-button" style="
                    background: #d9534f; color: white; border: none;
                    padding: 7px 14px; border-radius: 4px; cursor: pointer;
                    font-weight: bold; display: none;
                ">Download Blacklist</button>
                <button id="nova-copy-farm-button" style="
                    background: #5bc0de; color: white; border: none;
                    padding: 7px 14px; border-radius: 4px; cursor: pointer;
                    font-weight: bold; display: none;
                ">Copy Farm List</button>
                <button id="nova-clear-button" style="
                    background: #777; color: white; border: none;
                    padding: 7px 14px; border-radius: 4px; cursor: pointer;
                    font-weight: bold;
                ">Clear Cache</button>
                <span id="nova-progress" style="margin-left: 8px; color: #f0ad4e; align-self: center;"></span>
            </div>
            <div id="nova-log-output" style="
                background: #1e1e1e; border: 1px solid #333; padding: 8px;
                border-radius: 3px; max-height: 300px; overflow-y: auto;
                white-space: pre-wrap; font-family: monospace; font-size: 12px;
                color: #a9b7c6;
            ">Ready. Click "Start Analysis" to begin.</div>
        `;
        return box;
    }

    function appendLog(message) {
        const logOutput = document.getElementById('nova-log-output');
        if (logOutput) {
            const time = new Date().toLocaleTimeString();
            logOutput.textContent += `\n[${time}] ${message}`;
            logOutput.scrollTop = logOutput.scrollHeight;
        }
    }

    function updateProgress(current, total, extra = '') {
        const progress = document.getElementById('nova-progress');
        if (progress) progress.textContent = `(${current}/${total}) ${extra}`;
    }

    function setResultButtonsVisible(visible) {
        ['nova-download-farm-button', 'nova-download-blacklist-button', 'nova-copy-farm-button'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.style.display = visible ? 'inline-block' : 'none';
        });
    }

    function readTroopConfigFromUI() {
        const ttInput = document.getElementById('nova-tt-count');
        const ttCount = ttInput ? (parseInt(ttInput.value) || CONFIG.defaultTT) : CONFIG.defaultTT;
        return {
            t1: 0, t2: 0, t3: 0,
            t4: ttCount,
            t5: 0, t6: 0, t7: 0, t8: 0, t9: 0, t10: 0, t11: 0
        };
    }

    // ============================================================
    // PHASE 1: READ REPORT LIST
    // ============================================================

    function readReportList() {
        appendLog('Reading report list...');
        const reportRows = document.querySelectorAll('#overview tbody tr');
        if (!reportRows || reportRows.length === 0) {
            appendLog('No reports found.');
            return [];
        }

        const reports = [];
        reportRows.forEach((row) => {
            const checkbox = row.querySelector('input.report');
            const reportId = checkbox ? checkbox.value : null;
            const linkElement = row.querySelector('td.sub div a');
            const reportLink = linkElement ? linkElement.getAttribute('href') : null;
            const reportSubject = linkElement ? linkElement.textContent.trim() : 'Unknown';
            const typeIcon = row.querySelector('img.iReport');

            let reportType = 'Unknown';
            if (typeIcon) {
                if (typeIcon.classList.contains('iReport1')) reportType = 'WonWithoutLosses';
                else if (typeIcon.classList.contains('iReport2')) reportType = 'WonWithLosses';
                else if (typeIcon.classList.contains('iReport3')) reportType = 'LostAsAttacker';
            }

            if (reportId && reportLink) {
                reports.push({ id: reportId, link: reportLink, subject: reportSubject, type: reportType });
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
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
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

        const victoryDiv = doc.querySelector('div.victory');
        if (victoryDiv) {
            if (victoryDiv.querySelector('.lostWon')) result.outcome = 'Lost';
            else if (victoryDiv.querySelector('.won')) result.outcome = 'Won';
        }

        // Attacker
        const attackerRole = doc.querySelector('div.role.attacker');
        if (attackerRole) {
            const playerLink = attackerRole.querySelector('.troopHeadline a.player');
            const villageLink = attackerRole.querySelector('.troopHeadline a.village');
            const allianceLink = attackerRole.querySelector('.troopHeadline span.inline-block a');

            result.attacker = {
                player: playerLink ? playerLink.textContent.trim() : null,
                village: villageLink ? villageLink.textContent.trim() : null,
                villageId: villageLink ? extractVillageId(villageLink.getAttribute('href')) : null,
                alliance: allianceLink ? allianceLink.textContent.trim() : null,
            };
        }

        // Defender
        const defenderRole = doc.querySelector('div.role.defender');
        if (defenderRole) {
            const playerLink = defenderRole.querySelector('.troopHeadline a.player');
            const villageLink = defenderRole.querySelector('.troopHeadline a.village');
            const allianceLink = defenderRole.querySelector('.troopHeadline span.inline-block a');

            const villageName = villageLink ? villageLink.textContent.trim() : '';
            result.defender = {
                player: playerLink ? playerLink.textContent.trim() : null,
                village: villageName,
                villageId: villageLink ? extractVillageId(villageLink.getAttribute('href')) : null,
                alliance: allianceLink ? allianceLink.textContent.trim() : null,
            };

            const nameCoords = extractCoordsFromName(villageName);
            if (nameCoords) result.coordsFromName = nameCoords;
        }

        // Bounty
        const infoRows = doc.querySelectorAll('.additionalInformation tbody tr');
        infoRows.forEach(row => {
            const th = row.querySelector('th');
            const td = row.querySelector('td');
            if (!th || !td) return;

            if (th.textContent.trim() === 'Bounty') {
                const resValues = td.querySelectorAll('.inlineIcon.resources .value');
                const carryValue = td.querySelector('.inlineIcon.carry .value');
                if (resValues.length >= 4) {
                    result.bounty.resources = {
                        lumber: parseInt(resValues[0].textContent.replace(/\D/g, '')) || 0,
                        clay: parseInt(resValues[1].textContent.replace(/\D/g, '')) || 0,
                        iron: parseInt(resValues[2].textContent.replace(/\D/g, '')) || 0,
                        crop: parseInt(resValues[3].textContent.replace(/\D/g, '')) || 0,
                    };
                    result.bounty.total = Object.values(result.bounty.resources).reduce((a, b) => a + b, 0);
                }
                if (carryValue) {
                    const parts = carryValue.textContent.split('/');
                    if (parts.length === 2) {
                        result.bounty.capacity = parseInt(parts[1].replace(/\D/g, '')) || 0;
                    }
                }
            }
        });

        // Combat Stats
        const statRows = doc.querySelectorAll('.combatStatistic tbody tr');
        statRows.forEach(row => {
            const th = row.querySelector('th');
            const tds = row.querySelectorAll('td .value');
            if (!th || tds.length < 2) return;
            const label = th.textContent.trim();
            const atkVal = parseInt(tds[0].textContent.replace(/\D/g, '')) || 0;
            const defVal = parseInt(tds[1].textContent.replace(/\D/g, '')) || 0;
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
            .replace(/\u2212/g, '-')
            .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
            .replace(/[\u202A\u202B\u202C\u202D\u202E]/g, '')
            .replace(/[^\d-]/g, '');
        const match = cleaned.match(/-?\d+/);
        return match ? parseInt(match[0], 10) : NaN;
    }

    function extractCoordsFromName(name) {
        if (!name) return null;
        const cleanName = name.replace(/[\u202A\u202B\u202C\u202D\u202E\u200E\u200F\u2066\u2067\u2068\u2069]/g, '');
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
            log(`Coords cache hit for village ${villageId}: (${coordsCache[villageId].x}|${coordsCache[villageId].y})`);
            return coordsCache[villageId];
        }

        const endpoints = [
            `/position.php?d=${villageId}`,
            `/karte.php?d=${villageId}`,
        ];

        for (const url of endpoints) {
            try {
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) continue;
                const html = await response.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const coords = extractCoordsFromKarte(doc, villageId);
                if (coords && !isNaN(coords.x) && !isNaN(coords.y)) {
                    coordsCache[villageId] = coords;
                    saveCoordsCache(coordsCache);
                    log(`Got coords for ${villageId} via ${url}: (${coords.x}|${coords.y})`);
                    return coords;
                }
            } catch (err) {
                log(`Failed ${url}: ${err.message}`);
            }
        }
        return null;
    }

    function extractCoordsFromKarte(doc, targetVillageId) {
        // Priority 1: position.php input fields
        const posX = doc.querySelector('input[name="x"], #xCoord, #x');
        const posY = doc.querySelector('input[name="y"], #yCoord, #y');
        if (posX && posY) {
            const x = parseCoord(posX.value || posX.textContent);
            const y = parseCoord(posY.value || posY.textContent);
            if (!isNaN(x) && !isNaN(y)) return { x, y };
        }

        // Priority 2: element with matching data-did
        if (targetVillageId) {
            const targetEl = doc.querySelector(
                `[data-did="${targetVillageId}"], #village${targetVillageId}, .village${targetVillageId}, [data-village-id="${targetVillageId}"]`
            );
            if (targetEl) {
                const x = parseCoord(targetEl.getAttribute('data-x') || targetEl.getAttribute('x'));
                const y = parseCoord(targetEl.getAttribute('data-y') || targetEl.getAttribute('y'));
                if (!isNaN(x) && !isNaN(y)) return { x, y };
            }
        }

        // Priority 3: JS variables
        if (targetVillageId) {
            const scripts = doc.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent;
                const re = new RegExp(
                    `[\\s\\S]{0,200}?d(?:id|ataId)?[\\s:='\"]+${targetVillageId}[\\s\\S]{0,200}?x[\\s:='\"]+(-?\\d+)[\\s\\S]{0,40}?y[\\s:='\"]+(-?\\d+)`
                );
                const m = text.match(re);
                if (m) return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };

                const re2 = new RegExp(
                    `[\\s\\S]{0,200}?d(?:id|ataId)?[\\s:='\"]+${targetVillageId}[\\s\\S]{0,200}?y[\\s:='\"]+(-?\\d+)[\\s\\S]{0,40}?x[\\s:='\"]+(-?\\d+)`
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
        const name = (report.defender.village || '').toLowerCase();
        if (name.includes('unoccupied oasis')) return true;
        if (!report.defender.player) return true;
        return false;
    }

    function isFullLoot(report) {
        if (!report.bounty || !report.bounty.capacity) return false;
        return (report.bounty.total / report.bounty.capacity) >= CONFIG.fullLootThreshold;
    }

    function cleanVillageName(name) {
        if (!name) return 'Unknown';
        return name.replace(/[\u202A\u202B\u202C\u202D\u202E\u200E\u200F\u2066\u2067\u2068\u2069]/g, '').trim();
    }

    function buildNameWithSuffix(name) {
        return cleanVillageName(name) + ' \u202D\u202C';
    }

    // ============================================================
    // BUILD BLACKLIST
    // ============================================================

    function buildBlacklist(allResults) {
        const withLosses = allResults.filter(r =>
            r.type === 'WonWithLosses' || r.type === 'LostAsAttacker'
        );

        const seen = new Set();
        const blacklist = [];

        withLosses.forEach(r => {
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
                lastType: r.type
            });
        });

        return blacklist;
    }

    // ============================================================
    // BUILD FARM LIST
    // ============================================================

    function buildFarmList(allResults, originCoords, troops) {
        const fullLoot = allResults.filter(r => isFullLoot(r));

        const uniqueTargets = {};
        fullLoot.forEach(r => {
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
                heroFollow: false
            });
        });

        targets.sort((a, b) => a.distance - b.distance);

        return {
            _format: 'farm-list-v1',
            _exported: Date.now(),
            list: {
                name: CONFIG.farmListName,
                troops: {
                    t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0,
                    t7: 0, t8: 0, t9: 0, t10: 0, t11: 0
                },
                heroFollow: false,
                targets: targets
            }
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
            appendLog('Nothing to analyze.');
            return;
        }

        appendLog(`--- Starting detailed analysis of ${reports.length} reports ---`);

        // Step 1: Fetch report details
        const allResults = [];
        for (let i = 0; i < reports.length; i++) {
            const report = reports[i];
            updateProgress(i + 1, reports.length, 'fetching reports');
            appendLog(`[${i + 1}/${reports.length}] ${report.subject.substring(0, 55)}...`);

            const details = await fetchReportDetails(report.id);
            if (details && !details.error) {
                allResults.push({ id: report.id, subject: report.subject, type: report.type, ...details });
            } else {
                appendLog(`  Error: ${details ? details.error : 'unknown'}`);
            }
            await sleep(CONFIG.delayBetweenRequests);
        }

        // Step 2: Fetch coordinates
        const uniqueVillageIds = new Set();
        allResults.forEach(r => {
            if (r.defender && r.defender.villageId && !isOasis(r)) {
                uniqueVillageIds.add(r.defender.villageId);
            }
        });

        appendLog(`--- Fetching coordinates for ${uniqueVillageIds.size} unique villages ---`);
        const coordsMap = {};
        const villageIdArray = Array.from(uniqueVillageIds);
        for (let i = 0; i < villageIdArray.length; i++) {
            const vid = villageIdArray[i];
            updateProgress(i + 1, villageIdArray.length, 'fetching coords');
            const coords = await fetchVillageCoordinates(vid);
            if (coords) {
                coordsMap[vid] = coords;
                appendLog(`  Village ${vid} → (${coords.x}|${coords.y})`);
            } else {
                appendLog(`  Village ${vid} → coords not found`);
            }
            await sleep(CONFIG.delayBetweenCoordinateFetches);
        }

        // Step 3: Enrich
        allResults.forEach(r => {
            if (r.defender && r.defender.villageId && coordsMap[r.defender.villageId]) {
                r.defender.coords = coordsMap[r.defender.villageId];
            }
        });

        // Step 4: Origin coords
        let originCoords = null;
        const activeVillageEl = document.querySelector('#villageName');
        if (activeVillageEl) {
            const dataX = activeVillageEl.getAttribute('data-x');
            const dataY = activeVillageEl.getAttribute('data-y');
            if (dataX && dataY) {
                originCoords = { x: parseInt(dataX), y: parseInt(dataY) };
                appendLog(`Origin village: (${originCoords.x}|${originCoords.y})`);
            }
        }

        // Step 5: Build outputs
        const blacklist = buildBlacklist(allResults);
        const farmList = buildFarmList(allResults, originCoords, troopConfig);

        const output = {
            timestamp: new Date().toISOString(),
            totalReports: allResults.length,
            blacklist: blacklist,
            farmList: farmList
        };

        saveCache(output);

        appendLog(`\n=== Analysis complete ===`);
        appendLog(`- Blacklist: ${blacklist.length} villages`);
        appendLog(`- Farm List: ${farmList.list.targets.length} targets (TT=${troopConfig.t4} each)`);

        farmList.list.targets.forEach(t => {
            appendLog(`  • ${t.name.trim()} (${t.x}|${t.y}) dist=${t.distance} t4=${t.troops.t4}`);
        });

        setResultButtonsVisible(true);
        bindActionButtons(output);
        updateProgress(reports.length, reports.length, 'done');
    }

    // ============================================================
    // ACTION BUTTONS
    // ============================================================

    function bindActionButtons(output) {
        const downloadFarm = document.getElementById('nova-download-farm-button');
        const downloadBlacklist = document.getElementById('nova-download-blacklist-button');
        const copyFarm = document.getElementById('nova-copy-farm-button');

        if (downloadFarm) {
            downloadFarm.onclick = () => {
                downloadJson(output.farmList, `farm_list_${timestampSuffix()}.json`);
                appendLog('Farm List JSON downloaded.');
            };
        }
        if (downloadBlacklist) {
            downloadBlacklist.onclick = () => {
                downloadJson(output.blacklist, `blacklist_${timestampSuffix()}.json`);
                appendLog('Blacklist JSON downloaded.');
            };
        }
        if (copyFarm) {
            copyFarm.onclick = () => {
                navigator.clipboard.writeText(JSON.stringify(output.farmList, null, 2));
                appendLog('Farm List copied to clipboard!');
            };
        }
    }

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function timestampSuffix() {
        return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    }

    // ============================================================
    // LOAD FROM CACHE
    // ============================================================

    function loadFromCache() {
        const cache = loadCache();
        if (!cache.lastAnalysis) {
            appendLog('No cache found. Run analysis first.');
            return;
        }
        const ts = new Date(cache.timestamp).toLocaleString();
        const data = cache.lastAnalysis;
        appendLog(`Loading cached analysis from ${ts}...`);
        appendLog(`- Blacklist: ${data.blacklist ? data.blacklist.length : 0}`);
        appendLog(`- Farm List: ${data.farmList && data.farmList.list ? data.farmList.list.targets.length : 0}`);

        // Show a preview of first target
        if (data.farmList && data.farmList.list && data.farmList.list.targets[0]) {
            const t = data.farmList.list.targets[0];
            appendLog(`  First target: ${t.name.trim()} (${t.x}|${t.y}) t4=${t.troops.t4}`);
        }

        setResultButtonsVisible(true);
        bindActionButtons(data);
    }

    // ============================================================
    // MAIN
    // ============================================================

    function main() {
        log('Script started.');
        waitForElement('#reportsForm', (formElement) => {
            log('Reports form found. Injecting UI...');
            const testBox = createTestBox();
            if (!testBox) return;

            formElement.parentNode.insertBefore(testBox, formElement);

            document.getElementById('nova-start-button').addEventListener('click', runAnalysis);
            document.getElementById('nova-load-cache-button').addEventListener('click', loadFromCache);

            document.getElementById('nova-clear-button').addEventListener('click', () => {
                if (confirm('Clear all cached analysis and coordinates?')) {
                    clearCache();
                    localStorage.removeItem(CONFIG.coordsCacheKey);
                    appendLog('Cache cleared. Coordinates cache also cleared.');
                    setResultButtonsVisible(false);
                }
            });
        });
    }

    main();
})();