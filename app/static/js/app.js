(function () {
  "use strict";

  var SPRITE = document.body.getAttribute("data-sprite");
  var I18N = window.I18N;
  var t = I18N.t;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var icon = function (name, cls) {
    return '<svg class="' + (cls || "icon") + '" aria-hidden="true"><use href="' + SPRITE + "#i-" + name + '"></use></svg>';
  };
  var NF = new Intl.NumberFormat("en-US");
  var num = function (n) { return '<span class="num">' + NF.format(n) + "</span>"; };
  var yr = function (y) { return '<span class="num">' + String(y) + "</span>"; };
  var ltr = function (s, extra) { return '<bdi dir="ltr" class="en' + (extra ? " " + extra : "") + '">' + esc(s) + "</bdi>"; };
  var bareDoi = function (doi) { return String(doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""); };
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };
  var papersN = function (n) {
    if (I18N.lang() === "en") return num(n) + (n === 1 ? " paper" : " papers");
    if (n === 1) return "ورقة واحدة";
    if (n === 2) return "ورقتان";
    if (n >= 3 && n <= 10) return num(n) + " أوراق";
    return num(n) + " ورقة";
  };

  var NO_SUMMARY = "لا تتوفر بيانات موثوقة كافية لإنشاء ملخص لهذا المحور.";

  var ROUTES = {
    dashboard: "لوحة التحكم",
    search: "البحث الذكي",
    papers: "الأوراق البحثية",
    themes: "المحاور البحثية",
    trends: "الاتجاهات",
    integrity: "النزاهة العلمية",
    "export": "التصدير"
  };

  var STAGES = [
    { key: "retrieval", label: "الاسترجاع من OpenAlex" },
    { key: "deduplication", label: "إزالة التكرار" },
    { key: "reranking", label: "إعادة الترتيب الدلالي" },
    { key: "verification", label: "التحقق من النزاهة" },
    { key: "clustering", label: "التجميع والاتجاهات" },
    { key: "summarisation", label: "التلخيص المُسند" },
    { key: "results", label: "تجهيز النتائج للعرض" }
  ];
  var STAGE_LABEL = { queued: "في قائمة الانتظار", complete: "مكتملة", partial: "مكتملة جزئيًا", failed: "فشلت" };
  STAGES.forEach(function (s) { STAGE_LABEL[s.key] = s.label; });
  var stageLabel = function (key) { return STAGE_LABEL[key] ? t(STAGE_LABEL[key]) : key; };
  var stageIndex = function (key) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].key === key) return i;
    return -1;
  };

  var STATUS_ORDER = ["clean", "corrected", "expression_of_concern", "retracted", "unverified"];
  var STATUS = {
    clean: { label: "سليمة", icon: "shield-check", desc: "تم حلّ DOI ولم يُعثر على تصحيح أو سحب في أي مصدر." },
    corrected: { label: "مُصحَّحة", icon: "shield-ellipsis", desc: "يوجد إشعار تصحيح أو تصويب منشور للورقة." },
    expression_of_concern: { label: "تعبير عن قلق", icon: "shield-alert", desc: "نشر الناشر تعبيرًا عن قلق بشأن الورقة." },
    retracted: { label: "مسحوبة", icon: "shield-x", desc: "سُحبت الورقة وفق أحد المصادر، وتُستبعد من التلخيص." },
    unverified: { label: "غير متحقق منها", icon: "shield-question", desc: "تعذّر إكمال الفحص؛ وهذا ليس حكمًا بسلامة الورقة." }
  };
  var statusBadge = function (s) {
    var m = STATUS[s] || { label: s, icon: "info" };
    return '<span class="badge st-' + esc(s) + '">' + icon(m.icon) + esc(t(m.label)) + "</span>";
  };
  var SOURCE_LABEL = { openalex: "OpenAlex", crossref: "Crossref", retraction_watch: "Retraction Watch" };

  var state = {
    route: "dashboard",
    params: {},
    jobId: null,
    question: "",
    job: null,
    lastStage: null,
    stageMsgs: {},
    netError: null,
    expired: false,
    pollTimer: null,
    filters: { q: "", status: "all", theme: "all", sort: "rank" },
    filtersFor: null,
    rendered: {}
  };
  var payload = function () { return state.job && state.job.payload ? state.job.payload : null; };
  var isRunning = function () { return !!(state.jobId && !payload() && !state.expired); };
  var results = function () { var p = payload(); return (p && p.results) || []; };
  var clusters = function () { var p = payload(); return (p && p.clusters) || []; };
  var rankOf = {};
  var indexResults = function () {
    rankOf = {};
    results().forEach(function (p, i) { rankOf[p.id] = i + 1; });
  };
  var clusterById = function (id) {
    var cs = clusters();
    for (var i = 0; i < cs.length; i++) if (cs[i].cluster_id === id) return cs[i];
    return null;
  };
  var themeName = function (c) {
    return (c && c.synthesis && c.synthesis.cluster_label) || (c && c.label) || "";
  };

  function submitQuestion(form) {
    var input = form.querySelector('input[name="question"]');
    var msg = form.querySelector("[data-form-msg]");
    var btn = form.querySelector('button[type="submit"]');
    var q = input.value.trim();
    msg.textContent = "";
    msg.classList.remove("is-error");
    if (!q) {
      msg.textContent = t("اكتب سؤالًا بحثيًا أولًا.");
      msg.classList.add("is-error");
      input.focus();
      return;
    }
    btn.disabled = true;
    fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
      })
      .then(function (r) {
        if (!r.res.ok || !r.data.job_id) {
          var errs = (r.data.errors || []).map(function (e) { return e.message; }).join(t("؛ "));
          msg.innerHTML = t("تعذّر بدء المهمة: ") + ltr(errs || "HTTP " + r.res.status);
          msg.classList.add("is-error");
          return;
        }
        startJob(r.data.job_id, q);
        if (state.route !== "search") location.hash = "#/search";
      })
      .catch(function (err) {
        msg.innerHTML = t("تعذّر الاتصال بالخادم: ") + ltr(err.message);
        msg.classList.add("is-error");
      })
      .then(function () { btn.disabled = isRunning(); syncForms(); });
  }

  function startJob(id, question) {
    clearTimeout(state.pollTimer);
    state.jobId = id;
    state.question = question;
    state.job = { stage: "queued", progress: "Queued", payload: null };
    state.lastStage = null;
    state.stageMsgs = {};
    state.netError = null;
    state.expired = false;
    state.filters = { q: "", status: "all", theme: "all", sort: "rank" };
    state.filtersFor = null;
    store.set("ra-job", JSON.stringify({ id: id, q: question }));
    render();
    poll();
  }

  function poll() {
    clearTimeout(state.pollTimer);
    if (!state.jobId) return;
    fetch("/api/jobs/" + encodeURIComponent(state.jobId), { cache: "no-store" })
      .then(function (res) {
        if (res.status === 404) {
          state.expired = true;
          state.job = null;
          store.del("ra-job");
          render();
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        state.netError = null;
        state.job = data;
        if (STAGE_LABEL[data.stage] && stageIndex(data.stage) >= 0) {
          state.lastStage = data.stage;
          state.stageMsgs[data.stage] = data.progress;
        }
        if (data.payload) {
          data.payload.errors = dedupeErrors(data.payload.errors);
          data.errors = data.payload.errors;
          if (data.payload.question) state.question = data.payload.question;
          indexResults();
        }
        render();
        if (!data.payload) state.pollTimer = setTimeout(poll, 1200);
      })
      .catch(function (err) {
        state.netError = err.message || String(err);
        render();
        state.pollTimer = setTimeout(poll, 3000);
      });
  }

  function renderChrome() {
    var title = t(ROUTES[state.route]);
    $("#page-title").textContent = title;
    document.title = title + t(" — مساعد البحث والنشر الذكي");
    var crumbs = state.route === "dashboard"
      ? t('<li aria-current="page">الرئيسية</li>')
      : t('<li><a href="#/dashboard">الرئيسية</a></li><li aria-current="page">') + esc(title) + "</li>";
    $("#crumbs").innerHTML = crumbs;

    $$(".nav a[data-route]").forEach(function (a) {
      if (a.getAttribute("data-route") === state.route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    $$("[data-view]").forEach(function (v) { v.hidden = v.getAttribute("data-view") !== state.route; });

    var p = payload();
    var setBadge = function (route, n, label) {
      var b = $('[data-badge="' + route + '"]');
      if (!b) return;
      if (n > 0) { b.hidden = false; b.textContent = NF.format(n); b.setAttribute("aria-label", label); }
      else { b.hidden = true; b.textContent = ""; }
    };
    var flagged = results().filter(function (r) { return r.status !== "clean"; }).length;
    setBadge("papers", p ? results().length : 0, t("عدد الأوراق"));
    setBadge("themes", p ? clusters().length : 0, t("عدد المحاور"));
    setBadge("integrity", p ? flagged : 0, t("أوراق تحتاج انتباهًا"));

    var chip = $("#job-chip");
    chip.className = "job-chip";
    if (!state.jobId || state.expired || !state.job) {
      chip.hidden = true;
    } else if (isRunning()) {
      chip.hidden = false;
      chip.innerHTML = icon("loader-circle", "icon icon-sm spin") + t('<span class="job-text">جارٍ: ') + esc(stageLabel(state.job.stage)) + "</span>";
      chip.setAttribute("aria-label", t("المهمة قيد التنفيذ: ") + stageLabel(state.job.stage));
    } else {
      var fs = p.stage;
      chip.hidden = false;
      chip.classList.add(fs === "failed" ? "is-failed" : fs === "partial" ? "is-partial" : "is-complete");
      chip.innerHTML = icon(fs === "failed" ? "circle-x" : fs === "partial" ? "circle-alert" : "circle-check", "icon icon-sm") +
        t('<span class="job-text">المهمة ') + esc(stageLabel(fs)) + "</span>";
      chip.setAttribute("aria-label", t("حالة المهمة: ") + stageLabel(fs));
    }
  }

  function syncForms() {
    $$("[data-ask-form]").forEach(function (f) {
      var b = f.querySelector('button[type="submit"]');
      b.disabled = isRunning();
      b.title = isRunning() ? t("توجد مهمة قيد التنفيذ") : "";
    });
  }

  function emptyState(iconName, title, body, action) {
    return '<div class="card"><div class="empty"><span class="empty-icon">' + icon(iconName, "icon icon-lg") + "</span><h3>" +
      esc(title) + "</h3><p>" + body + "</p>" + (action || "") + "</div></div>";
  }
  function noDataState() {
    if (state.expired) {
      return '<div class="alert alert-info" role="status">' + icon("info") +
        t("<div><strong>لم تعد المهمة السابقة متاحة.</strong><p>يحتفظ الخادم بالمهام في الذاكرة فقط، لذا تُفقد نتائجها عند إعادة تشغيله. ابدأ بحثًا جديدًا.</p></div></div>") +
        emptyState("search", t("لا توجد نتائج بعد"), t("ابدأ بحثًا لعرض البيانات هنا."), '<a class="btn btn-primary" href="#/dashboard">' + icon("search") + t("بحث جديد</a>"));
    }
    if (isRunning()) {
      return emptyState("loader-circle", t("المهمة قيد التنفيذ"), t("ستظهر البيانات هنا فور اكتمال خط المعالجة. المرحلة الحالية: <strong>") +
        esc(stageLabel(state.job.stage)) + "</strong>.", '<a class="btn btn-secondary" href="#/search">' + icon("sparkles") + t("متابعة التقدّم</a>"));
    }
    return emptyState("search", t("لا توجد نتائج بعد"), t("ابدأ بسؤال بحثي من لوحة التحكم، وستُعرض هنا البيانات الحقيقية التي يعيدها خط المعالجة."),
      '<a class="btn btn-primary" href="#/dashboard">' + icon("search") + t("ابدأ بحثًا</a>"));
  }
  function questionLine() {
    if (!state.question) return "";
    return '<p class="question-line">' + icon("search", "icon icon-sm") + t("السؤال: <q dir=\"auto\">") + esc(state.question) + "</q></p>";
  }
  var AR_RE = /[\u0600-\u06FF]/;
  function errLang(e) { return e.lang || (AR_RE.test(e.message || e.text || "") ? "ar" : "en"); }
  function dedupeErrors(errs) {
    var map = {}, seen = {}, out = [];
    (errs || []).forEach(function (e) {
      if (!e) return;
      var msg = String(e.message || e.text || "").trim(), stage = e.stage || "pipeline";
      var sig = JSON.stringify([stage, msg, e.cluster_id, e.cluster_ids, e.paper_id, e.paper_ids, e.count]);
      if (seen[sig]) return;
      seen[sig] = true;
      var key = stage + "\u0000" + msg, r = map[key];
      if (!r) {
        r = map[key] = { stage: stage, message: msg, text: msg, type: e.type || "warning", lang: errLang({ lang: e.lang, message: msg }), count: 0, cluster_ids: [], paper_ids: [] };
        out.push(r);
      }
      r.count += e.count || 1;
      [["cluster_id", "cluster_ids"], ["paper_id", "paper_ids"]].forEach(function (f) {
        var vals = (e[f[1]] || []).slice();
        if (e[f[0]] != null) vals.push(e[f[0]]);
        vals.forEach(function (v) { if (r[f[1]].indexOf(v) < 0) r[f[1]].push(v); });
      });
    });
    out.forEach(function (r) {
      if (r.cluster_ids.length) r.cluster_id = r.cluster_ids[0];
      if (r.paper_ids.length) r.paper_id = r.paper_ids[0];
    });
    return out;
  }
  function errorsList(errs, limit) {
    errs = dedupeErrors(errs);
    var shown = errs.slice(0, limit || errs.length);
    var more = errs.length - shown.length;
    var sep = I18N.lang() === "ar" ? "، " : ", ";
    return '<ul class="err-list">' + shown.map(function (e) {
      var en = errLang(e) !== "ar";
      var meta = [];
      if (e.cluster_ids && e.cluster_ids.length) {
        meta.push(t("المحاور المتأثرة: {ids}", { ids: e.cluster_ids.map(function (c) { return c + 1; }).join(sep) }));
      } else if (e.count > 1) {
        meta.push(t("تكرّر {n} مرات", { n: e.count }));
      }
      return "<li" + (en ? ' dir="ltr" lang="en"' : ' dir="auto"') + ">" +
        '<span class="err-stage">' + esc(e.stage) + ":</span> " + esc(e.message) +
        (meta.length ? '<span class="err-meta" dir="' + I18N.dir() + '">' + meta.join(" · ") + "</span>" : "") + "</li>";
    }).join("") + (more > 0 ? '<li class="err-more">' + t("… و{n} رسائل أخرى", { n: num(more) }) + "</li>" : "") + "</ul>";
  }

  function renderDashboard() {
    var el = $("#dash-results");
    var p = payload();
    if (!p) {
      if (isRunning()) {
        el.innerHTML = '<div class="card"><div class="card-head"><h2 class="card-title">' + icon("loader-circle", "icon spin") +
          t("مهمة قيد التنفيذ</h2><a class=\"btn btn-secondary\" href=\"#/search\">متابعة التقدّم</a></div>") + questionLine() +
          t('<p class="running-note">المرحلة الحالية: <strong>') + esc(stageLabel(state.job.stage)) + "</strong></p></div>";
      } else if (state.expired) {
        el.innerHTML = noDataState();
      } else {
        el.innerHTML = emptyState("layout-dashboard", t("لا توجد إحصاءات بعد"),
          t("تظهر هنا أعداد الأوراق والمحاور وحالات النزاهة بعد اكتمال أول بحث. لا تُعرض أي أرقام قبل وصول بيانات حقيقية."));
      }
      return;
    }
    var rs = results();
    if (p.stage === "failed") {
      el.innerHTML = '<div class="alert alert-error" role="alert">' + icon("circle-x") +
        t("<div><strong>فشلت المهمة الأخيرة ولم تُعِد أي أوراق.</strong>") + questionLine() + errorsList(p.errors || []) + "</div></div>";
      return;
    }
    var count = function (s) { return rs.filter(function (r) { return r.status === s; }).length; };
    var attention = count("corrected") + count("expression_of_concern") + count("retracted");
    var years = rs.map(function (r) { return r.year; }).filter(function (y) { return typeof y === "number"; });
    var span = years.length ? Math.min.apply(null, years) + "–" + Math.max.apply(null, years) : "—";
    var summarised = clusters().filter(function (c) { return c.synthesis; }).length;

    var html = t('<div class="card"><div class="card-head"><h2 class="card-title">نتائج آخر مهمة</h2>') +
      (p.stage === "partial" ? '<span class="badge st-expression_of_concern">' + icon("circle-alert") + t("نتائج جزئية</span>") : '<span class="badge st-clean">' + icon("circle-check") + t("مكتملة</span>")) +
      "</div>" + questionLine() + '<div class="stats" style="margin-top:16px">' +
      stat("file-text", t("الأوراق المُرتَّبة"), NF.format(p.returned), t("الحد الأقصى 50 ورقة"), "#/papers") +
      stat("layers", t("المحاور"), NF.format(clusters().length), t("منها {n} بملخص مُسند", { n: NF.format(summarised) }), "#/themes") +
      stat("shield-check", t("سليمة"), NF.format(count("clean")), t("تحقق كامل دون إشعارات"), "#/integrity") +
      stat("shield-alert", t("تحتاج انتباهًا"), NF.format(attention), t("تصحيح أو قلق أو سحب"), "#/integrity") +
      stat("shield-question", t("غير متحقق منها"), NF.format(count("unverified")), t("تعذّر إكمال الفحص"), "#/integrity") +
      stat("clock", t("نطاق سنوات النشر"), span, t("ضمن الأوراق المختارة"), "#/trends") +
      "</div></div>";
    if (p.stage === "partial" && (p.errors || []).length) {
      html += '<div class="alert alert-warn" role="status">' + icon("triangle-alert") + t("<div><strong>اكتملت المهمة جزئيًا</strong>") +
        "<p>" + (p.errors.length === 1 ? t("سجّل خط المعالجة تنبيهًا واحدًا.") : t("سجّل خط المعالجة {n} تنبيهات.", { n: num(p.errors.length) })) + ' <a href="#/search">' + t("عرض التفاصيل") + "</a></p></div></div>";
    }
    el.innerHTML = html;
  }
  function stat(ic, label, value, sub, href) {
    return '<a class="stat" href="' + href + '" style="text-decoration:none;color:inherit"><span class="stat-label">' + icon(ic, "icon icon-sm") + esc(label) +
      '</span><span class="stat-value num"><bdi dir="ltr" style="white-space:nowrap">' + esc(value) + '</bdi></span><span class="stat-sub">' + esc(sub) + "</span></a>";
  }

  function renderSearch() {
    var el = $("#search-status");
    if (!state.jobId || state.expired || !state.job) {
      el.innerHTML = state.expired ? noDataState() : emptyState("sparkles", t("لم تبدأ أي مهمة بعد"),
        t("اكتب سؤالك أعلاه. سيعرض هذا القسم المرحلة الحالية لخط المعالجة كما يبلّغ بها الخادم، ثم ملخص النتائج والتنبيهات."));
      return;
    }
    var job = state.job, p = payload();
    var finalStage = p ? p.stage : null;
    var cur, failed = false;
    if (p) {
      if (finalStage === "failed") { failed = true; cur = stageIndex(state.lastStage); }
      else cur = STAGES.length;
    } else if (job.stage === "queued") cur = -1;
    else if (job.stage === "complete" || job.stage === "partial") cur = STAGES.length - 1;
    else if (job.stage === "failed") { failed = true; cur = stageIndex(state.lastStage); }
    else cur = stageIndex(job.stage);

    var steps = STAGES.map(function (s, i) {
      var cls, dot;
      if (failed && i === cur) { cls = "is-failed"; dot = icon("circle-x", "icon icon-sm"); }
      else if (i < cur) { cls = "is-done"; dot = icon("circle-check", "icon icon-sm"); }
      else if (i === cur && !p) { cls = "is-active"; dot = icon("loader-circle", "icon icon-sm spin"); }
      else { cls = "is-pending"; dot = '<span class="num" style="font-size:12px">' + (i + 1) + "</span>"; }
      var msg = state.stageMsgs[s.key];
      var detail = (i === cur && !p) ? job.progress : (i <= cur ? msg : "");
      var failNote = cls === "is-failed" ? t('<p class="step-detail" style="color:var(--st-retracted)">آخر مرحلة رُصدت قبل توقف المهمة</p>') : "";
      var stateText = cls === "is-done" ? t("مكتملة") : cls === "is-active" ? t("قيد التنفيذ") : cls === "is-failed" ? t("آخر مرحلة رُصدت قبل الفشل") : t("لم تبدأ");
      return '<li class="' + cls + '"' + (cls === "is-active" ? ' aria-current="step"' : "") + '><span class="step-dot">' + dot +
        '</span><div><p class="step-name">' + esc(t(s.label)) + ' <span class="sr-only">(' + stateText + ")</span></p>" +
        (detail ? '<p class="step-detail">' + ltr(detail) + "</p>" : "") + failNote + "</div></li>";
    }).join("");

    var head;
    if (!p) head = icon("loader-circle", "icon spin") + t("المهمة قيد التنفيذ");
    else if (finalStage === "failed") head = icon("circle-x") + t("فشلت المهمة");
    else if (finalStage === "partial") head = icon("circle-alert") + t("اكتملت المهمة جزئيًا");
    else head = icon("circle-check") + t("اكتملت المهمة");

    var html = '<div class="grid grid-2"><div class="card"><div class="card-head"><h2 class="card-title">' + head + "</h2></div>" +
      questionLine() + t('<ol class="stepper" style="margin-top:8px" aria-label="مراحل خط المعالجة">') + steps + "</ol>";
    if (!p) {
      html += '<p class="running-note" style="margin-top:8px">' + icon("info", "icon icon-sm") +
        t("لا يوفّر الخادم نسبة إنجاز، لذا نعرض المرحلة الحالية ورسالتها كما يبلّغ بها فقط.</p>");
    }
    if (state.netError) {
      html += '<div class="alert alert-warn" role="alert" style="margin-top:16px">' + icon("triangle-alert") +
        t("<div><strong>انقطع الاتصال بالخادم مؤقتًا</strong><p>جارٍ إعادة المحاولة تلقائيًا… ") + ltr(state.netError) + "</p></div></div>";
    }
    html += "</div>";

    html += '<div class="view">';
    if (!p) {
      html += '<div class="card"><h2 class="card-title">' + icon("clock") + t("ماذا يحدث الآن؟</h2><p class=\"lede\" style=\"margin-top:8px\">") +
        t("يجري الخادم المراحل بالترتيب. قد تستغرق مرحلتا الترتيب والتلخيص وقتًا أطول لأنهما تعتمدان على نماذج محلية. يمكنك التنقل بين الأقسام؛ ستستمر المتابعة وتظهر النتائج تلقائيًا.</p></div>");
    } else {
      var errs = p.errors || [];
      if (finalStage !== "failed") {
        html += '<div class="card"><h2 class="card-title">' + icon("file-text") + t("الحصيلة</h2>") +
          '<div class="stats" style="margin-top:16px">' +
          stat("file-text", t("الأوراق"), NF.format(p.returned), t("مرتّبة حسب الصلة"), "#/papers") +
          stat("layers", t("المحاور"), NF.format(clusters().length), t("بين 4 و8 محاور"), "#/themes") +
          "</div>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"><a class="btn btn-primary" href="#/papers">' + icon("file-text") + t("عرض الأوراق</a>") +
          '<a class="btn btn-secondary" href="#/themes">' + icon("layers") + t("المحاور</a>") +
          '<a class="btn btn-secondary" href="#/export">' + icon("download") + t("التصدير</a></div></div>");
      }
      if (errs.length) {
        var groups = {};
        errs.forEach(function (e) { (groups[e.stage || "pipeline"] = groups[e.stage || "pipeline"] || []).push(e); });
        html += '<div class="alert ' + (finalStage === "failed" ? "alert-error" : "alert-warn") + '" role="status">' +
          icon(finalStage === "failed" ? "circle-x" : "triangle-alert") + t("<div><strong>رسائل خط المعالجة (") + num(errs.length) + ")</strong>" +
          t('<p class="hint">تُعرض كما سجّلها الخادم.</p>') +
          Object.keys(groups).map(function (g) {
            return '<p style="margin-top:8px;font-weight:600">' + esc(stageLabel(g)) + " — " + num(groups[g].length) + "</p>" + errorsList(groups[g], 8);
          }).join("") + "</div></div>";
      } else if (finalStage !== "failed") {
        html += '<div class="alert alert-info" role="status">' + icon("circle-check") + t("<div>لم يسجّل خط المعالجة أي تنبيهات لهذه المهمة.</div></div>");
      }
    }
    html += "</div></div>";
    el.innerHTML = html;
  }

  function setupPaperControls() {
    var p = payload();
    var bar = $("#papers-toolbar");
    if (!p || !results().length) { bar.hidden = true; return; }
    bar.hidden = false;
    if (state.filtersFor === state.jobId) return;
    state.filtersFor = state.jobId;
    var rs = results();
    var counts = {};
    rs.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    $("#p-status").innerHTML = t('<option value="all">كل الحالات (') + rs.length + ")</option>" +
      STATUS_ORDER.filter(function (s) { return counts[s]; }).map(function (s) {
        return '<option value="' + s + '">' + esc(t(STATUS[s].label)) + " (" + counts[s] + ")</option>";
      }).join("");
    $("#p-theme").innerHTML = t('<option value="all">كل المحاور</option>') + clusters().map(function (c) {
      return '<option value="' + c.cluster_id + t('">المحور ') + (c.cluster_id + 1) + " — " + esc(themeName(c)) + " (" + c.count + ")</option>";
    }).join("");
    applyFilterControls();
  }
  function applyFilterControls() {
    $("#p-q").value = state.filters.q;
    $("#p-status").value = state.filters.status;
    $("#p-theme").value = state.filters.theme;
    $("#p-sort").value = state.filters.sort;
  }

  function renderPapers() {
    setupPaperControls();
    var el = $("#papers-region");
    var p = payload();
    if (!p) { el.innerHTML = noDataState(); return; }
    var all = results();
    if (!all.length) {
      el.innerHTML = emptyState("file-text", t("لم تُعِد المهمة أي أوراق"), t("راجع رسائل خط المعالجة في قسم البحث الذكي، ثم جرّب صياغة أخرى للسؤال."),
        t('<a class="btn btn-secondary" href="#/search">عرض الرسائل</a>'));
      return;
    }
    var f = state.filters;
    var q = f.q.trim().toLowerCase();
    var list = all.map(function (r, i) { return { r: r, rank: i + 1 }; }).filter(function (x) {
      var r = x.r;
      if (f.status !== "all" && r.status !== f.status) return false;
      if (f.theme !== "all" && String(r.cluster_id) !== String(f.theme)) return false;
      if (q) {
        var hay = [r.title, (r.authors || []).join(" "), r.venue, bareDoi(r.doi), r.abstract].join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var byYear = function (dir) {
      return function (a, b) {
        var ya = a.r.year, yb = b.r.year;
        if (ya == null && yb == null) return a.rank - b.rank;
        if (ya == null) return 1;
        if (yb == null) return -1;
        return dir * (ya - yb) || a.rank - b.rank;
      };
    };
    var sorters = {
      rank: function (a, b) { return a.rank - b.rank; },
      "year-desc": byYear(-1),
      "year-asc": byYear(1),
      "cites-desc": function (a, b) { return (b.r.cited_by_count || 0) - (a.r.cited_by_count || 0) || a.rank - b.rank; },
      title: function (a, b) { return String(a.r.title || "").localeCompare(String(b.r.title || ""), ["ar", "en"]); }
    };
    list.sort(sorters[f.sort] || sorters.rank);

    var filtered = f.q || f.status !== "all" || f.theme !== "all";
    var html = '<div class="result-meta"><span>' + t("عرض {a} من {b}", { a: num(list.length), b: papersN(all.length) }) +
      (f.sort === "rank" ? t(" — مرتّبة حسب الصلة بالسؤال") : "") + "</span>" +
      (filtered ? '<button class="btn btn-ghost" type="button" id="p-reset">' + icon("refresh-ccw", "icon icon-sm") + t("إعادة ضبط المرشّحات</button>") : "") + "</div>";
    if (!list.length) {
      html += emptyState("filter", t("لا توجد أوراق مطابقة"), t("لا تطابق أي ورقة المرشّحات الحالية."), "");
    } else {
      html += t('<ol class="paper-list" aria-label="قائمة الأوراق">') + list.map(function (x) { return paperCard(x.r, x.rank); }).join("") + "</ol>";
    }
    el.innerHTML = html;
    var reset = $("#p-reset");
    if (reset) reset.addEventListener("click", function () {
      state.filters = { q: "", status: "all", theme: "all", sort: "rank" };
      applyFilterControls();
      renderPapers();
      $("#p-q").focus();
    });
    if (state.params.paper) {
      var target = document.getElementById("paper-" + state.params.paper);
      if (target) {
        target.classList.add("is-highlight");
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        var a = target.querySelector(".paper-title a, .paper-title span");
        if (a) a.focus({ preventScroll: true });
      }
    }
  }

  function paperCard(r, rank) {
    var authors = r.authors || [];
    var shown = authors.slice(0, 4);
    var extra = authors.length - shown.length;
    var c = clusterById(r.cluster_id);
    var safeUrl = /^https?:\/\//i.test(r.url || "");
    var title = safeUrl
      ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer" dir="auto">' + esc(r.title || t("بلا عنوان")) + t(' <span class="sr-only">(يفتح في نافذة جديدة)</span></a>')
      : '<span dir="auto" tabindex="-1">' + esc(r.title || t("بلا عنوان")) + "</span>";
    var doi = bareDoi(r.doi);
    var badges = statusBadge(r.status) +
      (doi ? (r.doi_resolved
        ? '<span class="badge">' + icon("circle-check") + t("DOI تم حلّه</span>")
        : '<span class="badge st-unverified">' + icon("circle-alert") + t("DOI لم يُحَلّ</span>"))
        : '<span class="badge st-unverified">' + icon("circle-alert") + t("بلا DOI</span>")) +
      (r.is_preprint ? '<span class="badge">' + icon("file-text") + t("نسخة أولية</span>") : "");
    return '<li class="paper" id="paper-' + rank + '">' +
      t('<span class="paper-rank num" title="الترتيب">') + rank + "</span>" +
      '<div class="paper-body">' +
      '<h3 class="paper-title">' + title + "</h3>" +
      (shown.length ? '<p class="paper-authors">' + ltr(shown.join(", ")) + (extra > 0 ? t(" وآخرون (") + num(extra) + ")" : "") + "</p>" : "") +
      '<div class="paper-facts">' +
      (r.year ? "<span>" + icon("clock", "icon icon-sm") + yr(r.year) + "</span>" : t('<span class="muted">سنة غير معروفة</span>')) +
      (r.venue ? "<span>" + icon("book-open", "icon icon-sm") + '<bdi dir="auto">' + esc(r.venue) + "</bdi></span>" : "") +
      (typeof r.cited_by_count === "number" ? "<span>" + icon("trending-up", "icon icon-sm") + num(r.cited_by_count) + t(" استشهاد</span>") : "") +
      (c ? '<span><a href="#/themes" title="' + esc(themeName(c)) + '">' + icon("layers", "icon icon-sm") + t("المحور ") + (c.cluster_id + 1) + "</a></span>" : "") +
      "</div>" +
      '<div class="paper-badges">' + badges + "</div>" +
      (doi ? '<p class="paper-doi" dir="ltr">DOI: <a class="mono" href="' + esc(r.doi.indexOf("http") === 0 ? r.doi : "https://doi.org/" + doi) + '" target="_blank" rel="noopener noreferrer">' + esc(doi) + "</a></p>" : "") +
      (r.abstract ? t('<details class="abstract"><summary>الملخص</summary><p dir="auto">') + esc(r.abstract) + "</p></details>" : "") +
      "</div></li>";
  }

  function renderThemes() {
    var el = $("#themes-region");
    var p = payload();
    if (!p) { el.innerHTML = noDataState(); return; }
    var cs = clusters();
    if (!cs.length) {
      el.innerHTML = emptyState("layers", t("لا توجد محاور لهذه المهمة"), t("لم يُنتج خط المعالجة محاور (يتطلب التجميع خمس أوراق على الأقل)."), "");
      return;
    }
    var errsFor = function (id) {
      return (p.errors || []).filter(function (e) {
        return e.stage === "summarisation" && (e.cluster_id === id || (e.cluster_ids || []).indexOf(id) >= 0);
      });
    };
    var html = '<div class="card"><p class="lede">' + t("قسّم الخادم الأوراق إلى {n} محاور (يختار عددها بين 4 و8 آليًا). تُبنى الملخصات من ملخصات الأوراق المتحقق منها وغير المسحوبة فقط، وكل ادعاء مرتبط بأرقام أوراقه في القائمة.", { n: num(cs.length) }) + "</p></div>";
    html += '<div class="grid grid-themes">' + cs.map(function (c) {
      var s = c.synthesis;
      var body;
      if (s && ((s.claims && s.claims.length) || s.summary)) {
        body = "";
        if (s.claims && s.claims.length) {
          body += t('<h4 class="theme-sub">الملخص المُسند</h4><ul class="theme-list" dir="auto">') + s.claims.map(function (cl) {
            var refs = (cl.source_ids || []).map(function (id) { return rankOf[id]; }).filter(Boolean);
            return '<li>' + esc(cl.text) + (refs.length ? '<span class="cite" dir="ltr">' + refs.map(function (n) {
              return '<a href="#/papers?paper=' + n + t('" aria-label="الورقة رقم ') + n + '">' + n + "</a>";
            }).join("") + "</span>" : "") + "</li>";
          }).join("") + "</ul>";
        } else {
          body += t('<h4 class="theme-sub">الملخص</h4><p class="theme-summary" dir="auto">') + esc(s.summary) + "</p>";
        }
        if (s.open_questions && s.open_questions.length) {
          body += t('<h4 class="theme-sub">أسئلة بحثية مفتوحة</h4><ul class="theme-list" dir="auto">') + s.open_questions.map(function (q) {
            return "<li>" + esc(q) + "</li>";
          }).join("") + "</ul>";
        }
      } else {
        var why = errsFor(c.cluster_id);
        body = '<p class="no-summary">' + t(NO_SUMMARY) + "</p>" + (why.length ? t('<details class="why"><summary>السبب كما سجّله الخادم</summary>') +
          why.map(function (e) { return errLang(e) === "ar" ? '<p dir="auto">' + esc(e.message) + "</p>" : '<p dir="ltr" lang="en">' + esc(e.message) + "</p>"; }).join("") + "</details>" : "");
      }
      return '<article class="card theme-card" aria-labelledby="theme-' + c.cluster_id + '">' +
        '<div class="theme-head"><span class="theme-index num" aria-hidden="true">' + (c.cluster_id + 1) + '</span><div style="flex:1;min-width:0">' +
        '<h3 class="theme-name" id="theme-' + c.cluster_id + t('"><span class="sr-only">المحور ') + (c.cluster_id + 1) + ": </span><bdi dir=\"auto\">" + esc(themeName(c)) + "</bdi></h3>" +
        t('<p class="theme-keywords">كلمات مفتاحية: ') + ltr(c.label) + "</p></div>" +
        '<span class="badge">' + papersN(c.count) + "</span></div>" + body +
        '<div class="theme-foot"><a href="#/papers?theme=' + c.cluster_id + '">' + icon("file-text", "icon icon-sm") + t(" أوراق هذا المحور</a>") +
        '<a href="#/trends">' + icon("trending-up", "icon icon-sm") + t(" الاتجاه الزمني</a></div></article>");
    }).join("") + "</div>";
    el.innerHTML = html;
  }

  function niceStep(max) {
    if (max <= 4) return 1;
    var raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  }
  function barChart(opts) {
    var data = opts.data, W = opts.width || 600, H = opts.height || 220;
    var m = { t: 16, r: 8, b: 26, l: 34 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var step = niceStep(opts.max);
    var top = Math.max(step, Math.ceil(opts.max / step) * step);
    var y = function (v) { return m.t + ih - (v / top) * ih; };
    var band = iw / data.length;
    var bw = Math.min(40, band * 0.62);
    var id = opts.id;
    var s = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(opts.label) + '">' +
      '<defs><pattern id="hatch-' + id + '" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect width="6" height="6" style="fill:var(--chart-bar);opacity:.18"></rect><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--chart-bar);stroke-width:2.5"></line></pattern></defs>';
    for (var tv = 0; tv <= top; tv += step) {
      s += '<line class="grid-line" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(tv) + '" y2="' + y(tv) + '"></line>' +
        '<text class="tick" x="' + (m.l - 8) + '" y="' + (y(tv) + 4) + '" text-anchor="end">' + tv + "</text>";
    }
    var peak = Math.max.apply(null, data.map(function (d) { return d.count; }));
    data.forEach(function (d, i) {
      var cx = m.l + band * i + band / 2;
      var x = cx - bw / 2, y0 = y(0), y1 = y(d.count), h = y0 - y1;
      var tip = d.year + " · " + d.count + " " + (d.count === 1 ? t("ورقة") : t("أوراق")) + (d.incomplete ? t(" · فهرسة قد تكون غير مكتملة") : "");
      s += '<rect class="hit" tabindex="0" role="img" aria-label="' + esc(tip) + '" data-tip="' + esc(tip) + '" data-w="' + W + '" data-x="' + cx + '" data-y="' + y1 +
        '" x="' + (m.l + band * i) + '" y="' + m.t + '" width="' + band + '" height="' + ih + '"></rect>';
      if (d.count > 0) {
        var r = Math.min(4, bw / 2, h);
        var path = "M" + x + "," + y0 + "V" + (y1 + r) + "Q" + x + "," + y1 + " " + (x + r) + "," + y1 + "H" + (x + bw - r) +
          "Q" + (x + bw) + "," + y1 + " " + (x + bw) + "," + (y1 + r) + "V" + y0 + "Z";
        s += '<path class="bar" d="' + path + '"' + (d.incomplete ? ' style="fill:url(#hatch-' + id + ')"' : "") + "></path>";
        if (d.incomplete) s += '<path class="bar is-incomplete-outline" d="' + path + '"></path>';
        if (opts.labelPeak && d.count === peak) {
          s += '<text class="value-label" x="' + cx + '" y="' + (y1 - 6) + '" text-anchor="middle">' + d.count + "</text>";
        }
      }
      s += '<text class="tick" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + (opts.shortYears ? "’" + String(d.year).slice(2) : d.year) + "</text>";
    });
    s += '<line class="axis-line" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(0) + '" y2="' + y(0) + '"></line></svg>';
    return '<div class="chart-wrap" dir="ltr">' + s + "</div>";
  }

  function renderTrends() {
    var el = $("#trends-region");
    var p = payload();
    if (!p) { el.innerHTML = noDataState(); return; }
    var series = (p.trends && p.trends.length ? p.trends : clusters().map(function (c) { return { cluster_id: c.cluster_id, trends: c.trends }; }))
      .filter(function (sr) { return sr.trends && sr.trends.length; });
    if (!series.length) {
      el.innerHTML = emptyState("trending-up", t("لا توجد بيانات اتجاهات"), t("لم تُنتج هذه المهمة توزيعًا زمنيًا للمحاور."), "");
      return;
    }
    var years = series[0].trends.map(function (d) { return d.year; });
    var incomplete = {};
    series[0].trends.forEach(function (d) { incomplete[d.year] = !!d.incomplete; });
    var total = years.map(function (yr, i) {
      return { year: yr, incomplete: incomplete[yr], count: series.reduce(function (sum, s) { return sum + ((s.trends[i] && s.trends[i].count) || 0); }, 0) };
    });
    var inRange = total.reduce(function (a, d) { return a + d.count; }, 0);
    var sharedMax = Math.max(1, Math.max.apply(null, series.map(function (s) { return Math.max.apply(null, s.trends.map(function (d) { return d.count; })); })));

    var legend = t('<div class="legend"><span><i class="swatch"></i>عدد الأوراق المنشورة في السنة</span>') +
      t('<span><i class="swatch swatch-hatch"></i>سنة قد تكون فهرستها غير مكتملة</span></div>');
    var html = '<div class="card"><div class="card-head"><h2 class="card-title">' + icon("chart-column") + t("كل المحاور حسب سنة النشر</h2>") + legend + "</div>" +
      '<p class="hint" style="margin-bottom:8px">' + t("يحسب هذا الرسم {a} من الأوراق المختارة نُشرت خلال السنوات العشر الأخيرة ({r})، ولا يمثّل حجم الأدبيات كاملة. أوراق خارج هذا النطاق: {o}.", { a: papersN(inRange), r: ltr(years[0] + "–" + years[years.length - 1], "num"), o: num(results().length - inRange) }) + "</p>" +
      barChart({ data: total, max: Math.max(1, Math.max.apply(null, total.map(function (d) { return d.count; }))), id: "all", label: t("توزيع الأوراق المختارة حسب سنة النشر"), height: 240, labelPeak: true }) +
      "</div>";

    html += t('<h2 class="section-title">المحاور (مقياس رأسي موحّد للمقارنة)</h2><div class="multiples">') + series.map(function (s) {
      var c = clusterById(s.cluster_id);
      return '<div class="card multiple"><h3><bdi dir="auto">' + esc(c ? themeName(c) : t("المحور ") + (s.cluster_id + 1)) + "</bdi></h3>" +
        t('<p class="muted">المحور ') + (s.cluster_id + 1) + " · " + papersN(c ? c.count : 0) + "</p>" +
        barChart({ data: s.trends, max: sharedMax, id: "c" + s.cluster_id, label: t("توزيع أوراق المحور {n} حسب السنة", { n: s.cluster_id + 1 }), width: 340, height: 170, shortYears: true }) +
        "</div>";
    }).join("") + "</div>";

    html += '<div class="card"><details class="table-toggle"><summary>' + icon("table", "icon icon-sm") + t("عرض البيانات كجدول</summary>") +
      t('<div class="table-wrap"><table class="data"><caption class="sr-only">عدد الأوراق حسب السنة والمحور</caption><thead><tr><th scope="col">السنة</th><th scope="col" class="num">الإجمالي</th>') +
      series.map(function (s) { return t('<th scope="col" class="num">المحور ') + (s.cluster_id + 1) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      total.map(function (d, i) {
        return '<tr><th scope="row" class="num">' + d.year + (d.incomplete ? " *" : "") + '</th><td class="num">' + d.count + "</td>" +
          series.map(function (s) { return '<td class="num">' + ((s.trends[i] && s.trends[i].count) || 0) + "</td>"; }).join("") + "</tr>";
      }).join("") + t('</tbody></table></div><p class="hint" style="margin-top:8px">* سنة قد تكون فهرستها غير مكتملة (حقل <span class="ltr en">incomplete</span> من الخادم).</p></details></div>');
    el.innerHTML = html;
    bindTooltips(el);
  }

  function bindTooltips(root) {
    $$(".chart-wrap", root).forEach(function (wrap) {
      var svg = $("svg", wrap);
      var tip = document.createElement("div");
      tip.className = "tooltip";
      tip.hidden = true;
      tip.setAttribute("dir", I18N.dir());
      wrap.appendChild(tip);
      var show = function (e) {
        var el = e.target;
        if (!el.classList || !el.classList.contains("hit")) return;
        var scale = svg.getBoundingClientRect().width / parseFloat(el.getAttribute("data-w"));
        tip.textContent = el.getAttribute("data-tip");
        tip.style.left = (parseFloat(el.getAttribute("data-x")) * scale) + "px";
        tip.style.top = (parseFloat(el.getAttribute("data-y")) * scale) + "px";
        tip.hidden = false;
      };
      var hide = function () { tip.hidden = true; };
      svg.addEventListener("mouseover", show);
      svg.addEventListener("focusin", show);
      svg.addEventListener("mouseleave", hide);
      svg.addEventListener("focusout", hide);
    });
  }

  function renderIntegrity() {
    var el = $("#integrity-region");
    var p = payload();
    if (!p) { el.innerHTML = noDataState(); return; }
    var rs = results();
    if (!rs.length) { el.innerHTML = emptyState("shield-check", t("لا توجد أوراق للتحقق"), t("لم تُعِد هذه المهمة أي أوراق."), ""); return; }
    var counts = {};
    STATUS_ORDER.forEach(function (s) { counts[s] = 0; });
    rs.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
    var complete = rs.filter(function (r) { return r.verification_complete; }).length;
    var vErrs = (p.errors || []).filter(function (e) { return e.stage === "verification"; });

    var html = t('<div class="card"><p class="lede">تُجمع حالة كل ورقة من ثلاثة مصادر: علامة السحب في <span class="ltr en">OpenAlex</span>، وإشعارات التحديث في <span class="ltr en">Crossref</span>، وقاعدة <span class="ltr en">Retraction Watch</span>. تُعرض النتائج كما حسبها الخادم دون أي منطق تحقق إضافي في الواجهة.</p>') +
      '<p class="hint" style="margin-top:8px">' + t("اكتمل التحقق لـ {a} من {b}.", { a: num(complete), b: papersN(rs.length) }) + "</p></div>";
    html += '<div class="status-tiles">' + STATUS_ORDER.map(function (s) {
      return '<div class="status-tile st-' + s + '"><span class="stat-label">' + icon(STATUS[s].icon, "icon icon-sm") + esc(t(STATUS[s].label)) +
        '</span><span class="stat-value num">' + NF.format(counts[s] || 0) + "</span><p>" + esc(t(STATUS[s].desc)) + "</p></div>";
    }).join("") + "</div>";

    if (vErrs.length) {
      html += '<div class="alert alert-warn" role="status">' + icon("triangle-alert") + t("<div><strong>رسائل مرحلة التحقق (") + num(vErrs.length) + ")</strong>" +
        t("<p>قد تجعل هذه الرسائل بعض الأوراق «غير متحقق منها».</p>") + errorsList(vErrs, 10) + "</div></div>";
    }

    var flagged = [];
    STATUS_ORDER.slice(1).forEach(function (s) {
      rs.forEach(function (r, i) { if (r.status === s) flagged.push({ r: r, rank: i + 1 }); });
    });
    html += '<div class="card"><div class="card-head"><h2 class="card-title">' + icon("shield-alert") + t("أوراق تحتاج مراجعة</h2>") +
      '<span class="muted">' + papersN(flagged.length) + "</span></div>";
    if (!flagged.length) {
      html += '<div class="empty" style="padding:24px">' + '<span class="empty-icon">' + icon("shield-check", "icon icon-lg") + t("</span><h3>كل الأوراق سليمة</h3><p>لم يُبلَّغ عن أي تصحيح أو سحب أو فحص غير مكتمل.</p></div>");
    } else {
      html += '<ul class="flag-list">' + flagged.map(function (x) {
        var r = x.r, src = r.verification_sources || [];
        var why = "";
        if (r.status === "unverified" && !src.length) {
          why = !bareDoi(r.doi) ? t("لا يوجد DOI لهذه الورقة، لذا تعذّر فحصها.") : !r.doi_resolved ? t("لم يُحَلّ DOI عبر Crossref ولا DataCite؛ قد يكون خطأً مطبعيًا أو مرجعًا غير موجود.") : t("تعذّر الوصول إلى أحد مصادر التحقق.");
        }
        return '<li class="flag"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + statusBadge(r.status) +
          '<a href="#/papers?paper=' + x.rank + '" class="num">#' + x.rank + "</a></div>" +
          '<p class="paper-title" dir="auto">' + esc(r.title || t("بلا عنوان")) + "</p>" +
          (bareDoi(r.doi) ? '<p class="paper-doi" dir="ltr">DOI: <bdi class="mono">' + esc(bareDoi(r.doi)) + "</bdi></p>" : "") +
          (src.length ? t('<div class="table-wrap"><table class="data"><thead><tr><th scope="col">المصدر</th><th scope="col">الحالة</th><th scope="col">التفاصيل</th><th scope="col">DOI</th></tr></thead><tbody>') +
            src.map(function (v) {
              return "<tr><td>" + ltr(SOURCE_LABEL[v.source] || v.source) + "</td><td>" + statusBadge(v.status) + "</td><td>" + ltr(v.detail || "—") + "</td><td>" + (v.doi ? ltr(v.doi, "mono") : "—") + "</td></tr>";
            }).join("") + "</tbody></table></div>" : (why ? '<p class="hint">' + esc(why) + "</p>" : "")) +
          (r.sources_disagree ? '<p class="hint">' + esc(t("المصادر غير متفقة على حالة هذه الورقة؛ راجعها يدويًا.")) + "</p>" : "") +
          "</li>";
      }).join("") + "</ul>";
    }
    html += "</div>";
    el.innerHTML = html;
  }

  function renderExport() {
    var el = $("#export-region");
    var p = payload();
    var ready = !!(p && p.returned > 0 && state.jobId);
    var base = ready ? "/api/jobs/" + encodeURIComponent(state.jobId) : "";
    var bib = (p && p.bibtex) || "";
    var csl = (p && p.csl_json) || [];
    var bibCount = (bib.match(/^@\w+\{/gm) || []).length;
    var action = function (href, label, file) {
      return ready
        ? '<a class="btn btn-primary" href="' + href + '" download="' + file + '">' + icon("download") + esc(label) + "</a>"
        : '<button class="btn btn-primary" type="button" disabled aria-describedby="export-why">' + icon("download") + esc(label) + "</button>";
    };
    var html = "";
    if (!ready) {
      html += '<div class="alert alert-info" role="status" id="export-why">' + icon("info") + "<div>" +
        (isRunning() ? t("يُتاح التصدير بعد اكتمال المهمة الجارية.") : p && p.returned === 0 ? t("لم تُعِد المهمة أي أوراق، فلا يوجد ما يُصدَّر.") : state.expired ? t("لم تعد المهمة السابقة متاحة على الخادم. ابدأ بحثًا جديدًا.") : t("ابدأ بحثًا أولًا؛ يُتاح التصدير عند وجود نتائج.")) +
        "</div></div>";
    }
    html += '<div class="grid grid-2">' +
      '<div class="card export-card"><div style="display:flex;gap:16px;align-items:center"><span class="export-icon">' + icon("file-text", "icon icon-lg") +
      '</span><div><h2 class="card-title">' + ltr("BibTeX") + t('</h2><p class="hint">لـ <span class="ltr en">LaTeX</span> و<span class="ltr en">Zotero</span> و<span class="ltr en">JabRef</span> — ملف <span class="ltr en mono">papers.bib</span></p></div></div>') +
      (ready ? "<p>" + papersN(bibCount) + t(" في الملف.</p>") : "") + action(base + "/bibtex", t("تنزيل BibTeX"), "papers.bib") +
      (ready && bib ? '<details class="table-toggle"><summary>' + icon("braces", "icon icon-sm") + t("معاينة أول المدخلات</summary><pre class=\"preview\">") + esc(bib.split("\n").slice(0, 16).join("\n")) + "</pre></details>" : "") +
      "</div>" +
      '<div class="card export-card"><div style="display:flex;gap:16px;align-items:center"><span class="export-icon">' + icon("braces", "icon icon-lg") +
      '</span><div><h2 class="card-title">' + ltr("CSL-JSON") + t('</h2><p class="hint">لـ <span class="ltr en">Zotero</span> و<span class="ltr en">Mendeley</span> و<span class="ltr en">Pandoc</span> — ملف <span class="ltr en mono">papers.csl.json</span></p></div></div>') +
      (ready ? "<p>" + papersN(csl.length) + t(" في الملف.</p>") : "") + action(base + "/csl", t("تنزيل CSL-JSON"), "papers.csl.json") +
      (ready && csl.length ? '<details class="table-toggle"><summary>' + icon("braces", "icon icon-sm") + t("معاينة أول سجل</summary><pre class=\"preview\">") + esc(JSON.stringify(csl[0], null, 2)) + "</pre></details>" : "") +
      "</div></div>";
    if (ready) {
      html += t('<p class="hint">تُولَّد الملفات على الخادم من الأوراق نفسها المعروضة في قسم الأوراق، بالترتيب نفسه. تحفظ المهام في ذاكرة الخادم فقط، لذا نزّل الملفات قبل إعادة تشغيله.</p>');
    }
    el.innerHTML = html;
  }

  var VIEWS = { dashboard: renderDashboard, search: renderSearch, papers: renderPapers, themes: renderThemes, trends: renderTrends, integrity: renderIntegrity, "export": renderExport };
  function dataKey() {
    var j = state.job;
    return [state.jobId, state.expired, state.netError, j && j.stage, j && j.progress, !!payload()].join("|");
  }
  function render(force) {
    renderChrome();
    syncForms();
    var key = dataKey() + "|" + JSON.stringify(state.params);
    if (force || state.rendered[state.route] !== key) {
      state.rendered[state.route] = key;
      VIEWS[state.route]();
    }
  }

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var parts = h.split("?");
    var route = ROUTES[parts[0]] ? parts[0] : "dashboard";
    var params = {};
    (parts[1] || "").split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      try {
        params[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = decodeURIComponent(i < 0 ? "" : kv.slice(i + 1));
      } catch (e) { }
    });
    return { route: route, params: params };
  }
  function onRoute(initial) {
    var r = parseHash();
    var changed = r.route !== state.route;
    state.route = r.route;
    state.params = r.params;
    if (r.route === "papers") {
      if (r.params.theme != null) state.filters = { q: "", status: "all", theme: r.params.theme, sort: "rank" };
      if (r.params.paper) state.filters = { q: "", status: "all", theme: "all", sort: "rank" };
      if (state.filtersFor === state.jobId) applyFilterControls();
    }
    closeDrawer(false);
    render(true);
    if (!initial && changed) {
      window.scrollTo(0, 0);
      if (!r.params.paper) $("#main").focus({ preventScroll: true });
    }
  }

  var sidebar = $("#sidebar"), scrim = $("#scrim"), menuBtn = $("#menu-btn"), mainCol = $(".main-col");
  var mobile = window.matchMedia("(max-width: 1024px)");
  function openDrawer() {
    sidebar.classList.add("is-open");
    scrim.classList.add("is-open");
    menuBtn.setAttribute("aria-expanded", "true");
    if (mobile.matches) mainCol.setAttribute("inert", "");
    var cur = $('.nav a[aria-current="page"]') || $(".nav a");
    setTimeout(function () { cur.focus(); }, 50);
  }
  function closeDrawer(returnFocus) {
    if (!sidebar.classList.contains("is-open")) return;
    sidebar.classList.remove("is-open");
    scrim.classList.remove("is-open");
    menuBtn.setAttribute("aria-expanded", "false");
    mainCol.removeAttribute("inert");
    if (returnFocus) menuBtn.focus();
  }
  menuBtn.addEventListener("click", openDrawer);
  $("#drawer-close").addEventListener("click", function () { closeDrawer(true); });
  scrim.addEventListener("click", function () { closeDrawer(true); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(true); });
  var onMq = function () { if (!mobile.matches) closeDrawer(false); };
  if (mobile.addEventListener) mobile.addEventListener("change", onMq);

  var darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  function effectiveTheme() {
    var th = document.documentElement.getAttribute("data-theme");
    return th === "light" || th === "dark" ? th : (darkMq.matches ? "dark" : "light");
  }
  function paintThemeButton() {
    var dark = effectiveTheme() === "dark";
    $$("[data-theme-toggle]").forEach(function (b) {
      $("use", b).setAttribute("href", SPRITE + "#i-" + (dark ? "sun" : "moon"));
      b.setAttribute("aria-label", dark ? t("التبديل إلى المظهر الفاتح") : t("التبديل إلى المظهر الداكن"));
    });
  }
  $$("[data-theme-toggle]").forEach(function (b) {
    b.addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("ra-theme", next); } catch (e) {}
      paintThemeButton();
    });
  });
  if (darkMq.addEventListener) darkMq.addEventListener("change", paintThemeButton);

  $$("[data-ask-form]").forEach(function (f) {
    f.addEventListener("submit", function (e) { e.preventDefault(); submitQuestion(f); });
    var input = f.querySelector('input[name="question"]');
    input.addEventListener("input", function () {
      $$('[data-ask-form] input[name="question"]').forEach(function (o) { if (o !== input) o.value = input.value; });
    });
  });
  $("#p-q").addEventListener("input", function (e) { state.filters.q = e.target.value; state.params = {}; renderPapers(); });
  $("#p-status").addEventListener("change", function (e) { state.filters.status = e.target.value; state.params = {}; renderPapers(); });
  $("#p-theme").addEventListener("change", function (e) { state.filters.theme = e.target.value; state.params = {}; renderPapers(); });
  $("#p-sort").addEventListener("change", function (e) { state.filters.sort = e.target.value; state.params = {}; renderPapers(); });
  window.addEventListener("hashchange", function () { if (booted) onRoute(false); });
  document.addEventListener("ra:langchange", function () {
    paintThemeButton();
    if (!booted) return;
    state.filtersFor = null;
    state.rendered = {};
    render(true);
    if (state.route !== "papers") setupPaperControls();
  });

  paintThemeButton();

  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    var saved = store.get("ra-job");
    if (saved) {
      try {
        var sv = JSON.parse(saved);
        if (sv && sv.id) {
          state.jobId = sv.id;
          state.question = sv.q || "";
          state.job = { stage: "queued", progress: "", payload: null };
          $$('[data-ask-form] input[name="question"]').forEach(function (o) { o.value = state.question; });
        }
      } catch (e) { store.del("ra-job"); }
    }
    onRoute(true);
    if (state.jobId) poll();
  }
  if (!window.RAAuth || window.RAAuth.current()) boot();
  else document.addEventListener("ra:login", boot);
})();
