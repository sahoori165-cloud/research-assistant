(function () {
  "use strict";

  var STORAGE_KEY = "ra-lang";
  var LANGS = {
    ar: { dir: "rtl" },
    en: { dir: "ltr" }
  };
  var DICTS = window.I18N_DICTS || {};
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var missing = {};
  var current = "ar";
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved && has(LANGS, saved)) current = saved;
  } catch (e) {}

  function t(src, vars) {
    var s = String(src == null ? "" : src);
    var out = s;
    if (current !== "ar") {
      var m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
      var key = m[2].replace(/\s+/g, " ");
      var dict = DICTS[current] || {};
      if (has(dict, key)) out = m[1] + dict[key] + m[3];
      else if (key) missing[key] = true;
    }
    if (vars) {
      out = out.replace(/\{(\w+)\}/g, function (all, k) { return has(vars, k) ? String(vars[k]) : all; });
    }
    return out;
  }

  var srcHTML = new WeakMap();
  var srcAttr = new WeakMap();
  function apply(root) {
    root = root || document;
    Array.prototype.forEach.call(root.querySelectorAll("[data-i18n]"), function (el) {
      if (!srcHTML.has(el)) srcHTML.set(el, el.innerHTML);
      el.innerHTML = t(srcHTML.get(el));
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-i18n-attr]"), function (el) {
      var names = el.getAttribute("data-i18n-attr").split(/\s+/);
      if (!srcAttr.has(el)) {
        var o = {};
        names.forEach(function (n) { o[n] = el.getAttribute(n); });
        srcAttr.set(el, o);
      }
      var orig = srcAttr.get(el);
      names.forEach(function (n) { if (orig[n] != null) el.setAttribute(n, t(orig[n])); });
    });
  }

  function paintButtons() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lang") === current));
    });
  }

  function set(lang) {
    if (!has(LANGS, lang)) return;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", LANGS[lang].dir);
    apply(document);
    paintButtons();
    document.dispatchEvent(new CustomEvent("ra:langchange", { detail: { lang: lang } }));
  }

  window.I18N = {
    t: t,
    apply: apply,
    set: set,
    lang: function () { return current; },
    dir: function () { return LANGS[current].dir; },
    missing: function () { return Object.keys(missing); }
  };

  document.documentElement.setAttribute("lang", current);
  document.documentElement.setAttribute("dir", LANGS[current].dir);
  apply(document);
  paintButtons();
  Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"), function (b) {
    b.addEventListener("click", function () { set(b.getAttribute("data-lang")); });
  });
})();
