// auth-ui.js  Sign in, sign up, password reset, the account screen, the topbar
// account slot, and the "confirm your email" banner. Runs after core.js and app.js.
(function () {
  const S = window.Sutros;
  if (!S) return;

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const PROVIDER_LABEL = { google: "Google", github: "GitHub" };
  const AUTH_PATHS = /^\/(login|signup|forgot|reset|auth-error)\/?$/;

  const ICON_GOOGLE =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.2v3.1C3.2 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.3c-.5-1.5-.5-3.1 0-4.6V6.6H1.2c-1.6 3.2-1.6 7 0 10.2l4.1-2.5z"/><path fill="#EA4335" d="M12 4.7c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.2 15.1 0 12 0 7.3 0 3.2 2.7 1.2 6.6l4.1 3.1c.9-2.9 3.6-5 6.7-5z"/></svg>';
  const ICON_GITHUB =
    '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z"/></svg>';
  const ICON_CHEVRON =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  /* ---------------- query flags (read once, then removed from the URL) ---------------- */
  const flags = (function () {
    const q = new URLSearchParams(location.search);
    const f = { verified: q.get("verified") === "1", error: q.get("error") || "" };
    if (f.verified || f.error) {
      q.delete("verified");
      q.delete("error");
      const s = q.toString();
      history.replaceState(null, "", location.pathname + (s ? "?" + s : "") + location.hash);
    }
    return f;
  })();

  function errorText(code) {
    switch (code) {
      case "google": return "Google sign-in didn't finish. Please try again, or use your email and password.";
      case "github": return "GitHub sign-in didn't finish. Please try again, or use your email and password.";
      case "verify": return "That confirmation link is no longer valid. Sign in and we can send you a new one.";
      case "email-unverified": return "That email address isn't confirmed with the sign-in provider, so we couldn't link it to your account. Please sign in with your email and password instead.";
      case "unverified": return "Please confirm your email first.";
      default: return "Something went wrong while signing in. Please try again.";
    }
  }

  /* ---------------- small helpers ---------------- */
  function safeNext(v) {
    v = String(v || "");
    if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return "/";
    // Control characters (tab, newline) get stripped by URL parsing, so "/\t//host" would
    // turn into "///host". Refuse them the same way the server does.
    if (/[\x00-\x1f\x7f]/.test(v)) return "/";
    return v;
  }
  // Move to a path and let the SPA handle it. Paths no module owns get a real page load.
  // `replace` swaps the current history entry instead of adding one, for redirects the
  // person did not ask for (signed-in user landing on /login, sign-out from the account screen).
  function goTo(path, replace) {
    path = safeNext(path);
    closeMenu();
    const method = replace ? "replaceState" : "pushState";
    try { history[method](null, "", path); }
    catch { path = "/"; history[method](null, "", path); }
    if (!S.dispatch()) {
      if (location.pathname !== "/") { location.replace(path); return; }
      // Nobody registered "/" (community-ui owns it when loaded), so show home ourselves.
      if (typeof window.go === "function") window.go("home"); else S.showScreen("screen-home");
    }
    if (location.pathname === "/") consumeHomeQuery();
  }
  // app.js only reads ?url= at page load. When we reach home inside the SPA (for example
  // after signing in with next=/?url=<site>), fill the checkup box from it here.
  function consumeHomeQuery() {
    const q = new URLSearchParams(location.search);
    const u = q.get("url");
    if (!u) return;
    q.delete("url");
    const s = q.toString();
    history.replaceState(null, "", "/" + (s ? "?" + s : "") + location.hash);
    const inp = document.getElementById("urlInput");
    if (!inp) return;
    inp.value = u.replace(/^https?:\/\//i, "");
    try { inp.focus({ preventScroll: true }); } catch {}
  }
  function nextForHere() {
    if (AUTH_PATHS.test(location.pathname)) return "/";
    return location.pathname + location.search;
  }
  function displayName(user) {
    if (user.name && user.name.trim()) return user.name.trim();
    return String(user.email || "").split("@")[0] || "You";
  }
  function initials(user) {
    const parts = displayName(user).split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
  }
  function avatarHtml(user) {
    const url = String(user.avatarUrl || "");
    if (/^https:\/\//i.test(url)) {
      return `<span class="au-avatar"><img src="${esc(url)}" alt="" referrerpolicy="no-referrer"></span>`;
    }
    return `<span class="au-avatar">${esc(initials(user))}</span>`;
  }
  function bindAvatarFallback(root, user) {
    root.querySelectorAll(".au-avatar img").forEach((img) => {
      img.addEventListener("error", () => { img.parentElement.textContent = initials(user); });
    });
  }
  function fmtDate(v) {
    const d = new Date(v);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function gradeClass(g) {
    const l = String(g || "").toUpperCase()[0];
    if (l === "A" || l === "B") return "good";
    if (l === "C") return "watch";
    if (l === "D") return "serious";
    return "urgent";
  }
  function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function showErr(el, msg) { if (!el) return; el.textContent = msg || ""; el.classList.toggle("show", Boolean(msg)); }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }
  function focusFirst(root) {
    const el = root && root.querySelector("input:not([type=hidden]):not(.au-hp):not([disabled])");
    if (el) { try { el.focus({ preventScroll: true }); } catch {} }
  }
  function hasPassword(user) {
    // The public user shape does not promise this field. When it is missing, show the
    // password form; the server answers with a plain error if there is no password to check.
    return typeof user.hasPassword === "boolean" ? user.hasPassword : true;
  }
  function availableProviders() {
    const p = (S.config && S.config.providers) || {};
    return ["google", "github"].filter((k) => p[k]);
  }
  function oauthButtonsHtml(next) {
    const list = availableProviders();
    if (!list.length) return "";
    const q = "?next=" + encodeURIComponent(safeNext(next));
    const btns = list.map((k) =>
      `<a class="btn btn-ghost au-oauth-btn" href="/auth/${k}${q}">${k === "google" ? ICON_GOOGLE : ICON_GITHUB} Continue with ${PROVIDER_LABEL[k]}</a>`
    ).join("");
    return `<div class="au-oauth">${btns}</div><div class="au-divider">or use your email</div>`;
  }
  function pwToggle(input) {
    const btn = input.parentElement && input.parentElement.querySelector(".au-eye");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  }
  function pwFieldHtml(id, autocomplete, label) {
    return `<div><label for="${id}">${label}</label><div class="au-pw"><input id="${id}" type="password" autocomplete="${autocomplete}" required><button type="button" class="au-eye" aria-label="Show password">Show</button></div></div>`;
  }

  /* ---------------- styles ---------------- */
  const style = document.createElement("style");
  style.id = "auth-ui-style";
  style.textContent = `
#screens-extra [hidden]{display:none !important;}
.au-page{padding:56px 0 90px; min-height:60vh;}
.au-card{background:var(--surface); border:1px solid var(--border); border-radius:22px; padding:28px; box-shadow:0 20px 50px -24px rgb(var(--shadow)/.4);}
.au-narrow{max-width:460px; margin:0 auto;}
.au-card h2{font-size:26px; margin-bottom:8px;}
.au-card h3{font-size:19px; margin-bottom:6px;}
.au-sub{color:var(--ink-soft); font-size:15px; margin-bottom:18px;}
.au-tabs{display:flex; gap:4px; border-bottom:1px solid var(--border); margin-bottom:20px;}
.au-tabs button{background:none; border:0; border-bottom:3px solid transparent; margin-bottom:-1px; padding:10px 14px; font-weight:700; font-size:15.5px; color:var(--ink-soft); cursor:pointer; font-family:inherit;}
.au-tabs button.is-on{color:var(--ink); border-bottom-color:var(--glow);}
.au-form{display:flex; flex-direction:column; gap:14px;}
.au-form label{font-size:14px; font-weight:700; display:block; margin-bottom:6px; color:var(--ink);}
.au-form input:not([type=checkbox]),.au-form textarea{width:100%; background:var(--surface-2); border:1.5px solid var(--border-strong); border-radius:10px; padding:12px 14px; font-size:15px; color:var(--ink); outline:none; font-family:inherit;}
.au-form input:focus,.au-form textarea:focus{border-color:var(--glow);}
.au-form textarea{min-height:84px; resize:vertical;}
.au-form .err{margin-top:0;}
.au-form .btn{width:100%; margin-top:2px;}
.au-form.au-inline .btn{width:auto; align-self:flex-start;}
.au-pw{position:relative;}
.au-pw input{padding-right:70px !important;}
.au-eye{position:absolute; right:8px; top:50%; transform:translateY(-50%); background:none; border:0; color:var(--ink-soft); font-weight:700; font-size:13px; cursor:pointer; padding:6px 8px; border-radius:6px; font-family:inherit;}
.au-eye:hover{color:var(--ink);}
.au-hp{position:absolute !important; left:-10000px; top:auto; width:1px; height:1px; overflow:hidden; opacity:0; pointer-events:none;}
.au-oauth{display:flex; flex-direction:column; gap:10px;}
.au-oauth .btn{width:100%; font-size:15px; padding:12px 18px;}
.au-divider{display:flex; align-items:center; gap:12px; color:var(--ink-faint); font-size:13px; font-weight:600; margin:16px 0;}
.au-divider::before,.au-divider::after{content:""; flex:1; height:1px; background:var(--border);}
.au-notice{display:none; background:var(--glow-2); color:var(--watch-text); border-radius:10px; padding:11px 14px; font-size:14.5px; line-height:1.5; margin-bottom:16px;}
.au-notice.show{display:block;}
.au-notice.good{background:var(--good-bg); color:var(--good);}
.au-notice.bad{background:var(--serious-bg); color:var(--serious);}
.au-links{font-size:14.5px; color:var(--ink-soft); text-align:center; margin-top:4px;}
.au-links a,.au-linkbtn{color:var(--ink); font-weight:700; text-decoration:underline; text-underline-offset:3px; text-decoration-color:var(--glow); background:none; border:0; cursor:pointer; font-size:inherit; font-family:inherit; padding:0;}
.au-fine{font-size:13.5px; color:var(--ink-faint); line-height:1.5;}
.au-actions{display:flex; gap:10px; flex-wrap:wrap; margin-top:18px;}
.au-actions .btn{width:auto;}
.au-done{text-align:center;}
.au-done .au-mark{width:54px; height:54px; border-radius:50%; background:var(--good-bg); color:var(--good); display:grid; place-items:center; margin:4px auto 16px;}
.au-done p{color:var(--ink-soft); font-size:15.5px; margin-bottom:18px;}
#authSlot{position:relative; display:inline-flex; align-items:center; flex:none;}
.au-signin{padding:9px 16px; font-size:14.5px; border-radius:10px; box-shadow:none;}
.au-userbtn{display:inline-flex; align-items:center; gap:9px; background:var(--surface); border:1px solid var(--border-strong); border-radius:100px; padding:3px 10px 3px 3px; cursor:pointer; font-weight:700; font-size:14px; color:var(--ink); font-family:inherit; max-width:220px;}
.au-userbtn:hover{border-color:var(--glow);}
.au-userbtn .au-uname{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.au-avatar{width:30px; height:30px; border-radius:50%; background:var(--glow-2); color:var(--ink); display:grid; place-items:center; font-weight:700; font-size:12.5px; overflow:hidden; flex:none; letter-spacing:.02em;}
.au-avatar img{width:100%; height:100%; object-fit:cover; display:block;}
.au-avatar.lg{width:52px; height:52px; font-size:18px;}
.au-menu{position:absolute; right:0; top:calc(100% + 8px); min-width:210px; background:var(--surface); border:1px solid var(--border); border-radius:14px; box-shadow:0 18px 40px -18px rgb(var(--shadow)/.45); padding:8px; display:none; z-index:60; text-align:left;}
.au-menu.show{display:block; animation:fade .2s var(--step);}
.au-menu a,.au-menu button{display:block; width:100%; text-align:left; background:none; border:0; padding:10px 12px; border-radius:9px; font-size:14.5px; font-weight:600; color:var(--ink); text-decoration:none; cursor:pointer; font-family:inherit;}
.au-menu a:hover,.au-menu button:hover{background:var(--surface-2);}
.au-menu-head{padding:6px 12px 10px; border-bottom:1px solid var(--border); margin-bottom:6px; font-size:12.5px; color:var(--ink-faint); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.au-banner{position:relative; z-index:2; background:var(--glow-2); border-bottom:1px solid color-mix(in srgb,var(--glow) 45%,transparent); color:var(--watch-text); font-size:14.5px; line-height:1.5;}
.au-banner .wrap{display:flex; align-items:center; gap:14px; padding-top:10px; padding-bottom:10px; flex-wrap:wrap;}
.au-banner span{flex:1; min-width:220px;}
.au-banner .btn{padding:8px 14px; font-size:13.5px; border-radius:9px; background:var(--surface); border-color:color-mix(in srgb,var(--glow) 60%,transparent); color:var(--ink);}
.au-grid{display:grid; grid-template-columns:1.15fr .85fr; gap:20px; margin-bottom:20px; align-items:start;}
.au-stack{display:flex; flex-direction:column; gap:20px;}
.au-chips{display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;}
.au-chip{display:inline-flex; align-items:center; gap:7px; background:var(--surface-2); border:1px solid var(--border); border-radius:100px; padding:6px 12px; font-size:13.5px; font-weight:600; color:var(--ink);}
.au-who{display:flex; align-items:center; gap:14px; margin-bottom:16px;}
.au-who .n{font-weight:700; font-size:17px;}
.au-who .e{font-size:14px; color:var(--ink-soft); word-break:break-word;}
.au-status{display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:700; padding:4px 10px; border-radius:100px; margin-top:6px;}
.au-status.good{background:var(--good-bg); color:var(--good);}
.au-status.watch{background:var(--watch-bg); color:var(--watch-text);}
.au-list{display:flex; flex-direction:column;}
.au-row{display:flex; align-items:center; gap:14px; padding:13px 0; border-top:1px solid var(--border); text-decoration:none; color:inherit;}
.au-row:first-child{border-top:0;}
.au-row:hover .t{text-decoration:underline; text-underline-offset:3px; text-decoration-color:var(--glow);}
.au-row .t{flex:1; min-width:0; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.au-row .s{font-size:13.5px; color:var(--ink-soft); white-space:nowrap;}
.au-row .d{font-size:13.5px; color:var(--ink-faint); white-space:nowrap;}
.au-row .sev-chip{min-width:34px; justify-content:center;}
.au-empty{color:var(--ink-soft); font-size:15px; background:var(--surface-2); border:1px dashed var(--border-strong); border-radius:12px; padding:18px; text-align:center;}
.au-empty a{font-weight:700;}
@media(max-width:820px){ .au-grid{grid-template-columns:1fr;} }
@media(max-width:540px){ .au-userbtn .au-uname{display:none;} .au-userbtn{padding-right:8px;} .au-card{padding:22px;} .au-row .d{display:none;} }
@media print{ .au-banner{display:none !important;} }
`;
  document.head.appendChild(style);

  /* ---------------- screens ---------------- */
  const host = $("#screens-extra") || document.body;
  host.insertAdjacentHTML("beforeend", `
<div class="screen" id="screen-auth">
  <section class="au-page"><div class="wrap"><div class="au-card au-narrow">
    <p class="eyebrow">Your account</p>
    <div class="au-tabs" role="tablist" id="auTabs">
      <button type="button" role="tab" data-tab="login" id="auTabLogin">Sign in</button>
      <button type="button" role="tab" data-tab="signup" id="auTabSignup">Create an account</button>
    </div>
    <p class="au-notice" id="auNotice" role="status"></p>
    <div id="auOauth"></div>
    <form class="au-form" id="auLoginForm" novalidate>
      <div><label for="auLoginEmail">Email</label><input id="auLoginEmail" type="email" autocomplete="email" inputmode="email" required></div>
      ${pwFieldHtml("auLoginPw", "current-password", "Password")}
      <input class="au-hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
      <p class="err" id="auLoginErr"></p>
      <button class="btn btn-primary" type="submit" id="auLoginBtn">Sign in</button>
      <p class="au-links"><a href="/forgot" data-link>Forgot your password?</a></p>
    </form>
    <form class="au-form" id="auSignupForm" novalidate hidden>
      <div><label for="auSignupName">Name <span class="au-fine">(optional, shown next to your checkups)</span></label><input id="auSignupName" type="text" autocomplete="name" maxlength="80"></div>
      <div><label for="auSignupEmail">Email</label><input id="auSignupEmail" type="email" autocomplete="email" inputmode="email" required></div>
      ${pwFieldHtml("auSignupPw", "new-password", "Password")}
      <p class="au-fine">Use at least 10 characters. Your email stays private; only your name appears on checkups you run.</p>
      <input class="au-hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
      <p class="err" id="auSignupErr"></p>
      <button class="btn btn-primary" type="submit" id="auSignupBtn">Create account</button>
      <p class="au-links">By creating an account you agree to our <a href="/terms">terms</a> and <a href="/privacy">privacy</a> pages.</p>
    </form>
    <div class="au-done" id="auSignupDone" hidden>
      <div class="au-mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></div>
      <h2>Check your email</h2>
      <p id="auSignupDoneMsg"></p>
      <button class="btn btn-primary" type="button" id="auSignupContinue">Continue</button>
    </div>
  </div></div></section>
</div>

<div class="screen" id="screen-forgot">
  <section class="au-page"><div class="wrap"><div class="au-card au-narrow">
    <p class="eyebrow">Password help</p>
    <h2>Reset your password</h2>
    <p class="au-sub">Enter your email and we'll send you a link to choose a new password. The link works for one hour.</p>
    <p class="au-notice" id="auForgotNotice" role="status"></p>
    <form class="au-form" id="auForgotForm" novalidate>
      <div><label for="auForgotEmail">Email</label><input id="auForgotEmail" type="email" autocomplete="email" inputmode="email" required></div>
      <p class="err" id="auForgotErr"></p>
      <button class="btn btn-primary" type="submit" id="auForgotBtn">Send the link</button>
      <p class="au-links"><a href="/login" data-link>Back to sign in</a></p>
    </form>
  </div></div></section>
</div>

<div class="screen" id="screen-reset">
  <section class="au-page"><div class="wrap"><div class="au-card au-narrow">
    <p class="eyebrow">Password help</p>
    <h2>Choose a new password</h2>
    <p class="au-sub">Pick something you don't use anywhere else. Signing in elsewhere will be cleared for safety.</p>
    <p class="au-notice" id="auResetNotice" role="status"></p>
    <form class="au-form" id="auResetForm" novalidate>
      ${pwFieldHtml("auResetPw", "new-password", "New password")}
      ${pwFieldHtml("auResetPw2", "new-password", "Type it again")}
      <p class="au-fine">Use at least 10 characters.</p>
      <p class="err" id="auResetErr"></p>
      <button class="btn btn-primary" type="submit" id="auResetBtn">Save new password</button>
    </form>
    <p class="au-links" id="auResetLinks" hidden><a href="/forgot" data-link>Request a new link</a></p>
  </div></div></section>
</div>

<div class="screen" id="screen-account">
  <section class="au-page"><div class="wrap" id="auAccountWrap"></div></section>
</div>

<div class="screen" id="screen-auth-error">
  <section class="au-page"><div class="wrap"><div class="au-card au-narrow">
    <p class="eyebrow">Sign in</p>
    <h2>That didn't go through</h2>
    <p class="au-sub" id="auErrorMsg"></p>
    <div class="au-actions">
      <a class="btn btn-primary" href="/login" data-link>Go to sign in</a>
      <a class="btn btn-ghost" href="/" data-link>Home</a>
    </div>
  </div></div></section>
</div>
`);

  /* ---------------- link handling (SPA links marked with data-link) ---------------- */
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[data-link]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    goTo(a.getAttribute("href"));
  });

  /* ---------------- topbar slot + menu ---------------- */
  function closeMenu() {
    const m = $("#auMenu"); const b = $("#auUserBtn");
    if (m) m.classList.remove("show");
    if (b) b.setAttribute("aria-expanded", "false");
  }
  function renderSlot(user) {
    const slot = $("#authSlot");
    if (!slot) return;
    if (!user) {
      slot.innerHTML = `<a class="btn btn-primary au-signin" id="auSignInLink" href="/login">Sign in</a>`;
      $("#auSignInLink").addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const next = nextForHere();
        goTo("/login" + (next !== "/" ? "?next=" + encodeURIComponent(next) : ""));
      });
      return;
    }
    slot.innerHTML = `
      <button type="button" class="au-userbtn" id="auUserBtn" aria-haspopup="true" aria-expanded="false" aria-controls="auMenu">
        ${avatarHtml(user)}<span class="au-uname">${esc(displayName(user))}</span>${ICON_CHEVRON}
      </button>
      <div class="au-menu" id="auMenu" role="menu">
        <div class="au-menu-head" title="${esc(user.email)}">${esc(user.email)}</div>
        <a href="/account" data-link role="menuitem">Account</a>
        <a href="/account?tab=checkups" data-link role="menuitem">My checkups</a>
        <a href="/bulletin" data-link role="menuitem">Bulletin</a>
        <button type="button" id="auSignOut" role="menuitem">Sign out</button>
      </div>`;
    bindAvatarFallback(slot, user);
    const btn = $("#auUserBtn"); const menu = $("#auMenu");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("show");
      menu.classList.toggle("show", open);
      btn.setAttribute("aria-expanded", String(open));
    });
    $("#auSignOut").addEventListener("click", signOut);
  }
  document.addEventListener("click", (e) => { const slot = $("#authSlot"); if (slot && !slot.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  async function signOut() {
    closeMenu();
    try { await S.api("/api/auth/logout", { method: "POST", body: {} }); } catch {}
    await S.refreshMe();
    S.toast("You're signed out.");
    // The user listener already moves off the account screen; only navigate if we are elsewhere.
    if (location.pathname !== "/") goTo("/");
  }

  /* ---------------- unverified banner ---------------- */
  function renderBanner(user) {
    let b = $("#auBanner");
    if (!user || user.emailVerified) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement("div");
      b.id = "auBanner"; b.className = "au-banner";
      const top = $(".topbar");
      if (top) top.insertAdjacentElement("afterend", b); else document.body.prepend(b);
    }
    b.innerHTML = `<div class="wrap"><span><b>Confirm your email</b> to run checkups and post. We sent a link to ${esc(user.email)}. Not there? Check your spam folder.</span><button type="button" class="btn btn-ghost" id="auResend">Resend</button></div>`;
    $("#auResend").addEventListener("click", resendVerify);
  }
  async function resendVerify(e) {
    const btn = e.currentTarget;
    busy(btn, true, "Sending...");
    try {
      const data = await S.api("/api/auth/verify/resend", { method: "POST", body: {} });
      const message = (data && data.message) || "";
      S.toast(message || "We sent a new confirmation email.");
      if (/already confirmed/i.test(message)) {
        // Confirmed in another tab or on another device; pull the fresh user so the banner goes away.
        await S.refreshMe();
        busy(btn, false);
        return;
      }
      btn.textContent = "Sent";
      setTimeout(() => busy(btn, false), 30000);
    } catch (err) {
      S.toast(err.message || "We couldn't send that just now. Please try again in a bit.");
      busy(btn, false);
    }
  }

  /* ---------------- login / signup ---------------- */
  const state = { next: "/", tab: "login" };

  function setTab(tab) {
    state.tab = tab;
    $("#auTabLogin").classList.toggle("is-on", tab === "login");
    $("#auTabSignup").classList.toggle("is-on", tab === "signup");
    $("#auTabLogin").setAttribute("aria-selected", String(tab === "login"));
    $("#auTabSignup").setAttribute("aria-selected", String(tab === "signup"));
    $("#auLoginForm").hidden = tab !== "login";
    $("#auSignupForm").hidden = tab !== "signup";
    $("#auSignupDone").hidden = true;
    $("#auOauth").innerHTML = oauthButtonsHtml(state.next);
    $("#auOauth").hidden = false;
  }
  function showAuth(tab, q) {
    state.next = safeNext(q.get("next") || "/");
    if (S.user) {
      // Already signed in (for example a stale confirmation link after signup). Say what
      // happened, then replace this entry so Back does not bounce through /login again.
      if (flags.error) { S.toast(errorText(flags.error)); flags.error = ""; }
      goTo(state.next, true);
      return;
    }
    setTab(tab);
    const notice = $("#auNotice");
    if (flags.error) {
      notice.textContent = errorText(flags.error);
      notice.className = "au-notice show";
      flags.error = "";
    } else {
      notice.className = "au-notice";
      notice.textContent = "";
    }
    showErr($("#auLoginErr"), ""); showErr($("#auSignupErr"), "");
    S.showScreen("screen-auth");
    focusFirst(tab === "login" ? $("#auLoginForm") : $("#auSignupForm"));
  }
  S.route(/^\/login\/?$/, (_m, q) => showAuth("login", q));
  S.route(/^\/signup\/?$/, (_m, q) => showAuth("signup", q));

  $("#auTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    history.replaceState(null, "", "/" + b.dataset.tab + location.search);
    setTab(b.dataset.tab);
    focusFirst(b.dataset.tab === "login" ? $("#auLoginForm") : $("#auSignupForm"));
  });
  pwToggle($("#auLoginPw")); pwToggle($("#auSignupPw")); pwToggle($("#auResetPw")); pwToggle($("#auResetPw2"));

  $("#auLoginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#auLoginErr");
    const email = $("#auLoginEmail").value.trim().toLowerCase();
    const password = $("#auLoginPw").value;
    const website = $("#auLoginForm input[name=website]").value;
    if (!isEmail(email)) return showErr(err, "Please enter your email address.");
    if (!password) return showErr(err, "Please enter your password.");
    showErr(err, "");
    const btn = $("#auLoginBtn");
    busy(btn, true, "Signing in...");
    try {
      await S.api("/api/auth/login", { method: "POST", body: { email, password, website } });
      const user = await S.refreshMe();
      if (!user) { showErr(err, "You're signed in, but we couldn't load your account. Please reload the page."); return; }
      $("#auLoginPw").value = "";
      S.toast("Welcome back, " + displayName(user) + ".");
      goTo(state.next);
    } catch (e2) {
      showErr(err, e2.message);
    } finally { busy(btn, false); }
  });

  $("#auSignupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#auSignupErr");
    const name = $("#auSignupName").value.trim();
    const email = $("#auSignupEmail").value.trim().toLowerCase();
    const password = $("#auSignupPw").value;
    const website = $("#auSignupForm input[name=website]").value;
    if (!isEmail(email)) return showErr(err, "Please enter a valid email address.");
    if (password.length < 10) return showErr(err, "Please use at least 10 characters for your password.");
    showErr(err, "");
    const btn = $("#auSignupBtn");
    busy(btn, true, "Creating your account...");
    try {
      const data = await S.api("/api/auth/signup", { method: "POST", body: { email, password, name: name || undefined, website } });
      const user = await S.refreshMe();
      $("#auSignupPw").value = "";
      $("#auSignupForm").hidden = true;
      $("#auOauth").hidden = true;
      let msg = data.message || "Check your email to confirm your account.";
      if (user) msg += " You're signed in already; confirming your email unlocks checkups and posting.";
      $("#auSignupDoneMsg").textContent = msg;
      $("#auSignupDone").hidden = false;
      window.scrollTo({ top: 0 });
    } catch (e2) {
      showErr(err, e2.message);
    } finally { busy(btn, false); }
  });
  $("#auSignupContinue").addEventListener("click", () => goTo(state.next));

  /* ---------------- forgot ---------------- */
  S.route(/^\/forgot\/?$/, () => {
    const n = $("#auForgotNotice"); n.className = "au-notice"; n.textContent = "";
    showErr($("#auForgotErr"), "");
    $("#auForgotForm").hidden = false;
    if (S.user && S.user.email && !$("#auForgotEmail").value) $("#auForgotEmail").value = S.user.email;
    S.showScreen("screen-forgot");
    focusFirst($("#auForgotForm"));
  });
  $("#auForgotForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#auForgotErr");
    const email = $("#auForgotEmail").value.trim().toLowerCase();
    if (!isEmail(email)) return showErr(err, "Please enter your email address.");
    showErr(err, "");
    const btn = $("#auForgotBtn");
    busy(btn, true, "Sending...");
    try {
      const data = await S.api("/api/auth/forgot", { method: "POST", body: { email } });
      const n = $("#auForgotNotice");
      n.textContent = (data.message || "If that email has an account, a reset link is on its way.") + " It can take a minute to arrive.";
      n.className = "au-notice good show";
      $("#auForgotForm").hidden = true;
    } catch (e2) {
      showErr(err, e2.message);
    } finally { busy(btn, false); }
  });

  /* ---------------- reset ---------------- */
  let resetToken = "";
  S.route(/^\/reset\/?$/, (_m, q) => {
    resetToken = q.get("token") || "";
    const claimed = q.get("claimed") === "1";
    if (q.has("token")) history.replaceState(null, "", "/reset");
    const n = $("#auResetNotice"); n.className = "au-notice"; n.textContent = "";
    showErr($("#auResetErr"), "");
    $("#auResetPw").value = ""; $("#auResetPw2").value = "";
    const missing = !resetToken;
    $("#auResetForm").hidden = missing;
    $("#auResetLinks").hidden = !missing;
    if (missing) { n.textContent = "This link is missing its reset code. Please request a new one below."; n.className = "au-notice show"; }
    if (claimed && !missing) { n.textContent = "Your email is confirmed. Choose a password to finish setting up your account."; n.className = "au-notice show"; }
    S.showScreen("screen-reset");
    if (!missing) focusFirst($("#auResetForm"));
  });
  $("#auResetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#auResetErr");
    const p1 = $("#auResetPw").value; const p2 = $("#auResetPw2").value;
    if (p1.length < 10) return showErr(err, "Please use at least 10 characters.");
    if (p1 !== p2) return showErr(err, "Those two passwords don't match.");
    showErr(err, "");
    const btn = $("#auResetBtn");
    busy(btn, true, "Saving...");
    try {
      await S.api("/api/auth/reset", { method: "POST", body: { token: resetToken, password: p1 } });
      resetToken = "";
      $("#auResetPw").value = ""; $("#auResetPw2").value = "";
      await S.refreshMe();
      S.toast("Your password is updated.");
      goTo("/");
    } catch (e2) {
      const n = $("#auResetNotice");
      n.textContent = e2.message; n.className = "au-notice bad show";
      $("#auResetLinks").hidden = false;
    } finally { busy(btn, false); }
  });

  /* ---------------- account ---------------- */
  let accountRenderedFor = null;
  S.route(/^\/account\/?$/, (_m, q) => {
    if (!S.requireLogin("/account" + (q.get("tab") ? "?tab=" + encodeURIComponent(q.get("tab")) : ""))) return;
    renderAccount(S.user);
    S.showScreen("screen-account");
    if (q.get("tab") === "checkups") {
      setTimeout(() => { const el = $("#au-checkups"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
    }
  });

  function renderAccount(user) {
    accountRenderedFor = user.id;
    const wrap = $("#auAccountWrap");
    const providers = Array.isArray(user.providers) ? user.providers : [];
    const pwOk = hasPassword(user);
    const providerChips = providers.length
      ? providers.map((p) => `<span class="au-chip">${p === "google" ? ICON_GOOGLE : p === "github" ? ICON_GITHUB : ""} ${esc(PROVIDER_LABEL[p] || p)}</span>`).join("")
      : `<span class="au-chip">Email and password</span>`;
    wrap.innerHTML = `
      <div class="report-top">
        <a class="back-btn" href="/" data-link><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> Home</a>
        <span class="eyebrow" style="margin:0;">Your account</span>
      </div>
      <div class="au-grid">
        <div class="au-stack">
          <div class="au-card">
            <div class="au-who">
              ${avatarHtml(user).replace('class="au-avatar"', 'class="au-avatar lg"')}
              <div>
                <div class="n">${esc(displayName(user))}</div>
                <div class="e">${esc(user.email)}</div>
                ${user.emailVerified
                  ? `<span class="au-status good">Email confirmed</span>`
                  : `<span class="au-status watch">Email not confirmed yet</span>`}
              </div>
            </div>
            <h3>Profile</h3>
            <p class="au-sub">Your name shows next to checkups you run and posts you make. The rest is optional.</p>
            <form class="au-form au-inline" id="auProfileForm" novalidate>
              <div><label for="auPName">Name</label><input id="auPName" type="text" maxlength="80" autocomplete="name" value="${esc(user.name || "")}"></div>
              <div><label for="auPAbout">About <span class="au-fine">(optional)</span></label><textarea id="auPAbout" maxlength="400" placeholder="A line or two about you or your organization">${esc(user.about || "")}</textarea></div>
              <div><label for="auPContact">Contact <span class="au-fine">(optional, shown when you offer help)</span></label><input id="auPContact" type="text" maxlength="200" placeholder="Email or website link" value="${esc(user.contact || "")}"></div>
              <p class="err" id="auProfileErr"></p>
              <button class="btn btn-primary" type="submit" id="auProfileBtn">Save profile</button>
            </form>
          </div>
          <div class="au-card">
            <h3>Password</h3>
            ${pwOk ? `
            <p class="au-sub">Changing your password keeps you signed in here.</p>
            <form class="au-form au-inline" id="auPwForm" novalidate>
              ${pwFieldHtml("auPwCurrent", "current-password", "Current password")}
              ${pwFieldHtml("auPwNext", "new-password", "New password")}
              <p class="au-fine">Use at least 10 characters.</p>
              <p class="err" id="auPwErr"></p>
              <button class="btn btn-ghost" type="submit" id="auPwBtn">Update password</button>
            </form>` : `
            <p class="au-sub">You sign in with ${esc(providers.map((p) => PROVIDER_LABEL[p] || p).join(" or ") || "a linked account")}, so there is no password to change here.</p>`}
          </div>
        </div>
        <div class="au-stack">
          <div class="au-card">
            <h3>How you sign in</h3>
            <p class="au-sub">Ways you can sign in to this account.</p>
            <div class="au-chips">${providerChips}</div>
            ${user.emailVerified ? "" : `<p class="au-fine" style="margin-top:14px;">Your email isn't confirmed yet. Confirming it lets you run checkups and post to the bulletin.</p><div class="au-actions" style="margin-top:10px;"><button type="button" class="btn btn-ghost" id="auResendAcct">Resend confirmation email</button></div>`}
          </div>
          <div class="au-card">
            <h3>Sign out</h3>
            <p class="au-sub">Signs you out on this device only.</p>
            <button type="button" class="btn btn-ghost" id="auSignOutAcct">Sign out</button>
          </div>
        </div>
      </div>
      <div class="au-card" id="au-checkups">
        <h3>My checkups</h3>
        <p class="au-sub">Every checkup you've run. All checkups are public, so these links can be shared.</p>
        <div class="au-list" id="auCheckups"><p class="au-fine">Loading your checkups...</p></div>
      </div>`;
    bindAvatarFallback(wrap, user);

    $("#auProfileForm").addEventListener("submit", saveProfile);
    const pwForm = $("#auPwForm");
    if (pwForm) { pwForm.addEventListener("submit", changePassword); pwToggle($("#auPwCurrent")); pwToggle($("#auPwNext")); }
    const resend = $("#auResendAcct"); if (resend) resend.addEventListener("click", resendVerify);
    $("#auSignOutAcct").addEventListener("click", signOut);
    loadCheckups();
  }

  async function saveProfile(e) {
    e.preventDefault();
    const err = $("#auProfileErr");
    const body = { name: $("#auPName").value.trim(), about: $("#auPAbout").value.trim(), contact: $("#auPContact").value.trim() };
    if (body.name.length > 80) return showErr(err, "Please keep your name under 80 characters.");
    if (body.about.length > 400) return showErr(err, "Please keep the about text under 400 characters.");
    if (body.contact.length > 200) return showErr(err, "Please keep the contact under 200 characters.");
    showErr(err, "");
    const btn = $("#auProfileBtn");
    busy(btn, true, "Saving...");
    try {
      await S.api("/api/me", { method: "PATCH", body });
      await S.refreshMe();
      const u = S.user;
      if (u) {
        // The user listener only rebuilds this screen for a different user, so refresh the header here.
        const n = $("#auAccountWrap .au-who .n");
        if (n) n.textContent = displayName(u);
        const av = $("#auAccountWrap .au-who .au-avatar");
        if (av && !av.querySelector("img")) av.textContent = initials(u);
      }
      S.toast("Profile saved.");
    } catch (e2) {
      showErr(err, e2.message);
    } finally { busy(btn, false); }
  }

  async function changePassword(e) {
    e.preventDefault();
    const err = $("#auPwErr");
    const current = $("#auPwCurrent").value; const next = $("#auPwNext").value;
    if (!current) return showErr(err, "Please enter your current password.");
    if (next.length < 10) return showErr(err, "Please use at least 10 characters for the new password.");
    if (current === next) return showErr(err, "The new password is the same as the current one.");
    showErr(err, "");
    const btn = $("#auPwBtn");
    busy(btn, true, "Updating...");
    try {
      await S.api("/api/auth/password", { method: "POST", body: { current, next } });
      $("#auPwCurrent").value = ""; $("#auPwNext").value = "";
      S.toast("Password updated.");
    } catch (e2) {
      showErr(err, e2.message);
    } finally { busy(btn, false); }
  }

  async function loadCheckups() {
    const box = $("#auCheckups");
    if (!box) return;
    try {
      const data = await S.api("/api/reports?mine=1&limit=50");
      const rows = (data && data.reports) || [];
      if (!box.isConnected) return;
      if (!rows.length) {
        box.innerHTML = `<div class="au-empty">You haven't run a checkup yet. <a href="/" data-link>Check a website</a> and it will show up here.</div>`;
        return;
      }
      box.innerHTML = rows.map((r) => {
        const grade = String(r.grade || "?").toUpperCase();
        return `<a class="au-row" href="/r/${esc(r.id)}">
          <span class="sev-chip ${gradeClass(grade)}">${esc(grade)}</span>
          <span class="t">${esc(r.target || "")}</span>
          ${typeof r.score === "number" ? `<span class="s">${esc(r.score)} / 100</span>` : ""}
          <span class="d">${esc(fmtDate(r.created_at))}</span>
        </a>`;
      }).join("");
    } catch (e2) {
      if (box.isConnected) box.innerHTML = `<div class="au-empty">${esc(e2.message || "We couldn't load your checkups just now.")}</div>`;
    }
  }

  /* ---------------- auth error ---------------- */
  S.route(/^\/auth-error\/?$/, (_m, q) => {
    const code = flags.error || q.get("error") || q.get("reason") || "";
    flags.error = "";
    $("#auErrorMsg").textContent = errorText(code);
    S.showScreen("screen-auth-error");
  });

  /* ---------------- user changes ---------------- */
  // The "/" route belongs to community-ui (it also refreshes the recent checkups). goTo()
  // falls back to the home screen on its own when nobody has registered it.
  renderSlot(S.user);
  S.onUser((user) => {
    renderSlot(user);
    renderBanner(user);
    const acct = document.getElementById("screen-account");
    if (acct && acct.classList.contains("is-active")) {
      if (!user) goTo("/", true);
      else if (user.id !== accountRenderedFor) renderAccount(user);
    }
  });

  /* ---------------- one-time flags after boot ---------------- */
  S.ready.then(() => {
    // /api/me can finish before this script runs, in which case the listener above
    // never fired. Render from the settled state so the banner and slot are right.
    renderSlot(S.user);
    renderBanner(S.user);
    if (flags.verified) {
      flags.verified = false;
      S.toast("Email confirmed. Thanks!");
    }
    if (flags.error && !/^\/(login|signup|auth-error)\/?$/.test(location.pathname)) {
      S.toast(errorText(flags.error));
      flags.error = "";
    }
  });
})();
