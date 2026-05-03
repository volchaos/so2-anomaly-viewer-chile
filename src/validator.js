/**
 * validator.js - Módulo de validación de anomalías SO2.
 * Usa Personal Access Token (PAT) de GitHub.
 * Solo usuarios en VALIDATORS pueden validar.
 */
(function (global) {

  const VALIDATORS  = ["volchaos"];
  const REPO_OWNER  = "volchaos";
  const REPO_NAME   = "so2-anomaly-viewer-chile";
  const VAL_PATH    = "data/validations.json";
  const SESSION_KEY = "gh_pat_token";
  const USER_KEY    = "gh_pat_username";

  let _token    = sessionStorage.getItem(SESSION_KEY) || null;
  let _username = sessionStorage.getItem(USER_KEY) || null;
  let _so2Data  = null;
  let _valData  = null;

  function el(id) { return document.getElementById(id); }
  function showStatus(html) { const s = el("validatorStatus"); if (s) s.innerHTML = html; }

  async function ghApi(path, opts = {}) {
    const r = await fetch("https://api.github.com" + path, {
      headers: {
        Authorization: "Bearer " + _token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...opts.headers
      },
      ...opts
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || "GitHub API " + r.status);
    }
    return r.json();
  }

  async function loginWithPAT(token) {
    showStatus("Verificando token…");
    try {
      const resp = await fetch("https://api.github.com/user", {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" }
      });
      if (!resp.ok) throw new Error("Token inválido (status " + resp.status + ")");
      const data = await resp.json();
      const username = data.login;
      if (!VALIDATORS.includes(username)) {
        showStatus("El usuario <strong>" + username + "</strong> no tiene permiso para validar.");
        return;
      }
      _token = token;
      _username = username;
      sessionStorage.setItem(SESSION_KEY, token);
      sessionStorage.setItem(USER_KEY, username);
      await afterLogin();
    } catch (e) {
      showStatus("Error: " + e.message);
    }
  }

  function logout() {
    _token = null; _username = null;
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(USER_KEY);
    renderPanel();
  }

  async function loadValidations() {
    try {
      const r = await fetch("data/validations.json?t=" + Date.now());
      _valData = await r.json();
    } catch (e) { _valData = { validations: [] }; }
  }

  function isValidated(date, volcano) {
    return (_valData?.validations || []).some(v => v.date === date && v.volcano === volcano);
  }

  async function saveValidation(date, volcano, valid) {
    const fileInfo = await ghApi("/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + VAL_PATH);
    const existing = JSON.parse(atob(fileInfo.content.replace(/\n/g, "")));
    existing.validations = existing.validations.filter(v => !(v.date === date && v.volcano === volcano));
    existing.validations.push({ date, volcano, valid, validated_by: _username, validated_at: new Date().toISOString() });
    existing.validations.sort((a, b) => a.date.localeCompare(b.date));
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(existing, null, 2))));
    await ghApi("/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + VAL_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: (valid ? "✓" : "✗") + " " + volcano + " " + date + " [" + _username + "]",
        content, sha: fileInfo.sha
      })
    });
    _valData = existing;
  }

  function getPendingAnomalies() {
    if (!_so2Data) return [];
    const items = [];
    for (const [name, v] of Object.entries(_so2Data.volcanoes || {})) {
      for (const h of (v.history || [])) {
        if (h.so2_tons > 0 && !isValidated(h.date, name)) {
          items.push({ date: h.date, volcano: name, tons: h.so2_tons, max_du: h.max_du });
        }
      }
    }
    return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  }

  function anomalyRow(item) {
    const id = "vr-" + item.date + "-" + item.volcano.replace(/\s/g, "_");
    return `<div class="val-row" id="${id}">
      <div class="val-info">
        <span class="val-date">${item.date}</span>
        <span class="val-volcano">${item.volcano}</span>
        <span class="val-tons">${item.tons.toFixed(1)} t</span>
        <span class="val-du">${item.max_du.toFixed(2)} DU</span>
      </div>
      <div class="val-actions">
        <button class="val-btn val-ok" data-date="${item.date}" data-volcano="${item.volcano}" data-valid="true" title="Anomalía volcánica confirmada">✓</button>
        <button class="val-btn val-no" data-date="${item.date}" data-volcano="${item.volcano}" data-valid="false" title="Descartar">✗</button>
      </div>
    </div>`;
  }

  function renderPanel() {
    const panel = el("validatorPanel");
    if (!panel) return;

    if (!_token || !_username) {
      panel.innerHTML = `
        <div class="validator-intro">
          <p>Área exclusiva para el equipo de Geoquímica.<br>
          Necesitas un <a href="https://github.com/settings/tokens/new?scopes=public_repo&description=SO2+Validator" target="_blank" rel="noopener">Personal Access Token</a> de GitHub con permiso <code>public_repo</code>.</p>
          <div class="val-pat-row">
            <input id="patInput" type="password" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off" />
            <button id="patLoginBtn" class="btn primary">Entrar</button>
          </div>
        </div>
        <div id="validatorStatus" class="validator-status"></div>`;

      el("patLoginBtn").addEventListener("click", () => {
        const token = el("patInput")?.value?.trim();
        if (!token) { showStatus("Ingresa el token."); return; }
        loginWithPAT(token);
      });
      el("patInput").addEventListener("keydown", e => { if (e.key === "Enter") el("patLoginBtn").click(); });
      return;
    }

    const pending = getPendingAnomalies();
    panel.innerHTML = `
      <div class="validator-header">
        <span class="validator-user">● ${_username}</span>
        <button id="validatorLogoutBtn" class="btn">Cerrar sesión</button>
      </div>
      <div id="validatorStatus" class="validator-status"></div>
      ${pending.length === 0
        ? '<div class="validator-empty">No hay anomalías pendientes.</div>'
        : '<div class="validator-list">' + pending.map(anomalyRow).join("") + '</div>'
      }`;

    el("validatorLogoutBtn").addEventListener("click", logout);

    panel.querySelectorAll(".val-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { date, volcano, valid } = btn.dataset;
        btn.disabled = true;
        showStatus("Guardando…");
        try {
          await saveValidation(date, volcano, valid === "true");
          showStatus("✓ Guardado correctamente.");
          const row = el("vr-" + date + "-" + volcano.replace(/\s/g, "_"));
          if (row) {
            row.classList.add(valid === "true" ? "val-accepted" : "val-rejected");
            row.querySelectorAll(".val-btn").forEach(b => b.disabled = true);
          }
        } catch (e) {
          showStatus("Error al guardar: " + e.message);
          btn.disabled = false;
        }
      });
    });
  }

  async function afterLogin() {
    showStatus("Cargando validaciones…");
    await loadValidations();
    renderPanel();
  }

  async function init(so2Data) {
    _so2Data = so2Data;
    if (_token && _username && VALIDATORS.includes(_username)) {
      await afterLogin();
    } else {
      renderPanel();
    }
  }

  global.SO2Validator = { init };

})(window);
