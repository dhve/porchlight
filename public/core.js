// core.js  window.Sutros: shared API client, user state, routing, and hooks
(function () {
  const S = (window.Sutros = window.Sutros || {});
  S.user = null; S.config = { requireAccount: false, providers: {}, mail: { configured: false } };
  const userListeners = [];

  S.api = async function (path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method, credentials: "same-origin",
      headers: { "X-Requested-With": "fetch", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) { const e = new Error((data && data.error) || "Something went wrong."); e.status = res.status; e.data = data; throw e; }
    return data;
  };
  S.onUser = (fn) => userListeners.push(fn);
  S.refreshMe = async function () {
    try { const d = await S.api("/api/me"); S.user = d.user || null; } catch { S.user = null; }
    userListeners.forEach((fn) => { try { fn(S.user); } catch {} });
    return S.user;
  };
  S.loadConfig = async function () { try { S.config = await S.api("/api/config"); } catch {} return S.config; };

  // ---- routing ----
  const routes = [];
  S.route = (pattern, handler) => routes.push({ pattern, handler });
  S.showScreen = function (id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("is-active"));
    const el = document.getElementById(id); if (el) el.classList.add("is-active");
    window.scrollTo({ top: 0 });
  };
  S.dispatch = function () {
    const p = location.pathname;
    for (const r of routes) { const m = p.match(r.pattern); if (m) { try { r.handler(m, new URLSearchParams(location.search)); } catch (e) { console.error(e); } return true; } }
    return false;
  };
  S.navigate = function (path) { history.pushState(null, "", path); S.dispatch(); };
  window.addEventListener("popstate", () => S.dispatch());
  S.requireLogin = function (next) {
    if (S.user) return true;
    S.navigate("/login?next=" + encodeURIComponent(next || location.pathname + location.search));
    return false;
  };

  // ---- hooks (modules may replace) ----
  S.beforeCheckup = async () => true;
  S.onReportRendered = () => {};
  S.toast = function (text) {
    let t = document.getElementById("sutrosToast");
    if (!t) { t = document.createElement("div"); t.id = "sutrosToast"; t.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:12px 18px;border-radius:12px;font-size:14.5px;z-index:999;box-shadow:0 10px 30px rgba(0,0,0,.2);opacity:0;transition:opacity .2s"; document.body.appendChild(t); }
    t.textContent = text; t.style.opacity = "1"; clearTimeout(t._h); t._h = setTimeout(() => (t.style.opacity = "0"), 2600);
  };

  // boot: config + user, then let modules dispatch routes
  S.ready = Promise.all([S.loadConfig(), S.refreshMe()]);
  document.addEventListener("DOMContentLoaded", () => { S.ready.then(() => S.dispatch()); });
})();
