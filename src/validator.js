/**
 * validator.js
 * Módulo de validación de anomalías SO2.
 * Usa GitHub Device Flow OAuth para autenticar.
 * Solo usuarios en VALIDATORS pueden validar.
 */

(function (global) {

  const CLIENT_ID   = "Ov23lixui5UQ8PEuRPti";
  const VALIDATORS  = ["volchaos"];          // agregar CB y GV cuando tengan cuenta
  const REPO_OWNER  = "volchaos";
  const REPO_NAME   = "so2-anomaly-viewer-chile";
  const VAL_PATH    = "data/validations.json";
  const CORS_PROXY  = "https://corsproxy.io/?";

  // ── Estado interno ────────────────────────────────────────────────────────
  let _token    = sessionStorage.getItem("gh_token") || null;
  let _username = sessionStorage.getItem("gh_username") || null;
  let _so2Data  = null;
  let _valData  = null;

  // ── UI refs ───────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  // ── Helpers GitHub API ────────────────────────────────────────────────────
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
    if (!r.ok) throw new Error("GitHub API " + r.status + " " + path);
    return r.json();
  }

  // ── Device Flow ───────────────────────────────────────────────────────────
  async function startDeviceFlow() {
    const r = await fetch(
      CORS_PROXY + encodeURIComponent(
        "https://github.com/login/device/code?client_id=" + CLIENT_ID + "&scope=public_repo"
      ),
      { method: "POST", headers: { Accept: "application/json" } }
    );
    return r.json();
  }

  async function pollDeviceFlow(device_code, interval) {
    return new Promise((resolve, reject) => {
      const iv = setInterval(async () => {
        try {
          const r = await fetch(
            CORS_PROXY + encodeURIComponent(
              "https://github.com/login/oauth/access_token" +
              "?client_id=" + CLIENT_ID +
              "&device_code=" + device_code +
              "&grant_type=urn:ietf:params:oauth:grant-type:device_code"
            ),
            { method: "POST", headers: { Accept: "application/json" } }
          );
          const data = await r.json();
          if (data.access_token) {
            clearInterval(iv);
            resolve(data.access_token);
          } else if (data.error === "access_denied" || data.error === "expired_token") {
            clearInterval(iv);
            reject(new Error(data.error));
          }
          // "authorization_pending" → seguir esperando
        } catch (e) {
          clearInterval(iv);
          reject(e);
        }
      }, (interval || 5) * 1000);
    });
  }

  // ── Login ─────────────────────────────────────────────────────────────────
  async function login() {
    showValidatorStatus("Iniciando autenticación con GitHub…");

    const device = await startDeviceFlow();

    // Mostrar código al usuario
    showValidatorStatus(
      `Ingresa el código <strong>${device.user_code}</strong> en ` +
      `<a href="${device.verification_uri}" target="_blank">${device.verification_uri}</a> ` +
      `y luego espera aquí.`
    );

    try {
      _token = await pollDeviceFlow(device.device_code, device.interval);
      sessionStorage.setItem("gh_token", _token);

      const user = await ghApi("/user");
      _username = user.login;
      sessionStorage.setItem("gh_username", _username);

      if (!VALIDATORS.includes(_username)) {
        _token = null; _username = null;
        sessionStorage.clear();
        showValidatorStatus("⚠ Tu usuario no tiene permiso para validar anomalías.");
        return;
      }

      await afterLogin();
    } catch (e) {
      showValidatorStatus("Error de autenticación: " + e.message);
    }
  }

  function logout() {
    _token = null; _username = null;
    sessionStorage.clear();
    renderValidatorPanel();
  }

  // ── Cargar datos ──────────────────────────────────────────────────────────
  async function loadValidations() {
    try {
      const r = await fetch("data/validations.json?t=" + Date.now());
      _valData = await r.json();
    } catch (e) {
      _valData = { validations: [] };
    }
  }

  function isValidated(date, volcano) {
    return (_valData?.validations || []).some(
      v => v.date === date && v.volcano === volcano
    );
  }

  // ── Guardar validación en GitHub ──────────────────────────────────────────
  async function saveValidation(date, volcano, valid) {
    // Obtener SHA del archivo actual
    const fileInfo = await ghApi(
      "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + VAL_PATH
    );
    const sha = fileInfo.sha;
    const existing = JSON.parse(atob(fileInfo.content.replace(/\n/g, "")));

    // Agregar nueva validación
    existing.validations = existing.validations.filter(
      v => !(v.date === date && v.volcano === volcano)
    );
    existing.validations.push({
      date,
      volcano,
      valid,
      validated_by: _username,
      validated_at: new Date().toISOString()
    });
    existing.validations.sort((a, b) => a.date.localeCompare(b.date));

    const content = btoa(unescape(encodeURIComponent(
      JSON.stringify(existing, null, 2)
    )));

    await ghApi(
      "/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + VAL_PATH,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: (valid ? "✓" : "✗") + " Validar " + volcano + " " + date + " [" + _username + "]",
          content,
          sha
        })
      }
    );

    // Actualizar cache local
    _valData = existing;
  }

  // ── Renderizado del panel ─────────────────────────────────────────────────
  function showValidatorStatus(html) {
    const s = el("validatorStatus");
    if (s) s.innerHTML = html;
  }

  function renderValidatorPanel() {
    const panel = el("validatorPanel");
    if (!panel) return;

    if (!_token || !_username) {
      // No autenticado
      panel.innerHTML = `
        <div class="validator-intro">
          <p>Área exclusiva para el equipo de Geoquímica.<br>Inicia sesión para validar anomalías.</p>
          <button id="validatorLoginBtn" class="btn primary">Iniciar sesión con GitHub</button>
        </div>
        <div id="validatorStatus" class="validator-status"></div>
      `;
      el("validatorLoginBtn").addEventListener("click", login);
      return;
    }

    // Autenticado — mostrar lista de anomalías pendientes
    const pending = getPendingAnomalies();

    panel.innerHTML = `
      <div class="validator-header">
        <span class="validator-user">● ${_username}</span>
        <button id="validatorLogoutBtn" class="btn">Cerrar sesión</button>
      </div>
      <div id="validatorStatus" class="validator-status"></div>
      ${pending.length === 0
        ? '<div class="validator-empty">No hay anomalías pendientes de validación.</div>'
        : `<div class="validator-list" id="validatorList">
            ${pending.map(item => renderAnomalyRow(item)).join("")}
           </div>`
      }
    `;

    el("validatorLogoutBtn").addEventListener("click", logout);

    // Botones de validación
    panel.querySelectorAll(".val-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { date, volcano, valid } = btn.dataset;
        btn.disabled = true;
        btn.textContent = "…";
        showValidatorStatus("Guardando…");
        try {
          await saveValidation(date, volcano, valid === "true");
          showValidatorStatus("✓ Guardado correctamente.");
          // Actualizar fila visualmente
          const row = document.getElementById("val-row-" + date + "-" + volcano.replace(/\s/g, "_"));
          if (row) row.classList.add(valid === "true" ? "val-accepted" : "val-rejected");
          btn.closest(".val-row").querySelectorAll(".val-btn").forEach(b => b.disabled = true);
        } catch (e) {
          showValidatorStatus("Error al guardar: " + e.message);
          btn.disabled = false;
          btn.textContent = valid === "true" ? "✓" : "✗";
        }
      });
    });
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
    // Ordenar más reciente primero, limitar a 60
    return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
  }

  function renderAnomalyRow(item) {
    const id = "val-row-" + item.date + "-" + item.volcano.replace(/\s/g, "_");
    return `
      <div class="val-row" id="${id}">
        <div class="val-info">
          <span class="val-date">${item.date}</span>
          <span class="val-volcano">${item.volcano}</span>
          <span class="val-tons">${item.tons.toFixed(1)} t</span>
          <span class="val-du">${item.max_du.toFixed(2)} DU</span>
        </div>
        <div class="val-actions">
          <button class="val-btn val-ok" data-date="${item.date}" data-volcano="${item.volcano}" data-valid="true" title="Validar como anomalía volcánica">✓</button>
          <button class="val-btn val-no" data-date="${item.date}" data-volcano="${item.volcano}" data-valid="false" title="Descartar (ruido / no volcánico)">✗</button>
        </div>
      </div>
    `;
  }

  async function afterLogin() {
    showValidatorStatus("Cargando datos…");
    await loadValidations();
    renderValidatorPanel();
  }

  // ── Init público ──────────────────────────────────────────────────────────
  async function init(so2Data) {
    _so2Data = so2Data;

    // Si hay token en sesión, verificar y cargar
    if (_token && _username) {
      if (VALIDATORS.includes(_username)) {
        await afterLogin();
        return;
      }
    }
    renderValidatorPanel();
  }

  global.SO2Validator = { init };

})(window);
