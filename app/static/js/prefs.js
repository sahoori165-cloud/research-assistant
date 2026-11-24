(function () {
  "use strict";
  var KEY = "ra-font", MIN = 14, MAX = 20, STEP = 1, DEFAULT = 16;
  var root = document.documentElement;

  function read() {
    var v;
    try { v = parseInt(localStorage.getItem(KEY), 10); } catch (e) {}
    return v >= MIN && v <= MAX ? v : DEFAULT;
  }
  var size = read();

  function paint() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-font]"), function (b) {
      var dir = b.getAttribute("data-font");
      b.disabled = dir === "dec" ? size <= MIN : size >= MAX;
      b.title = size + "px";
    });
  }
  function set(v) {
    size = Math.max(MIN, Math.min(MAX, v));
    root.style.fontSize = size + "px";
    try { localStorage.setItem(KEY, String(size)); } catch (e) {}
    paint();
  }

  root.style.fontSize = size + "px";
  paint();
  Array.prototype.forEach.call(document.querySelectorAll("[data-font]"), function (b) {
    b.addEventListener("click", function () { set(size + (b.getAttribute("data-font") === "dec" ? -STEP : STEP)); });
  });
})();
