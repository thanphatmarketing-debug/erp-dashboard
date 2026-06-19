(function () {
  "use strict";

  function dayStart(value) {
    var date = value instanceof Date ? new Date(value) : new Date(value);
    if (isNaN(date)) return null;
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function calendarStats(events) {
    var today = dayStart(new Date());
    var nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    return events.reduce(function (stats, event) {
      var date = dayStart(event.date);
      if (!date) return stats;
      if (date.getTime() === today.getTime()) stats.today += 1;
      else if (date < today) stats.overdue += 1;
      else if (date <= nextWeek) stats.upcoming += 1;
      return stats;
    }, { today: 0, upcoming: 0, overdue: 0 });
  }

  function alertsMarkup(events) {
    var stats = calendarStats(events);
    return '<div class="calendar-alert-strip">' +
      '<div class="calendar-alert today">นัดและงานวันนี้<b>' + stats.today + '</b></div>' +
      '<div class="calendar-alert upcoming">ล่วงหน้า 7 วัน<b>' + stats.upcoming + '</b></div>' +
      '<div class="calendar-alert overdue">เลยกำหนด<b>' + stats.overdue + '</b></div>' +
      '</div>';
  }

  function eventClass(event) {
    var date = dayStart(event.date);
    var today = dayStart(new Date());
    var overdue = date && date < today && !/เสร็จ|completed|done/i.test(event.sub || "");
    return "kind-" + (event.kind || "project") + (overdue ? " is-overdue" : "");
  }

  var originalPaint = window.paintWorkCalendar;
  window.paintWorkCalendar = function () {
    if (typeof originalPaint === "function") originalPaint();
    var wrap = document.getElementById("calendar-list");
    if (!wrap || typeof collectCalendarEvents !== "function") return;
    var events = collectCalendarEvents();
    var card = document.getElementById("dashboard-work-calendar");
    var existing = card && card.querySelector(".calendar-alert-strip");
    if (existing) existing.remove();
    if (card) {
      var target = card.querySelector(".chart-card-head") || card.firstElementChild;
      if (target) target.insertAdjacentHTML("afterend", alertsMarkup(events));
    }
    Array.from(wrap.querySelectorAll(".calendar-item")).forEach(function (row, index) {
      if (events[index]) row.classList.add.apply(row.classList, eventClass(events[index]).split(" "));
    });
  };

  var originalRender = window.renderWorkCalendar;
  window.renderWorkCalendar = async function (force) {
    if (typeof originalRender === "function") await originalRender(force);
    window.paintWorkCalendar();
  };

  window.ERP_CALENDAR = {
    stats: calendarStats,
    refresh: function () { return window.renderWorkCalendar(false); }
  };
})();
