(function () {
  "use strict";

  var t = window.I18N.t;
  var root = document.documentElement;

  var TIMEOUT_MS = (parseFloat(root.getAttribute("data-session-timeout-min")) || 10) * 60 * 1000;
  var WARNING_MS = 60 * 1000;
  var AUTH = { login: "/api/auth/login", logout: "/api/auth/logout", me: "/api/auth/me" };
  var ROLE_AR = { "Professor": "أستاذة", "Postgraduate student": "طالبة دراسات عليا", "Researcher": "باحثة" };

  var K_SESSION = "ra-session", K_ACTIVITY = "ra-last-activity", K_REASON = "ra-logout-reason";
  var ls = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var $ = function (s) { return document.querySelector(s); };
  var SPRITE = document.body.getAttribute("data-sprite");
  var icon = function (n) { return '<svg class="icon icon-sm" aria-hidden="true"><use href="' + SPRITE + "#i-" + n + '"></use></svg>'; };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  function readSession() {
    try { var s = JSON.parse(ls.get(K_SESSION)); return s && s.username ? s : null; } catch (e) { return null; }
  }
  function lastActivity() { var v = parseInt(ls.get(K_ACTIVITY), 10); return isFinite(v) ? v : 0; }
  function remaining() { return TIMEOUT_MS - (Date.now() - lastActivity()); }
  function roleLabel(role) { return ROLE_AR[role] ? t(ROLE_AR[role]) : role; }

  var session = readSession();
  if (session && remaining() <= 0) {
    ls.del(K_SESSION);
    ls.del(K_ACTIVITY);
    try { sessionStorage.removeItem("ra-job"); sessionStorage.setItem(K_REASON, "timeout"); } catch (e) {}
    session = null;
  }

  function apiLogin(username, password) {
    return fetch(AUTH.login, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username, password: password }) })
      .then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (body) {
          var reason = ((body && body.errors) || [])[0] || {};
          var code = r.status === 401 ? "invalid"
            : r.status === 429 ? "locked"
            : r.status === 503 && /no accounts/i.test(reason.message || "") ? "noaccounts"
            : "unavailable";
          return Promise.reject(new Error(code));
        });
      });
  }
  function login(username, password) {
    return apiLogin(username, password).then(function (user) {
      session = { username: user.username, role: user.role, loginAt: Date.now() };
      ls.set(K_SESSION, JSON.stringify(session));
      touch(true);
      signedIn();
      return session;
    });
  }
  function logout(reason) {
    try { fetch(AUTH.logout, { method: "POST", credentials: "same-origin", keepalive: true }); } catch (e) {}
    ls.del(K_SESSION);
    ls.del(K_ACTIVITY);
    try {
      sessionStorage.removeItem("ra-job");
      sessionStorage.setItem(K_REASON, reason || "logout");
    } catch (e) {}
    location.reload();
  }

  var modalOpen = false, lastWrite = 0;
  function touch(force) {
    if (!session || (modalOpen && !force)) return;
    var now = Date.now();
    if (force || now - lastWrite > 1000) { lastWrite = now; ls.set(K_ACTIVITY, String(now)); }
  }
  ["click", "keydown", "scroll", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, function () { touch(false); }, { passive: true, capture: true });
  });
  window.addEventListener("storage", function (e) {
    if (e.key === K_SESSION && !e.newValue && session) location.reload();
  });

  var modal = $("#timeout-modal"), stayBtn = $("#stay-btn"), outBtn = $("#logout-now"), app = $(".app");
  var restoreFocus = null;
  function paintModal(ms) {
    $("#timeout-desc").textContent = t("ستنتهي جلستك خلال {s} ثانية بسبب عدم النشاط.", { s: Math.max(0, Math.ceil(ms / 1000)) });
  }
  function openModal(ms) {
    paintModal(ms);
    if (modalOpen) return;
    modalOpen = true;
    restoreFocus = document.activeElement;
    modal.hidden = false;
    app.setAttribute("inert", "");
    stayBtn.focus();
  }
  function closeModal() {
    if (!modalOpen) return;
    modalOpen = false;
    modal.hidden = true;
    app.removeAttribute("inert");
    if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
  }
  stayBtn.addEventListener("click", function () { touch(true); closeModal(); tick(); });
  outBtn.addEventListener("click", function () { logout("logout"); });
  modal.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); stayBtn.click(); }
    if (e.key === "Tab") {
      e.preventDefault();
      (document.activeElement === stayBtn ? outBtn : stayBtn).focus();
    }
  });

  var accBtn = $("#account-btn"), panel = $("#account-panel");
  function renderAccount() {
    if (!session) return;
    var initial = session.username.charAt(0).toUpperCase();
    $("#account-initial").textContent = initial;
    $("#account-name").textContent = session.username;
    accBtn.setAttribute("aria-label", t("حساب {u}", { u: session.username }));
    panel.innerHTML =
      '<div class="acct-head"><span class="avatar avatar-lg" aria-hidden="true">' + esc(initial) + "</span><div>" +
      '<p class="acct-name" id="account-title"><bdi>' + esc(session.username) + "</bdi></p>" +
      '<p class="acct-role">' + esc(roleLabel(session.role)) + "</p></div></div>" +
      '<dl class="acct-meta">' +
      "<div><dt>" + t("الدور") + "</dt><dd>" + esc(roleLabel(session.role)) + "</dd></div>" +
      "</dl>" +
      '<button class="btn btn-secondary" type="button" id="logout-btn" style="width:100%">' + icon("log-out") + t("تسجيل الخروج") + "</button>";
    $("#logout-btn").addEventListener("click", function () { logout("logout"); });
  }
  function togglePanel(open) {
    var show = open == null ? panel.hidden : open;
    panel.hidden = !show;
    accBtn.setAttribute("aria-expanded", String(show));
    if (show) { renderAccount(); $("#logout-btn").focus(); }
  }
  accBtn.addEventListener("click", function (e) { e.stopPropagation(); togglePanel(); });
  document.addEventListener("click", function (e) {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== accBtn) togglePanel(false);
  });
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { togglePanel(false); accBtn.focus(); }
  });

  function tick() {
    if (!session) return;
    var r = remaining();
    if (r <= 0) { logout("timeout"); return; }
    if (r <= WARNING_MS) openModal(r); else closeModal();
  }

  var form = $("#login-form"), err = $("#login-error"), notice = $("#login-notice");
  var noticeKey = null;
  function paintNotice() {
    if (noticeKey !== "logout") { notice.hidden = true; return; }
    notice.hidden = false;
    notice.querySelector("[data-notice-text]").textContent = t("تم تسجيل الخروج.");
  }
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var u = form.username.value, p = form.password.value, btn = form.querySelector('button[type="submit"]');
    err.textContent = "";
    if (!u.trim() || !p) { err.textContent = t("أدخل اسم المستخدم وكلمة المرور."); return; }
    btn.disabled = true;
    login(u, p).catch(function (ex) {
      err.textContent = ex && ex.message === "noaccounts" ? t("لا توجد حسابات على الخادم بعد. أنشئها بالأمر: python manage_users.py add <username>")
        : ex && ex.message === "unavailable" ? t("تعذّر الوصول إلى خدمة تسجيل الدخول.")
        : ex && ex.message === "locked" ? t("محاولات فاشلة كثيرة؛ حاول مجددًا بعد بضع دقائق.")
        : t("اسم المستخدم أو كلمة المرور غير صحيحة.");
      form.password.value = "";
      form.password.focus();
    }).then(function () { btn.disabled = false; });
  });

  function signedIn() {
    root.classList.remove("auth-required");
    noticeKey = null;
    renderAccount();
    tick();
    document.dispatchEvent(new CustomEvent("ra:login", { detail: session }));
    var main = $("#main");
    if (main) main.focus({ preventScroll: true });
  }

  document.addEventListener("ra:langchange", function () {
    renderAccount();
    paintNotice();
    if (modalOpen) paintModal(remaining());
  });

  window.RAAuth = {
    current: function () { return session; },
    logout: logout,
    remainingMs: remaining
  };

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (response) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (response.status === 401 && session && url.indexOf("/api/") !== -1 && url.indexOf(AUTH.login) === -1) logout("timeout");
      return response;
    });
  };
  if (session) {
    nativeFetch(AUTH.me, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { if (r.status === 401) logout("timeout"); })
      .catch(function () {});
  }

  setInterval(tick, 1000);
  if (session) {
    root.classList.remove("auth-required");
    renderAccount();
    tick();
  } else {
    root.classList.add("auth-required");
    try { noticeKey = sessionStorage.getItem(K_REASON); sessionStorage.removeItem(K_REASON); } catch (e) {}
    paintNotice();
    setTimeout(function () { form.username.focus(); }, 0);
  }
})();
