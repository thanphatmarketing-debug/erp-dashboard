// ── State ─────────────────────────────────────────────────────
var API_URL    = '';
var API_TOKEN  = '';
var CONNECTED  = false;
var ERP_IS_LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname) || location.protocol === 'file:';
var ERP_IS_GITHUB_PAGES = /\.github\.io$/i.test(location.hostname);
var ERP_REQUIRE_BACKEND_LOGIN = !ERP_IS_LOCAL_HOST && !ERP_IS_GITHUB_PAGES;
var ERP_CLIENT_ORIGIN = location.origin && location.origin !== 'null' ? location.origin : 'local-dev';
var DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbwwJ_DxaUSPp9TuJdD9dEYJSceBKJGpUAIlwbBM1z61-0iKlES4v7LoAKRM51SkO1f2_w/exec';
var DEFAULT_API_TOKEN = '';
var LEGACY_API_URLS = [
  'https://script.google.com/macros/s/AKfycbw3S_xrji37lJe4eGoL-R-9kzwWQjM1R5wnimJU-4Fq1qSUWbiANM0u8aa3Da4k4Zp9Zg/exec'
];
var CURRENT_PANEL = 'dashboard';
var EDIT_ID    = null;
var SEARCH_TIMER = null;
var PAGE_STATE = {};
var CHARTS     = {};

var SCHEMAS = {
  sales:     ['วันที่','ลูกค้า','สินค้า','จำนวน','ราคา','ยอดรวม','สถานะ','หมายเหตุ'],
  customers: ['ชื่อ','บริษัท','อีเมล','โทรศัพท์','ที่อยู่','สถานะ','วันที่เพิ่ม'],
  contracts: ['ชื่อลูกค้า','สัญญางานสร้างบ้าน','ข้อมูลมัดจำ/เซ็นสัญญา','ทำเลที่ดินของลูกค้า','วันเริ่มสัญญา','วันสิ้นสุดสัญญา','มูลค่าสัญญา','สถานะ','รายละเอียดของแต่ละงาน','หมายเหตุ'],
  employees: ['ชื่อ','ตำแหน่ง','แผนก','อีเมล','โทรศัพท์','วันเริ่มงาน','สถานะ'],
  projects:  ['ชื่องาน/โปรเจกต์','ลูกค้า','ผู้รับผิดชอบ','ทำเลที่ดินของลูกค้า','งานเพิ่มเติม','รายละเอียดของแต่ละงาน','วันเริ่ม','วันส่งมอบ','งบประมาณ','สถานะ']
};

var DEFAULT_SCHEMAS = JSON.parse(JSON.stringify(SCHEMAS));
var SHEET_SCHEMA_KEY = 'erp-sheet-schemas-v1';

function loadSheetSchemas() {
  try {
    var saved = JSON.parse(localStorage.getItem(SHEET_SCHEMA_KEY) || '{}');
    Object.keys(saved).forEach(function(sheet) {
      if (Array.isArray(saved[sheet]) && saved[sheet].length) {
        SCHEMAS[sheet] = saved[sheet].filter(function(h) { return h && h !== 'ID'; });
      }
    });
  } catch(e) {}
}

function saveSheetSchema(sheet, headers) {
  if (!sheet || !Array.isArray(headers)) return;
  var clean = headers.filter(function(h) { return h && h !== 'ID'; });
  if (!clean.length) return;
  SCHEMAS[sheet] = clean;
  try {
    var saved = JSON.parse(localStorage.getItem(SHEET_SCHEMA_KEY) || '{}');
    saved[sheet] = clean;
    localStorage.setItem(SHEET_SCHEMA_KEY, JSON.stringify(saved));
  } catch(e) {}
}

function syncSchemaFromRows(sheet, rows) {
  if (!sheet || !Array.isArray(rows) || !rows.length) return;
  var headers = [];
  rows.forEach(function(row) {
    Object.keys(row || {}).forEach(function(k) {
      if (k && k !== 'ID' && headers.indexOf(k) === -1) headers.push(k);
    });
  });
  saveSheetSchema(sheet, headers);
}

loadSheetSchemas();

var NUM_FIELDS = ['จำนวน','ราคา','ยอดรวม','มูลค่า','มูลค่าสัญญา','ข้อมูลมัดจำ/เซ็นสัญญา','งบประมาณ'];

// ── Theme ─────────────────────────────────────────────────────
function toggleTheme() {
  var html   = document.documentElement;
  var isDark = html.getAttribute('data-theme') === 'dark';
  var next   = isDark ? 'light' : 'dark';
  html.setAttribute('data-theme', next);

  // Update toggle icon
  var btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = next === 'dark' ? '🌙' : '☀️';

  // Update toggle title
  if (btn) btn.title = next === 'dark' ? 'สลับเป็น Light Mode' : 'สลับเป็น Dark Mode';

  localStorage.setItem('erp-theme', next);

  // Re-render charts & status after theme CSS settles
  setTimeout(function() {
    initCharts();
    updateSystemStatus(CONNECTED);
  }, 150);

  toast((next === 'light' ? '☀️ Light Mode' : '🌙 Dark Mode') + ' เปิดแล้ว', 'info');
}

// Apply saved theme on load (before login)
(function() {
  var saved = localStorage.getItem('erp-theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    document.addEventListener('DOMContentLoaded', function() {
      var btn = document.getElementById('theme-btn');
      if (btn) btn.textContent = saved === 'dark' ? '🌙' : '☀️';
    });
  }
})();

/* Executive dashboard view for EMP-EXEC. */
(function () {
  "use strict";

  var EXECUTIVE_ID = "EMP-EXEC";
  var MONTH_TARGET = 15000000;

  function isExecutiveSession() {
    var id = String(CURRENT_USER && (CURRENT_USER.employeeId || CURRENT_USER.id) || "").trim().toUpperCase();
    return id === EXECUTIVE_ID || !!(CURRENT_USER && CURRENT_USER.role === "executive");
  }

  function setExecText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function escapeExec(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char];
    });
  }

  function execRows(sheet) {
    var rows = [];
    try {
      if (typeof SMART_DATA_CACHE !== "undefined" && SMART_DATA_CACHE[sheet] && SMART_DATA_CACHE[sheet].length) rows = SMART_DATA_CACHE[sheet];
      else if (typeof CACHED_DATA !== "undefined" && CACHED_DATA[sheet] && CACHED_DATA[sheet].length) rows = CACHED_DATA[sheet];
      else if (typeof getLocalRows === "function") rows = getLocalRows(sheet);
    } catch (error) {}
    return Array.isArray(rows) ? rows.slice() : [];
  }

  function firstByPattern(row, patterns) {
    var keys = Object.keys(row || {});
    for (var i = 0; i < patterns.length; i += 1) {
      var key = keys.find(function (candidate) { return patterns[i].test(candidate); });
      if (key && row[key] !== "" && row[key] != null) return row[key];
    }
    return "";
  }

  function toNumber(value) {
    var n = parseFloat(String(value == null ? "" : value).replace(/[^\d.-]/g, ""));
    return isNaN(n) ? 0 : n;
  }

  function sumRows(rows, patterns) {
    return (rows || []).reduce(function (sum, row) {
      return sum + toNumber(firstByPattern(row, patterns));
    }, 0);
  }

  function moneyShort(value) {
    var n = Math.max(0, Number(value) || 0);
    if (n >= 1000000) return "฿" + (n / 1000000).toFixed(n >= 10000000 ? 1 : 2).replace(/\.0$/, "") + "M";
    if (n >= 1000) return "฿" + Math.round(n / 1000).toLocaleString("th-TH") + "K";
    return "฿" + Math.round(n).toLocaleString("th-TH");
  }

  function isThisMonth(row) {
    var raw = firstByPattern(row, [/วันที่/i, /date/i, /created/i, /เริ่ม/i, /สิ้นสุด/i]);
    if (!raw) return false;
    var date = new Date(raw);
    var now = new Date();
    return !isNaN(date) && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  }

  function isToday(row) {
    var raw = firstByPattern(row, [/วันที่/i, /date/i, /created/i]);
    if (!raw) return false;
    var date = new Date(raw);
    var now = new Date();
    return !isNaN(date) && date.toDateString() === now.toDateString();
  }

  function statusClass(status) {
    var value = String(status || "").toLowerCase();
    if (/ล่าช้า|ค้าง|overdue|late|delay|เสี่ยง/.test(value)) return "danger";
    if (/รอ|กำลัง|pending|progress|review/.test(value)) return "warn";
    return "ok";
  }

  function renderPipeline(sales, customers, contracts) {
    var leadCount = Math.max(customers.length, sales.length, 24);
    var quoteCount = Math.max(contracts.length, Math.round(leadCount * .38));
    var closedCount = Math.max(sales.length, Math.round(leadCount * .24));
    var rows = [
      { label:"Lead", count:leadCount, width:100 },
      { label:"นัดหมาย", count:Math.max(8, Math.round(leadCount * .65)), width:65 },
      { label:"ใบเสนอราคา", count:quoteCount, width:Math.max(28, Math.round(quoteCount / leadCount * 100)) },
      { label:"ปิดการขาย", count:closedCount, width:Math.max(18, Math.round(closedCount / leadCount * 100)) }
    ];
    var wrap = document.getElementById("exec-sales-pipeline");
    if (!wrap) return;
    wrap.innerHTML = rows.map(function (row) {
      return '<div class="exec-pipe-row"><span>' + escapeExec(row.label) + '</span><div class="exec-pipe-bar"><i style="width:' + row.width + '%"></i></div><b>' + row.count + '</b></div>';
    }).join("");
  }

  function renderProjects(projects) {
    var fallback = [
      { name:"บ้านคุณสมชาย", step:"โครงสร้าง", progress:72, status:"กำลังดำเนินการ" },
      { name:"บ้านคุณศิริพร", step:"งานระบบ", progress:54, status:"รอตรวจ" },
      { name:"โครงการรีโนเวท", step:"ส่งมอบ", progress:91, status:"ล่าช้า" }
    ];
    var rows = projects.slice(0, 6).map(function (row, index) {
      var name = firstByPattern(row, [/โครงการ/i, /ชื่องาน/i, /ชื่อ/i, /project/i, /name/i]) || "โครงการ " + (index + 1);
      var step = firstByPattern(row, [/ขั้นตอน/i, /phase/i, /stage/i, /ประเภท/i]) || "ดำเนินงาน";
      var progress = toNumber(firstByPattern(row, [/%/i, /progress/i, /ความคืบหน้า/i])) || Math.min(95, 35 + index * 12);
      var status = firstByPattern(row, [/สถานะ/i, /status/i]) || "กำลังดำเนินการ";
      return { name:name, step:step, progress:progress, status:status };
    });
    if (!rows.length) rows = fallback;
    var tbody = document.getElementById("exec-construction-tbody");
    if (!tbody) return;
    tbody.innerHTML = rows.map(function (row) {
      var cls = statusClass(row.status);
      return '<tr><td>' + escapeExec(row.name) + '</td><td>' + escapeExec(row.step) + '</td><td>' + Math.round(row.progress) + '%</td><td><span class="exec-badge ' + cls + '">' + escapeExec(row.status) + '</span></td></tr>';
    }).join("");
  }

  function campaignSummary() {
    var keys = ["erp-marketing-campaigns", "marketing-campaigns", "adsCampaigns"];
    var campaigns = [];
    keys.forEach(function (key) {
      try {
        var parsed = JSON.parse(localStorage.getItem(key) || "[]");
        if (Array.isArray(parsed)) campaigns = campaigns.concat(parsed);
      } catch (error) {}
    });
    var leads = campaigns.reduce(function (sum, row) {
      return sum + toNumber(row.leads || row.lead || row["Lead"] || row["leads"]);
    }, 0);
    var budget = campaigns.reduce(function (sum, row) {
      return sum + toNumber(row.spend || row.budget || row.cost || row["งบประมาณ"] || row["งบที่ใช้"]);
    }, 0);
    return {
      fb: leads ? Math.max(1, Math.round(leads * .66)) : 16,
      tt: leads ? Math.max(1, leads - Math.round(leads * .66)) : 8,
      budget: budget || 4440,
      cpl: leads && budget ? Math.round(budget / leads) : 185
    };
  }

  function renderAlerts(projects, contracts, outstanding) {
    var late = projects.filter(function (row) {
      var status = firstByPattern(row, [/สถานะ/i, /status/i]);
      return /ล่าช้า|ค้าง|overdue|late|delay/i.test(String(status || ""));
    }).length;
    var alerts = [];
    if (late) alerts.push({ type:"danger", title:"มีงานล่าช้า " + late + " รายการ", meta:"ตรวจสถานะโครงการและผู้รับผิดชอบ" });
    if (outstanding > 0) alerts.push({ type:"warn", title:"ยอดค้างชำระ " + moneyShort(outstanding), meta:"ติดตามงวดชำระจากฝ่ายการเงิน" });
    if (contracts.length) alerts.push({ type:"ok", title:"สัญญาในระบบ " + contracts.length + " รายการ", meta:"พร้อมดูรายละเอียดในหน้า Contracts" });
    if (alerts.length < 3) alerts.push({ type:"warn", title:"ตรวจ KPI การตลาดวันนี้", meta:"ดู CPL, CTR และ Lead ที่หน้าแผนกการตลาด" });
    alerts = alerts.slice(0, 4);
    setExecText("exec-alert-count", alerts.length + " รายการ");
    var wrap = document.getElementById("exec-alert-list");
    if (!wrap) return;
    wrap.innerHTML = alerts.map(function (alert) {
      return '<div class="exec-alert ' + alert.type + '"><i></i><div><b>' + escapeExec(alert.title) + '</b><span>' + escapeExec(alert.meta) + '</span></div></div>';
    }).join("");
  }

  function renderDepartments() {
    var departments = [
      ["ผู้บริหาร", "ดู Dashboard ทุกแผนก และตัดสินใจนโยบาย"],
      ["การตลาด", "ADS, Content, Social, วิเคราะห์ผล"],
      ["ขาย", "ตอบลูกค้า ปิดการขาย ใบเสนอราคา"],
      ["แอดมิน", "เอกสาร ประสานงาน จัดเก็บข้อมูล"],
      ["ก่อสร้าง/ผลิต", "หน้างาน แผนงาน คุณภาพ ส่งมอบ"],
      ["การเงินและบัญชี", "รับ-จ่าย ภาษี รายงานการเงิน"],
      ["HR", "สรรหา อบรม ประเมินผล สวัสดิการ"]
    ];
    var wrap = document.getElementById("exec-dept-grid");
    if (!wrap) return;
    wrap.innerHTML = departments.map(function (dept) {
      return '<div class="exec-dept"><b>' + escapeExec(dept[0]) + '</b><span>' + escapeExec(dept[1]) + '</span></div>';
    }).join("");
  }

  function renderExecutiveDashboard() {
    var panel = document.getElementById("panel-dashboard");
    var dash = document.getElementById("executive-dashboard");
    if (!panel || !dash) return;
    var active = isExecutiveSession();
    panel.classList.toggle("executive-mode", active);
    dash.hidden = !active;
    if (!active) return;

    var sales = execRows("sales");
    var customers = execRows("customers");
    var contracts = execRows("contracts");
    var projects = execRows("projects");
    var employees = execRows("employees");
    var monthlySales = sumRows(sales.filter(isThisMonth), [/ยอดรวม/i, /ยอดขาย/i, /มูลค่า/i, /ราคา/i, /amount/i, /total/i]);
    if (!monthlySales) monthlySales = sumRows(contracts.filter(isThisMonth), [/มูลค่า/i, /ยอดรวม/i, /ราคา/i, /amount/i, /total/i]);
    if (!monthlySales) monthlySales = 12400000;
    var outstanding = Math.round(monthlySales * .26) || 3200000;
    var todayLeads = customers.filter(isToday).length || Math.max(24, Math.round(customers.length * .2));
    var lateProjects = projects.filter(function (row) {
      var status = firstByPattern(row, [/สถานะ/i, /status/i]);
      return /ล่าช้า|ค้าง|overdue|late|delay/i.test(String(status || ""));
    }).length || (projects.length ? 0 : 3);
    var ads = campaignSummary();
    var financePercent = Math.min(100, Math.round(monthlySales / MONTH_TARGET * 100));

    setExecText("exec-today-date", new Date().toLocaleDateString("th-TH", { day:"2-digit", month:"short", year:"numeric" }));
    setExecText("exec-kpi-leads", todayLeads.toLocaleString("th-TH"));
    setExecText("exec-kpi-sales", moneyShort(monthlySales));
    setExecText("exec-kpi-projects", Math.max(projects.length, 8).toLocaleString("th-TH"));
    setExecText("exec-kpi-overdue", moneyShort(outstanding));
    setExecText("exec-kpi-late", lateProjects.toLocaleString("th-TH"));
    setExecText("exec-finance-income", moneyShort(monthlySales));
    setExecText("exec-finance-deposit", moneyShort(Math.round(monthlySales * .145)));
    setExecText("exec-finance-outstanding", moneyShort(outstanding));
    setExecText("exec-finance-due", moneyShort(Math.round(outstanding * .19)));
    setExecText("exec-finance-progress-text", financePercent + "%");
    var progress = document.getElementById("exec-finance-progress");
    if (progress) progress.style.width = financePercent + "%";
    setExecText("exec-ads-fb", ads.fb.toLocaleString("th-TH"));
    setExecText("exec-ads-tt", ads.tt.toLocaleString("th-TH"));
    setExecText("exec-ads-cpl", moneyShort(ads.cpl));
    setExecText("exec-ads-budget", moneyShort(ads.budget));
    if (employees.length) setExecText("exec-kpi-leads-note", "รวมทีม " + employees.length + " คนในระบบ");

    renderPipeline(sales, customers, contracts);
    renderProjects(projects);
    renderAlerts(projects, contracts, outstanding);
    renderDepartments();
  }

  window.renderExecutiveDashboard = renderExecutiveDashboard;

  var previousExecutiveSwitchPanel = switchPanel;
  switchPanel = window.switchPanel = function (el) {
    previousExecutiveSwitchPanel(el);
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : CURRENT_PANEL;
    if (panel === "dashboard" || CURRENT_PANEL === "dashboard") setTimeout(renderExecutiveDashboard, 20);
  };

  var previousExecutiveUpdateTopbarUser = updateTopbarUser;
  updateTopbarUser = window.updateTopbarUser = function (user) {
    previousExecutiveUpdateTopbarUser(user);
    setTimeout(renderExecutiveDashboard, 60);
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(renderExecutiveDashboard, 100);
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      renderExecutiveDashboard();
      if (CURRENT_USER || tries > 20) clearInterval(timer);
    }, 250);
  });
})();





(function() {
  var saved = localStorage.getItem('erp-theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    
// ── Admin Panel ───────────────────────────────────────────────
var ADMIN_PASS_KEY = 'erp-admin-pass';
var ADMIN_USERS_KEY = 'erp-admin-users';
var ADMIN_UNLOCKED = false;

var DEFAULT_ADMIN_PASS = '';

var PERMISSION_MODULES = [
  { name: '📦 ระบบพนักงาน', sub: '& รายละเอียดงาน' },
  { name: '📈 ระบบ Sales', sub: '& ลูกค้า' },
  { name: '📋 สัญญา', sub: '& โปรเจกต์' },
  { name: '📊 Reports', sub: '& Analytics' },
  { name: '≋ Activity Log', sub: 'การบันทึก' },
];

var ROLES = [
  { key: 'admin',  label: 'ADMIN',  color: '#7c3aed', bg: 'rgba(124,58,237,0.1)' },
  { key: 'editor', label: 'EDITOR', color: '#4f8ef7', bg: 'rgba(79,142,247,0.1)' },
  { key: 'viewer', label: 'VIEWER', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
];

var PERM_DEFAULTS = {
  admin:  { view: true,  fill: true,  edit: true  },
  editor: { view: true,  fill: true,  edit: false },
  viewer: { view: true,  fill: false, edit: false },
};

var adminUsers = [];
var adminNextId = 1;

function getAdminPass() {
  return localStorage.getItem(ADMIN_PASS_KEY) || DEFAULT_ADMIN_PASS;
}

function checkAdminPass() {
  openAdminPanelForCurrentUser();
}

function lockAdmin() {
  ADMIN_UNLOCKED = false;
  var gate = document.getElementById('admin-gate');
  var content = document.getElementById('admin-content');
  var pass = document.getElementById('admin-pass-input');
  var err = document.getElementById('admin-pass-err');
  if (gate) gate.style.display = 'none';
  if (content) content.style.display = 'none';
  if (pass) pass.value = '';
  if (err) err.style.display = 'none';
  if (CURRENT_USER && CURRENT_PANEL === 'admin') switchPanelByName('dashboard');
}

function loadAdminData() {
  // Load users
  try {
    var saved = localStorage.getItem(ADMIN_USERS_KEY);
    adminUsers = saved ? JSON.parse(saved) : [
      { id:1, name:'สมชาย ใจดี',  email:'admin@erp.co.th',  role:'admin'  },
      { id:2, name:'มาลี รักงาน', email:'malee@erp.co.th',   role:'editor' },
    ];
    adminNextId = adminUsers.length ? Math.max.apply(null, adminUsers.map(function(u){return u.id;})) + 1 : 1;
  } catch(e) { adminUsers = []; }
  normalizeAdminUserIds();
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  syncAdminUsersToLoginDb();
  renderAdminMatrix();
  renderAdminUsers();
}

function renderAdminMatrix() {
  var tbody = document.getElementById('permission-matrix-body');
  if (!tbody) return;
  var html = '';
  PERMISSION_MODULES.forEach(function(mod) {
    ROLES.forEach(function(role, ri) {
      var p = PERM_DEFAULTS[role.key];
      html += '<tr style="border-bottom:1px solid var(--border)">';
      if (ri === 0) {
        html += '<td style="padding:10px 14px;font-weight:600;color:var(--text);vertical-align:middle" rowspan="3">' +
          mod.name + '<br><span style="color:var(--muted);font-weight:400;font-size:11px">' + mod.sub + '</span></td>';
      }
      html += '<td style="padding:8px 14px;text-align:center">' +
        '<span style="padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;font-family:var(--mono);background:' + role.bg + ';color:' + role.color + '">' + role.label + '</span></td>';
      html += '<td style="padding:8px 14px;text-align:center;color:' + (p.view ? 'var(--green)' : 'var(--red)') + '">' + (p.view ? '✔ เปิด' : '✕ ปิด') + '</td>';
      html += '<td style="padding:8px 14px;text-align:center;color:' + (p.fill ? 'var(--green)' : 'var(--red)') + '">' + (p.fill ? '✔ ได้' : '✕ ปิด') + '</td>';
      html += '<td style="padding:8px 14px;text-align:center">';
      if (p.edit) {
        html += '<span style="color:var(--green)">✔ ได้</span>';
      } else {
        html += '<span style="background:var(--bg4);color:var(--muted);padding:2px 8px;border-radius:6px;font-size:11px">🔒 บล็อก</span>';
      }
      html += '</td></tr>';
    });
  });
  tbody.innerHTML = html;
}

function renderAdminUsers() {
  var wrap = document.getElementById('admin-user-list');
  var countEl = document.getElementById('admin-user-count');
  if (!wrap) return;
  if (countEl) countEl.textContent = adminUsers.length + ' คน';
  if (!adminUsers.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">ยังไม่มีผู้ใช้</div>';
    return;
  }
  var avatarColors = ['#7c3aed','#4f8ef7','#22c55e','#ef4444','#f59e0b','#14b8a6','#ec4899'];
  var roleBadge = { admin: 'rgba(124,58,237,0.12);color:#a78bfa', editor: 'rgba(79,142,247,0.12);color:#60a5fa', viewer: 'rgba(245,158,11,0.12);color:#fbbf24' };
  wrap.innerHTML = adminUsers.map(function(u) {
    var initials = u.name.trim().split(' ').slice(0,2).map(function(p){return p[0];}).join('');
    var avatarColor = avatarColors[(u.id-1) % avatarColors.length];
    var badge = roleBadge[u.role] || 'rgba(107,114,128,0.1);color:var(--muted)';
    var position = u.position || u.pos || 'ยังไม่ระบุตำแหน่ง';
    var detail = u.detail || '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border)" id="admin-user-row-' + u.id + '">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + avatarColor + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0">' + initials + '</div>' +
        '<div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + u.name + '</div>' +
          '<div style="font-size:10px;color:var(--muted);font-family:var(--mono)">' + u.email + '</div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + position + (detail ? ' · ' + detail : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<select onchange="adminChangeRole(' + u.id + ',this.value)" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);font-family:var(--font);font-size:11px;padding:4px 8px;border-radius:7px;outline:none;cursor:pointer">' +
          '<option value="admin"'  + (u.role==='admin'  ?' selected':'') + '>Admin</option>'  +
          '<option value="editor"' + (u.role==='editor' ?' selected':'') + '>Editor</option>' +
          '<option value="viewer"' + (u.role==='viewer' ?' selected':'') + '>Viewer</option>' +
        '</select>' +
        '<button onclick="adminDeleteUser(' + u.id + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 4px" title="ลบ">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function adminChangeRole(id, role) {
  var u = adminUsers.find(function(x){return x.id===id;});
  if (u) u.role = role;
}

function adminDeleteUser(id) {
  var u = adminUsers.find(function(x){return x.id===id;});
  if (!u) return;
  if (!confirm('ลบ "' + u.name + '" ออกจากระบบ?')) return;
  adminUsers = adminUsers.filter(function(x){return x.id!==id;});
  renderAdminUsers();
  toast('ลบผู้ใช้ "' + u.name + '" แล้ว', 'ok');
}

function openAdminAddUser() {
  EDIT_ID = null;
  document.getElementById('modal-title').textContent = '+ เพิ่มผู้ใช้ระบบ';
  var html = '<div class="form-group"><label class="form-label">ชื่อ-นามสกุล</label><input class="form-input" id="admin-field-name" placeholder="ชื่อ นามสกุล"></div>' +
    '<div class="form-group"><label class="form-label">อีเมล</label><input class="form-input" id="admin-field-email" type="email" placeholder="email@example.com"></div>' +
    '<div class="form-group"><label class="form-label">ตำแหน่ง</label><input class="form-input" id="admin-field-position" placeholder="เช่น นักยิงแอด, ฝ่ายบัญชี"></div>' +
    '<div class="form-group"><label class="form-label">เปลี่ยนรหัสผ่าน</label><input class="form-input" id="admin-field-password" type="password" placeholder="รหัสผ่านใหม่"></div>' +
    '<div class="form-group"><label class="form-label">บทบาท</label><select class="form-select" id="admin-field-role"><option value="admin">Admin</option><option value="editor" selected>Editor</option><option value="viewer">Viewer</option></select></div>' +
    '<div class="form-group full"><label class="form-label">รายละเอียด</label><textarea class="form-input textarea" id="admin-field-detail" placeholder="รายละเอียดเพิ่มเติมของพนักงาน"></textarea></div>';
  document.getElementById('modal-form').innerHTML = html;
  document.getElementById('modal-save').onclick = saveAdminUser;
  document.getElementById('modal-overlay').classList.add('open');
}

function saveAdminUser() {
  var name     = (document.getElementById('admin-field-name') || {}).value || '';
  var email    = (document.getElementById('admin-field-email') || {}).value || '';
  var position = (document.getElementById('admin-field-position') || {}).value || '';
  var password = (document.getElementById('admin-field-password') || {}).value || '';
  var detail   = (document.getElementById('admin-field-detail') || {}).value || '';
  var role     = (document.getElementById('admin-field-role') || {}).value || 'editor';
  if (!name.trim()) { toast('กรุณากรอกชื่อ', 'err'); return; }
  if (!email.trim()) { toast('กรุณากรอกอีเมล', 'err'); return; }
  if (password && password.length < 4) { toast('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร', 'err'); return; }
  adminUsers.push({
    id: adminNextId++,
    name: name.trim(),
    email: email.trim(),
    position: position.trim(),
    password: password.trim(),
    detail: detail.trim(),
    role: role
  });
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  renderAdminUsers();
  syncDailyPositionOptions(payload.position);
  renderDailyFieldAdmin();
  closeModal();
  document.getElementById('modal-save').onclick = saveModal;
  toast('เพิ่มผู้ใช้ "' + name + '" แล้ว', 'ok');
}

function saveAdminChanges() {
  // sync roles from dropdowns
  adminUsers.forEach(function(u) {
    var row = document.getElementById('admin-user-row-' + u.id);
    if (row) { var sel = row.querySelector('select'); if (sel) u.role = sel.value; }
  });
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  toast('บันทึกการเปลี่ยนแปลงสิทธิ์แล้ว ✅', 'ok');
}

function changeAdminPassword() {
  var oldP = document.getElementById('admin-old-pass').value;
  var newP = document.getElementById('admin-new-pass').value;
  var conP = document.getElementById('admin-confirm-pass').value;
  if (oldP !== getAdminPass()) { toast('รหัสผ่านปัจจุบันไม่ถูกต้อง', 'err'); return; }
  if (!newP || newP.length < 4) { toast('รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร', 'err'); return; }
  if (newP !== conP) { toast('รหัสผ่านใหม่ไม่ตรงกัน', 'err'); return; }
  localStorage.setItem(ADMIN_PASS_KEY, newP);
  document.getElementById('admin-old-pass').value = '';
  document.getElementById('admin-new-pass').value = '';
  document.getElementById('admin-confirm-pass').value = '';
  toast('เปลี่ยนรหัสผ่าน Admin สำเร็จ ✅', 'ok');
}

// Show admin nav only when on admin panel or always visible
function initAdminNav() {
  syncRoleAccess();
}


document.addEventListener('DOMContentLoaded', function() {
  initAdminNav();
      document.getElementById('theme-btn').textContent = saved === 'dark' ? '🌙' : '☀️';
    });
  }
})();

// ── Navigation ────────────────────────────────────────────────
function switchPanel(el) {
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  el.classList.add('active');
  var panel = el.getAttribute('data-panel');
  CURRENT_PANEL = panel;
  document.getElementById('page-title').textContent = el.textContent.trim().replace(/[0-9—\s]+$/, '').trim();

  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('panel-' + panel).classList.add('active');

  var addBtn = document.getElementById('btn-add');
  addBtn.style.display = (userCanWrite() && SCHEMAS[panel]) ? 'inline-flex' : 'none';

  if (panel === 'admin') { openAdminPanelForCurrentUser(); return; }
  if (panel === 'dashboard') { loadStats(); return; }
  if (panel === 'activity')  { loadActivity(1); return; }
  if (panel === 'audit')     { renderAuditTrail(); return; }
  if (panel === 'ai')        { renderAIInsights(); return; }
  if (panel === 'calendar')  { renderWorkCalendar(true); return; }
  if (panel === 'backup')    { renderBackupSummary(); return; }
  if (panel === 'reports')   { loadReports(); return; }
  if (SCHEMAS[panel]) loadPanel(panel, 1, '');
}

function switchPanelByName(name) {
  var el = document.querySelector('.nav-item[data-panel="' + name + '"]');
  if (el) switchPanel(el);
}

function quickAdd(name) {
  switchPanelByName(name);
  if (SCHEMAS[name]) openAddModal();
}

// ── API ───────────────────────────────────────────────────────
async function connect() {
  API_URL   = document.getElementById('api-url').value.trim();
  API_TOKEN = document.getElementById('api-token').value.trim();
  if (!API_URL) { toast('กรุณากรอก URL', 'err'); return; }
  if (!API_TOKEN) { toast('กรุณากรอก API Token', 'err'); return; }
  setStatus('idle', 'กำลังตรวจสอบ...');
  try {
    var result = await apiGet({ action:'read', sheet:'sales', page:1, pageSize:1 });
    if (!result || result.ok === false) throw new Error(result && (result.msg || result.error) || 'API rejected the request');
    CONNECTED = true;
    setStatus('ok', 'เชื่อมต่อแล้ว');
    localStorage.setItem('erp-url', API_URL);
    if (window.ERP_SECURITY) window.ERP_SECURITY.setApiToken(API_TOKEN);
    toast('เชื่อมต่อ API และ Google Sheets สำเร็จ', 'ok');
    updateSystemStatus(true);
    addNotif('เชื่อมต่อ Google Sheets สำเร็จ', 'ระบบพร้อมใช้งาน', 'success', '✅');
    loadStats();
    if (CURRENT_PANEL !== 'dashboard') switchPanelByName(CURRENT_PANEL);
  } catch (error) {
    CONNECTED = false;
    setStatus('idle', 'เชื่อมต่อไม่ได้');
    updateSystemStatus(false);
    toast('เชื่อมต่อ API ไม่สำเร็จ: ' + String(error.message || error), 'err');
  }
}

window.erpConnectApi = connect;

function setStatus(type, text) {
  var dot  = document.getElementById('status-dot');
  var txt  = document.getElementById('status-text');
  dot.className = 'status-dot dot-' + type;
  txt.textContent = text;
}

function apiGet(params) {
  var url = API_URL + (API_URL.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(API_TOKEN);
  var backendSession = window.ERP_SECURITY && window.ERP_SECURITY.getSession();
  if (backendSession && backendSession.session) url += '&session=' + encodeURIComponent(backendSession.session);
  url += '&origin=' + encodeURIComponent(ERP_CLIENT_ORIGIN);
  Object.keys(params).forEach(function(k) {
    var v = params[k];
    if (typeof v === 'object') v = JSON.stringify(v);
    url += '&' + k + '=' + encodeURIComponent(v);
  });
  return fetchJsonWithProxy(url);
}

// ใช้ GET ทั้งหมดเพื่อหลีกเลี่ยง CORS preflight
function apiPost(data) {
  var url = API_URL + (API_URL.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(API_TOKEN);
  var backendSession = window.ERP_SECURITY && window.ERP_SECURITY.getSession();
  if (backendSession && backendSession.session) url += '&session=' + encodeURIComponent(backendSession.session);
  url += '&origin=' + encodeURIComponent(ERP_CLIENT_ORIGIN);
  Object.keys(data).forEach(function(k) {
    var v = data[k];
    if (typeof v === 'object') v = JSON.stringify(v);
    url += '&' + k + '=' + encodeURIComponent(v);
  });
  return fetchJsonWithProxy(url);
}

function prepareApiDataForSheet(data) {
  var clean = Object.assign({}, data || {});
  Object.keys(clean).forEach(function(k) {
    var value = clean[k];
    if (/โทรศัพท์|phone|tel/i.test(k) && /^0\d+/.test(String(value || ''))) {
      clean[k] = "'" + String(value);
    }
  });
  return clean;
}

function fetchJsonUrl(url) {
  return fetch(url).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function fetchJsonWithProxy(url) {
  if (!ERP_IS_LOCAL_HOST) return fetchJsonUrl(url);
  if (/^https:\/\/script\.google\.com\/macros\//.test(url)) {
    return fetchJsonUrl(url).catch(function() {
      return fetchJsonUrl('http://127.0.0.1:8090/erp-proxy?target=' + encodeURIComponent(url));
    });
  }
  return fetchJsonUrl(url).catch(function(err) {
    var proxyUrl = 'http://127.0.0.1:8090/erp-proxy?target=' + encodeURIComponent(url);
    return fetchJsonUrl(proxyUrl);
  });
}

// ── Restore saved config ──────────────────────────────────────
(function() {
  var u = localStorage.getItem('erp-url') || DEFAULT_API_URL;
  var t = (window.ERP_SECURITY ? window.ERP_SECURITY.getApiToken() : '') || DEFAULT_API_TOKEN;
  if (LEGACY_API_URLS.indexOf(u) > -1) u = DEFAULT_API_URL;
  if (u) { document.getElementById('api-url').value   = u; API_URL   = u; }
  if (t) { document.getElementById('api-token').value = t; API_TOKEN = t; }
  if (u && t) {
    localStorage.setItem('erp-url', u);
    if (window.ERP_SECURITY) window.ERP_SECURITY.setApiToken(t);
    CONNECTED = true;
    setStatus('ok', 'เชื่อมต่อแล้ว');
  }
})();

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  if (!CONNECTED) return;
  try {
    var sheets = ['sales','customers','contracts','employees','projects','activity'];
    var results = await Promise.all(sheets.map(function(s) {
      return apiGet({ action:'read', sheet:s, page:1, pageSize:1 }).catch(function() { return { ok:false, pagination:{ total:0 } }; });
    }));
    var map = {};
    sheets.forEach(function(s, i) { map[s] = results[i].pagination ? results[i].pagination.total : 0; });

    setText('s-sales',     fmt(map.sales));
    setText('s-customers', fmt(map.customers));
    setText('s-contracts', fmt(map.contracts));
    setText('s-employees', fmt(map.employees));
    setText('s-projects',  fmt(map.projects));
    setText('s-activity',  fmt(map.activity));
    setText('s-docs',      '—');

    // Update sidebar badges
    ['sales','customers','contracts','employees','projects'].forEach(function(s) {
      var el = document.getElementById('badge-' + s);
      if (el) el.textContent = fmt(map[s]);
    });

    // KPI demo changes
    setText('kpi-sales-change',     '+12.4%');
    setText('kpi-customers-change', '+8.1%');
    setText('kpi-contracts-change', '+3.5%');
    setText('kpi-employees-change', map.employees + ' คน');

    setStatus('ok', 'เชื่อมต่อแล้ว');
    updateSystemStatus(true);

  } catch(e) {
    setStatus('ok', 'เชื่อมต่อแล้ว');
    updateSystemStatus(true);
    initOfflineDashboard();
  }
  try {
    var r = await apiGet({ action:'read', sheet:'sales', page:1, pageSize:5 });
    if (r.ok && r.data) renderLatestSales(r.data);
  } catch(e) {}
}

function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

function initOfflineDashboard() {
  var counts = {
    sales: 0,
    customers: 0,
    contracts: 0,
    employees: getDbUsers().length,
    projects: 0,
    activity: 0,
    docs: 0
  };
  setText('s-sales', fmt(counts.sales));
  setText('s-customers', fmt(counts.customers));
  setText('s-contracts', fmt(counts.contracts));
  setText('s-employees', fmt(counts.employees));
  setText('s-projects', fmt(counts.projects));
  setText('s-activity', fmt(counts.activity));
  setText('s-docs', fmt(counts.docs));
  setText('kpi-employees-change', counts.employees + ' คน');
  ['sales','customers','contracts','employees','projects'].forEach(function(s) {
    var el = document.getElementById('badge-' + s);
    if (el) el.textContent = fmt(counts[s]);
  });
}

function renderLatestSales(data) {
  var wrap = document.getElementById('latest-sales-wrap');
  if (!data.length) { wrap.innerHTML = '<div class="empty"><div class="empty-text">ไม่มีข้อมูล</div></div>'; return; }
  var cols = Object.keys(data[0]).filter(function(k) { return k !== 'ID'; }).slice(0, 6);
  var html = '<div class="table-wrap"><table><thead><tr>';
  cols.forEach(function(c) { html += '<th>' + c + '</th>'; });
  html += '</tr></thead><tbody>';
  data.forEach(function(row) {
    html += '<tr>';
    cols.forEach(function(c) {
      var v = row[c] || '—';
      if (c === 'สถานะ') html += '<td>' + statusBadge(v) + '</td>';
      else html += '<td>' + v + '</td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

// ── Panel Table ───────────────────────────────────────────────
async function loadPanel(sheet, page, search) {
  page   = page   || 1;
  search = search || '';
  PAGE_STATE[sheet] = { page: page, search: search };

  var wrap = document.getElementById('table-' + sheet);
  if (!wrap) return;
  if (!CONNECTED) { wrap.innerHTML = '<div class="empty"><div class="empty-icon">🔗</div><div class="empty-text">กรุณาเชื่อมต่อก่อน</div></div>'; return; }
  wrap.innerHTML = '<div class="loading"><span class="spinner"></span>กำลังโหลด...</div>';

  try {
    var params = { action:'read', sheet:sheet, page:page, pageSize:20 };
    if (search) params.search = search;
    var r = await apiGet(params);

    if (!r.ok) { wrap.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">' + (r.msg || 'โหลดไม่ได้') + '</div></div>'; return; }

    var countEl = document.getElementById('count-' + sheet);
    if (countEl) countEl.textContent = (r.pagination ? r.pagination.total : 0) + ' รายการ';

    var badge = document.getElementById('badge-' + sheet);
    if (badge && r.pagination) badge.textContent = fmt(r.pagination.total);

    renderTable(sheet, r.data || [], wrap);
    if (r.pagination) renderPagination(sheet, r.pagination);

  } catch(e) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><div class="empty-text">เกิดข้อผิดพลาด</div></div>';
  }
}

function renderTable(sheet, data, wrap) {
  if (!data.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">ไม่มีข้อมูล</div></div>';
    return;
  }
  var cols = Object.keys(data[0]).filter(function(k) { return k !== 'ID'; });
  var html = '<table><thead><tr>';
  cols.forEach(function(c) { html += '<th onclick="sortTable(\'' + sheet + '\',\'' + c + '\')">' + c + ' ↕</th>'; });
  html += '<th>จัดการ</th></tr></thead><tbody>';
  data.forEach(function(row) {
    html += '<tr>';
    cols.forEach(function(c) {
      var v = row[c];
      if (c === 'สถานะ') html += '<td>' + statusBadge(v) + '</td>';
      else if (NUM_FIELDS.indexOf(c) > -1) html += '<td class="num">' + fmtCurrency(v) + '</td>';
      else if (c === 'ID') html += '<td class="mono">' + (v || '—') + '</td>';
      else html += '<td>' + (v || '—') + '</td>';
    });
    html += '<td style="white-space:nowrap">' +
      '<button class="btn btn-ghost btn-sm" onclick="editRow(\'' + sheet + '\',\'' + row['ID'] + '\')">✏️ แก้ไข</button> ' +
      '<button class="btn btn-danger btn-sm" onclick="confirmDelete(\'' + sheet + '\',\'' + row['ID'] + '\')">🗑️</button>' +
      '</td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

var SORT_STATE = {};
function sortTable(sheet, col) {
  var data = CACHED_DATA[sheet];
  if (!data) return;
  var asc = !(SORT_STATE[sheet] && SORT_STATE[sheet].col === col && SORT_STATE[sheet].asc);
  SORT_STATE[sheet] = { col: col, asc: asc };
  data.sort(function(a, b) {
    var av = a[col] || '', bv = b[col] || '';
    var an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
    return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });
  var wrap = document.getElementById('table-' + sheet);
  if (wrap) renderTable(sheet, data, wrap);
}
var CACHED_DATA = {};

// ── Status Badge ──────────────────────────────────────────────
function statusBadge(val) {
  var v = String(val).toLowerCase();
  if (['active','ใช้งาน','สำเร็จ','เสร็จสิ้น','อนุมัติแล้ว'].indexOf(v) > -1)
    return '<span class="badge badge-green">' + val + '</span>';
  if (['inactive','ยกเลิก','หมดอายุ','ปฏิเสธ'].indexOf(v) > -1)
    return '<span class="badge badge-red">' + val + '</span>';
  if (['pending','รอดำเนินการ','รอ','รออนุมัติ'].indexOf(v) > -1)
    return '<span class="badge badge-amber">' + val + '</span>';
  if (['กำลังดำเนินการ','in progress','ดำเนินการ'].indexOf(v) > -1)
    return '<span class="badge badge-blue">' + val + '</span>';
  return '<span class="badge badge-gray">' + (val || '—') + '</span>';
}

// ── Pagination ────────────────────────────────────────────────
function renderPagination(sheet, p) {
  var wrap = document.getElementById('page-' + sheet);
  if (!wrap) return;
  var start = (p.page - 1) * p.pageSize + 1;
  var end   = Math.min(p.page * p.pageSize, p.total);
  var html  = '<span class="page-info">' + start + '–' + end + ' จาก ' + p.total + '</span>';
  html += '<div class="page-btns">';
  html += '<button class="page-btn" onclick="loadPanel(\'' + sheet + '\',' + (p.page-1) + ',\'' + (PAGE_STATE[sheet] ? PAGE_STATE[sheet].search : '') + '\')" ' + (p.hasPrev ? '' : 'disabled') + '>← ก่อน</button>';
  var s = Math.max(1, p.page - 2), e = Math.min(p.totalPages, p.page + 2);
  for (var i = s; i <= e; i++) {
    html += '<button class="page-btn' + (i === p.page ? ' active' : '') + '" onclick="loadPanel(\'' + sheet + '\',' + i + ',\'' + (PAGE_STATE[sheet] ? PAGE_STATE[sheet].search : '') + '\')">' + i + '</button>';
  }
  html += '<button class="page-btn" onclick="loadPanel(\'' + sheet + '\',' + (p.page+1) + ',\'' + (PAGE_STATE[sheet] ? PAGE_STATE[sheet].search : '') + '\')" ' + (p.hasNext ? '' : 'disabled') + '>ถัดไป →</button>';
  html += '</div>';
  wrap.innerHTML = html;
}

// ── Activity ──────────────────────────────────────────────────
async function loadActivity(page) {
  page = page || 1;
  var wrap = document.getElementById('activity-list-wrap');
  if (!CONNECTED) { wrap.innerHTML = '<div class="empty"><div class="empty-icon">🔗</div><div class="empty-text">กรุณาเชื่อมต่อก่อน</div></div>'; return; }
  wrap.innerHTML = '<div class="loading"><span class="spinner"></span>กำลังโหลด...</div>';
  try {
    var r = await apiGet({ action:'read', sheet:'activity', page:page, pageSize:50 });
    if (!r.ok) { wrap.innerHTML = '<div class="empty">' + r.msg + '</div>'; return; }
    setText('count-activity', (r.pagination ? r.pagination.total : 0) + ' รายการ');
    if (!r.data.length) { wrap.innerHTML = '<div class="empty"><div class="empty-icon">≋</div><div class="empty-text">ไม่มี log</div></div>'; return; }
    var html = '<div class="activity-list">';
    r.data.forEach(function(row) {
      var type  = row['ประเภท'] || 'info';
      var color = type === 'delete' ? 'var(--red)' : type === 'write' ? 'var(--green)' : 'var(--accent)';
      html += '<div class="activity-item">' +
        '<div class="act-dot" style="background:' + color + '"></div>' +
        '<div class="act-info">' +
          '<div class="act-action">' + (row['การกระทำ'] || '—') + ' — <span style="color:var(--muted)">' + (row['ผู้ใช้'] || 'system') + '</span></div>' +
          '<div class="act-detail">' + (row['รายละเอียด'] || '') + '</div>' +
        '</div>' +
        '<div class="act-time">' + (row['วันที่'] || '') + ' ' + (row['เวลา'] || '') + '</div>' +
        '</div>';
    });
    html += '</div>';
    wrap.innerHTML = html;
    if (r.pagination) renderPagination('activity', r.pagination);
  } catch(e) {
    wrap.innerHTML = '<div class="empty">โหลดไม่ได้</div>';
  }
}

// ── Reports ───────────────────────────────────────────────────
async function loadReports() {
  if (!CONNECTED) return;
  try {
    var [salesR, contractsR, projectsR] = await Promise.all([
      apiGet({ action:'read', sheet:'sales', pageSize:500 }),
      apiGet({ action:'read', sheet:'contracts', pageSize:500 }),
      apiGet({ action:'read', sheet:'projects', pageSize:500 })
    ]);

    // Revenue
    var revenue = 0;
    if (salesR.ok && salesR.data) {
      salesR.data.forEach(function(r) { revenue += parseFloat(r['ยอดรวม'] || r['ราคา'] || 0); });
      setText('rpt-revenue', '฿' + revenue.toLocaleString('th-TH'));
      setText('rpt-count', salesR.data.length + ' รายการ');

      // Render report table
      var rptWrap = document.getElementById('rpt-table');
      if (rptWrap) renderTable('sales', salesR.data.slice(0, 20), rptWrap);

      // Bar chart for reports
      renderReportBarChart(salesR.data);
    }

    // Contract rate
    if (contractsR.ok && contractsR.data && contractsR.data.length) {
      var active = contractsR.data.filter(function(r) {
        return String(r['สถานะ'] || '').toLowerCase() === 'active' || r['สถานะ'] === 'ใช้งาน';
      }).length;
      var rate = Math.round(active / contractsR.data.length * 100);
      setText('rpt-contract-rate', rate + '%');

      // Pie chart for reports
      renderReportPieChart(contractsR.data);
    }

    // Projects done
    if (projectsR.ok && projectsR.data && projectsR.data.length) {
      var done = projectsR.data.filter(function(r) {
        return String(r['สถานะ'] || '').toLowerCase().indexOf('เสร็จ') > -1;
      }).length;
      setText('rpt-projects-done', done + '/' + projectsR.data.length);
    }
  } catch(e) {}
}

// ── Charts ────────────────────────────────────────────────────
function getChartColors() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    grid:   isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    text:   isDark ? '#6b7280' : '#9ca3af',
    bg:     isDark ? '#13161e' : '#ffffff'
  };
}

function initCharts() {
  var c = getChartColors();
  Chart.defaults.color = c.text;
  Chart.defaults.borderColor = c.grid;

  // Demo data
  var months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var salesData  = [42,55,38,67,71,58,82,76,69,88,93,105];
  var growthData = [30,42,38,55,60,52,70,65,62,78,85,95];
  var cxData     = [10,15,12,18,22,20,28,26,24,30,33,38];

  destroyChart('chart-bar');
  destroyChart('chart-pie');
  destroyChart('chart-line');

  // Bar Chart
  var barCtx = document.getElementById('chart-bar');
  if (barCtx) {
    CHARTS['chart-bar'] = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: months,
        datasets: [{
          label: 'ยอดขาย',
          data: salesData,
          backgroundColor: 'rgba(79,142,247,0.7)',
          borderColor: 'rgba(79,142,247,1)',
          borderWidth: 1, borderRadius: 6,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: c.grid }, ticks: { color: c.text } },
          y: { grid: { color: c.grid }, ticks: { color: c.text } }
        }
      }
    });
  }

  // Pie Chart
  var pieCtx = document.getElementById('chart-pie');
  if (pieCtx) {
    CHARTS['chart-pie'] = new Chart(pieCtx, {
      type: 'doughnut',
      data: {
        labels: ['ใช้งาน','รอดำเนินการ','หมดอายุ','ยกเลิก'],
        datasets: [{
          data: [55, 25, 12, 8],
          backgroundColor: ['rgba(34,197,94,0.8)','rgba(245,158,11,0.8)','rgba(107,114,128,0.8)','rgba(239,68,68,0.8)'],
          borderColor: c.bg, borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { padding: 12, font: { size: 11 } } }
        },
        cutout: '60%'
      }
    });
  }

  // Line Chart
  var lineCtx = document.getElementById('chart-line');
  if (lineCtx) {
    CHARTS['chart-line'] = new Chart(lineCtx, {
      type: 'line',
      data: {
        labels: months,
        datasets: [
          {
            label: 'Sales', data: salesData,
            borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,0.1)',
            tension: 0.4, fill: true, pointRadius: 3, pointHoverRadius: 5
          },
          {
            label: 'ลูกค้า', data: cxData,
            borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.08)',
            tension: 0.4, fill: false, pointRadius: 3, pointHoverRadius: 5
          },
          {
            label: 'โปรเจกต์', data: growthData.map(function(v) { return Math.round(v * 0.4); }),
            borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)',
            tension: 0.4, fill: false, pointRadius: 3, pointHoverRadius: 5
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { font: { size: 11 } } } },
        scales: {
          x: { grid: { color: c.grid }, ticks: { color: c.text } },
          y: { grid: { color: c.grid }, ticks: { color: c.text } }
        }
      }
    });
  }
}

function destroyChart(id) {
  if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; }
}

function renderReportBarChart(salesData) {
  var c = getChartColors();
  var monthly = {};
  var months  = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  months.forEach(function(m) { monthly[m] = 0; });
  salesData.forEach(function(row) {
    var d = row['วันที่'] || '';
    var m = parseInt(d.split('/')[1] || d.split('-')[1]);
    if (m >= 1 && m <= 12) monthly[months[m-1]] += parseFloat(row['ยอดรวม'] || row['ราคา'] || 0);
  });
  destroyChart('rpt-chart-bar');
  var ctx = document.getElementById('rpt-chart-bar');
  if (!ctx) return;
  CHARTS['rpt-chart-bar'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [{ label: 'ยอดขาย (฿)', data: Object.values(monthly), backgroundColor: 'rgba(79,142,247,0.7)', borderRadius: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: c.grid }, ticks: { color: c.text } },
        y: { grid: { color: c.grid }, ticks: { color: c.text, callback: function(v) { return '฿' + v.toLocaleString(); } } }
      }
    }
  });
}

function renderReportPieChart(contractsData) {
  var c = getChartColors();
  var counts = { ใช้งาน: 0, รอดำเนินการ: 0, หมดอายุ: 0, ยกเลิก: 0 };
  contractsData.forEach(function(r) {
    var s = r['สถานะ'] || '';
    if (counts[s] !== undefined) counts[s]++;
    else counts['ยกเลิก']++;
  });
  destroyChart('rpt-chart-pie');
  var ctx = document.getElementById('rpt-chart-pie');
  if (!ctx) return;
  CHARTS['rpt-chart-pie'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(counts),
      datasets: [{
        data: Object.values(counts),
        backgroundColor: ['rgba(34,197,94,0.8)','rgba(245,158,11,0.8)','rgba(107,114,128,0.8)','rgba(239,68,68,0.8)'],
        borderColor: c.bg, borderWidth: 2
      }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }, cutout: '60%' }
  });
}

// ── Search ────────────────────────────────────────────────────
function onSearch(val) {
  clearTimeout(SEARCH_TIMER);
  SEARCH_TIMER = setTimeout(function() {
    if (SCHEMAS[CURRENT_PANEL]) loadPanel(CURRENT_PANEL, 1, val);
  }, 400);
}

function refreshCurrent() {
  if (CURRENT_PANEL === 'dashboard') { loadStats(); return; }
  if (CURRENT_PANEL === 'reports')   { loadReports(); return; }
  if (CURRENT_PANEL === 'activity')  { loadActivity(1); return; }
  var st = PAGE_STATE[CURRENT_PANEL] || {};
  loadPanel(CURRENT_PANEL, st.page || 1, st.search || '');
}

// ── Add / Edit Modal ──────────────────────────────────────────
function openAddModal() {
  if (!userCanWrite()) { toast('Admin only', 'err'); return; }
  EDIT_ID = null;
  document.getElementById('modal-title').textContent = '+ เพิ่มข้อมูล — ' + CURRENT_PANEL;
  buildForm(CURRENT_PANEL, {});
  document.getElementById('modal-overlay').classList.add('open');
}

async function editRow(sheet, id) {
  if (!userCanWrite()) { toast('Admin only', 'err'); return; }
  try {
    var r = await apiGet({ action:'read', sheet:sheet, pageSize:500 });
    var row = (r.data || []).find(function(d) { return d['ID'] === id; });
    if (!row) { toast('ไม่พบข้อมูล', 'err'); return; }
    syncSchemaFromRows(sheet, r.data || []);
    EDIT_ID = id;
    document.getElementById('modal-title').textContent = '✏️ แก้ไข — ' + sheet;
    buildForm(sheet, row);
    document.getElementById('modal-overlay').classList.add('open');
  } catch(e) { toast('โหลดข้อมูลไม่ได้', 'err'); }
}

function buildForm(sheet, data) {
  var fields = customFieldsForContext(sheet, userIsAdmin() ? '' : getCurrentUserPosition(), userIsAdmin());
  var html   = '';
  function todayInputValue() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function normalizeDateInput(value) {
    if (!value) return '';
    var s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    return s;
  }
  fields.forEach(function(f) {
    var cfg = getFieldConfig(sheet, f);
    if (cfg.hidden) return;
    var isNum  = cfg.type === 'number';
    var isDate = cfg.type === 'date';
    var isLongText = cfg.type === 'textarea';
    var isWide = isLongText || ['ชื่อสัญญา','ชื่อโปรเจกต์','ชื่องาน/โปรเจกต์','ที่อยู่','ทำเลที่ดินของลูกค้า'].indexOf(f) > -1;
    var isStatus = cfg.type === 'select';
    var value = data[f] || '';
    if (!EDIT_ID && sheet === 'sales' && f === 'วันที่' && !value) value = todayInputValue();
    if (isDate) value = normalizeDateInput(value);
    html += '<div class="form-group' + (isWide ? ' full' : '') + '">' +
      '<label class="form-label">' + escapeHtml(f) + (cfg.required ? ' <span style="color:#f87171">*</span>' : '') + '</label>';
    if (isStatus) {
      html += '<select class="form-select" id="field-' + f + '"' + (cfg.required ? ' required' : '') + '>' +
        (cfg.options || []).map(function(o) {
          return '<option value="' + o + '"' + (value === o ? ' selected' : '') + '>' + o + '</option>';
        }).join('') + '</select>';
    } else if (isLongText) {
      html += '<textarea class="form-input textarea" id="field-' + f + '" placeholder="' + escapeHtml(cfg.placeholder || f) + '"' + (cfg.required ? ' required' : '') + '>' + escapeHtml(value) + '</textarea>';
    } else {
      html += '<input class="form-input" id="field-' + f + '" type="' + (isDate ? 'date' : (isNum ? 'number' : 'text')) + '" value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(cfg.placeholder || f) + '"' + (cfg.required ? ' required' : '') + '>';
    }
    html += '</div>';
  });
  document.getElementById('modal-form').innerHTML = html;
}

async function saveModal() {
  if (!userCanWrite()) { toast('Admin only', 'err'); return; }
  var sheet  = CURRENT_PANEL;
  var fields = customFieldsForContext(sheet, userIsAdmin() ? '' : getCurrentUserPosition(), userIsAdmin());
  var data   = {};
  fields.forEach(function(f) {
    var el = document.getElementById('field-' + f);
    if (el) data[f] = el.value;
  });

  var saveBtn = document.getElementById('modal-save');
  saveBtn.textContent = '⏳ กำลังบันทึก...';
  saveBtn.disabled    = true;

  try {
    var r;
    var apiData = prepareApiDataForSheet(data);
    if (EDIT_ID) {
      r = await apiPost({ action:'update', sheet:sheet, id:EDIT_ID, data:apiData });
    } else {
      r = await apiPost({ action:'write', sheet:sheet, data:apiData });
    }
    if (r.ok) {
      toast(r.msg || 'บันทึกสำเร็จ', 'ok');
      closeModal();
      loadPanel(sheet);
      loadStats();
    } else {
      if (EDIT_ID) localUpdate(sheet, EDIT_ID, data);
      else localWrite(sheet, data);
      closeModal();
      loadPanel(sheet);
      loadStats();
      toast('บันทึกในเครื่องสำเร็จ (รอซิงก์)', 'ok');
    }
  } catch(e) {
    if (EDIT_ID) localUpdate(sheet, EDIT_ID, data);
    else localWrite(sheet, data);
    closeModal();
    loadPanel(sheet);
    loadStats();
    setStatus('ok', 'เชื่อมต่อแล้ว');
    toast('บันทึกในเครื่องสำเร็จ (รอซิงก์)', 'ok');
  }

  saveBtn.textContent = '💾 บันทึก';
  saveBtn.disabled    = false;
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }

// ── Delete ────────────────────────────────────────────────────
function confirmDelete(sheet, id) {
  document.getElementById('confirm-id').textContent = 'ID: ' + id + ' · Sheet: ' + sheet;
  document.getElementById('confirm-ok').onclick = function() { doDelete(sheet, id); };
  document.getElementById('confirm-overlay').classList.add('open');
}

async function doDelete(sheet, id) {
  if (!userCanWrite()) { toast('Admin only', 'err'); return; }
  closeConfirm();
  try {
    var r = await apiPost({ action:'delete', sheet:sheet, id:id });
    if (r.ok) { toast('ลบสำเร็จ', 'ok'); loadPanel(sheet); loadStats(); }
    else toast(r.msg || 'ลบไม่ได้', 'err');
  } catch(e) { toast('ลบไม่ได้', 'err'); }
}

function closeConfirm() { document.getElementById('confirm-overlay').classList.remove('open'); }

// ── Export CSV ────────────────────────────────────────────────
async function exportCSV(sheet) {
  if (!CONNECTED) { toast('กรุณาเชื่อมต่อก่อน', 'err'); return; }
  try {
    var r = await apiGet({ action:'read', sheet:sheet, pageSize:9999 });
    if (!r.ok || !r.data.length) { toast('ไม่มีข้อมูลให้ Export', 'err'); return; }
    var cols = Object.keys(r.data[0]);
    var csv  = cols.join(',') + '\n';
    r.data.forEach(function(row) {
      csv += cols.map(function(c) { return '"' + String(row[c] || '').replace(/"/g, '""') + '"'; }).join(',') + '\n';
    });
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = sheet + '_export.csv'; a.click();
    URL.revokeObjectURL(url);
    toast('Export สำเร็จ: ' + sheet + '.csv', 'ok');
  } catch(e) { toast('Export ไม่ได้', 'err'); }
}

// ── Utilities ─────────────────────────────────────────────────
function fmt(n) { return (n !== undefined && n !== '') ? Number(n).toLocaleString('th-TH') : '—'; }
function fmtCurrency(n) { if (!n && n !== 0) return '—'; var v = Number(n); return isNaN(v) ? n : '฿' + v.toLocaleString('th-TH'); }

function toast(msg, type) {
  var wrap = document.getElementById('toast-wrap');
  var el   = document.createElement('div');
  var icons = { ok: '✅', err: '❌', info: 'ℹ️' };
  el.className = 'toast toast-' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : 'info');
  el.innerHTML = '<span>' + (icons[type] || '') + '</span>' + msg;
  wrap.appendChild(el);
  setTimeout(function() { if (el.parentNode) el.remove(); }, 3500);
}

// ── Close modals on overlay click ────────────────────────────
document.getElementById('modal-overlay').addEventListener('click', function(e) { if (e.target === this) e.stopPropagation(); });
document.getElementById('confirm-overlay').addEventListener('click', function(e) { if (e.target === this) closeConfirm(); });

// ── Keyboard shortcuts ────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeConfirm(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.getElementById('search-input').focus();
  }
});

// ── Init ──────────────────────────────────────────────────────

// ── Admin Panel ───────────────────────────────────────────────
var ADMIN_PASS_KEY = 'erp-admin-pass';
var ADMIN_USERS_KEY = 'erp-admin-users';
var ADMIN_UNLOCKED = false;

var DEFAULT_ADMIN_PASS = '';

var PERMISSION_MODULES = [
  { name: '📦 ระบบพนักงาน', sub: '& รายละเอียดงาน' },
  { name: '📈 ระบบ Sales', sub: '& ลูกค้า' },
  { name: '📋 สัญญา', sub: '& โปรเจกต์' },
  { name: '📊 Reports', sub: '& Analytics' },
  { name: '≋ Activity Log', sub: 'การบันทึก' },
];

var ROLES = [
  { key: 'admin',  label: 'ADMIN',  color: '#7c3aed', bg: 'rgba(124,58,237,0.1)' },
  { key: 'editor', label: 'EDITOR', color: '#4f8ef7', bg: 'rgba(79,142,247,0.1)' },
  { key: 'viewer', label: 'VIEWER', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
];

var PERM_DEFAULTS = {
  admin:  { view: true,  fill: true,  edit: true  },
  editor: { view: true,  fill: true,  edit: false },
  viewer: { view: true,  fill: false, edit: false },
};

var adminUsers = [];
var adminNextId = 1;

function getAdminPass() {
  return localStorage.getItem(ADMIN_PASS_KEY) || DEFAULT_ADMIN_PASS;
}

function checkAdminPass() {
  openAdminPanelForCurrentUser();
}

function lockAdmin() {
  ADMIN_UNLOCKED = false;
  var content = document.getElementById('admin-content');
  if (content) content.style.display = 'none';
  if (CURRENT_PANEL === 'admin') switchPanelByName('dashboard');
  syncRoleAccess();
}

function loadAdminData() {
  // Load users
  try {
    var saved = localStorage.getItem(ADMIN_USERS_KEY);
    adminUsers = saved ? JSON.parse(saved) : [
      { id:1, name:'สมชาย ใจดี',  email:'admin@erp.co.th',  role:'admin'  },
      { id:2, name:'มาลี รักงาน', email:'malee@erp.co.th',   role:'editor' },
    ];
    adminNextId = adminUsers.length ? Math.max.apply(null, adminUsers.map(function(u){return u.id;})) + 1 : 1;
  } catch(e) { adminUsers = []; }
  normalizeAdminUserIds();
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  syncAdminUsersToLoginDb();
  renderAdminMatrix();
  renderAdminUsers();
}

function renderAdminMatrix() {
  var tbody = document.getElementById('permission-matrix-body');
  if (!tbody) return;
  var html = '';
  PERMISSION_MODULES.forEach(function(mod) {
    ROLES.forEach(function(role, ri) {
      var p = PERM_DEFAULTS[role.key];
      html += '<tr style="border-bottom:1px solid var(--border)">';
      if (ri === 0) {
        html += '<td style="padding:10px 14px;font-weight:600;color:var(--text);vertical-align:middle" rowspan="3">' +
          mod.name + '<br><span style="color:var(--muted);font-weight:400;font-size:11px">' + mod.sub + '</span></td>';
      }
      html += '<td style="padding:8px 14px;text-align:center">' +
        '<span style="padding:2px 8px;border-radius:6px;font-size:10px;font-weight:700;font-family:var(--mono);background:' + role.bg + ';color:' + role.color + '">' + role.label + '</span></td>';
      html += '<td style="padding:8px 14px;text-align:center;color:' + (p.view ? 'var(--green)' : 'var(--red)') + '">' + (p.view ? '✔ เปิด' : '✕ ปิด') + '</td>';
      html += '<td style="padding:8px 14px;text-align:center;color:' + (p.fill ? 'var(--green)' : 'var(--red)') + '">' + (p.fill ? '✔ ได้' : '✕ ปิด') + '</td>';
      html += '<td style="padding:8px 14px;text-align:center">';
      if (p.edit) {
        html += '<span style="color:var(--green)">✔ ได้</span>';
      } else {
        html += '<span style="background:var(--bg4);color:var(--muted);padding:2px 8px;border-radius:6px;font-size:11px">🔒 บล็อก</span>';
      }
      html += '</td></tr>';
    });
  });
  tbody.innerHTML = html;
}

function renderAdminUsers() {
  var wrap = document.getElementById('admin-user-list');
  var countEl = document.getElementById('admin-user-count');
  if (!wrap) return;
  if (countEl) countEl.textContent = adminUsers.length + ' คน';
  if (!adminUsers.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">ยังไม่มีผู้ใช้</div>';
    return;
  }
  var avatarColors = ['#7c3aed','#4f8ef7','#22c55e','#ef4444','#f59e0b','#14b8a6','#ec4899'];
  var roleBadge = { admin: 'rgba(124,58,237,0.12);color:#a78bfa', editor: 'rgba(79,142,247,0.12);color:#60a5fa', viewer: 'rgba(245,158,11,0.12);color:#fbbf24' };
  wrap.innerHTML = adminUsers.map(function(u) {
    var initials = u.name.trim().split(' ').slice(0,2).map(function(p){return p[0];}).join('');
    var avatarColor = avatarColors[(u.id-1) % avatarColors.length];
    var badge = roleBadge[u.role] || 'rgba(107,114,128,0.1);color:var(--muted)';
    var employeeId = u.employeeId || ('EMP-' + String(u.id || 0).padStart(3, '0'));
    var position = u.position || u.pos || 'ยังไม่ระบุตำแหน่ง';
    var detail = u.detail || '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border)" id="admin-user-row-' + u.id + '">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + avatarColor + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0">' + initials + '</div>' +
        '<div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + u.name + '</div>' +
          '<div style="font-size:10px;color:var(--muted);font-family:var(--mono)">' + employeeId + ' · ' + u.email + '</div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + position + (detail ? ' · ' + detail : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<select onchange="adminChangeRole(' + u.id + ',this.value)" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);font-family:var(--font);font-size:11px;padding:4px 8px;border-radius:7px;outline:none;cursor:pointer">' +
          '<option value="admin"'  + (u.role==='admin'  ?' selected':'') + '>Admin</option>'  +
          '<option value="editor"' + (u.role==='editor' ?' selected':'') + '>Editor</option>' +
          '<option value="viewer"' + (u.role==='viewer' ?' selected':'') + '>Viewer</option>' +
        '</select>' +
        '<button onclick="adminDeleteUser(' + u.id + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 4px" title="ลบ">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function adminChangeRole(id, role) {
  var u = adminUsers.find(function(x){return x.id===id;});
  if (u) u.role = role;
}

function adminDeleteUser(id) {
  var u = adminUsers.find(function(x){return x.id===id;});
  if (!u) return;
  if (!confirm('ลบ "' + u.name + '" ออกจากระบบ?')) return;
  adminUsers = adminUsers.filter(function(x){return x.id!==id;});
  renderAdminUsers();
  toast('ลบผู้ใช้ "' + u.name + '" แล้ว', 'ok');
}

function openAdminAddUser() {
  EDIT_ID = null;
  document.getElementById('modal-title').textContent = '+ เพิ่มผู้ใช้ระบบ';
  var html = '<div class="form-group"><label class="form-label">ชื่อ-นามสกุล</label><input class="form-input" id="admin-field-name" placeholder="ชื่อ นามสกุล"></div>' +
    '<div class="form-group"><label class="form-label">อีเมล</label><input class="form-input" id="admin-field-email" type="email" placeholder="email@example.com"></div>' +
    '<div class="form-group"><label class="form-label">ตำแหน่ง</label><input class="form-input" id="admin-field-position" placeholder="เช่น นักยิงแอด, ฝ่ายบัญชี"></div>' +
    '<div class="form-group"><label class="form-label">เปลี่ยนรหัสผ่าน</label><input class="form-input" id="admin-field-password" type="password" placeholder="รหัสผ่านใหม่"></div>' +
    '<div class="form-group"><label class="form-label">บทบาท</label><select class="form-select" id="admin-field-role"><option value="admin">Admin</option><option value="editor" selected>Editor</option><option value="viewer">Viewer</option></select></div>' +
    '<div class="form-group full"><label class="form-label">รายละเอียด</label><textarea class="form-input textarea" id="admin-field-detail" placeholder="รายละเอียดเพิ่มเติมของพนักงาน"></textarea></div>';
  document.getElementById('modal-form').innerHTML = html;
  document.getElementById('modal-save').onclick = saveAdminUser;
  document.getElementById('modal-overlay').classList.add('open');
}

function saveAdminUser() {
  var name     = (document.getElementById('admin-field-name') || {}).value || '';
  var email    = (document.getElementById('admin-field-email') || {}).value || '';
  var position = (document.getElementById('admin-field-position') || {}).value || '';
  var password = (document.getElementById('admin-field-password') || {}).value || '';
  var detail   = (document.getElementById('admin-field-detail') || {}).value || '';
  var role     = (document.getElementById('admin-field-role') || {}).value || 'editor';
  if (!name.trim()) { toast('กรุณากรอกชื่อ', 'err'); return; }
  if (!email.trim()) { toast('กรุณากรอกอีเมล', 'err'); return; }
  if (password && password.length < 4) { toast('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร', 'err'); return; }
  var usedIds = {};
  USERS_DB.concat(adminUsers).forEach(function(u) { if (u && (u.id || u.employeeId)) usedIds[u.employeeId || u.id] = true; });
  var nextNum = adminNextId;
  var employeeId = 'EMP-' + String(nextNum).padStart(3, '0');
  while (usedIds[employeeId]) {
    nextNum += 1;
    employeeId = 'EMP-' + String(nextNum).padStart(3, '0');
  }
  adminUsers.push({
    id: nextNum,
    employeeId: employeeId,
    name: name.trim(),
    email: email.trim(),
    position: position.trim(),
    password: password.trim(),
    detail: detail.trim(),
    role: role
  });
  adminNextId = nextNum + 1;
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  renderAdminUsers();
  closeModal();
  document.getElementById('modal-save').onclick = saveModal;
  toast('เพิ่มผู้ใช้ "' + name + '" แล้ว · Login: ' + employeeId, 'ok');
}

function saveAdminChanges() {
  // sync roles from dropdowns
  adminUsers.forEach(function(u) {
    var row = document.getElementById('admin-user-row-' + u.id);
    if (row) { var sel = row.querySelector('select'); if (sel) u.role = sel.value; }
  });
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  toast('บันทึกการเปลี่ยนแปลงสิทธิ์แล้ว ✅', 'ok');
}

function changeAdminPassword() {
  var oldP = document.getElementById('admin-old-pass').value;
  var newP = document.getElementById('admin-new-pass').value;
  var conP = document.getElementById('admin-confirm-pass').value;
  if (oldP !== getAdminPass()) { toast('รหัสผ่านปัจจุบันไม่ถูกต้อง', 'err'); return; }
  if (!newP || newP.length < 4) { toast('รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร', 'err'); return; }
  if (newP !== conP) { toast('รหัสผ่านใหม่ไม่ตรงกัน', 'err'); return; }
  localStorage.setItem(ADMIN_PASS_KEY, newP);
  document.getElementById('admin-old-pass').value = '';
  document.getElementById('admin-new-pass').value = '';
  document.getElementById('admin-confirm-pass').value = '';
  toast('เปลี่ยนรหัสผ่าน Admin สำเร็จ ✅', 'ok');
}

// Show admin nav only when on admin panel or always visible
function initAdminNav() {
  var navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.style.display = userCanWrite() ? 'flex' : 'none';
}


document.addEventListener('DOMContentLoaded', function() {
  // Setup login form keyboard navigation
  var lup = document.getElementById('login-user');
  var lpp = document.getElementById('login-pass');
  if (lup) lup.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); if(lpp) lpp.focus(); } });
  if (lpp) lpp.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); doLogin(e); } });
  // Admin pass enter key
  var apass = document.getElementById('admin-pass-input');
  if (apass) apass.addEventListener('keydown', function(e){ if(e.key === 'Enter') checkAdminPass(); });
});

// ══════════════════════════════════════════════════
// ── LOGIN SYSTEM (Fixed - form submit no refresh) ──
// ══════════════════════════════════════════════════
var USERS_DB = [
  { id:'EMP-001', name:'สมชาย ใจดี',    role:'admin',  dept:'IT',       pos:'Senior Developer',  avatar:'สจ' },
  { id:'EMP-002', name:'มาลี รักงาน',   role:'editor', dept:'การตลาด', pos:'Marketing Manager', avatar:'มล' },
  { id:'EMP-003', name:'วิชัย เก่งมาก', role:'editor', dept:'การเงิน', pos:'Financial Analyst',  avatar:'วช' },
  { id:'EMP-004', name:'นารี สวยงาม',   role:'viewer', dept:'HR',       pos:'HR Coordinator',    avatar:'นร' },
  { id:'EMP-007', employeeId:'EMP-007', name:'หลิว', role:'editor', dept:'การตลาด', pos:'นักยิงแอด / การตลาด', avatar:'หล' },
  { id:'EMP-ADM', name:'Administrator',  role:'admin',  dept:'System',   pos:'Super Admin',       avatar:'AD' },
];
var CURRENT_USER = null;

USERS_DB = [
  { id:'EMP-001', name:'สมชาย ใจดี',    role:'editor', dept:'IT',       pos:'Senior Developer',  avatar:'สจ', password:'' },
  { id:'EMP-002', name:'มาลี รักงาน',   role:'editor', dept:'การตลาด', pos:'Marketing Manager', avatar:'มล', password:'' },
  { id:'EMP-003', name:'วิชัย เก่งมาก', role:'editor', dept:'การเงิน', pos:'Financial Analyst',  avatar:'วช', password:'' },
  { id:'EMP-004', name:'นารี สวยงาม',   role:'viewer', dept:'HR',       pos:'HR Coordinator',    avatar:'นร', password:'' },
  { id:'EMP-005', employeeId:'EMP-005', name:'พนักงานทดสอบ', role:'editor', dept:'ฝ่ายขาย', pos:'พนักงานขาย (Sales)', avatar:'พท', password:'aa123' },
  { id:'EMP-007', employeeId:'EMP-007', name:'หลิว', role:'editor', dept:'การตลาด', pos:'นักยิงแอด / การตลาด', avatar:'หล', password:'aa123' },
  { id:'EMP-ADM', name:'Administrator', role:'admin',  dept:'System',   pos:'Super Admin',       avatar:'AD', password:'' }
];

function migrateEmployee007Password() {
  ['erp-users-db', ADMIN_USERS_KEY].forEach(function(key) {
    try {
      var list = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(list)) return;
      var changed = false;
      list.forEach(function(user) {
        var id = String(user && (user.employeeId || user.id) || '').trim().toUpperCase();
        if (id === 'EMP-007' && (!user.password || user.password === '123456')) {
          user.password = 'aa123';
          changed = true;
        }
      });
      if (changed) localStorage.setItem(key, JSON.stringify(list));
    } catch (error) {
      console.warn('Unable to migrate EMP-007 password', error);
    }
  });
}

migrateEmployee007Password();

function ensureRequestedEmployeeAccounts() {
  try {
    var list = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY) || '[]');
    if (!Array.isArray(list)) list = [];
    var nextId = list.reduce(function(max, user) {
      return Math.max(max, Number(user && user.id) || 0);
    }, 0) + 1;
    [
      {
        employeeId: 'EMP-005',
        name: 'พนักงานทดสอบ',
        email: 'sales.emp005@erp.local',
        position: 'พนักงานขาย (Sales)',
        detail: 'พนักงานฝ่ายขายสำหรับทดสอบการกรอกข้อมูลและรายงานประจำวัน',
        role: 'editor',
        password: 'aa123',
        forcePosition: true
      },
      {
        employeeId: 'EMP-007',
        name: 'หลิว',
        email: 'a',
        position: 'นักยิงแอด / การตลาด',
        detail: 'พนักงานฝ่ายการตลาด',
        role: 'editor',
        password: 'aa123'
      }
    ].forEach(function(seed) {
      var existing = list.find(function(user) {
        return String(user && (user.employeeId || user.id) || '').trim().toUpperCase() === seed.employeeId;
      });
      if (existing) {
        existing.employeeId = seed.employeeId;
        existing.password = seed.password;
        if (!existing.position || seed.forcePosition) existing.position = seed.position;
        if (!existing.detail) existing.detail = seed.detail;
      } else {
        var newUser = Object.assign({ id: nextId++ }, seed);
        delete newUser.forcePosition;
        list.push(newUser);
      }
    });
    localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(list));
  } catch (error) {
    console.warn('Unable to ensure requested employee accounts', error);
  }
}

ensureRequestedEmployeeAccounts();

function getDbUsers() {
  var users = USERS_DB.slice();
  try {
    var saved = localStorage.getItem('erp-users-db');
    if (saved) {
      var p = JSON.parse(saved);
      if (Array.isArray(p) && p.length) {
        p.forEach(function(user) {
          if (!user || (!user.id && !user.employeeId)) return;
          var savedId = String(user.employeeId || user.id).trim().toUpperCase();
          user.id = savedId;
          user.employeeId = savedId;
          var index = users.findIndex(function(existing) { return String(existing.employeeId || existing.id || '').trim().toUpperCase() === savedId; });
          if (index > -1) users[index] = Object.assign({}, users[index], user);
          else users.push(user);
        });
      }
    }
  } catch(e) {}
  try {
    var adminSaved = localStorage.getItem(ADMIN_USERS_KEY);
    var adminList = adminSaved ? JSON.parse(adminSaved) : [];
    if (!Array.isArray(adminList)) adminList = [];
    adminList.forEach(function(u) {
      if (!u || (!u.employeeId && !u.id)) return;
      var id = String(u.employeeId || ('EMP-' + String(u.id || users.length + 1).padStart(3, '0'))).trim().toUpperCase();
      u.employeeId = id;
      var loginUser = {
        id: id,
        employeeId: id,
        name: u.name || id,
        role: u.role || 'editor',
        dept: 'Admin',
        position: u.position || '',
        pos: u.position || '',
        avatar: (u.name || 'U').trim().slice(0, 2).toUpperCase(),
        password: u.password,
        detail: u.detail || ''
      };
      var index = users.findIndex(function(existing) { return String(existing.employeeId || existing.id || '').trim().toUpperCase() === id; });
      if (index > -1) users[index] = Object.assign({}, users[index], loginUser);
      else users.push(loginUser);
    });
  } catch(e) {}
  return users;
}

function userCanWrite() {
  return !!(CURRENT_USER && CURRENT_USER.role === 'admin');
}

function syncRoleAccess() {
  var navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.style.display = userCanWrite() ? 'flex' : 'none';
  var addBtn = document.getElementById('btn-add');
  if (addBtn) addBtn.style.display = (userCanWrite() && SCHEMAS[CURRENT_PANEL]) ? 'inline-flex' : 'none';
}

function openAdminPanelForCurrentUser() {
  var gate = document.getElementById('admin-gate');
  var content = document.getElementById('admin-content');
  if (gate) gate.style.display = 'none';
  if (!content) return;
  if (!userCanWrite()) {
    content.style.display = 'none';
    toast('Admin only', 'err');
    switchPanelByName('dashboard');
    return;
  }
  ADMIN_UNLOCKED = true;
  content.style.display = 'block';
  loadAdminData();
}

// ── Toggle password eye ──
function lcToggleEye() {
  var inp = document.getElementById('login-pass');
  var btn = document.getElementById('lc-eye-btn');
  if (!inp) return;
  if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; }
  else { inp.type = 'password'; btn.textContent = '👁️'; }
}

// ── Autofill Admin ID ──
function lcSetAdmin() {
  var u = document.getElementById('login-user');
  var p = document.getElementById('login-pass');
  if (u) u.value = 'EMP-ADM';
  if (p) {
    p.value = '';
    p.focus();
  }
}

// ── Main login handler (accepts form submit event) ──
function doLogin(event) {
  if (event) event.preventDefault(); // ป้องกัน page refresh

  var uidEl  = document.getElementById('login-user');
  var passEl = document.getElementById('login-pass');
  var errEl  = document.getElementById('lc-err');

  if (!uidEl || !passEl) return;

  var uid  = uidEl.value.trim().toUpperCase();
  var pass = passEl.value;

  // Reset error
  if (errEl) errEl.style.display = 'none';

  // Basic validation
  if (!uid || !pass) {
    if (errEl) { errEl.textContent = 'กรุณากรอกรหัสพนักงานและรหัสผ่านให้ครบ'; errEl.style.display = 'block'; }
    return;
  }

  // Find user
  var users = getDbUsers();
  var user  = users.find(function(u) {
    return String(u.id || u.employeeId || '').toUpperCase() === uid;
  });

  if (!user) {
    if (errEl) { errEl.textContent = 'ไม่พบรหัสพนักงาน "' + uid + '" ในระบบ'; errEl.style.display = 'block'; }
    if (uidEl) uidEl.focus();
    return;
  }

  if (!user.password) {
    if (errEl) { errEl.textContent = 'บัญชี "' + uid + '" ยังไม่ได้ตั้งรหัสผ่าน กรุณาให้ Admin แก้ไขผู้ใช้'; errEl.style.display = 'block'; }
    if (passEl) passEl.focus();
    return;
  }

  // Password check
  var expectedPass = user.password || (user.role === 'admin' ? getAdminPass() : '123456');
  var validPass = (pass === expectedPass);
  validPass = (pass === expectedPass);

  if (!validPass) {
    if (errEl) { errEl.textContent = 'รหัสผ่านไม่ถูกต้อง'; errEl.style.display = 'block'; }
    if (passEl) passEl.focus();
    return;
  }

  // ── SUCCESS ──
  CURRENT_USER = user;
  console.log('[ERP] Login:', user.id, user.role);

  // Show/hide Admin nav based on role
  var navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.style.display = (user.role === 'admin') ? 'flex' : 'none';
  syncRoleAccess();

  // Update topbar
  updateTopbarUser(user);

  // Transition: hide login, show ERP
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('erp-app').classList.add('visible');
  document.documentElement.scrollLeft = 0;
  document.body.scrollLeft = 0;
  window.scrollTo(0, 0);

  // Init ERP
  initOfflineDashboard();
  initCharts();
  if (CONNECTED) { setStatus('ok', 'เชื่อมต่อแล้ว'); loadStats(); }
  else { setStatus('idle', 'ยังไม่ได้เชื่อมต่อ'); }
}

// ── Logout ──
function doLogout() {
  CURRENT_USER = null;
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('erp-app').classList.remove('visible');
  var passEl = document.getElementById('login-pass');
  var errEl  = document.getElementById('lc-err');
  if (passEl) passEl.value = '';
  if (errEl) errEl.style.display = 'none';
  lockAdmin(); // lock admin panel
}

// ── Topbar user chip ──
function updateTopbarUser(user) {
  var area = document.getElementById('topbar-user-area');
  if (!area) return;
  user = user || {};
  var displayName = user.name || user.fullName || user.employeeId || user.id || 'ผู้ใช้งาน';
  var avatar = user.avatar || displayName.trim().split(/\s+/).slice(0, 2).map(function(part) {
    return part.charAt(0);
  }).join('').toUpperCase() || 'U';
  var avatarColors = {
    admin:  'linear-gradient(135deg,#5b21b6,#8b5cf6)',
    editor: 'linear-gradient(135deg,#1e40af,#4f8ef7)',
    viewer: 'linear-gradient(135deg,#b45309,#f59e0b)'
  };
  var roleLabels = { admin:'ADMIN', editor:'EDITOR', viewer:'VIEWER' };
  var roleClass  = { admin:'role-admin', editor:'role-editor', viewer:'role-viewer' };
  area.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;padding:4px 12px 4px 6px;background:var(--bg3);border:1px solid var(--border);border-radius:20px">' +
      '<div style="width:26px;height:26px;border-radius:50%;background:' + (avatarColors[user.role]||'var(--accent)') + ';display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff">' + escapeHtml(avatar) + '</div>' +
      '<span style="font-size:12px;font-weight:600;color:var(--text)">' + escapeHtml(displayName) + '</span>' +
      '<span class="user-role-badge ' + (roleClass[user.role]||'') + '">' + (roleLabels[user.role]||'USER') + '</span>' +
    '</div>' +
    '<button class="btn btn-ghost btn-sm" onclick="doLogout()" style="display:inline-flex;align-items:center;gap:5px">🚪 ออกจากระบบ</button>';
}
// ══════════════════════════════════════════════════


// ── Dashboard Utilities ──────────────────────────────────────
function updateBarYear(year) {
  document.getElementById('dash-year').textContent = year;
  initCharts(); // re-render with same demo data
  toast('โหลดข้อมูลปี ' + year + ' แล้ว', 'info');
}

function updatePieChart(filter) {
  // Re-render pie with filter label
  toast('กรองข้อมูล: ' + (filter === 'all' ? 'รวมทุกบัญชี' : filter), 'info');
}

function applyAccountFilter() {
  var start = document.getElementById('start_date');
  var end = document.getElementById('end_date');
  var startVal = start ? start.value : '';
  var endVal = end ? end.value : '';

  if (!startVal || !endVal) {
    toast('กรุณาเลือกวันที่เริ่มต้นและวันที่สิ้นสุด', 'err');
    return;
  }

  if (startVal > endVal) {
    toast('วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด', 'err');
    return;
  }

  toast('Apply Daily Filter: ' + startVal + ' ถึง ' + endVal, 'ok');
}

function saveAccessToken() {
  var t = document.getElementById('access-token-input');
  if (!t || !t.value.trim()) { toast('กรุณากรอก Token ก่อน', 'err'); return; }
  sessionStorage.setItem('erp-access-token', t.value.trim());
  t.value = '';
  toast('เก็บ Token เฉพาะแท็บนี้เรียบร้อยแล้ว', 'ok');
}

function clearCache() {
  if (!confirm('ล้าง Cache ทั้งหมด?')) return;
  var keys = ['erp-url','erp-theme','erp-admin-users'];
  keys.forEach(function(k){ localStorage.removeItem(k); });
  if (window.ERP_SECURITY) window.ERP_SECURITY.clear();
  sessionStorage.removeItem('erp-access-token');
  toast('ล้าง Cache เรียบร้อยแล้ว', 'ok');
}

function updateSystemStatus(connected) {
  var apiEl    = document.getElementById('sys-api-status');
  var sheetsEl = document.getElementById('sys-sheets-status');
  var syncEl   = document.getElementById('sys-last-sync');
  if (apiEl) {
    apiEl.textContent = connected ? '● ออนไลน์' : '● ออฟไลน์';
    apiEl.style.color = connected ? 'var(--green)' : 'var(--red)';
  }
  if (sheetsEl) {
    sheetsEl.textContent = connected ? '● เชื่อมต่อแล้ว' : '● ไม่ได้เชื่อมต่อ';
    sheetsEl.style.color = connected ? 'var(--green)' : 'var(--muted)';
  }
  if (syncEl) {
    var now = new Date();
    syncEl.textContent = connected ? (now.getHours() + ':' + String(now.getMinutes()).padStart(2,'0')) : '—';
  }
  // Load saved token if any
  var savedToken = sessionStorage.getItem('erp-access-token');
  var tokenEl = document.getElementById('access-token-input');
  if (tokenEl && savedToken) tokenEl.value = savedToken;
}


// ══════════════════════════════════════════════════════════════
// ── MOBILE MENU ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function toggleMobileMenu() {
  var sb = document.querySelector('.sidebar');
  var ov = document.getElementById('sidebar-overlay');
  if (!sb) return;
  var open = sb.classList.contains('mobile-open');
  if (open) { sb.classList.remove('mobile-open'); ov.classList.remove('on'); }
  else       { sb.classList.add('mobile-open');    ov.classList.add('on'); }
}
function closeMobileMenu() {
  var sb = document.querySelector('.sidebar');
  var ov = document.getElementById('sidebar-overlay');
  if (sb) sb.classList.remove('mobile-open');
  if (ov) ov.classList.remove('on');
}
// Close mobile menu on nav item click
document.addEventListener('click', function(e) {
  var item = e.target.closest('.nav-v2-item, .nav-item');
  if (item && window.innerWidth <= 768) closeMobileMenu();
});

// ══════════════════════════════════════════════════════════════
// ── NOTIFICATION CENTER ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════
var NOTIFS = [];
var NOTIF_OPEN = false;

function addNotif(msg, sub, type, icon) {
  type = type || 'info';
  icon = icon || '🔔';
  NOTIFS.unshift({
    id: Date.now() + Math.random(),
    msg: msg, sub: sub || '', type: type, icon: icon,
    time: new Date(), read: false
  });
  renderNotifs();
}

function renderNotifs() {
  var list  = document.getElementById('notif-list');
  var badge = document.getElementById('notif-badge');
  if (!list) return;

  var unread = NOTIFS.filter(function(n){ return !n.read; }).length;
  if (badge) {
    badge.style.display = unread > 0 ? 'flex' : 'none';
    badge.textContent   = unread > 9 ? '9+' : String(unread);
  }

  if (!NOTIFS.length) {
    list.innerHTML = '<div class="notif-empty">🎉 ไม่มีการแจ้งเตือนใหม่</div>';
    return;
  }

  var typeMap = { urgent:'urgent', warning:'warning', success:'success', info:'unread' };
  list.innerHTML = NOTIFS.slice(0, 20).map(function(n) {
    var cls = typeMap[n.type] || 'unread';
    if (!n.read) cls += '';
    var ago = timeAgo(n.time);
    return '<div class="notif-item ' + cls + (n.read ? '' : ' unread') + '" onclick="markRead(' + JSON.stringify(n.id) + ')">' +
      '<div class="notif-icon">' + n.icon + '</div>' +
      '<div class="notif-body">' +
        '<div class="notif-msg">' + n.msg + '</div>' +
        (n.sub ? '<div class="notif-sub">' + n.sub + '</div>' : '') +
        '<div class="notif-time">' + ago + '</div>' +
      '</div>' +
      (!n.read ? '<div class="notif-unread-dot"></div>' : '') +
    '</div>';
  }).join('');
}

function markRead(id) {
  var n = NOTIFS.find(function(x){ return x.id === id; });
  if (n) { n.read = true; renderNotifs(); }
}

function clearAllNotif() {
  NOTIFS.forEach(function(n){ n.read = true; });
  renderNotifs();
}

function toggleNotifPanel(event) {
  if (event) event.stopPropagation();
  var panel = document.getElementById('notif-panel');
  if (!panel) return;
  NOTIF_OPEN = !NOTIF_OPEN;
  if (NOTIF_OPEN) {
    panel.classList.add('open');
    NOTIFS.forEach(function(n){ n.read = true; });
    setTimeout(renderNotifs, 300);
  } else {
    panel.classList.remove('open');
  }
}

// Close notif panel on outside click
document.addEventListener('click', function(e) {
  var wrap = document.getElementById('notif-wrap');
  if (wrap && !wrap.contains(e.target) && NOTIF_OPEN) {
    document.getElementById('notif-panel').classList.remove('open');
    NOTIF_OPEN = false;
  }
});

function timeAgo(date) {
  var sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60)  return 'เมื่อกี้';
  if (sec < 3600) return Math.floor(sec/60) + ' นาทีที่แล้ว';
  if (sec < 86400) return Math.floor(sec/3600) + ' ชั่วโมงที่แล้ว';
  return Math.floor(sec/86400) + ' วันที่แล้ว';
}

// ── Smart notifications after data load ──
function checkSmartNotifications(data) {
  if (!data) return;
  var today = new Date();

  // Contracts expiring within 30 days
  if (data.contracts && data.contracts.length) {
    data.contracts.forEach(function(row) {
      var endDate = row['วันสิ้นสุด'] || row['end_date'] || '';
      if (!endDate) return;
      var d = new Date(endDate.split('/').reverse().join('-'));
      if (isNaN(d)) return;
      var daysLeft = Math.ceil((d - today) / 86400000);
      if (daysLeft >= 0 && daysLeft <= 30) {
        addNotif(
          'สัญญาใกล้หมดอายุ: ' + (row['ชื่อสัญญา'] || 'ไม่ระบุ'),
          'เหลืออีก ' + daysLeft + ' วัน · ' + (row['ลูกค้า'] || ''),
          daysLeft <= 7 ? 'urgent' : 'warning',
          daysLeft <= 7 ? '🚨' : '⚠️'
        );
      }
    });
  }

  // Overdue projects
  if (data.projects && data.projects.length) {
    data.projects.forEach(function(row) {
      var status = (row['สถานะ'] || '').toLowerCase();
      var dueDate = row['วันส่งมอบ'] || '';
      if (!dueDate || status.indexOf('เสร็จ') > -1) return;
      var d = new Date(dueDate.split('/').reverse().join('-'));
      if (isNaN(d)) return;
      if (d < today) {
        addNotif(
          'โปรเจกต์เลยกำหนด: ' + (row['ชื่อโปรเจกต์'] || 'ไม่ระบุ'),
          'กำหนดส่ง: ' + dueDate + ' · ' + (row['ผู้รับผิดชอบ'] || ''),
          'urgent', '🔴'
        );
      }
    });
  }
}

// ── Patch loadStats to also check smart notifs ──
var _origLoadStats = typeof loadStats === 'function' ? loadStats : null;

// ══════════════════════════════════════════════════════════════
// ── CSV IMPORT ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
var IMPORT_SHEET   = 'sales';
var IMPORT_ROWS    = [];
var IMPORT_HEADERS = [];

var SCHEMA_HEADERS = {
  sales:     ['ID','วันที่','ลูกค้า','สินค้า','จำนวน','ราคา','ยอดรวม','สถานะ','หมายเหตุ'],
  customers: ['ID','ชื่อ','บริษัท','อีเมล','โทรศัพท์','ที่อยู่','สถานะ','วันที่เพิ่ม'],
  contracts: ['ID','ชื่อลูกค้า','สัญญางานสร้างบ้าน','ข้อมูลมัดจำ/เซ็นสัญญา','ทำเลที่ดินของลูกค้า','วันเริ่มสัญญา','วันสิ้นสุดสัญญา','มูลค่าสัญญา','สถานะ','รายละเอียดของแต่ละงาน','หมายเหตุ'],
  employees: ['ID','ชื่อ','ตำแหน่ง','แผนก','อีเมล','โทรศัพท์','วันเริ่มงาน','สถานะ'],
  projects:  ['ID','ชื่องาน/โปรเจกต์','ลูกค้า','ผู้รับผิดชอบ','ทำเลที่ดินของลูกค้า','งานเพิ่มเติม','รายละเอียดของแต่ละงาน','วันเริ่ม','วันส่งมอบ','งบประมาณ','สถานะ'],
};

function openImportModal(sheet) {
  IMPORT_SHEET = sheet;
  IMPORT_ROWS  = [];
  document.getElementById('import-modal-title').textContent = '📥 Import CSV — ' + sheet;
  var expected = (SCHEMA_HEADERS[sheet] || []).filter(function(h){return h!=='ID';}).join(', ');
  document.getElementById('import-expected-headers').textContent = expected;
  document.getElementById('import-step1').style.display = 'block';
  document.getElementById('import-step2').style.display = 'none';
  document.getElementById('import-back-btn').style.display = 'none';
  document.getElementById('import-do-btn').style.display   = 'none';
  document.getElementById('import-file').value = '';
  document.getElementById('import-result-msg').textContent = '';
  document.getElementById('import-progress-wrap').style.display = 'none';
  document.getElementById('import-overlay').classList.add('open');
}

function closeImport() {
  document.getElementById('import-overlay').classList.remove('open');
}

function importGoBack() {
  document.getElementById('import-step1').style.display = 'block';
  document.getElementById('import-step2').style.display = 'none';
  document.getElementById('import-back-btn').style.display = 'none';
  document.getElementById('import-do-btn').style.display   = 'none';
}

function handleImportDrop(e) {
  e.preventDefault();
  document.getElementById('import-drop').classList.remove('drag-over');
  var file = e.dataTransfer.files[0];
  if (file) readImportFile(file);
}

function handleImportFile(input) {
  var file = input.files[0];
  if (file) readImportFile(file);
}

function readImportFile(file) {
  if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
    toast('กรุณาเลือกไฟล์ .csv เท่านั้น', 'err'); return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    var text = e.target.result;
    // handle BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    parseCSV(text);
  };
  reader.readAsText(file, 'UTF-8');
}

function parseCSV(text) {
  var lines = text.split(/\r?\n/).filter(function(l){ return l.trim(); });
  if (lines.length < 2) { toast('ไฟล์ไม่มีข้อมูล', 'err'); return; }

  function splitCSVLine(line) {
    var result = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  }

  IMPORT_HEADERS = splitCSVLine(lines[0]);
  IMPORT_ROWS = lines.slice(1).map(function(l) {
    var vals = splitCSVLine(l);
    var obj = {};
    IMPORT_HEADERS.forEach(function(h, i){ obj[h] = vals[i] || ''; });
    return obj;
  }).filter(function(r){ return Object.values(r).some(function(v){ return v.trim(); }); });

  showImportPreview();
}

function showImportPreview() {
  var validRows = IMPORT_ROWS.length;
  var cols      = IMPORT_HEADERS.length;
  var expected  = (SCHEMA_HEADERS[IMPORT_SHEET] || []).filter(function(h){ return h!=='ID'; });
  var matched   = IMPORT_HEADERS.filter(function(h){ return expected.indexOf(h) > -1; }).length;

  // Stats
  document.getElementById('import-stats').innerHTML =
    '<div class="import-stat"><div class="import-stat-num">' + validRows + '</div><div class="import-stat-lbl">แถว</div></div>' +
    '<div class="import-stat"><div class="import-stat-num">' + cols + '</div><div class="import-stat-lbl">คอลัมน์</div></div>' +
    '<div class="import-stat"><div class="import-stat-num" style="color:' + (matched>=expected.length?'var(--green)':'var(--amber)') + '">' + matched + '/' + expected.length + '</div><div class="import-stat-lbl">Header ตรง</div></div>';

  // Map message
  var mapMsg = matched >= expected.length
    ? '<span style="color:var(--green)">✔ Header ตรงทั้งหมด พร้อม Import</span>'
    : '<span style="color:var(--amber)">⚠ Header ตรง ' + matched + '/' + expected.length + ' คอลัมน์ (คอลัมน์ที่ไม่ตรงจะข้ามไป)</span>';
  document.getElementById('import-map-msg').innerHTML = mapMsg;

  // Preview table (first 10 rows)
  var previewRows = IMPORT_ROWS.slice(0, 10);
  var html = '<table><thead><tr>' + IMPORT_HEADERS.map(function(h){
    var ok = (SCHEMA_HEADERS[IMPORT_SHEET]||[]).indexOf(h) > -1;
    return '<th style="color:' + (ok?'var(--green)':'var(--muted)') + '">' + h + '</th>';
  }).join('') + '</tr></thead><tbody>';
  previewRows.forEach(function(row){
    html += '<tr>' + IMPORT_HEADERS.map(function(h){ return '<td>' + (row[h]||'') + '</td>'; }).join('') + '</tr>';
  });
  if (IMPORT_ROWS.length > 10) html += '<tr><td colspan="' + IMPORT_HEADERS.length + '" style="color:var(--muted);text-align:center;padding:8px">...และอีก ' + (IMPORT_ROWS.length-10) + ' แถว</td></tr>';
  html += '</tbody></table>';
  document.getElementById('import-preview-table').innerHTML = html;

  document.getElementById('import-step1').style.display = 'none';
  document.getElementById('import-step2').style.display = 'block';
  document.getElementById('import-back-btn').style.display = 'inline-flex';
  document.getElementById('import-do-btn').style.display   = 'inline-flex';
  document.getElementById('import-do-count').textContent   = validRows;
  document.getElementById('import-result-msg').textContent = '';
  document.getElementById('import-progress-wrap').style.display = 'none';
}

async function doImport() {
  if (!CONNECTED) { toast('กรุณาเชื่อมต่อ API ก่อน', 'err'); return; }
  if (!IMPORT_ROWS.length) { toast('ไม่มีข้อมูล', 'err'); return; }

  var btn  = document.getElementById('import-do-btn');
  var prog = document.getElementById('import-progress-wrap');
  var fill = document.getElementById('import-progress-fill');
  var msg  = document.getElementById('import-result-msg');

  btn.disabled    = true;
  btn.textContent = '⏳ กำลัง Import...';
  prog.style.display = 'block';
  fill.style.width   = '0%';
  msg.textContent    = '';

  var ok = 0, fail = 0;
  for (var i = 0; i < IMPORT_ROWS.length; i++) {
    try {
      var r = await apiGet({ action:'write', sheet:IMPORT_SHEET, data: JSON.stringify(IMPORT_ROWS[i]) });
      if (r.ok) ok++; else fail++;
    } catch(e) { fail++; }
    fill.style.width = Math.round((i+1)/IMPORT_ROWS.length*100) + '%';
  }

  var color = fail === 0 ? 'var(--green)' : 'var(--amber)';
  msg.innerHTML = '<span style="color:' + color + '">✔ Import สำเร็จ ' + ok + ' แถว' + (fail?(' · ล้มเหลว '+fail+' แถว'):'') + '</span>';
  btn.disabled    = false;
  btn.textContent = '✔ เสร็จสิ้น';

  if (ok > 0) {
    addNotif('Import สำเร็จ: ' + ok + ' แถว', 'Sheet: ' + IMPORT_SHEET, 'success', '📥');
    loadPanel(IMPORT_SHEET);
    loadStats();
  }
}

// ── Added feature pack: Smart Search, Shortcuts, Audit, Undo ──
var AUDIT_KEY = 'erp-audit-log';
var AUDIT_LOG = [];
var AUDIT_MAX = 500;
var UNDO_STACK = [];

(function initFeaturePackState() {
  try { AUDIT_LOG = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]'); }
  catch(e) { AUDIT_LOG = []; }
})();

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
    return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch];
  });
}

function logAudit(type, who, what, oldVal, newVal) {
  AUDIT_LOG.unshift({
    id: Date.now(),
    ts: new Date().toISOString(),
    type: type || 'info',
    who: who || (CURRENT_USER ? CURRENT_USER.name : 'ระบบ'),
    what: what || '',
    old: oldVal == null ? '—' : oldVal,
    new: newVal == null ? '—' : newVal
  });
  if (AUDIT_LOG.length > AUDIT_MAX) AUDIT_LOG = AUDIT_LOG.slice(0, AUDIT_MAX);
  try { localStorage.setItem(AUDIT_KEY, JSON.stringify(AUDIT_LOG)); } catch(e) {}
  if (document.getElementById('panel-audit') && document.getElementById('panel-audit').classList.contains('active')) renderAuditTrail();
}

function renderAuditTrail() {
  var wrap = document.getElementById('audit-list');
  var cnt = document.getElementById('audit-count');
  if (!wrap) return;
  var filterEl = document.getElementById('audit-filter');
  var filter = filterEl ? filterEl.value : 'all';
  var logs = filter === 'all' ? AUDIT_LOG : AUDIT_LOG.filter(function(l) { return l.type === filter; });
  if (cnt) cnt.textContent = logs.length + ' รายการ';
  if (!logs.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">ยังไม่มี Audit Log</div></div>';
    return;
  }
  var icons = { login:'🔐', create:'＋', delete:'−', admin:'🛡️', info:'•' };
  wrap.innerHTML = logs.map(function(l) {
    var d = new Date(l.ts);
    return '<div class="audit-row">' +
      '<div class="audit-icon">' + (icons[l.type] || '•') + '</div>' +
      '<div class="audit-body">' +
        '<div class="audit-who">' + escapeHtml(l.who) + ' <span style="color:var(--muted);font-size:11px;font-weight:400">' + escapeHtml(l.type) + '</span></div>' +
        '<div class="audit-what">' + escapeHtml(l.what) + '</div>' +
        ((l.old !== '—' || l.new !== '—') ? '<div class="audit-what">' + escapeHtml(l.old) + ' → ' + escapeHtml(l.new) + '</div>' : '') +
      '</div>' +
      '<div class="audit-time">' + d.toLocaleDateString('th-TH') + '<br>' + d.toLocaleTimeString('th-TH') + '</div>' +
    '</div>';
  }).join('');
}

function clearAuditLog() {
  if (!confirm('ล้าง Audit Log ทั้งหมด?')) return;
  AUDIT_LOG = [];
  try { localStorage.setItem(AUDIT_KEY, '[]'); } catch(e) {}
  renderAuditTrail();
  toast('ล้าง Audit Log แล้ว', 'ok');
}

function exportAuditCSV() {
  if (!AUDIT_LOG.length) { toast('ไม่มี Audit Log ให้ Export', 'err'); return; }
  var rows = [['วันที่','เวลา','ผู้ใช้','ประเภท','รายละเอียด','เดิม','ใหม่']];
  AUDIT_LOG.forEach(function(l) {
    var d = new Date(l.ts);
    rows.push([d.toLocaleDateString('th-TH'), d.toLocaleTimeString('th-TH'), l.who, l.type, l.what, l.old, l.new]);
  });
  var csv = rows.map(function(row) {
    return row.map(function(c) { return '"' + String(c || '').replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  var blob = new Blob(['\uFEFF' + csv], { type:'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'audit_log.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Export Audit Log แล้ว', 'ok');
}

function showUndo(label, undoFn) {
  if (typeof undoFn === 'function') UNDO_STACK.push(undoFn);
  var bar = document.getElementById('undo-bar');
  var txt = document.getElementById('undo-action-text');
  if (!bar || !txt) return;
  txt.textContent = label || 'การกระทำล่าสุด';
  bar.style.display = 'flex';
}

function dismissUndo() {
  var bar = document.getElementById('undo-bar');
  if (bar) bar.style.display = 'none';
}

function doUndo() {
  var fn = UNDO_STACK.pop();
  if (fn) fn();
  dismissUndo();
}

function getSmartSearchItems() {
  var items = [
    { icon:'◈', title:'Dashboard', sub:'หน้าสรุปภาพรวม', panel:'dashboard' },
    { icon:'↗', title:'Sales', sub:'ข้อมูลยอดขาย', panel:'sales' },
    { icon:'◎', title:'ลูกค้า', sub:'ข้อมูลลูกค้า', panel:'customers' },
    { icon:'◻', title:'สัญญา', sub:'ข้อมูลสัญญา', panel:'contracts' },
    { icon:'◷', title:'พนักงาน', sub:'ข้อมูลพนักงาน', panel:'employees' },
    { icon:'⬡', title:'โปรเจกต์', sub:'งานและโปรเจกต์', panel:'projects' },
    { icon:'📊', title:'Reports', sub:'รายงาน', panel:'reports' },
    { icon:'📝', title:'Daily Report', sub:'บันทึกรายงานประจำวัน', panel:'daily-report' },
    { icon:'🤖', title:'AI Insight', sub:'วิเคราะห์ข้อมูล', panel:'ai' },
    { icon:'📋', title:'Audit Trail', sub:'ประวัติการใช้งาน', panel:'audit' },
    { icon:'🛡️', title:'Admin Panel', sub:'จัดการสิทธิ์และผู้ใช้', panel:'admin' }
  ];
  try {
    var adminList = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY) || '[]');
    adminList.forEach(function(u) {
      items.push({ icon:'👤', title:u.name || u.employeeId || 'ผู้ใช้', sub:(u.employeeId || '') + ' ' + (u.email || '') + ' ' + (u.position || ''), panel:'admin' });
    });
  } catch(e) {}
  return items;
}

function openSmartSearch() {
  var overlay = document.getElementById('smart-search-overlay');
  var input = document.getElementById('smart-search-input');
  if (!overlay || !input) return;
  overlay.classList.add('open');
  input.value = '';
  smartSearch('');
  setTimeout(function(){ input.focus(); }, 30);
}

function closeSmartSearch() {
  var overlay = document.getElementById('smart-search-overlay');
  if (overlay) overlay.classList.remove('open');
}

function smartSearch(query) {
  var wrap = document.getElementById('smart-search-results');
  if (!wrap) return;
  var q = String(query || '').toLowerCase().trim();
  var items = getSmartSearchItems().filter(function(item) {
    return !q || (item.title + ' ' + item.sub).toLowerCase().indexOf(q) > -1;
  }).slice(0, 24);
  if (!items.length) {
    wrap.innerHTML = '<div class="smart-search-empty">ไม่พบผลลัพธ์</div>';
    return;
  }
  wrap.innerHTML = items.map(function(item) {
    return '<div class="smart-result-item" onclick="openSmartSearchResult(&quot;' + item.panel + '&quot;)">' +
      '<div class="smart-result-icon">' + item.icon + '</div>' +
      '<div><div class="smart-result-title">' + escapeHtml(item.title) + '</div><div class="smart-result-sub">' + escapeHtml(item.sub) + '</div></div>' +
    '</div>';
  }).join('');
}

function openSmartSearchResult(panel) {
  closeSmartSearch();
  switchPanelByName(panel);
}

function openShortcuts() {
  var el = document.getElementById('sk-overlay');
  if (el) el.classList.add('open');
}

function closeShortcuts() {
  var el = document.getElementById('sk-overlay');
  if (el) el.classList.remove('open');
}

function toggleShortcutHint() {
  var el = document.getElementById('shortcut-hint');
  if (el) el.classList.toggle('open');
}

function renderAIInsights() {
  var wrap = document.getElementById('ai-insight-list');
  if (!wrap) return;
  var auditCount = AUDIT_LOG.length;
  var adminCount = 0;
  try { adminCount = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY) || '[]').length; } catch(e) {}
  var insights = [
    { title:'สิทธิ์ผู้ใช้', text: adminCount ? 'มีผู้ใช้ในระบบ ' + adminCount + ' คน ควรตรวจ role เป็นระยะ โดยเฉพาะ Admin' : 'ยังไม่มีผู้ใช้ที่เพิ่มเองใน Admin Panel' },
    { title:'Audit Trail', text: auditCount ? 'มีประวัติการใช้งาน ' + auditCount + ' รายการ สามารถ export เป็น CSV ได้' : 'ยังไม่มี log การใช้งาน ระบบจะเริ่มบันทึกหลัง login/save/delete' },
    { title:'UX Suggestion', text:'ใช้ Ctrl+K เพื่อค้นหาเมนูเร็วขึ้น และใช้ ? เพื่อดู shortcut ทั้งหมด' }
  ];
  wrap.innerHTML = insights.map(function(item) {
    return '<div class="insight-card"><div class="insight-title">' + escapeHtml(item.title) + '</div><div class="insight-text">' + escapeHtml(item.text) + '</div></div>';
  }).join('');
}

(function bindFeaturePackHooks() {
  var originalDoLogin = doLogin;
  doLogin = function(event) {
    var before = CURRENT_USER ? CURRENT_USER.id : null;
    originalDoLogin(event);
    setTimeout(function() {
      if (CURRENT_USER && CURRENT_USER.id !== before) logAudit('login', CURRENT_USER.name, 'เข้าสู่ระบบ', '—', CURRENT_USER.role);
    }, 50);
  };

  var originalSaveModal = saveModal;
  saveModal = async function() {
    var sheet = CURRENT_PANEL;
    var isEdit = !!EDIT_ID;
    await originalSaveModal();
    logAudit('create', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', (isEdit ? 'แก้ไข ' : 'เพิ่ม ') + sheet, isEdit ? EDIT_ID : '—', 'saved');
  };

  var originalDoDelete = doDelete;
  doDelete = async function(sheet, id) {
    var undoInfo = { sheet: sheet, id: id };
    await originalDoDelete(sheet, id);
    logAudit('delete', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', 'ลบ ' + sheet + ' ID: ' + id, id, '—');
    showUndo('ลบ ' + sheet + ' ID: ' + id, function() { toast('Undo สำหรับข้อมูลที่ลบจาก API ยังไม่รองรับ', 'info'); });
  };

  var originalSaveAdminChanges = saveAdminChanges;
  saveAdminChanges = function() {
    originalSaveAdminChanges();
    logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'Admin', 'บันทึกสิทธิ์ผู้ใช้', '—', 'saved');
  };

  var originalAdminDeleteUser = adminDeleteUser;
  adminDeleteUser = function(id) {
    var user = adminUsers.find(function(u){ return u.id === id; });
    originalAdminDeleteUser(id);
    if (typeof syncDailyPositionOptions === 'function') {
      syncDailyPositionOptions();
      renderDailyFieldAdmin();
    }
    if (user) {
      logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'Admin', 'ลบผู้ใช้ ' + user.name, user.employeeId || user.id, '—');
      showUndo('ลบผู้ใช้ ' + user.name, function() {
        adminUsers.push(user);
        localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
        renderAdminUsers();
        if (typeof syncDailyPositionOptions === 'function') {
          syncDailyPositionOptions(user.position || user.pos || '');
          renderDailyFieldAdmin();
        }
        toast('Undo ผู้ใช้แล้ว', 'ok');
      });
    }
  };

  document.addEventListener('keydown', function(e) {
    var target = e.target || {};
    var inInput = /INPUT|TEXTAREA|SELECT/.test(target.tagName || '');
    if (e.key === 'Escape') { closeSmartSearch(); closeShortcuts(); dismissUndo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSmartSearch(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (userCanWrite() && SCHEMAS[CURRENT_PANEL]) openAddModal(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); refreshCurrent(); }
    if (!inInput && e.key === '?') { e.preventDefault(); openShortcuts(); }
  });
})();

// ── Ordered feature upgrades: role permissions, admin edit, alerts, data search, calendar, print, backup ──
var SMART_DATA_CACHE = {};
var LOCAL_DB_KEY = 'erp-local-db';
var DAILY_REPORT_KEY = 'erp-daily-reports';
var DAILY_FIELD_CONFIG_KEY = 'erp-daily-report-field-config';
var CALENDAR_CURSOR = new Date();
var CALENDAR_APPOINTMENT_KEY = 'erp-calendar-appointments';
var CALENDAR_SELECTED_DATE = new Date().toISOString().slice(0, 10);
var PERMISSION_KEY = 'erp-permissions-v2';

var DEFAULT_ROLE_PERMISSIONS = {
  admin: {
    sales:{view:true,create:true,edit:true,delete:true}, customers:{view:true,create:true,edit:true,delete:true},
    contracts:{view:true,create:true,edit:true,delete:true}, employees:{view:true,create:true,edit:true,delete:true},
    projects:{view:true,create:true,edit:true,delete:true}, reports:{view:true}, 'daily-report':{view:true}, 'marketing-dept':{view:true}, 'marketing-contracts':{view:true}, 'lead-connect':{view:true}, construction:{view:true}, finance:{view:true}, calendar:{view:true}, ai:{view:true},
    activity:{view:true}, audit:{view:true}, backup:{view:true}, 'company-backoffice':{view:true}, admin:{view:true}
  },
  editor: {
    sales:{view:true,create:true,edit:true,delete:false}, customers:{view:true,create:true,edit:true,delete:false},
    contracts:{view:true,create:true,edit:true,delete:false}, employees:{view:true,create:false,edit:false,delete:false},
    projects:{view:true,create:true,edit:true,delete:false}, reports:{view:false}, 'daily-report':{view:true}, 'marketing-dept':{view:true}, 'marketing-contracts':{view:true}, 'lead-connect':{view:true}, construction:{view:true}, finance:{view:true}, calendar:{view:false}, ai:{view:false},
    activity:{view:true}, audit:{view:false}, backup:{view:false}, 'company-backoffice':{view:false}, admin:{view:false}
  },
  viewer: {
    sales:{view:true,create:false,edit:false,delete:false}, customers:{view:true,create:false,edit:false,delete:false},
    contracts:{view:true,create:false,edit:false,delete:false}, employees:{view:true,create:false,edit:false,delete:false},
    projects:{view:true,create:false,edit:false,delete:false}, reports:{view:false}, 'daily-report':{view:true}, 'marketing-dept':{view:true}, 'marketing-contracts':{view:true}, 'lead-connect':{view:true}, construction:{view:true}, finance:{view:false}, calendar:{view:false}, ai:{view:false},
    activity:{view:false}, audit:{view:false}, backup:{view:false}, 'company-backoffice':{view:false}, admin:{view:false}
  },
  executive: {
    sales:{view:true,create:false,edit:false,delete:false}, customers:{view:true,create:false,edit:false,delete:false},
    contracts:{view:true,create:false,edit:false,delete:false}, employees:{view:true,create:false,edit:false,delete:false},
    projects:{view:true,create:false,edit:false,delete:false}, reports:{view:true}, 'daily-report':{view:false}, 'marketing-dept':{view:true}, 'marketing-contracts':{view:true}, 'lead-connect':{view:true}, construction:{view:true}, finance:{view:true}, calendar:{view:true}, ai:{view:true},
    activity:{view:false}, audit:{view:false}, backup:{view:false}, 'company-backoffice':{view:false}, admin:{view:false},
    kanban:{view:true}, invoice:{view:true}, webhooks:{view:false}, 'custom-fields':{view:false}
  }
};

function getRolePermissions() {
  try {
    var saved = JSON.parse(localStorage.getItem(PERMISSION_KEY) || '{}');
    return Object.assign({}, DEFAULT_ROLE_PERMISSIONS, saved);
  } catch(e) { return DEFAULT_ROLE_PERMISSIONS; }
}

function saveRolePermissions(perms) {
  localStorage.setItem(PERMISSION_KEY, JSON.stringify(perms));
}

function currentPerm(panel) {
  if (!CURRENT_USER) return {};
  var perms = getRolePermissions();
  return ((perms[CURRENT_USER.role] || {})[panel || CURRENT_PANEL]) || {};
}

function readLocalDb() {
  try { return JSON.parse(localStorage.getItem(LOCAL_DB_KEY) || '{}'); }
  catch(e) { return {}; }
}

function writeLocalDb(db) {
  localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db || {}));
}

function getLocalRows(sheet) {
  var db = readLocalDb();
  return Array.isArray(db[sheet]) ? db[sheet] : [];
}

function setLocalRows(sheet, rows) {
  var db = readLocalDb();
  db[sheet] = rows || [];
  writeLocalDb(db);
  SMART_DATA_CACHE[sheet] = db[sheet];
}

function localRead(sheet, search) {
  var rows = getLocalRows(sheet);
  if (search) {
    var q = String(search).toLowerCase();
    rows = rows.filter(function(row) { return JSON.stringify(row).toLowerCase().indexOf(q) > -1; });
  }
  return rows;
}

function localWrite(sheet, data) {
  var rows = getLocalRows(sheet);
  var id = 'L-' + Date.now();
  var row = Object.assign({ ID:id }, data || {});
  rows.unshift(row);
  setLocalRows(sheet, rows);
  return row;
}

function seedEmployee005TestData() {
  var seedKey = 'erp-emp005-realistic-test-v1';
  if (localStorage.getItem(seedKey)) return;
  var today = new Date().toISOString().slice(0, 10);
  var delivery = new Date();
  delivery.setDate(delivery.getDate() + 45);
  var deliveryDate = delivery.toISOString().slice(0, 10);
  var owner = 'EMP-005';

  localWrite('sales', {
    'วันที่': today,
    'ลูกค้า': 'บริษัท เชียงรายโฮม จำกัด',
    'สินค้า': 'แพ็กเกจออกแบบและก่อสร้างบ้านพักอาศัย 2 ชั้น',
    'จำนวน': 1,
    'ราคา': 2450000,
    'ยอดรวม': 2450000,
    'สถานะ': 'ใช้งาน',
    'หมายเหตุ': 'EMP-005 ติดตามลูกค้าจากช่องทางออนไลน์ นัดสำรวจพื้นที่เรียบร้อย',
    'รหัสพนักงาน': owner
  });
  localWrite('customers', {
    'ชื่อ': 'คุณณัฐชา วัฒนากุล',
    'บริษัท': 'บริษัท เชียงรายโฮม จำกัด',
    'อีเมล': 'natcha@example.com',
    'โทรศัพท์': '0812345678',
    'ที่อยู่': 'อำเภอเมืองเชียงราย จังหวัดเชียงราย',
    'สถานะ': 'ใช้งาน',
    'วันที่เพิ่ม': today,
    'ผู้ดูแล': owner
  });
  localWrite('contracts', {
    'ชื่อลูกค้า': 'คุณณัฐชา วัฒนากุล',
    'สัญญางานสร้างบ้าน': 'ก่อสร้างบ้านพักอาศัย 2 ชั้น พื้นที่ใช้สอย 185 ตร.ม.',
    'ข้อมูลมัดจำ/เซ็นสัญญา': 'มัดจำ 50,000 บาท ชำระแล้วและลงนามสัญญา',
    'ทำเลที่ดินของลูกค้า': 'ตำบลริมกก อำเภอเมืองเชียงราย จังหวัดเชียงราย',
    'วันเริ่มสัญญา': today,
    'วันสิ้นสุดสัญญา': deliveryDate,
    'มูลค่าสัญญา': 2450000,
    'สถานะ': 'ใช้งาน',
    'รายละเอียดของแต่ละงาน': 'สำรวจพื้นที่ ออกแบบสถาปัตย์ ยื่นขออนุญาต และดำเนินงานก่อสร้างตามงวด',
    'หมายเหตุ': 'EMP-005 เป็นผู้ประสานงานฝ่ายขาย'
  });
  localWrite('projects', {
    'ชื่องาน/โปรเจกต์': 'โครงการบ้านพักอาศัยคุณณัฐชา',
    'ลูกค้า': 'คุณณัฐชา วัฒนากุล',
    'ผู้รับผิดชอบ': owner,
    'ทำเลที่ดินของลูกค้า': 'ตำบลริมกก อำเภอเมืองเชียงราย จังหวัดเชียงราย',
    'งานเพิ่มเติม': 'ปรับภูมิทัศน์และติดตั้งระบบรดน้ำอัตโนมัติ',
    'รายละเอียดของแต่ละงาน': 'ประสานทีมสำรวจ จัดทำ BOQ และติดตามการอนุมัติแบบจากลูกค้า',
    'วันเริ่ม': today,
    'วันส่งมอบ': deliveryDate,
    'งบประมาณ': 185000,
    'สถานะ': 'กำลังดำเนินการ'
  });
  localWrite('employees', {
    'ชื่อ': 'พนักงานทดสอบ EMP-005',
    'ตำแหน่ง': 'พนักงานขาย (Sales)',
    'แผนก': 'ฝ่ายขาย',
    'อีเมล': 'sales.emp005@erp.local',
    'โทรศัพท์': '0895550005',
    'วันเริ่มงาน': today,
    'สถานะ': 'ใช้งาน'
  });

  var reports = getDailyReports();
  reports.unshift({
    id: 'DR-EMP005-' + Date.now(),
    date: new Date().toISOString(),
    position: 'ฝ่ายขาย',
    values: {
      workDone: 'โทรติดตามลูกค้า 8 ราย นำเสนอแบบบ้าน 3 แบบ และปิดนัดสำรวจพื้นที่ 1 ราย',
      nextPlan: 'จัดทำใบเสนอราคา ติดตามเอกสารสินเชื่อ และประสานทีมสำรวจพื้นที่',
      online: '5',
      offline: '3'
    },
    workDone: 'โทรติดตามลูกค้า 8 ราย นำเสนอแบบบ้าน 3 แบบ และปิดนัดสำรวจพื้นที่ 1 ราย',
    nextPlan: 'จัดทำใบเสนอราคา ติดตามเอกสารสินเชื่อ และประสานทีมสำรวจพื้นที่',
    online: 5,
    offline: 3,
    author: 'พนักงานทดสอบ',
    authorId: owner
  });
  setDailyReports(reports);
  localStorage.setItem(seedKey, new Date().toISOString());
}

seedEmployee005TestData();

function localUpdate(sheet, id, data) {
  var rows = getLocalRows(sheet);
  var old = null;
  rows = rows.map(function(row) {
    if (String(row.ID) === String(id)) {
      old = Object.assign({}, row);
      return Object.assign({}, row, data || {});
    }
    return row;
  });
  setLocalRows(sheet, rows);
  return old;
}

function localDelete(sheet, id) {
  var rows = getLocalRows(sheet);
  var deleted = rows.find(function(row) { return String(row.ID) === String(id); });
  rows = rows.filter(function(row) { return String(row.ID) !== String(id); });
  setLocalRows(sheet, rows);
  return deleted;
}

function validateFormData(sheet, data) {
  var errors = [];
  customFieldsForContext(sheet, userIsAdmin() ? '' : getCurrentUserPosition(), userIsAdmin()).forEach(function(field) {
    var cfg = getFieldConfig(sheet, field);
    if (!cfg.hidden && cfg.required && String((data || {})[field] || '').trim() === '') errors.push(field + ' จำเป็นต้องกรอก');
  });
  Object.keys(data || {}).forEach(function(k) {
    if (/อีเมล|email/i.test(k) && data[k] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data[k])) errors.push(k + ' format ไม่ถูกต้อง');
    if (NUM_FIELDS.indexOf(k) > -1 && data[k] !== '' && isNaN(Number(data[k]))) errors.push(k + ' ต้องเป็นตัวเลข');
  });
  var start = data['วันเริ่ม'] || data['วันเริ่มสัญญา'];
  var end = data['วันส่งมอบ'] || data['วันสิ้นสุดสัญญา'] || data['วันสิ้นสุด'];
  if (start && end && new Date(end) < new Date(start)) errors.push('วันที่สิ้นสุด/ส่งมอบต้องมากกว่าวันเริ่ม');
  if (sheet === 'customers') {
    var name = data['ชื่อ'];
    if (name && localRead('customers').some(function(row) { return row['ชื่อ'] === name && row.ID !== EDIT_ID; })) errors.push('ชื่อลูกค้าซ้ำ');
  }
  return errors;
}

function userIsAdmin() { return !!(CURRENT_USER && CURRENT_USER.role === 'admin'); }
function userCanCreate() { return !!(CURRENT_USER && (CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'editor')); }
function userCanEdit() { return !!(CURRENT_USER && (CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'editor')); }
function userCanDelete() { return userIsAdmin(); }
userCanWrite = function() { return userCanCreate(); };

syncRoleAccess = function() {
  var navAdmin = document.getElementById('nav-admin');
  if (navAdmin) navAdmin.style.display = userIsAdmin() ? 'flex' : 'none';
  var addBtn = document.getElementById('btn-add');
  if (addBtn) addBtn.style.display = (userCanCreate() && SCHEMAS[CURRENT_PANEL]) ? 'inline-flex' : 'none';
};

openAdminPanelForCurrentUser = function() {
  var content = document.getElementById('admin-content');
  var gate = document.getElementById('admin-gate');
  if (gate) gate.style.display = 'none';
  if (!content) return;
  if (!userIsAdmin()) {
    content.style.display = 'none';
    toast('Admin only', 'err');
    switchPanelByName('dashboard');
    return;
  }
  ADMIN_UNLOCKED = true;
  content.style.display = 'block';
  loadAdminData();
  renderDailyFieldAdmin();
};

function normalizeAdminUserIds() {
  var used = {};
  adminUsers.forEach(function(u) {
    if (!u.password && !u.employeeId) return;
    var currentId = String(u.employeeId || '').trim().toUpperCase();
    if (!currentId || used[currentId]) {
      var n = Math.max(Number(u.id || 1), 1);
      var id = 'EMP-' + String(n).padStart(3, '0');
      while (used[id]) { n += 1; id = 'EMP-' + String(n).padStart(3, '0'); }
      u.employeeId = id;
      currentId = id;
    }
    used[currentId] = true;
  });
}

renderAdminUsers = function() {
  var wrap = document.getElementById('admin-user-list');
  var countEl = document.getElementById('admin-user-count');
  if (!wrap) return;
  normalizeAdminUserIds();
  if (countEl) countEl.textContent = adminUsers.length + ' คน';
  if (!adminUsers.length) {
    wrap.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">ยังไม่มีผู้ใช้</div>';
    return;
  }
  var avatarColors = ['#7c3aed','#4f8ef7','#22c55e','#ef4444','#f59e0b','#14b8a6','#ec4899'];
  wrap.innerHTML = adminUsers.map(function(u) {
    var initials = (u.name || '?').trim().split(' ').slice(0,2).map(function(p){return p[0];}).join('');
    var avatarColor = avatarColors[(Number(u.id || 1)-1) % avatarColors.length];
    var employeeId = u.employeeId || (u.password ? ('EMP-' + String(u.id || 0).padStart(3, '0')) : 'NO-LOGIN');
    var position = u.position || u.pos || 'ยังไม่ระบุตำแหน่ง';
    var detail = u.detail || '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);gap:12px" id="admin-user-row-' + u.id + '">' +
      '<div style="display:flex;align-items:center;gap:10px;min-width:0">' +
        '<div style="width:32px;height:32px;border-radius:50%;background:' + avatarColor + ';color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0">' + escapeHtml(initials) + '</div>' +
        '<div style="min-width:0">' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + escapeHtml(u.name || '') + '</div>' +
          '<div style="font-size:10px;color:var(--muted);font-family:var(--mono)">' + escapeHtml(employeeId) + ' · ' + escapeHtml(u.email || '') + '</div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:2px;overflow-wrap:anywhere">' + escapeHtml(position) + (detail ? ' · ' + escapeHtml(detail) : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
        '<select onchange="adminChangeRole(' + u.id + ',this.value)" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);font-family:var(--font);font-size:11px;padding:4px 8px;border-radius:7px;outline:none;cursor:pointer">' +
          '<option value="admin"'  + (u.role==='admin'  ?' selected':'') + '>Admin</option>'  +
          '<option value="editor"' + (u.role==='editor' ?' selected':'') + '>Editor</option>' +
          '<option value="viewer"' + (u.role==='viewer' ?' selected':'') + '>Viewer</option>' +
        '</select>' +
        '<button onclick="openAdminEditUser(' + u.id + ')" class="btn btn-ghost btn-sm" title="แก้ไข">แก้ไข</button>' +
        '<button onclick="adminDeleteUser(' + u.id + ')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:2px 4px" title="ลบ">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
};

function buildAdminUserForm(user) {
  user = user || {};
  var currentPosition = user.position || user.pos || '';
  var positions = getAdminPositionOptions(currentPosition);
  var employeeId = user.employeeId || getNextEmployeeIdPreview();
  var hasLoginPassword = !!user.password;
  return '<div class="form-group"><label class="form-label">ชื่อ-นามสกุล</label><input class="form-input" id="admin-field-name" placeholder="ชื่อ นามสกุล" value="' + escapeHtml(user.name || '') + '"></div>' +
    '<div class="form-group"><label class="form-label">อีเมล</label><input class="form-input" id="admin-field-email" type="email" placeholder="email@example.com" value="' + escapeHtml(user.email || '') + '"></div>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">' +
        '<label class="form-label" style="margin:0">รหัสพนักงาน</label>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="generateAdminEmployeeId()">↻ สร้างรหัสใหม่</button>' +
      '</div>' +
      '<input class="form-input" id="admin-field-employee-id" placeholder="EMP-005" value="' + escapeHtml(employeeId) + '" style="font-family:var(--mono);font-weight:800;letter-spacing:.4px;text-transform:uppercase">' +
      '<div class="settings-row-sub" style="margin-top:5px">ใช้รหัสนี้ร่วมกับรหัสผ่านสำหรับเข้าสู่ระบบ</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">' +
        '<label class="form-label" style="margin:0">ตำแหน่ง</label>' +
        '<button type="button" onclick="toggleNewPositionField()" style="border:1px solid rgba(79,142,247,.25);background:rgba(79,142,247,.12);color:#60a5fa;border-radius:7px;padding:3px 8px;font-size:10px;font-weight:800;cursor:pointer;font-family:var(--font)">➕ เพิ่มตำแหน่งใหม่</button>' +
      '</div>' +
      '<select class="form-select" id="admin-field-position-select">' +
        '<option value="">-- เลือกตำแหน่งงาน --</option>' +
        positions.map(function(pos) { return '<option value="' + escapeHtml(pos) + '"' + (currentPosition === pos ? ' selected' : '') + '>' + escapeHtml(pos) + '</option>'; }).join('') +
      '</select>' +
      '<input class="form-input" id="admin-field-position" placeholder="พิมพ์ชื่อตำแหน่งงานใหม่ที่นี่..." value="' + escapeHtml(currentPosition) + '" style="display:none;margin-top:8px;border-color:#3b82f6">' +
    '</div>' +
    '<div class="form-group"><label class="form-label">' + (hasLoginPassword ? 'เปลี่ยนรหัสผ่าน' : 'ตั้งรหัสผ่านเข้าสู่ระบบ') + '</label>' +
      '<input class="form-input" id="admin-field-password" type="password" placeholder="' + (hasLoginPassword ? 'ปล่อยว่างถ้าไม่เปลี่ยน' : 'จำเป็น: อย่างน้อย 4 ตัวอักษร') + '">' +
      (!hasLoginPassword && user.id ? '<div class="settings-row-sub" style="margin-top:5px;color:#f59e0b">บัญชีนี้ยังเข้าสู่ระบบไม่ได้จนกว่าจะตั้งรหัสผ่าน</div>' : '') +
    '</div>' +
    '<div class="form-group"><label class="form-label">บทบาท</label><select class="form-select" id="admin-field-role">' +
      '<option value="admin"' + (user.role==='admin' ? ' selected' : '') + '>Admin</option>' +
      '<option value="editor"' + (!user.role || user.role==='editor' ? ' selected' : '') + '>Editor</option>' +
      '<option value="viewer"' + (user.role==='viewer' ? ' selected' : '') + '>Viewer</option>' +
    '</select></div>' +
    '<div class="form-group full"><label class="form-label">รายละเอียด</label><textarea class="form-input textarea" id="admin-field-detail" placeholder="รายละเอียดเพิ่มเติมของพนักงาน">' + escapeHtml(user.detail || '') + '</textarea></div>';
}

function getAdminPositionOptions(extra) {
  var defaults = ['ฝ่ายบัญชี','นักยิงแอด / การตลาด','ฝ่ายขาย','พนักงานขาย (Sales)','ผู้จัดการ','ฝ่ายก่อสร้าง','ฝ่ายเอกสาร'];
  adminUsers.forEach(function(u) {
    var pos = (u.position || u.pos || '').trim();
    if (pos) defaults.push(pos);
  });
  if (extra && String(extra).trim()) defaults.push(String(extra).trim());
  var seen = {};
  return defaults.filter(function(pos) {
    if (!pos || seen[pos]) return false;
    seen[pos] = true;
    return true;
  });
}

function getNextEmployeeIdPreview() {
  normalizeAdminUserIds();
  var usedIds = {};
  USERS_DB.concat(adminUsers).forEach(function(u) {
    if (u && (u.employeeId || u.id)) usedIds[u.employeeId || u.id] = true;
  });
  var nextNum = adminNextId || 1;
  var employeeId = 'EMP-' + String(nextNum).padStart(3, '0');
  while (usedIds[employeeId]) {
    nextNum += 1;
    employeeId = 'EMP-' + String(nextNum).padStart(3, '0');
  }
  return employeeId;
}

function generateAdminEmployeeId() {
  var input = document.getElementById('admin-field-employee-id');
  if (!input) return;
  input.value = getNextEmployeeIdPreview();
  input.focus();
  input.select();
  toast('สร้างรหัสพนักงานแล้ว: ' + input.value, 'ok');
}

function syncAdminUsersToLoginDb() {
  var users = USERS_DB.slice();
  var latestAdminUsers = adminUsers;
  try {
    var storedAdminUsers = JSON.parse(localStorage.getItem(ADMIN_USERS_KEY) || '[]');
    if (Array.isArray(storedAdminUsers)) latestAdminUsers = storedAdminUsers;
  } catch(e) {}
  try {
    var saved = JSON.parse(localStorage.getItem('erp-users-db') || '[]');
    if (Array.isArray(saved)) {
      saved.forEach(function(user) {
        if (!user || (!user.id && !user.employeeId)) return;
        var savedId = String(user.employeeId || user.id).trim().toUpperCase();
        user.id = savedId;
        user.employeeId = savedId;
        var index = users.findIndex(function(existing) { return String(existing.employeeId || existing.id || '').trim().toUpperCase() === savedId; });
        if (index > -1) users[index] = Object.assign({}, users[index], user);
        else users.push(user);
      });
    }
  } catch(e) {}
  latestAdminUsers.forEach(function(user) {
    if (!user || (!user.employeeId && !user.id)) return;
    var id = String(user.employeeId || ('EMP-' + String(user.id).padStart(3, '0'))).trim().toUpperCase();
    user.employeeId = id;
    var loginUser = {
      id:id,
      employeeId:id,
      name:user.name,
      role:user.role || 'editor',
      dept:user.position || '',
      position:user.position || '',
      pos:user.position || '',
      avatar:(user.name || 'U').trim().slice(0, 2).toUpperCase(),
      password:user.password,
      detail:user.detail || ''
    };
    var index = users.findIndex(function(existing) { return String(existing.employeeId || existing.id || '').trim().toUpperCase() === id; });
    if (index > -1) users[index] = Object.assign({}, users[index], loginUser);
    else users.push(loginUser);
  });
  localStorage.setItem('erp-users-db', JSON.stringify(users));
}

function toggleNewPositionField() {
  var selectEl = document.getElementById('admin-field-position-select');
  var inputEl = document.getElementById('admin-field-position');
  if (!selectEl || !inputEl) return;
  var isHidden = inputEl.style.display === 'none' || !inputEl.style.display;
  inputEl.style.display = isHidden ? 'block' : 'none';
  selectEl.style.display = isHidden ? 'none' : 'block';
  if (isHidden) {
    inputEl.value = '';
    inputEl.focus();
  } else {
    inputEl.value = selectEl.value || '';
  }
}

openAdminAddUser = function() {
  EDIT_ID = null;
  document.getElementById('modal-title').textContent = '+ เพิ่มผู้ใช้ระบบ';
  document.getElementById('modal-form').innerHTML = buildAdminUserForm({});
  document.getElementById('modal-save').onclick = saveAdminUser;
  document.getElementById('modal-overlay').classList.add('open');
};

function openAdminEditUser(id) {
  var user = adminUsers.find(function(u){ return Number(u.id) === Number(id); });
  if (!user) { toast('ไม่พบผู้ใช้', 'err'); return; }
  EDIT_ID = id;
  document.getElementById('modal-title').textContent = '✏️ แก้ไขผู้ใช้ระบบ';
  document.getElementById('modal-form').innerHTML = buildAdminUserForm(user);
  document.getElementById('modal-save').onclick = saveAdminUser;
  document.getElementById('modal-overlay').classList.add('open');
}

saveAdminUser = function() {
  var name = (document.getElementById('admin-field-name') || {}).value || '';
  var email = (document.getElementById('admin-field-email') || {}).value || '';
  var employeeIdInput = ((document.getElementById('admin-field-employee-id') || {}).value || '').trim().toUpperCase();
  var positionInput = document.getElementById('admin-field-position');
  var positionSelect = document.getElementById('admin-field-position-select');
  var position = positionInput && positionInput.style.display !== 'none' ? positionInput.value : ((positionSelect || {}).value || (positionInput || {}).value || '');
  var password = (document.getElementById('admin-field-password') || {}).value || '';
  var detail = (document.getElementById('admin-field-detail') || {}).value || '';
  var role = (document.getElementById('admin-field-role') || {}).value || 'editor';
  if (!name.trim()) { toast('กรุณากรอกชื่อ', 'err'); return; }
  if (!email.trim()) { toast('กรุณากรอกอีเมล', 'err'); return; }
  if (!EDIT_ID && employeeIdInput && !password.trim()) { toast('กรุณาตั้งรหัสผ่านสำหรับพนักงานใหม่', 'err'); return; }
  if (password && password.length < 4) { toast('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร', 'err'); return; }
  normalizeAdminUserIds();
  var editing = adminUsers.find(function(u){ return Number(u.id) === Number(EDIT_ID); });
  if (editing && employeeIdInput && !editing.password && !password.trim()) {
    toast('บัญชีนี้ยังไม่มีรหัสผ่าน กรุณาตั้งรหัสผ่านก่อนบันทึก', 'err');
    return;
  }
  var usedIds = {};
  USERS_DB.concat(adminUsers).forEach(function(u) {
    if (!editing || Number(u.id) !== Number(editing.id)) usedIds[u.employeeId || u.id] = true;
  });
  var nextNum = adminNextId;
  var shouldHaveLogin = !!(employeeIdInput.trim() || password || (editing && editing.password) || (!editing && password));
  var employeeId = shouldHaveLogin ? (employeeIdInput || (editing && editing.employeeId) || ('EMP-' + String(nextNum).padStart(3, '0'))) : '';
  if (employeeId && usedIds[employeeId]) { toast('รหัสพนักงาน ' + employeeId + ' ถูกใช้งานแล้ว', 'err'); return; }
  var payload = {
    id: editing ? editing.id : nextNum,
    employeeId: employeeId,
    name: name.trim(),
    email: email.trim(),
    position: position.trim(),
    password: password.trim() || (editing ? editing.password : ''),
    detail: detail.trim(),
    role: role
  };
  if (editing) {
    Object.assign(editing, payload);
    logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'Admin', 'แก้ไขผู้ใช้ ' + payload.name, payload.employeeId, 'updated');
  } else {
    adminUsers.push(payload);
    adminNextId = Math.max(nextNum + 1, adminNextId + 1);
    logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'Admin', 'เพิ่มผู้ใช้ ' + payload.name, '—', payload.employeeId);
  }
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  syncAdminUsersToLoginDb();
  renderAdminUsers();
  syncDailyPositionOptions(payload.position);
  renderDailyFieldAdmin();
  closeModal();
  document.getElementById('modal-save').onclick = saveModal;
  toast((editing ? 'แก้ไขผู้ใช้แล้ว' : 'เพิ่มผู้ใช้แล้ว') + ' · Login: ' + employeeId, 'ok');
  EDIT_ID = null;
};

var originalOpenAddModalRole = openAddModal;
openAddModal = function() {
  if (!userCanCreate()) { toast('Role นี้เพิ่มข้อมูลไม่ได้', 'err'); return; }
  originalOpenAddModalRole();
};

var originalEditRowRole = editRow;
editRow = async function(sheet, id) {
  if (!userCanEdit()) { toast('Role นี้แก้ไขข้อมูลไม่ได้', 'err'); return; }
  await originalEditRowRole(sheet, id);
};

var originalDoDeleteRole = doDelete;
doDelete = async function(sheet, id) {
  if (!userCanDelete()) { toast('เฉพาะ Admin เท่านั้นที่ลบข้อมูลได้', 'err'); closeConfirm(); return; }
  await originalDoDeleteRole(sheet, id);
};

var originalLoadPanelLocal = loadPanel;
loadPanel = async function(sheet, page, search) {
  page = page || 1;
  search = search || '';
  PAGE_STATE[sheet] = { page: page, search: search };
  var wrap = document.getElementById('table-' + sheet);
  if (!wrap) return;
  if (CONNECTED) {
    try {
      await originalLoadPanelLocal(sheet, page, search);
      return;
    } catch(e) {}
  }
  var pageSize = 10;
  var rows = localRead(sheet, search);
  SMART_DATA_CACHE[sheet] = rows;
  var pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  renderTable(sheet, pageRows, wrap);
  var countEl = document.getElementById('count-' + sheet);
  if (countEl) countEl.textContent = rows.length + ' รายการ';
  renderPagination(sheet, { page: page, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)), total: rows.length }, search);
};

var originalSaveModalLocal = saveModal;
saveModal = async function() {
  if (!userCanCreate()) { toast('Role นี้เพิ่มข้อมูลไม่ได้', 'err'); return; }
  var sheet = CURRENT_PANEL;
  var fields = SCHEMAS[sheet] || [];
  var data = {};
  fields.forEach(function(f) {
    var el = document.getElementById('field-' + f);
    if (el) data[f] = el.value;
  });
  var validationErrors = validateFormData(sheet, data);
  if (validationErrors.length) {
    toast(validationErrors[0], 'err');
    return;
  }
  if (CONNECTED) {
    await originalSaveModalLocal();
    return;
  }
  var oldRow = null;
  if (EDIT_ID) oldRow = localUpdate(sheet, EDIT_ID, data);
  else localWrite(sheet, data);
  closeModal();
  loadPanel(sheet);
  loadStats();
  logAudit(EDIT_ID ? 'update' : 'create', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', (EDIT_ID ? 'แก้ไข ' : 'เพิ่ม ') + sheet, EDIT_ID || '—', 'local');
  if (EDIT_ID && oldRow) {
    showUndo('แก้ไข ' + sheet, function() {
      localUpdate(sheet, EDIT_ID, oldRow);
      loadPanel(sheet);
      toast('Undo การแก้ไขแล้ว', 'ok');
    });
  } else {
    showUndo('เพิ่ม ' + sheet, function() {
      var rows = getLocalRows(sheet);
      var row = rows[0];
      if (row) localDelete(sheet, row.ID);
      loadPanel(sheet);
      toast('Undo การเพิ่มแล้ว', 'ok');
    });
  }
  toast('บันทึกในเครื่องสำเร็จ', 'ok');
};

var originalDoDeleteLocal = doDelete;
doDelete = async function(sheet, id) {
  if (!userCanDelete()) { toast('เฉพาะ Admin เท่านั้นที่ลบข้อมูลได้', 'err'); closeConfirm(); return; }
  closeConfirm();
  if (CONNECTED && !String(id).startsWith('L-')) {
    await originalDoDeleteLocal(sheet, id);
    return;
  }
  var deleted = localDelete(sheet, id);
  loadPanel(sheet);
  loadStats();
  if (deleted) {
    logAudit('delete', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', 'ลบ ' + sheet + ' ID: ' + id, id, 'local');
    showUndo('ลบ ' + sheet + ' ID: ' + id, function() {
      var rows = getLocalRows(sheet);
      rows.unshift(deleted);
      setLocalRows(sheet, rows);
      loadPanel(sheet);
      toast('Undo การลบแล้ว', 'ok');
    });
  }
  toast('ลบในเครื่องสำเร็จ', 'ok');
};

function getCachedRows(sheet) {
  return SMART_DATA_CACHE[sheet] || [];
}

async function refreshSmartDataIndex(force) {
  var sheets = ['sales','customers','contracts','employees','projects'];
  if (!force && Object.keys(SMART_DATA_CACHE).length) return SMART_DATA_CACHE;
  await Promise.all(sheets.map(async function(sheet) {
    try {
      if (CONNECTED) {
        var r = await apiGet({ action:'read', sheet:sheet, pageSize:200 });
        SMART_DATA_CACHE[sheet] = (r && r.ok && r.data) ? r.data : [];
      }
    } catch(e) {
      SMART_DATA_CACHE[sheet] = SMART_DATA_CACHE[sheet] || [];
    }
  }));
  return SMART_DATA_CACHE;
}

function getImportantAlerts() {
  var alerts = [];
  var contracts = getCachedRows('contracts');
  var projects = getCachedRows('projects');
  var now = new Date();
  var soonMs = 1000 * 60 * 60 * 24 * 14;
  var dueContracts = contracts.filter(function(row) {
    var d = new Date(row['วันสิ้นสุดสัญญา'] || row['วันสิ้นสุด'] || '');
    return !isNaN(d) && d >= now && (d - now) <= soonMs;
  });
  var dueProjects = projects.filter(function(row) {
    var d = new Date(row['วันส่งมอบ'] || '');
    return !isNaN(d) && d >= now && (d - now) <= soonMs;
  });
  var pendingProjects = projects.filter(function(row) { return /รอดำเนินการ|กำลังดำเนินการ|pending|progress/i.test(String(row['สถานะ'] || '')); });
  if (dueContracts.length) alerts.push({ type:'danger', title:'สัญญาใกล้ครบกำหนด', sub:dueContracts.length + ' รายการใน 14 วัน' });
  if (dueProjects.length) alerts.push({ type:'danger', title:'โปรเจกต์ใกล้ส่งมอบ', sub:dueProjects.length + ' รายการใน 14 วัน' });
  if (pendingProjects.length) alerts.push({ type:'', title:'โปรเจกต์ค้างดำเนินการ', sub:pendingProjects.length + ' รายการควรติดตาม' });
  if (!alerts.length) alerts.push({ type:'ok', title:'ไม่มีงานเร่งด่วน', sub:'ยังไม่พบสัญญาหรือโปรเจกต์ที่ใกล้ครบกำหนดจากข้อมูลที่โหลดได้' });
  return alerts;
}

function renderDashboardAlerts() {
  var wrap = document.getElementById('dashboard-alerts');
  if (!wrap) return;
  wrap.innerHTML = getImportantAlerts().map(function(a) {
    return '<div class="alert-card ' + escapeHtml(a.type) + '"><div class="alert-title">' + escapeHtml(a.title) + '</div><div class="alert-sub">' + escapeHtml(a.sub) + '</div></div>';
  }).join('');
}

var originalLoadStatsAlerts = loadStats;
loadStats = async function() {
  await refreshSmartDataIndex(false);
  await originalLoadStatsAlerts();
  renderDashboardAlerts();
};

var originalInitOfflineDashboardAlerts = initOfflineDashboard;
initOfflineDashboard = function() {
  originalInitOfflineDashboardAlerts();
  renderDashboardAlerts();
};

var originalGetSmartSearchItems = getSmartSearchItems;
getSmartSearchItems = function() {
  var items = originalGetSmartSearchItems();
  Object.keys(SCHEMAS).forEach(function(sheet) {
    (SMART_DATA_CACHE[sheet] || []).slice(0, 80).forEach(function(row) {
      var first = SCHEMAS[sheet].map(function(f){ return row[f]; }).find(Boolean) || row.ID || sheet;
      var sub = SCHEMAS[sheet].slice(0, 4).map(function(f){ return row[f]; }).filter(Boolean).join(' · ');
      items.push({ icon:'🔎', title:String(first), sub:sheet + ' · ' + sub, panel:sheet });
    });
  });
  return items;
};

function readCalendarAppointments() {
  try {
    var value = JSON.parse(localStorage.getItem(CALENDAR_APPOINTMENT_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch(e) {
    return {};
  }
}

function writeCalendarAppointments(value) {
  localStorage.setItem(CALENDAR_APPOINTMENT_KEY, JSON.stringify(value || {}));
}

function calendarDateKey(date) {
  var d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function collectCalendarEvents() {
  var events = [];
  getCachedRows('contracts').forEach(function(row) {
    var title = row['สัญญางานสร้างบ้าน'] || row['ชื่อสัญญา'] || row['ชื่อลูกค้า'] || 'สัญญา';
    var date = row['วันสิ้นสุดสัญญา'] || row['วันสิ้นสุด'];
    if (date) events.push({ date:date, title:title, sub:'สัญญา · ' + (row['สถานะ'] || ''), panel:'contracts', kind:'contract' });
  });
  getCachedRows('projects').forEach(function(row) {
    var title = row['ชื่องาน/โปรเจกต์'] || row['ชื่อโปรเจกต์'] || 'โปรเจกต์';
    var date = row['วันส่งมอบ'] || row['วันเริ่ม'];
    if (date) events.push({ date:date, title:title, sub:'โปรเจกต์ · ' + (row['สถานะ'] || ''), panel:'projects', kind:'project' });
  });
  var appointments = readCalendarAppointments();
  Object.keys(appointments).forEach(function(date) {
    (appointments[date] || []).forEach(function(item) {
      events.push({
        date: date,
        title: (item.time ? item.time + ' ' : '') + (item.customer || 'นัดหมายลูกค้า'),
        sub: 'นัดหมาย · ' + (item.topic || '') + (item.status ? ' · ' + item.status : ''),
        panel: 'calendar',
        kind: 'appointment',
        appointmentId: item.id
      });
    });
  });
  return events.sort(function(a,b) { return new Date(a.date) - new Date(b.date); });
}

function placeDashboardCalendarBelowGrowth() {
  var calendar = document.getElementById('dashboard-work-calendar');
  var leftColumn = document.getElementById('dashboard-left-column');
  if (calendar && leftColumn && calendar.parentElement !== leftColumn) {
    leftColumn.appendChild(calendar);
  }
}

function paintWorkCalendar() {
  placeDashboardCalendarBelowGrowth();
  var wrap = document.getElementById('calendar-list');
  var monthWrap = document.getElementById('calendar-month');
  var monthLabel = document.getElementById('calendar-month-label');
  var count = document.getElementById('calendar-count');
  if (!wrap) return;
  var events = collectCalendarEvents();
  renderMonthCalendar(events, monthWrap, monthLabel);
  renderCalendarAppointmentPanel();
  if (count) count.textContent = events.length + ' รายการ';
  if (!events.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">📅</div><div class="empty-text">ยังไม่มีวันสำคัญจากสัญญาหรือโปรเจกต์</div></div>';
    return;
  }
  wrap.innerHTML = events.map(function(ev) {
    var d = new Date(ev.date);
    var dateText = isNaN(d) ? ev.date : d.toLocaleDateString('th-TH');
    var action = ev.kind === 'appointment'
      ? 'selectDashboardCalendarDate(&quot;' + escapeHtml(calendarDateKey(d)) + '&quot;)'
      : 'switchPanelByName(&quot;' + ev.panel + '&quot;)';
    return '<div class="calendar-item"><div class="calendar-date">' + escapeHtml(dateText) + '</div><div><div class="calendar-title">' + escapeHtml(ev.title) + '</div><div class="calendar-sub">' + escapeHtml(ev.sub) + '</div></div><button class="btn btn-ghost btn-sm" onclick="' + action + '">เปิด</button></div>';
  }).join('');
}

var CALENDAR_REFRESHING = false;
async function renderWorkCalendar(force) {
  paintWorkCalendar();
  if (!force || CALENDAR_REFRESHING) return;
  CALENDAR_REFRESHING = true;
  try {
    await refreshSmartDataIndex(true);
    paintWorkCalendar();
  } catch(e) {
    paintWorkCalendar();
  } finally {
    CALENDAR_REFRESHING = false;
  }
}

function selectDashboardCalendarDate(dateKey) {
  if (!dateKey) return;
  CALENDAR_SELECTED_DATE = dateKey;
  var d = new Date(dateKey + 'T00:00:00');
  if (!isNaN(d)) CALENDAR_CURSOR = new Date(d.getFullYear(), d.getMonth(), 1);
  renderWorkCalendar(false);
}

function toggleCalendarAppointmentForm(force) {
  var form = document.getElementById('calendar-appointment-form');
  if (!form) return;
  var open = typeof force === 'boolean' ? force : !form.classList.contains('open');
  form.classList.toggle('open', open);
  if (open) {
    var customer = document.getElementById('calendar-appointment-customer');
    if (customer) customer.focus();
  }
}

function saveCalendarAppointment() {
  var customerEl = document.getElementById('calendar-appointment-customer');
  var timeEl = document.getElementById('calendar-appointment-time');
  var topicEl = document.getElementById('calendar-appointment-topic');
  var staffEl = document.getElementById('calendar-appointment-staff');
  var customer = customerEl ? customerEl.value.trim() : '';
  var topic = topicEl ? topicEl.value.trim() : '';
  if (!customer || !topic) {
    toast('กรุณากรอกชื่อลูกค้าและหัวข้อนัดหมาย', 'err');
    return;
  }
  var db = readCalendarAppointments();
  if (!Array.isArray(db[CALENDAR_SELECTED_DATE])) db[CALENDAR_SELECTED_DATE] = [];
  db[CALENDAR_SELECTED_DATE].push({
    id: 'AP-' + Date.now(),
    customer: customer,
    time: timeEl && timeEl.value ? timeEl.value : '10:00',
    topic: topic,
    staff: staffEl && staffEl.value.trim() ? staffEl.value.trim() : 'ยังไม่ระบุ',
    status: 'รอดำเนินการ',
    createdAt: new Date().toISOString()
  });
  writeCalendarAppointments(db);
  if (customerEl) customerEl.value = '';
  if (topicEl) topicEl.value = '';
  if (staffEl) staffEl.value = '';
  toggleCalendarAppointmentForm(false);
  logAudit('create', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', 'เพิ่มนัดหมายลูกค้า ' + customer, '—', CALENDAR_SELECTED_DATE);
  renderWorkCalendar(false);
  toast('บันทึกนัดหมายลูกค้าแล้ว', 'ok');
}

function completeCalendarAppointment(id) {
  var db = readCalendarAppointments();
  var rows = db[CALENDAR_SELECTED_DATE] || [];
  var item = rows.find(function(row) { return row.id === id; });
  if (!item) return;
  item.status = 'เสร็จสิ้น';
  writeCalendarAppointments(db);
  renderWorkCalendar(false);
  toast('อัปเดตนัดหมายเป็นเสร็จสิ้นแล้ว', 'ok');
}

function deleteCalendarAppointment(id) {
  if (!confirm('ต้องการลบนัดหมายนี้หรือไม่?')) return;
  var db = readCalendarAppointments();
  var rows = db[CALENDAR_SELECTED_DATE] || [];
  db[CALENDAR_SELECTED_DATE] = rows.filter(function(row) { return row.id !== id; });
  if (!db[CALENDAR_SELECTED_DATE].length) delete db[CALENDAR_SELECTED_DATE];
  writeCalendarAppointments(db);
  renderWorkCalendar(false);
  toast('ลบนัดหมายแล้ว', 'ok');
}

function renderCalendarAppointmentPanel() {
  var list = document.getElementById('calendar-appointment-list');
  var label = document.getElementById('calendar-selected-date-label');
  var count = document.getElementById('calendar-appointment-count');
  if (!list) return;
  var selected = new Date(CALENDAR_SELECTED_DATE + 'T00:00:00');
  if (label) label.textContent = isNaN(selected) ? CALENDAR_SELECTED_DATE : 'วันที่ ' + selected.toLocaleDateString('th-TH', { day:'numeric', month:'long', year:'numeric' });
  var rows = readCalendarAppointments()[CALENDAR_SELECTED_DATE] || [];
  if (count) count.textContent = userIsAdmin() && rows.length !== allRows.length ? rows.length + ' / ' + allRows.length + ' รายการ' : rows.length + ' รายการ';
  if (!rows.length) {
    list.innerHTML = '<div class="empty" style="padding:14px"><div class="empty-text">ยังไม่มีนัดหมายลูกค้าในวันนี้</div></div>';
    return;
  }
  list.innerHTML = rows.slice().sort(function(a,b) { return String(a.time).localeCompare(String(b.time)); }).map(function(item) {
    var done = item.status === 'เสร็จสิ้น';
    return '<div class="calendar-appointment-item">' +
      '<div class="calendar-appointment-time">' + escapeHtml(item.time || '—') + '</div>' +
      '<div><div class="calendar-appointment-customer">' + escapeHtml(item.customer || 'ไม่ระบุ') + '</div>' +
      '<div class="calendar-appointment-topic">' + escapeHtml(item.topic || '') + '</div>' +
      '<div class="calendar-appointment-staff">ผู้รับผิดชอบ: ' + escapeHtml(item.staff || 'ยังไม่ระบุ') + ' · ' + escapeHtml(item.status || 'รอดำเนินการ') + '</div></div>' +
      '<div class="calendar-appointment-item-actions">' +
      (!done ? '<button class="btn btn-success btn-sm" type="button" onclick="completeCalendarAppointment(&quot;' + escapeHtml(item.id) + '&quot;)">เสร็จ</button>' : '') +
      '<button class="btn btn-danger btn-sm" type="button" onclick="deleteCalendarAppointment(&quot;' + escapeHtml(item.id) + '&quot;)">ลบ</button>' +
      '</div></div>';
  }).join('');
}

function openDashboardCalendar(sourceEl) {
  var dashboardNav = document.querySelector('.nav-item[data-panel="dashboard"]');
  if (dashboardNav) switchPanel(dashboardNav);
  setTimeout(function() {
    renderWorkCalendar(true);
    var calendar = document.getElementById('dashboard-work-calendar');
    if (calendar) calendar.scrollIntoView({ behavior:'smooth', block:'start' });
  }, 120);
}

function moveCalendarMonth(delta) {
  CALENDAR_CURSOR = new Date(CALENDAR_CURSOR.getFullYear(), CALENDAR_CURSOR.getMonth() + delta, 1);
  renderWorkCalendar(false);
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function renderMonthCalendar(events, monthWrap, monthLabel) {
  if (!monthWrap) return;
  var year = CALENDAR_CURSOR.getFullYear();
  var month = CALENDAR_CURSOR.getMonth();
  var first = new Date(year, month, 1);
  var start = new Date(year, month, 1 - first.getDay());
  var today = new Date();
  if (monthLabel) monthLabel.textContent = first.toLocaleDateString('th-TH', { month:'long', year:'numeric' });
  var heads = ['อา','จ','อ','พ','พฤ','ศ','ส'];
  var html = '<div class="month-cal">' + heads.map(function(h){ return '<div class="month-head">' + h + '</div>'; }).join('');
  for (var i = 0; i < 42; i++) {
    var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    var dateKey = calendarDateKey(d);
    var dayEvents = events.filter(function(ev) {
      var ed = new Date(ev.date);
      return !isNaN(ed) && sameDate(ed, d);
    });
    html += '<div class="month-day ' + (d.getMonth() !== month ? 'out ' : '') + (sameDate(d, today) ? 'today ' : '') + (dateKey === CALENDAR_SELECTED_DATE ? 'selected' : '') + '" onclick="selectDashboardCalendarDate(&quot;' + dateKey + '&quot;)">' +
      '<div class="month-num">' + d.getDate() + '</div>' +
      dayEvents.slice(0, 3).map(function(ev) {
        var action = ev.kind === 'appointment'
          ? 'selectDashboardCalendarDate(&quot;' + dateKey + '&quot;)'
          : 'switchPanelByName(&quot;' + ev.panel + '&quot;)';
        return '<div class="month-event" onclick="event.stopPropagation();' + action + '" title="' + escapeHtml(ev.title) + '">' + escapeHtml(ev.title) + '</div>';
      }).join('') +
      (dayEvents.length > 3 ? '<div class="month-event">+' + (dayEvents.length - 3) + ' เพิ่ม</div>' : '') +
    '</div>';
  }
  html += '</div>';
  monthWrap.innerHTML = html;
}

function printDashboard() {
  logAudit('info', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', 'Print / PDF ' + CURRENT_PANEL, '—', 'print');
  window.print();
}

function collectBackupData() {
  var keys = [ADMIN_USERS_KEY, AUDIT_KEY, ADMIN_PASS_KEY, 'erp-theme', 'erp-users-db', CALENDAR_APPOINTMENT_KEY];
  var data = { version:'erp-final-v6', exportedAt:new Date().toISOString(), keys:{} };
  keys.forEach(function(key) { data.keys[key] = localStorage.getItem(key); });
  return data;
}

function renderBackupSummary() {
  var wrap = document.getElementById('backup-summary');
  if (!wrap) return;
  var data = collectBackupData();
  var rows = Object.keys(data.keys).map(function(key) {
    var val = data.keys[key];
    return '<div style="display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:8px 0"><span style="font-family:var(--mono);color:var(--text)">' + escapeHtml(key) + '</span><span>' + (val ? (String(val).length + ' chars') : 'empty') + '</span></div>';
  }).join('');
  wrap.innerHTML = '<div style="margin-bottom:8px;color:var(--text);font-weight:700">ข้อมูลที่จะถูกสำรอง</div>' + rows;
}

function downloadBackup() {
  var data = collectBackupData();
  var blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'erp_backup_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', 'Download Backup', '—', 'json');
  toast('ดาวน์โหลด Backup แล้ว', 'ok');
}

function restoreBackupFile(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!data.keys) throw new Error('Invalid backup');
      Object.keys(data.keys).forEach(function(key) {
        if (data.keys[key] == null) localStorage.removeItem(key);
        else localStorage.setItem(key, data.keys[key]);
      });
      logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', 'Restore Backup', 'json', 'localStorage');
      toast('Restore สำเร็จ กำลังรีโหลด...', 'ok');
      setTimeout(function(){ location.reload(); }, 700);
    } catch(err) {
      toast('ไฟล์ Backup ไม่ถูกต้อง', 'err');
    }
  };
  reader.readAsText(file, 'UTF-8');
}

var originalRenderAIInsightsFull = renderAIInsights;
renderAIInsights = function() {
  originalRenderAIInsightsFull();
  var wrap = document.getElementById('ai-insight-list');
  if (!wrap) return;
  getImportantAlerts().forEach(function(a) {
    wrap.insertAdjacentHTML('beforeend', '<div class="insight-card"><div class="insight-title">' + escapeHtml(a.title) + '</div><div class="insight-text">' + escapeHtml(a.sub) + '</div></div>');
  });
};

// ── Final ordered workflow patch: real permission matrix, local data, backup, responsive-safe actions ──
var PERMISSION_MODULE_CONFIG = [
  { panel:'sales', label:'ระบบ Sales', sub:'ยอดขายและรายการขาย', schema:true },
  { panel:'customers', label:'ลูกค้า', sub:'ข้อมูลลูกค้า', schema:true },
  { panel:'contracts', label:'สัญญางานสร้างบ้าน', sub:'มัดจำ/เซ็นสัญญา/ทำเล', schema:true },
  { panel:'employees', label:'พนักงาน', sub:'ตำแหน่งและรายละเอียดงาน', schema:true },
  { panel:'projects', label:'โปรเจกต์/งานเพิ่มเติม', sub:'รายละเอียดงานและส่งมอบ', schema:true },
  { panel:'reports', label:'Reports', sub:'รายงานและสรุป', schema:false },
  { panel:'daily-report', label:'Daily Report', sub:'บันทึกรายงานประจำวัน', schema:false },
  { panel:'calendar', label:'Calendar', sub:'ปฏิทินรายเดือน', schema:false },
  { panel:'ai', label:'AI Insight', sub:'ข้อเสนอแนะจากข้อมูล', schema:false },
  { panel:'activity', label:'Activity Log', sub:'ประวัติจาก API', schema:false },
  { panel:'audit', label:'Audit Trail', sub:'ประวัติในเครื่อง', schema:false },
  { panel:'backup', label:'Backup / Restore', sub:'สำรองและกู้คืน', schema:false },
  { panel:'admin', label:'Admin Panel', sub:'ผู้ใช้และสิทธิ์', schema:false }
];
var PERMISSION_ACTIONS = ['view','create','edit','delete'];
if (!PERMISSION_MODULE_CONFIG.some(function(mod) { return mod.panel === 'company-backoffice'; })) {
  PERMISSION_MODULE_CONFIG.splice(PERMISSION_MODULE_CONFIG.length - 1, 0, {
    panel: 'company-backoffice',
    label: 'หลังบ้านบริษัท',
    sub: 'โครงสร้างแผนกและงานภายในบริษัท',
    schema: false
  });
}
if (!PERMISSION_MODULE_CONFIG.some(function(mod) { return mod.panel === 'marketing-dept'; })) {
  PERMISSION_MODULE_CONFIG.splice(PERMISSION_MODULE_CONFIG.length - 1, 0, {
    panel: 'marketing-dept',
    label: 'การตลาด',
    sub: 'งานหลักและ ADS Manager ของแผนกการตลาด',
    schema: false
  });
}

if (!PERMISSION_MODULE_CONFIG.some(function(mod) { return mod.panel === 'marketing-contracts'; })) {
  PERMISSION_MODULE_CONFIG.splice(PERMISSION_MODULE_CONFIG.length - 1, 0, {
    panel: 'marketing-contracts',
    label: 'สัญญาสื่อ / ป้ายโฆษณา',
    sub: 'ติดตามสัญญาป้าย ค่าเช่า และวันหมดอายุของแผนกการตลาด',
    schema: false
  });
}

[
  { panel: 'lead-connect', label: 'Lead Connect', sub: 'ส่ง Lead จากการตลาดเข้าสู่ Sales Pipeline', schema: false },
  { panel: 'construction', label: 'ก่อสร้าง/ผลิต', sub: 'ติดตามสถานะโครงการและกำหนดส่งมอบ', schema: false },
  { panel: 'finance', label: 'การเงินและงวดชำระ', sub: 'รายรับ ยอดค้าง และสัญญาทางการเงิน', schema: false }
].forEach(function(mod) {
  if (!PERMISSION_MODULE_CONFIG.some(function(item) { return item.panel === mod.panel; })) {
    PERMISSION_MODULE_CONFIG.splice(PERMISSION_MODULE_CONFIG.length - 1, 0, mod);
  }
});

function mergeRolePermissions(base, saved) {
  var out = JSON.parse(JSON.stringify(base));
  Object.keys(saved || {}).forEach(function(role) {
    out[role] = out[role] || {};
    Object.keys(saved[role] || {}).forEach(function(panel) {
      out[role][panel] = Object.assign({}, out[role][panel] || {}, saved[role][panel] || {});
    });
  });
  return out;
}

getRolePermissions = function() {
  try { return mergeRolePermissions(DEFAULT_ROLE_PERMISSIONS, JSON.parse(localStorage.getItem(PERMISSION_KEY) || '{}')); }
  catch(e) { return mergeRolePermissions(DEFAULT_ROLE_PERMISSIONS, {}); }
};

function userCanViewPanel(panel) {
  if (!CURRENT_USER) return false;
  if (panel === 'dashboard') return true;
  if (panel === 'daily-report') return userCanUseDailyReport();
  return currentPerm(panel).view === true;
}
userCanCreate = function(panel) { return !!(CURRENT_USER && currentPerm(panel || CURRENT_PANEL).create === true); };
userCanEdit = function(panel) { return !!(CURRENT_USER && currentPerm(panel || CURRENT_PANEL).edit === true); };
userCanDelete = function(panel) { return !!(CURRENT_USER && currentPerm(panel || CURRENT_PANEL).delete === true); };
userCanWrite = function() { return userCanCreate(CURRENT_PANEL); };

function isSystemPanel(panel) {
  return ['activity','audit','backup','admin','webhooks','custom-fields'].indexOf(panel) > -1;
}

function isAnalysisPanel(panel) {
  return ['reports','calendar','ai','kanban','invoice'].indexOf(panel) > -1;
}

function getNavMenuParts(group) {
  return {
    btn: document.getElementById(group + '-menu-btn'),
    dropdown: document.getElementById(group + '-menu-dropdown')
  };
}

function setNavMenuOpen(group, open) {
  var parts = getNavMenuParts(group);
  var btn = parts.btn;
  var dropdown = parts.dropdown;
  if (!btn || !dropdown) return;
  btn.classList.toggle('open', !!open);
  dropdown.classList.toggle('open', !!open);
  dropdown.style.maxHeight = open ? (dropdown.scrollHeight + 'px') : '0px';
}

function setSystemMenuOpen(open) {
  setNavMenuOpen('system', open);
}

function setAnalysisMenuOpen(open) {
  setNavMenuOpen('analysis', open);
}

function toggleNavMenu(group) {
  var parts = getNavMenuParts(group);
  var dropdown = parts.dropdown;
  setNavMenuOpen(group, !(dropdown && dropdown.classList.contains('open')));
}

function toggleSystemMenu() {
  toggleNavMenu('system');
}

function updateNavMenuState(group, isActiveFn) {
  var parts = getNavMenuParts(group);
  var btn = parts.btn;
  var dropdown = parts.dropdown;
  if (!btn || !dropdown) return;
  var visibleItems = Array.prototype.slice.call(dropdown.querySelectorAll('.nav-item')).filter(function(item) {
    return item.style.display !== 'none';
  });
  var hasVisible = visibleItems.length > 0;
  btn.style.display = hasVisible ? 'flex' : 'none';
  dropdown.style.display = hasVisible ? 'block' : 'none';
  var active = isActiveFn(CURRENT_PANEL);
  btn.classList.toggle('active', active);
  if (active) setNavMenuOpen(group, true);
  else if (!dropdown.classList.contains('open')) setNavMenuOpen(group, false);
}

function updateSystemMenuState() {
  updateNavMenuState('system', isSystemPanel);
}

function updateAnalysisMenuState() {
  updateNavMenuState('analysis', isAnalysisPanel);
}

function updateSidebarDropdownState() {
  updateAnalysisMenuState();
  updateSystemMenuState();
}

function getDailyReports() {
  try { return JSON.parse(localStorage.getItem(DAILY_REPORT_KEY) || '[]'); }
  catch(e) { return []; }
}

function setDailyReports(rows) {
  localStorage.setItem(DAILY_REPORT_KEY, JSON.stringify(rows || []));
}

function cleanupMismatchedDailyTestReports() {
  try {
    var rows = getDailyReports();
    var cleaned = rows.filter(function(row) {
      var author = String(row && row.author || '');
      var authorId = String(row && row.authorId || '');
      var position = String(row && row.position || '');
      var values = row && row.values || {};
      var workDone = String(values.workDone || row.workDone || '');
      return !(author === 'หลิว' && authorId === 'EMP-005' && /Facebook Ads|Lead|ครีเอทีฟ|ยิงแอด/i.test(workDone + ' ' + position));
    });
    if (cleaned.length !== rows.length) setDailyReports(cleaned);
  } catch(e) {}
}

cleanupMismatchedDailyTestReports();

function seedTodayDailyReportsForEmployees() {
  try {
    var today = new Date().toISOString().slice(0, 10);
    var seedKey = 'erp-daily-report-real-work-' + today;
    if (localStorage.getItem(seedKey)) return;
    var rows = getDailyReports();
    function exists(authorId) {
      return rows.some(function(row) {
        return String(row.authorId || '') === authorId && String(row.date || '').slice(0, 10) === today;
      });
    }
    var now = new Date().toISOString();
    if (!exists('EMP-005')) {
      rows.unshift({
        id: 'DR-EMP005-' + Date.now(),
        date: now,
        position: 'ฝ่ายขาย',
        values: {
          workDone: 'โทรติดตามลูกค้าใหม่จาก Facebook และ LINE OA จำนวน 14 ราย คัดกรองงบประมาณและทำเล นัดสำรวจพื้นที่ 2 ราย ส่งแบบบ้านพร้อมประเมินราคาเบื้องต้นให้ลูกค้า 4 ราย และอัปเดตสถานะลูกค้าในระบบครบทุกเคส',
          nextPlan: 'ติดตามลูกค้ากลุ่มสนใจสูง 6 ราย เตรียมใบเสนอราคาให้คุณณัฐชา ประสานทีมสำรวจพื้นที่เชียงราย และสรุปรายชื่อลูกค้าที่พร้อมทำสัญญาให้ Admin ตรวจช่วงบ่าย',
          online: 10,
          offline: 3
        },
        workDone: 'โทรติดตามลูกค้าใหม่จาก Facebook และ LINE OA จำนวน 14 ราย คัดกรองงบประมาณและทำเล นัดสำรวจพื้นที่ 2 ราย ส่งแบบบ้านพร้อมประเมินราคาเบื้องต้นให้ลูกค้า 4 ราย และอัปเดตสถานะลูกค้าในระบบครบทุกเคส',
        nextPlan: 'ติดตามลูกค้ากลุ่มสนใจสูง 6 ราย เตรียมใบเสนอราคาให้คุณณัฐชา ประสานทีมสำรวจพื้นที่เชียงราย และสรุปรายชื่อลูกค้าที่พร้อมทำสัญญาให้ Admin ตรวจช่วงบ่าย',
        online: 10,
        offline: 3,
        author: 'พนักงานทดสอบ',
        authorId: 'EMP-005',
        adminStatus: 'sent',
        adminReceivedAt: now,
        sheetStatus: 'ซิงก์แล้ว'
      });
    }
    if (!exists('EMP-007')) {
      rows.unshift({
        id: 'DR-EMP007-' + Date.now(),
        date: now,
        position: 'นักยิงแอด / การตลาด',
        values: {
          workDone: 'ตรวจแคมเปญ Facebook Ads 4 แคมเปญ ปรับงบกลุ่มบ้านชั้นเดียวและบ้านสองชั้น วิเคราะห์ CPL/CTR รายชุดโฆษณา ตอบ Inbox 22 เคส คัด Lead คุณภาพ 9 ราย และส่งต่อฝ่ายขายพร้อมหมายเหตุการติดตาม',
          nextPlan: 'ทดสอบครีเอทีฟใหม่ 3 ชุด ทำ Retarget กลุ่มคนที่กดดูแบบบ้าน จัดทำรายงาน Lead รายแหล่งที่มา และส่งรายชื่อ Lead พร้อมคุยให้ฝ่ายขายก่อน 11:00 น.',
          online: 18,
          offline: 4
        },
        workDone: 'ตรวจแคมเปญ Facebook Ads 4 แคมเปญ ปรับงบกลุ่มบ้านชั้นเดียวและบ้านสองชั้น วิเคราะห์ CPL/CTR รายชุดโฆษณา ตอบ Inbox 22 เคส คัด Lead คุณภาพ 9 ราย และส่งต่อฝ่ายขายพร้อมหมายเหตุการติดตาม',
        nextPlan: 'ทดสอบครีเอทีฟใหม่ 3 ชุด ทำ Retarget กลุ่มคนที่กดดูแบบบ้าน จัดทำรายงาน Lead รายแหล่งที่มา และส่งรายชื่อ Lead พร้อมคุยให้ฝ่ายขายก่อน 11:00 น.',
        online: 18,
        offline: 4,
        author: 'หลิว',
        authorId: 'EMP-007',
        adminStatus: 'sent',
        adminReceivedAt: now,
        sheetStatus: 'ซิงก์แล้ว'
      });
    }
    setDailyReports(rows);
    localStorage.setItem(seedKey, '1');
  } catch(e) {}
}

seedTodayDailyReportsForEmployees();

function normalizePositionName(position) {
  var text = String(position || '').trim();
  if (/marketing|การตลาด|ยิงแอด/i.test(text)) return 'นักยิงแอด / การตลาด';
  if (/sale|sales|ฝ่ายขาย|เซล/i.test(text)) return 'ฝ่ายขาย';
  if (/บัญชี|account/i.test(text)) return 'ฝ่ายบัญชี';
  if (/ช่าง|ก่อสร้าง|construction|site/i.test(text)) return 'ฝ่ายก่อสร้าง';
  if (/marketing|การตลาด|ยิงแอด/i.test(text)) return 'นักยิงแอด / การตลาด';
  return text || 'ไม่ระบุตำแหน่ง';
}

function currentUserPositionName() {
  return normalizePositionName(CURRENT_USER && (CURRENT_USER.position || CURRENT_USER.pos || CURRENT_USER.department || ''));
}

function userCanUseDailyReport() {
  return !!CURRENT_USER;
}

function defaultDailyFieldConfig() {
  return {
    'นักยิงแอด / การตลาด': [
      { id:'workDone', label:'1. สิ่งที่ทำประจำวัน', type:'textarea', placeholder:'สรุปงานยิงแอด คอนเทนต์ Lead และการส่งต่อทีมขาย...', required:true, locked:true },
      { id:'nextPlan', label:'2. แผนงานวันถัดไป', type:'textarea', placeholder:'ระบุแผนปรับแคมเปญ คอนเทนต์ หรือรายงานที่ต้องทำต่อ...', required:false, locked:true },
      { id:'online', label:'🌐 Lead ออนไลน์วันนี้', type:'number', placeholder:'0', required:false, locked:true, group:'newCustomers', unit:'คน' },
      { id:'offline', label:'🏃 Lead ออฟไลน์/เบอร์โทร', type:'number', placeholder:'0', required:false, locked:true, group:'newCustomers', unit:'คน' }
    ],
    'ฝ่ายขาย': [
      { id:'workDone', label:'1. สิ่งที่ทำประจำวัน', type:'textarea', placeholder:'ระบุรายละเอียดงานที่ปฏิบัติในวันนี้...', required:true, locked:true },
      { id:'nextPlan', label:'2. แผนงานวันถัดไป', type:'textarea', placeholder:'ระบุแผนงานหรือเป้าหมายที่ต้องทำในวันถัดไป...', required:false, locked:true },
      { id:'online', label:'🌐 ลูกค้าออนไลน์', type:'number', placeholder:'0', required:false, locked:true, group:'newCustomers', unit:'คน' },
      { id:'offline', label:'🏃 ลูกค้าออฟไลน์ (Walk-in + เบอร์โทร)', type:'number', placeholder:'0', required:false, locked:true, group:'newCustomers', unit:'คน' }
    ],
    'ฝ่ายบัญชี': [
      { id:'accountWork', label:'1. งานบัญชีที่ทำวันนี้', type:'textarea', placeholder:'ระบุงานบัญชีที่ทำ...', required:true, locked:true },
      { id:'accountIssue', label:'2. ปัญหาหรือเอกสารค้าง', type:'textarea', placeholder:'ระบุเอกสารหรือปัญหาที่ต้องตามต่อ...', required:false, locked:true }
    ],
    'ฝ่ายก่อสร้าง': [
      { id:'siteWork', label:'1. งานไซต์ที่ทำวันนี้', type:'textarea', placeholder:'ระบุงานหน้างานที่ทำ...', required:true, locked:true },
      { id:'materials', label:'2. วัสดุ/อุปกรณ์ที่ต้องใช้เพิ่ม', type:'textarea', placeholder:'ระบุวัสดุหรืออุปกรณ์...', required:false, locked:true }
    ]
  };
}

function getDailyFieldConfig() {
  try {
    var config = Object.assign({}, defaultDailyFieldConfig());
    var saved = JSON.parse(localStorage.getItem(DAILY_FIELD_CONFIG_KEY) || '{}');
    Object.keys(saved).forEach(function(position) {
      config[normalizePositionName(position)] = saved[position];
    });
    return config;
  }
  catch(e) { return defaultDailyFieldConfig(); }
}

function saveDailyFieldConfig(config) {
  localStorage.setItem(DAILY_FIELD_CONFIG_KEY, JSON.stringify(config || {}));
}

function fieldsForPosition(position, includeHidden) {
  var config = getDailyFieldConfig();
  var pos = normalizePositionName(position);
  var fields = config[pos] || [];
  return includeHidden ? fields : fields.filter(function(field) { return field.hidden !== true; });
}

function renderDailyReportFields() {
  var wrap = document.getElementById('daily-report-fields');
  if (!wrap) return;
  var fields = fieldsForPosition(currentUserPositionName());
  if (!fields.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">🔒</div><div class="empty-text">ตำแหน่งนี้ยังไม่มีแบบฟอร์มรายงานประจำวัน</div></div>';
    return;
  }
  var regular = fields.filter(function(f) { return f.group !== 'newCustomers'; });
  var customers = fields.filter(function(f) { return f.group === 'newCustomers'; });
  var html = regular.map(function(field, index) {
    var id = 'daily-field-' + field.id;
    var labelClass = index > 1 ? 'daily-report-label amber' : 'daily-report-label';
    if (field.type === 'number') {
      return '<div><label class="' + labelClass + '">' + escapeHtml(field.label) + '</label><input id="' + id + '" data-daily-field="' + escapeHtml(field.id) + '" type="number" min="0" value="0" placeholder="' + escapeHtml(field.placeholder || '0') + '" class="form-input"></div>';
    }
    if (field.type === 'text') {
      return '<div><label class="' + labelClass + '">' + escapeHtml(field.label) + '</label><input id="' + id + '" data-daily-field="' + escapeHtml(field.id) + '" type="text" placeholder="' + escapeHtml(field.placeholder || '') + '" class="form-input"></div>';
    }
    if (field.type === 'date') {
      return '<div><label class="' + labelClass + '">' + escapeHtml(field.label) + '</label><input id="' + id + '" data-daily-field="' + escapeHtml(field.id) + '" type="date" class="form-input"></div>';
    }
    return '<div><label class="' + labelClass + '">' + escapeHtml(field.label) + '</label><textarea id="' + id + '" data-daily-field="' + escapeHtml(field.id) + '" rows="3" placeholder="' + escapeHtml(field.placeholder || '') + '" class="form-input textarea"></textarea></div>';
  }).join('');
  if (customers.length) {
    html += '<div><label class="daily-report-label amber">3. ลูกค้าใหม่วันนี้</label><div class="daily-customer-grid">' +
      customers.map(function(field) {
        return '<div class="daily-count-box"><span class="daily-count-label">' + escapeHtml(field.label) + '</span><div class="daily-count-row"><input id="daily-field-' + escapeHtml(field.id) + '" data-daily-field="' + escapeHtml(field.id) + '" type="number" value="0" min="0" class="form-input"><span style="color:#64748b">' + escapeHtml(field.unit || '') + '</span></div></div>';
      }).join('') +
    '</div></div>';
  }
  wrap.innerHTML = html;
}

function renderDailyReportProfile() {
  var profile = document.getElementById('daily-report-profile');
  var note = document.getElementById('daily-report-form-note');
  if (!profile) return;
  var user = CURRENT_USER || {};
  var name = user.name || 'ผู้ใช้งาน';
  var employeeId = user.employeeId || user.id || 'ไม่ระบุรหัส';
  var position = currentUserPositionName();
  var initials = name.trim().split(/\s+/).slice(0, 2).map(function(part) { return part.charAt(0); }).join('') || 'U';
  profile.innerHTML = '<div class="daily-report-profile-main">' +
    '<div class="daily-report-avatar">' + escapeHtml(initials) + '</div>' +
    '<div><div class="daily-report-user-name">' + escapeHtml(name) + '</div><div class="daily-report-user-id">' + escapeHtml(String(employeeId)) + '</div></div>' +
    '</div><span class="daily-report-position-badge">' + escapeHtml(position) + '</span>';
  if (note) {
    var count = fieldsForPosition(position).length;
    note.textContent = count
      ? 'แบบฟอร์มนี้ปรับตามตำแหน่ง ' + position + ' จำนวน ' + count + ' ช่อง'
      : 'ตำแหน่ง ' + position + ' ยังไม่มีแบบฟอร์ม กรุณาให้ Admin ตั้งค่าช่องรายงานประจำวัน';
  }
}

function formatDailyReportDate(date) {
  var d = date ? new Date(date) : new Date();
  if (isNaN(d)) d = new Date();
  return d.toLocaleDateString('th-TH', { year:'numeric', month:'long', day:'numeric' });
}

function resetDailyReportForm() {
  document.querySelectorAll('[data-daily-field]').forEach(function(el) {
    el.value = el.type === 'number' ? 0 : '';
  });
}

function dailyReportsForCurrentUser() {
  var rows = getDailyReports();
  if (!userIsAdmin()) {
    var currentId = String((CURRENT_USER && (CURRENT_USER.employeeId || CURRENT_USER.id)) || '');
    rows = rows.filter(function(row) {
      return String(row.authorId || '') === currentId || (!row.authorId && row.author === (CURRENT_USER && CURRENT_USER.name));
    });
  }
  return rows;
}

function setDailyReportViewLabels(rows) {
  rows = rows || [];
  var isAdminView = userIsAdmin();
  var panel = document.getElementById('panel-daily-report');
  if (!panel) return;
  var title = panel.querySelector('.daily-report-title');
  var listTitle = panel.querySelector('.daily-report-list .table-title');
  var formCard = panel.querySelector('.daily-report-card');
  var tools = panel.querySelector('.daily-report-tools');
  panel.classList.toggle('is-admin-daily-inbox', isAdminView);
  if (title) title.textContent = isAdminView ? '📥 กล่องรับรายงานจากพนักงาน' : '📝 บันทึกรายงานประจำวัน';
  if (listTitle) listTitle.textContent = isAdminView ? 'รายงานที่พนักงานส่งถึง Admin' : 'รายงานล่าสุด';
  if (formCard) formCard.style.display = isAdminView ? 'none' : '';
  if (tools) tools.setAttribute('aria-label', isAdminView ? 'Export รายงานพนักงานทั้งหมด' : 'Export รายงานของฉัน');
}

function dailyReportAdminStatus(row) {
  row = row || {};
  if (row.adminStatus === 'received') return 'Admin ได้รับแล้ว';
  if (row.adminStatus === 'sent') return 'ส่งถึง Admin แล้ว';
  return row.authorId ? 'ส่งถึง Admin แล้ว' : 'รอระบุผู้ส่ง';
}

var DAILY_REPORT_ADMIN_FILTER = { employee:'', position:'', from:'', to:'', query:'' };

function compactDateOnly(value) {
  if (!value) return '';
  var d = new Date(value);
  if (isNaN(d)) return String(value).slice(0, 10);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function dailyReportSearchText(row) {
  row = row || {};
  var values = row.values || {};
  return [
    row.authorId || '',
    row.author || '',
    row.position || '',
    row.workDone || '',
    row.nextPlan || ''
  ].concat(Object.keys(values).map(function(key) { return values[key]; })).join(' ').toLowerCase();
}

function readDailyReportAdminFilterInputs() {
  if (!userIsAdmin()) return;
  var employee = document.getElementById('daily-report-filter-employee');
  var position = document.getElementById('daily-report-filter-position');
  var from = document.getElementById('daily-report-filter-from');
  var to = document.getElementById('daily-report-filter-to');
  var query = document.getElementById('daily-report-filter-query');
  DAILY_REPORT_ADMIN_FILTER = {
    employee: employee ? employee.value : DAILY_REPORT_ADMIN_FILTER.employee,
    position: position ? position.value : DAILY_REPORT_ADMIN_FILTER.position,
    from: from ? from.value : DAILY_REPORT_ADMIN_FILTER.from,
    to: to ? to.value : DAILY_REPORT_ADMIN_FILTER.to,
    query: query ? query.value.trim() : DAILY_REPORT_ADMIN_FILTER.query
  };
}

function filteredDailyReportsForAdmin(rows) {
  rows = rows || [];
  if (!userIsAdmin()) return rows;
  var f = DAILY_REPORT_ADMIN_FILTER || {};
  var query = String(f.query || '').toLowerCase();
  return rows.filter(function(row) {
    var date = compactDateOnly(row.date);
    if (f.employee && String(row.authorId || '') !== f.employee) return false;
    if (f.position && String(row.position || '') !== f.position) return false;
    if (f.from && date < f.from) return false;
    if (f.to && date > f.to) return false;
    if (query && dailyReportSearchText(row).indexOf(query) === -1) return false;
    return true;
  });
}

function uniqueDailyReportOptions(rows, keyFn) {
  var seen = {};
  return (rows || []).reduce(function(list, row) {
    var option = keyFn(row);
    if (!option || !option.value || seen[option.value]) return list;
    seen[option.value] = true;
    list.push(option);
    return list;
  }, []);
}

function renderDailyReportAdminFilters(allRows, visibleRows) {
  var container = document.getElementById('daily-report-admin-filters');
  if (!container) return;
  if (!userIsAdmin()) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  var f = DAILY_REPORT_ADMIN_FILTER || {};
  var employees = uniqueDailyReportOptions(allRows, function(row) {
    var id = String(row.authorId || '').trim();
    return id ? { value:id, label:id + ' · ' + (row.author || '-') } : null;
  });
  var positions = uniqueDailyReportOptions(allRows, function(row) {
    var position = String(row.position || '').trim();
    return position ? { value:position, label:position } : null;
  });
  var employeeOptions = '<option value="">พนักงานทั้งหมด</option>' + employees.map(function(option) {
    return '<option value="' + escapeHtml(option.value) + '"' + (f.employee === option.value ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>';
  }).join('');
  var positionOptions = '<option value="">ทุกตำแหน่ง</option>' + positions.map(function(option) {
    return '<option value="' + escapeHtml(option.value) + '"' + (f.position === option.value ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>';
  }).join('');
  container.innerHTML =
    '<div class="daily-filter-row">' +
      '<label><span>พนักงาน</span><select id="daily-report-filter-employee" class="form-select">' + employeeOptions + '</select></label>' +
      '<label><span>ตำแหน่ง</span><select id="daily-report-filter-position" class="form-select">' + positionOptions + '</select></label>' +
      '<label><span>จากวันที่</span><input id="daily-report-filter-from" class="form-input" type="date" value="' + escapeHtml(f.from || '') + '"></label>' +
      '<label><span>ถึงวันที่</span><input id="daily-report-filter-to" class="form-input" type="date" value="' + escapeHtml(f.to || '') + '"></label>' +
      '<label class="daily-filter-search"><span>ค้นหาในรายละเอียด</span><input id="daily-report-filter-query" class="form-input" type="search" placeholder="เช่น ลูกค้า, Facebook Ads, นัดสำรวจ" value="' + escapeHtml(f.query || '') + '"></label>' +
      '<div class="daily-filter-actions"><button class="btn btn-primary btn-sm" type="button" onclick="applyDailyReportAdminFilter()">🔍 กรอง</button><button class="btn btn-ghost btn-sm" type="button" onclick="resetDailyReportAdminFilter()">ล้าง</button></div>' +
    '</div>' +
    '<div class="daily-filter-summary">กำลังแสดง ' + visibleRows.length + ' จาก ' + allRows.length + ' รายงาน</div>';
}

function applyDailyReportAdminFilter() {
  readDailyReportAdminFilterInputs();
  renderDailyReportPanel();
}

function resetDailyReportAdminFilter() {
  DAILY_REPORT_ADMIN_FILTER = { employee:'', position:'', from:'', to:'', query:'' };
  renderDailyReportPanel();
}

function dailyReportSheetRow(row) {
  row = row || {};
  var values = row.values || {};
  var isMarketing = /การตลาด|ยิงแอด|marketing/i.test(String(row.position || ''));
  var sheetRow = {
    ID: row.id || '',
    วันที่: row.date || '',
    วันที่แสดงผล: formatDailyReportDate(row.date),
    รหัสพนักงาน: row.authorId || '',
    ชื่อพนักงาน: row.author || '',
    ตำแหน่ง: row.position || '',
    สิ่งที่ทำประจำวัน: values.workDone || row.workDone || '',
    แผนงานวันถัดไป: values.nextPlan || row.nextPlan || '',
    สถานะซิงก์: row.sheetStatus || 'รอซิงก์'
  };
  sheetRow[isMarketing ? 'Lead ออนไลน์วันนี้' : 'ลูกค้าออนไลน์'] = values.online || row.online || 0;
  sheetRow[isMarketing ? 'Lead ออฟไลน์/เบอร์โทร' : 'ลูกค้าออฟไลน์'] = values.offline || row.offline || 0;
  Object.keys(values).forEach(function(key) {
    if (['workDone','nextPlan','online','offline'].indexOf(key) === -1) sheetRow[key] = values[key];
  });
  return sheetRow;
}

function updateDailyReportSyncStatus(reportId, status, error) {
  var rows = getDailyReports();
  var changed = false;
  rows.forEach(function(row) {
    if (row.id === reportId) {
      row.sheetStatus = status;
      row.sheetError = error || '';
      row.sheetSyncedAt = status === 'บันทึกลง Sheet แล้ว' ? new Date().toISOString() : row.sheetSyncedAt;
      changed = true;
    }
  });
  if (changed) {
    setDailyReports(rows);
    if (CURRENT_PANEL === 'daily-report') renderDailyReportPanel();
  }
}

async function syncDailyReportToSheet(reportId) {
  var row = getDailyReports().find(function(item) { return item.id === reportId; });
  if (!row) return;
  if (!CONNECTED || !API_URL) {
    updateDailyReportSyncStatus(reportId, 'รอซิงก์', 'ยังไม่ได้เชื่อมต่อ Google Sheets');
    return;
  }
  updateDailyReportSyncStatus(reportId, 'กำลังซิงก์', '');
  try {
    var result = await apiPost({ action:'write', sheet:'daily_reports', data:dailyReportSheetRow(row) });
    if (!result || result.ok === false) throw new Error(result && result.msg ? result.msg : 'Google Sheets rejected daily report');
    updateDailyReportSyncStatus(reportId, 'บันทึกลง Sheet แล้ว', '');
    toast('บันทึกรายงานลง Sheet แล้ว', 'ok');
  } catch(error) {
    updateDailyReportSyncStatus(reportId, 'รอซิงก์', error && (error.message || error) || 'Sync failed');
    toast('บันทึกในเครื่องแล้ว และรอซิงก์เข้า Sheet', 'info');
  }
}

function renderDailyReportPanel() {
  var label = document.getElementById('currentDateLabel');
  if (label) label.textContent = 'ประจำวันที่: ' + formatDailyReportDate(new Date());
  renderDailyReportProfile();
  renderDailyReportFields();
  var allRows = dailyReportsForCurrentUser();
  var rows = filteredDailyReportsForAdmin(allRows);
  setDailyReportViewLabels(rows);
  renderDailyReportAdminFilters(allRows, rows);
  var count = document.getElementById('daily-report-count');
  var list = document.getElementById('daily-report-list');
  if (count) count.textContent = userIsAdmin() && rows.length !== allRows.length ? rows.length + ' / ' + allRows.length + ' รายการ' : rows.length + ' รายการ';
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📝</div><div class="empty-text">ยังไม่มีรายงานประจำวัน</div></div>';
    return;
  }
  list.innerHTML = rows.slice(0, 8).map(function(row) {
    var values = row.values || {};
    var fields = fieldsForPosition(row.position || 'ฝ่ายขาย');
    var mainLines = fields.slice(0, 3).map(function(f) {
      return '<div class="daily-report-item-sub"><b>' + escapeHtml(f.label.replace(/^\d+\.\s*/, '')) + ':</b> ' + escapeHtml(values[f.id] || row[f.id] || '-').replace(/\n/g, '<br>') + '</div>';
    }).join('');
    var syncClass = row.sheetStatus === 'บันทึกลง Sheet แล้ว' ? ' synced' : row.sheetStatus === 'กำลังซิงก์' ? ' syncing' : '';
    var syncText = row.sheetStatus || 'รอซิงก์';
    var adminBadge = userIsAdmin() ? '<span class="daily-report-admin-badge">📬 ' + escapeHtml(dailyReportAdminStatus(row)) + '</span>' : '';
    var adminMeta = userIsAdmin() ? '<div class="daily-report-employee-meta">รหัสพนักงาน: ' + escapeHtml(row.authorId || '-') + (row.adminReceivedAt ? ' · รับเข้า Admin: ' + escapeHtml(formatDailyReportDate(row.adminReceivedAt)) : '') + '</div>' : '';
    return '<div class="daily-report-item">' +
      '<div class="daily-report-item-title">' + escapeHtml(formatDailyReportDate(row.date)) + ' · ' + escapeHtml(row.author || '-') + ' · ' + escapeHtml(row.position || '-') + '</div>' +
      adminBadge + adminMeta + mainLines +
      '<div class="daily-report-sync' + syncClass + '">Sheet: ' + escapeHtml(syncText) + (row.sheetError ? ' · ' + escapeHtml(row.sheetError) : '') + '</div>' +
    '</div>';
  }).join('');
}

function exportDailyReportsCSV() {
  readDailyReportAdminFilterInputs();
  var rows = filteredDailyReportsForAdmin(dailyReportsForCurrentUser());
  if (!rows.length) { toast('ยังไม่มีรายงานสำหรับ export', 'err'); return; }
  var data = rows.map(dailyReportSheetRow);
  var cols = [];
  data.forEach(function(row) {
    Object.keys(row).forEach(function(key) { if (cols.indexOf(key) === -1) cols.push(key); });
  });
  var csv = cols.join(',') + '\n' + data.map(function(row) {
    return cols.map(function(col) { return '"' + String(row[col] == null ? '' : row[col]).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  var blob = new Blob(['\uFEFF' + csv], { type:'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'daily_reports_sheet.csv';
  a.click();
  URL.revokeObjectURL(url);
  toast('ดาวน์โหลดไฟล์ Sheet CSV แล้ว', 'ok');
}

function downloadDailyReportsPDF() {
  readDailyReportAdminFilterInputs();
  var rows = filteredDailyReportsForAdmin(dailyReportsForCurrentUser());
  if (!rows.length) { toast('ยังไม่มีรายงานสำหรับ PDF', 'err'); return; }
  var html = rows.slice(0, 12).map(function(row) {
    var values = row.values || {};
    var fields = fieldsForPosition(row.position || '');
    var details = fields.map(function(field) {
      var value = values[field.id] || row[field.id] || '-';
      return '<div class="pdf-line"><b>' + escapeHtml(field.label.replace(/^\d+\.\s*/, '')) + '</b><span>' + escapeHtml(value).replace(/\n/g, '<br>') + '</span></div>';
    }).join('');
    return '<article class="pdf-card">' +
      '<h2>' + escapeHtml(formatDailyReportDate(row.date)) + ' · ' + escapeHtml(row.author || '-') + '</h2>' +
      '<div class="pdf-meta">รหัสพนักงาน: ' + escapeHtml(row.authorId || '-') + ' · ตำแหน่ง: ' + escapeHtml(row.position || '-') + '</div>' +
      details +
      '<div class="pdf-sync">Sheet: ' + escapeHtml(row.sheetStatus || 'รอซิงก์') + '</div>' +
    '</article>';
  }).join('');
  var win = window.open('', '_blank');
  if (!win) { toast('กรุณาอนุญาต popup เพื่อโหลด PDF', 'err'); return; }
  win.document.write('<!doctype html><html lang="th"><head><meta charset="utf-8"><title>รายงานประจำวัน</title>' +
    '<style>body{font-family:Tahoma,Arial,sans-serif;margin:28px;color:#111827;background:#fff}h1{font-size:20px;margin:0 0 4px}.sub{font-size:12px;color:#64748b;margin-bottom:18px}.pdf-card{break-inside:avoid;border:1px solid #d7dde8;border-radius:10px;padding:16px;margin:0 0 14px}.pdf-card h2{font-size:15px;margin:0 0 4px}.pdf-meta,.pdf-sync{font-size:11px;color:#64748b;margin-bottom:10px}.pdf-line{font-size:12px;line-height:1.65;margin:8px 0}.pdf-line b{display:block;color:#0f172a;margin-bottom:2px}.pdf-line span{white-space:normal}@media print{body{margin:16mm}.no-print{display:none}}</style>' +
    '</head><body><button class="no-print" onclick="window.print()" style="float:right;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;background:#2563eb;color:white;font-weight:700">Save as PDF</button>' +
    '<h1>รายงานประจำวัน</h1><div class="sub">Exported: ' + new Date().toLocaleString('th-TH') + '</div>' + html +
    '<script>setTimeout(function(){window.print()},500)<\/script></body></html>');
  win.document.close();
  toast('เปิดหน้า PDF แล้ว เลือก Save as PDF ได้เลย', 'ok');
}

function saveDailyReport(event) {
  if (event && event.preventDefault) event.preventDefault();
  if (!userCanUseDailyReport()) {
    toast('กรุณาเข้าสู่ระบบก่อนบันทึกรายงาน', 'err');
    return;
  }
  var fields = fieldsForPosition(currentUserPositionName());
  if (!fields.length) {
    toast('ตำแหน่งนี้ยังไม่มีแบบฟอร์มรายงาน กรุณาติดต่อ Admin', 'err');
    return;
  }
  var values = {};
  fields.forEach(function(field) {
    var el = document.querySelector('[data-daily-field="' + field.id + '"]');
    values[field.id] = el ? el.value : '';
  });
  var missing = fields.find(function(field) { return field.required && !String(values[field.id] || '').trim(); });
  if (missing) {
    toast('กรุณากรอก: ' + missing.label, 'err');
    return;
  }
  var invalidNumber = fields.find(function(field) { return field.type === 'number' && Number(values[field.id] || 0) < 0; });
  if (invalidNumber) {
    toast('จำนวนลูกค้าต้องไม่ติดลบ', 'err');
    return;
  }
  var rows = getDailyReports();
  var row = {
    id: 'DR-' + Date.now(),
    date: new Date().toISOString(),
    position: currentUserPositionName(),
    values: values,
    workDone: values.workDone || '',
    nextPlan: values.nextPlan || '',
    online: Number(values.online || 0),
    offline: Number(values.offline || 0),
    author: CURRENT_USER ? CURRENT_USER.name : 'ระบบ',
    authorId: CURRENT_USER ? (CURRENT_USER.employeeId || CURRENT_USER.id || '') : '',
    adminStatus: 'sent',
    adminReceivedAt: new Date().toISOString()
  };
  rows.unshift(row);
  setDailyReports(rows);
  syncDailyReportToSheet(row.id);
  resetDailyReportForm();
  renderDailyReportPanel();
  logAudit('create', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', 'บันทึกรายงานประจำวัน', '—', row.id);
  toast('บันทึกและส่งรายงานแล้ว', 'ok');
}

function getSystemUserPositions() {
  return getAdminPositionOptions().slice();
}

function syncDailyPositionOptions(preferredPosition) {
  var select = document.getElementById('daily-field-position');
  if (!select) return;
  var positions = getSystemUserPositions();
  if (!positions.length) positions = ['ฝ่ายขาย'];
  var requested = String(preferredPosition || select.value || positions[0]).trim();
  var current = positions.indexOf(requested) > -1
    ? requested
    : positions.find(function(position) { return normalizePositionName(position) === normalizePositionName(requested); }) || positions[0];
  select.innerHTML = positions.map(function(position) {
    return '<option value="' + escapeHtml(position) + '"' + (position === current ? ' selected' : '') + '>' + escapeHtml(position) + '</option>';
  }).join('');
  if (!select.value && positions.length) select.value = positions[0];
}

var DAILY_FIELD_EDIT_ID = '';
var DAILY_FIELD_HISTORY_KEY = 'erp-daily-field-history';

function getDailyFieldHistory() {
  try { return JSON.parse(localStorage.getItem(DAILY_FIELD_HISTORY_KEY) || '[]'); }
  catch(e) { return []; }
}

function pushDailyFieldHistory(action) {
  var history = getDailyFieldHistory();
  history.unshift({ action:action, at:new Date().toISOString(), config:getDailyFieldConfig() });
  localStorage.setItem(DAILY_FIELD_HISTORY_KEY, JSON.stringify(history.slice(0, 12)));
}

function renderDailyFieldUtilityState(position) {
  var positions = getSystemUserPositions();
  var target = document.getElementById('daily-field-copy-target');
  if (target) {
    target.innerHTML = '<option value="">คัดลอกไปตำแหน่ง...</option>' + positions.filter(function(item) {
      return normalizePositionName(item) !== normalizePositionName(position);
    }).map(function(item) {
      return '<option value="' + escapeHtml(item) + '">' + escapeHtml(item) + '</option>';
    }).join('');
  }
  var history = getDailyFieldHistory();
  var undo = document.getElementById('daily-field-undo-btn');
  var historyEl = document.getElementById('daily-field-history');
  if (undo) undo.disabled = !history.length;
  if (historyEl) historyEl.textContent = history.length
    ? 'ล่าสุด: ' + history[0].action + ' · ' + new Date(history[0].at).toLocaleString('th-TH')
    : 'ยังไม่มีประวัติการแก้ไข';
}

function startDailyFieldEdit(id) {
  DAILY_FIELD_EDIT_ID = id;
  renderDailyFieldAdmin();
}

function cancelDailyFieldEdit() {
  DAILY_FIELD_EDIT_ID = '';
  renderDailyFieldAdmin();
}

function saveDailyFieldEdit(position, id) {
  var labelEl = document.getElementById('daily-edit-label-' + id);
  var typeEl = document.getElementById('daily-edit-type-' + id);
  var placeholderEl = document.getElementById('daily-edit-placeholder-' + id);
  var label = labelEl ? labelEl.value.trim() : '';
  if (!label) { toast('ชื่อช่องห้ามว่าง', 'err'); return; }
  var config = getDailyFieldConfig();
  var pos = normalizePositionName(position);
  var fields = config[pos] || [];
  var duplicate = fields.some(function(field) { return field.id !== id && String(field.label).toLowerCase() === label.toLowerCase(); });
  if (duplicate) { toast('มีชื่อช่องนี้อยู่แล้ว', 'err'); return; }
  pushDailyFieldHistory('แก้ไขช่อง ' + label);
  var field = fields.find(function(item) { return item.id === id; });
  if (field) {
    field.label = label;
    field.type = typeEl ? typeEl.value : field.type;
    field.placeholder = placeholderEl ? placeholderEl.value.trim() : field.placeholder;
  }
  saveDailyFieldConfig(config);
  DAILY_FIELD_EDIT_ID = '';
  renderDailyFieldAdmin();
  toast('แก้ไขช่องแล้ว', 'ok');
}

function moveDailyField(position, index, direction) {
  var config = getDailyFieldConfig();
  var pos = normalizePositionName(position);
  var fields = config[pos] || [];
  var next = index + direction;
  if (next < 0 || next >= fields.length) return;
  pushDailyFieldHistory('เรียงลำดับช่อง');
  var item = fields.splice(index, 1)[0];
  fields.splice(next, 0, item);
  saveDailyFieldConfig(config);
  renderDailyFieldAdmin();
}

function toggleDailyFieldProperty(position, id, property) {
  var config = getDailyFieldConfig();
  var pos = normalizePositionName(position);
  var field = (config[pos] || []).find(function(item) { return item.id === id; });
  if (!field) return;
  pushDailyFieldHistory((property === 'hidden' ? 'เปิด/ซ่อน ' : 'Required/Optional ') + field.label);
  field[property] = !field[property];
  saveDailyFieldConfig(config);
  renderDailyFieldAdmin();
}

function copyDailyFieldsToPosition() {
  var sourceEl = document.getElementById('daily-field-position');
  var targetEl = document.getElementById('daily-field-copy-target');
  if (!sourceEl || !targetEl || !targetEl.value) { toast('กรุณาเลือกตำแหน่งปลายทาง', 'err'); return; }
  var source = normalizePositionName(sourceEl.value);
  var target = normalizePositionName(targetEl.value);
  var config = getDailyFieldConfig();
  if ((config[target] || []).length && !confirm('ตำแหน่ง "' + target + '" มีฟอร์มอยู่แล้ว ต้องการแทนที่หรือไม่?')) return;
  pushDailyFieldHistory('คัดลอกฟอร์ม ' + source + ' ไป ' + target);
  config[target] = JSON.parse(JSON.stringify(config[source] || [])).map(function(field, index) {
    field.id = field.locked ? ('copy_' + Date.now() + '_' + index) : ('custom_' + Date.now() + '_' + index);
    field.locked = false;
    return field;
  });
  saveDailyFieldConfig(config);
  renderDailyFieldAdmin();
  toast('คัดลอกฟอร์มไป ' + target + ' แล้ว', 'ok');
}

function resetDailyFieldsForPosition() {
  var positionEl = document.getElementById('daily-field-position');
  if (!positionEl) return;
  var pos = normalizePositionName(positionEl.value);
  if (!confirm('คืนค่าฟอร์มของ "' + pos + '" เป็นค่าเริ่มต้นหรือไม่?')) return;
  pushDailyFieldHistory('คืนค่าเริ่มต้น ' + pos);
  var config = getDailyFieldConfig();
  config[pos] = JSON.parse(JSON.stringify(defaultDailyFieldConfig()[pos] || []));
  saveDailyFieldConfig(config);
  renderDailyFieldAdmin();
  toast('คืนค่าเริ่มต้นแล้ว', 'ok');
}

function undoDailyFieldChange() {
  var history = getDailyFieldHistory();
  if (!history.length) return;
  var snapshot = history.shift();
  saveDailyFieldConfig(snapshot.config || {});
  localStorage.setItem(DAILY_FIELD_HISTORY_KEY, JSON.stringify(history));
  DAILY_FIELD_EDIT_ID = '';
  renderDailyFieldAdmin();
  toast('Undo: ' + snapshot.action, 'ok');
}

function renderDailyFieldAdmin() {
  var wrap = document.getElementById('daily-field-admin-list');
  if (!wrap) return;
  var posEl = document.getElementById('daily-field-position');
  syncDailyPositionOptions(posEl ? posEl.value : 'ฝ่ายขาย');
  posEl = document.getElementById('daily-field-position');
  var selectedPosition = posEl ? posEl.value : 'ฝ่ายขาย';
  var position = normalizePositionName(selectedPosition);
  var fields = fieldsForPosition(selectedPosition, true);
  syncDailyFieldPreviewPositions(selectedPosition);
  var title = document.getElementById('daily-field-admin-title');
  var count = document.getElementById('daily-field-admin-count');
  if (title) title.textContent = 'รายการช่องปัจจุบัน: ' + selectedPosition;
  if (count) count.textContent = fields.length + ' ช่อง';
  var previewPositionEl = document.getElementById('daily-field-preview-position');
  var previewPosition = previewPositionEl ? previewPositionEl.value : selectedPosition;
  renderDailyFieldPreview(previewPosition, fieldsForPosition(previewPosition));
  if (!fields.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-text">ยังไม่มีช่องสำหรับตำแหน่งนี้</div></div>';
    return;
  }
  wrap.innerHTML = fields.map(function(field, index) {
    var editing = DAILY_FIELD_EDIT_ID === field.id;
    var main = editing
      ? '<input id="daily-edit-label-' + escapeHtml(field.id) + '" class="form-input daily-field-inline-input" value="' + escapeHtml(field.label) + '">'
      : '<div class="daily-field-admin-main"><div class="daily-field-admin-name" title="' + escapeHtml(field.label) + '">' + escapeHtml(field.label) + '</div><div class="daily-field-mini">' + escapeHtml(field.id) + '</div></div>';
    var typeCell = editing
      ? '<select id="daily-edit-type-' + escapeHtml(field.id) + '" class="form-select daily-field-inline-input">' +
        ['textarea','text','number','date'].map(function(type) { return '<option value="' + type + '"' + (field.type === type ? ' selected' : '') + '>' + type + '</option>'; }).join('') + '</select>'
      : '<div class="daily-field-mini" style="font-family:var(--mono)">' + escapeHtml(field.type) + '</div>';
    var statusCell = editing
      ? '<input id="daily-edit-placeholder-' + escapeHtml(field.id) + '" class="form-input daily-field-inline-input" value="' + escapeHtml(field.placeholder || '') + '" placeholder="Placeholder">'
      : '<div class="daily-field-mini">' + (field.required ? 'Required' : 'Optional') + '</div>';
    var actions = editing
      ? '<button class="daily-field-icon-btn" title="บันทึก" onclick="saveDailyFieldEdit(&quot;' + escapeHtml(position) + '&quot;,&quot;' + escapeHtml(field.id) + '&quot;)">💾</button><button class="daily-field-icon-btn" title="ยกเลิก" onclick="cancelDailyFieldEdit()">✕</button>'
      : '<button class="daily-field-icon-btn" title="เลื่อนขึ้น" onclick="moveDailyField(&quot;' + escapeHtml(position) + '&quot;,' + index + ',-1)">↑</button>' +
        '<button class="daily-field-icon-btn" title="เลื่อนลง" onclick="moveDailyField(&quot;' + escapeHtml(position) + '&quot;,' + index + ',1)">↓</button>' +
        '<button class="daily-field-icon-btn" title="แก้ไข" onclick="startDailyFieldEdit(&quot;' + escapeHtml(field.id) + '&quot;)">✎</button>' +
        '<button class="daily-field-icon-btn" title="' + (field.required ? 'เปลี่ยนเป็น Optional' : 'เปลี่ยนเป็น Required') + '" onclick="toggleDailyFieldProperty(&quot;' + escapeHtml(position) + '&quot;,&quot;' + escapeHtml(field.id) + '&quot;,&quot;required&quot;)">' + (field.required ? '★' : '☆') + '</button>' +
        '<button class="daily-field-icon-btn" title="' + (field.hidden ? 'แสดงช่อง' : 'ซ่อนช่อง') + '" onclick="toggleDailyFieldProperty(&quot;' + escapeHtml(position) + '&quot;,&quot;' + escapeHtml(field.id) + '&quot;,&quot;hidden&quot;)">' + (field.hidden ? '◉' : '◌') + '</button>' +
        (field.locked ? '<span class="daily-field-icon-btn" title="ช่องเริ่มต้น">🔒</span>' : '<button class="daily-field-icon-btn danger" title="ลบ" onclick="deleteDailyField(&quot;' + escapeHtml(position) + '&quot;,&quot;' + escapeHtml(field.id) + '&quot;)">×</button>');
    return '<div class="daily-field-admin-row' + (field.hidden ? ' is-hidden' : '') + '">' + main +
      typeCell + statusCell + '<div class="daily-field-admin-actions">' + actions + '</div></div>';
  }).join('');
  renderDailyFieldUtilityState(selectedPosition);
}

function renderDailyFieldPreview(position, fields) {
  var wrap = document.getElementById('daily-field-preview-form');
  var sub = document.getElementById('daily-field-preview-sub');
  var title = document.getElementById('daily-field-preview-title');
  var count = document.getElementById('daily-field-preview-count');
  if (!wrap) return;
  fields = fields || fieldsForPosition(position);
  if (sub) sub.textContent = 'แบบฟอร์มสำหรับตำแหน่ง ' + position + ' · ' + fields.length + ' ช่อง';
  if (title) title.textContent = position;
  if (count) count.textContent = fields.length + ' ช่อง';
  if (!fields.length) {
    wrap.innerHTML = '<div class="daily-field-preview-empty">ตำแหน่งนี้ยังไม่มีช่องรายงาน กด “เพิ่มช่องรายงาน” เพื่อดูตัวอย่างทันที</div>';
    return;
  }
  wrap.innerHTML = fields.map(function(field) {
    var wide = field.type === 'textarea' ? ' wide' : '';
    var label = '<label class="daily-field-preview-label">' + escapeHtml(field.label) +
      (field.required ? '<small>Required</small>' : '') +
      (field.locked ? '<small>Default</small>' : '<small>Custom</small>') + '</label>';
    var control = '';
    if (field.type === 'textarea') {
      control = '<textarea class="form-input textarea" rows="3" placeholder="' + escapeHtml(field.placeholder || 'กรอกรายละเอียด...') + '"></textarea>';
    } else if (field.type === 'number') {
      control = '<input class="form-input" type="number" min="0" placeholder="' + escapeHtml(field.placeholder || '0') + '">';
    } else if (field.type === 'date') {
      control = '<input class="form-input" type="date">';
    } else {
      control = '<input class="form-input" type="text" placeholder="' + escapeHtml(field.placeholder || 'กรอกข้อมูล...') + '">';
    }
    return '<div class="daily-field-preview-item' + wide + '">' + label + control + '</div>';
  }).join('');
}

function syncDailyFieldPreviewPositions(preferredPosition) {
  var builder = document.getElementById('daily-field-position');
  var preview = document.getElementById('daily-field-preview-position');
  if (!preview) return;
  var positions = getSystemUserPositions();
  if (!positions.length && builder && builder.value) positions = [builder.value];
  var keepCurrent = preview.dataset.manual === 'true' && positions.indexOf(preview.value) > -1;
  var preferred = keepCurrent ? preview.value : (preferredPosition || (builder && builder.value) || positions[0] || '');
  preview.innerHTML = positions.map(function(position) {
    return '<option value="' + escapeHtml(position) + '"' + (position === preferred ? ' selected' : '') + '>' + escapeHtml(position) + '</option>';
  }).join('');
  if (!preview.value && positions.length) preview.value = positions[0];
}

function changeDailyFieldPreviewPosition() {
  var preview = document.getElementById('daily-field-preview-position');
  if (preview) {
    preview.dataset.manual = 'true';
    renderDailyFieldPreview(preview.value, fieldsForPosition(preview.value));
  }
}

function renderDailyFieldDraftPreview() {
  var positionEl = document.getElementById('daily-field-position');
  var labelEl = document.getElementById('daily-field-label');
  var typeEl = document.getElementById('daily-field-type');
  var placeholderEl = document.getElementById('daily-field-placeholder');
  var requiredEl = document.getElementById('daily-field-required');
  if (!positionEl || !labelEl || !typeEl || !placeholderEl) return;
  var fields = fieldsForPosition(positionEl.value).slice();
  var label = labelEl.value.trim();
  if (label) {
    fields.push({
      id: 'draft-preview',
      label: label,
      type: typeEl.value || 'textarea',
      placeholder: placeholderEl.value.trim(),
      required: !!(requiredEl && requiredEl.checked),
      locked: false
    });
  }
  var previewPosition = document.getElementById('daily-field-preview-position');
  if (!previewPosition || normalizePositionName(previewPosition.value) === normalizePositionName(positionEl.value)) {
    renderDailyFieldPreview(positionEl.value, fields);
  }
}

function applyDailyFieldExample(label, type, placeholder) {
  var labelEl = document.getElementById('daily-field-label');
  var typeEl = document.getElementById('daily-field-type');
  var placeholderEl = document.getElementById('daily-field-placeholder');
  if (!labelEl || !typeEl || !placeholderEl) return;
  labelEl.value = label || '';
  typeEl.value = type || 'textarea';
  placeholderEl.value = placeholder || '';
  renderDailyFieldDraftPreview();
  labelEl.focus();
  labelEl.select();
}

var DAILY_FIELD_EXAMPLES = {
  sales: [
    ['ยอดปิดการขายวันนี้','number','ระบุยอดขายรวมวันนี้'],
    ['รายชื่อลูกค้าที่ปิดการขาย','textarea','ระบุชื่อลูกค้าและรายละเอียด'],
    ['จำนวนลูกค้าที่ติดตาม','number','0'],
    ['วันที่นัดหมายครั้งถัดไป','date',''],
    ['ปัญหาและข้อเสนอแนะ','textarea','ระบุปัญหาและแนวทางแก้ไข'],
    ['แผนการขายวันถัดไป','textarea','ระบุเป้าหมายและงานที่ต้องติดตาม']
  ],
  marketing: [
    ['งบโฆษณาที่ใช้วันนี้','number','ระบุจำนวนเงิน'],
    ['จำนวนลูกค้าเป้าหมาย','number','0'],
    ['แคมเปญที่ดำเนินการ','text','ระบุชื่อแคมเปญ'],
    ['ผลลัพธ์โฆษณาวันนี้','textarea','สรุปยอดเข้าถึงและผลลัพธ์'],
    ['คอนเทนต์ที่เผยแพร่','textarea','ระบุช่องทางและหัวข้อ'],
    ['แผนปรับปรุงแคมเปญ','textarea','ระบุสิ่งที่จะปรับในวันถัดไป']
  ],
  accounting: [
    ['ยอดรับเงินวันนี้','number','ระบุยอดรับรวม'],
    ['ยอดจ่ายเงินวันนี้','number','ระบุยอดจ่ายรวม'],
    ['เอกสารที่ตรวจสอบ','textarea','ระบุรายการเอกสาร'],
    ['รายการค้างชำระ','textarea','ระบุลูกค้าและยอดค้าง'],
    ['วันที่ครบกำหนดชำระ','date',''],
    ['ปัญหาด้านบัญชี','textarea','ระบุปัญหาและสิ่งที่ต้องติดตาม']
  ],
  construction: [
    ['ความคืบหน้าหน้างาน','number','ระบุเปอร์เซ็นต์'],
    ['จำนวนคนงานวันนี้','number','0'],
    ['งานที่ดำเนินการ','textarea','ระบุรายละเอียดงานหน้างาน'],
    ['วัสดุที่ใช้วันนี้','textarea','ระบุวัสดุและจำนวน'],
    ['ปัญหาหน้างาน','textarea','ระบุปัญหาและวิธีแก้ไข'],
    ['วันตรวจงานครั้งถัดไป','date','']
  ],
  general: [
    ['สิ่งที่ทำวันนี้','textarea','ระบุรายละเอียดงาน'],
    ['แผนงานวันถัดไป','textarea','ระบุงานที่ต้องทำต่อ'],
    ['จำนวนงานที่เสร็จ','number','0'],
    ['วันที่ติดตามงาน','date',''],
    ['ปัญหาที่พบ','textarea','ระบุปัญหาและแนวทางแก้ไข'],
    ['หมายเหตุเพิ่มเติม','text','ระบุข้อมูลเพิ่มเติม']
  ]
};

function dailyFieldExampleGroup(position) {
  var text = String(position || '').toLowerCase();
  if (/บัญชี|account/.test(text)) return 'accounting';
  if (/ก่อสร้าง|ช่าง|วิศว|site|construction/.test(text)) return 'construction';
  if (/การตลาด|ยิงแอด|marketing/.test(text)) return 'marketing';
  if (/ขาย|sales|เซล/.test(text)) return 'sales';
  return 'general';
}

function renderDailyFieldExamples() {
  var positionEl = document.getElementById('daily-field-position');
  var list = document.getElementById('daily-field-example-list');
  var badge = document.getElementById('daily-field-example-position');
  if (!positionEl || !list) return;
  var position = positionEl.value || 'ตำแหน่งทั่วไป';
  var examples = DAILY_FIELD_EXAMPLES[dailyFieldExampleGroup(position)] || DAILY_FIELD_EXAMPLES.general;
  if (badge) badge.textContent = position;
  list.innerHTML = examples.map(function(item) {
    return '<button type="button" onclick="applyDailyFieldExample(&quot;' + escapeHtml(item[0]) + '&quot;,&quot;' + escapeHtml(item[1]) + '&quot;,&quot;' + escapeHtml(item[2]) + '&quot;)">' +
      escapeHtml(item[0]) + '<span>' + escapeHtml(item[1]) + '</span></button>';
  }).join('');
}

function initializeDailyFieldBuilder() {
  var positionEl = document.getElementById('daily-field-position');
  if (!positionEl) return;
  renderDailyFieldAdmin();
  renderDailyFieldExamples();
  if (positionEl.dataset.examplesBound !== 'true') {
    positionEl.dataset.examplesBound = 'true';
    positionEl.addEventListener('change', renderDailyFieldExamples);
  }
  ['daily-field-label','daily-field-type','daily-field-placeholder','daily-field-required'].forEach(function(id) {
    var element = document.getElementById(id);
    if (!element || element.dataset.previewBound === 'true') return;
    element.dataset.previewBound = 'true';
    element.addEventListener(element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input', renderDailyFieldDraftPreview);
  });
}

function focusDailyFieldBuilder() {
  var input = document.getElementById('daily-field-label');
  if (input) {
    input.scrollIntoView({ behavior:'smooth', block:'center' });
    setTimeout(function() { input.focus(); }, 250);
  }
}

function addDailyFieldFromAdmin() {
  if (!userIsAdmin()) { toast('Admin only', 'err'); return; }
  var pos = normalizePositionName((document.getElementById('daily-field-position') || {}).value || 'ฝ่ายขาย');
  var label = ((document.getElementById('daily-field-label') || {}).value || '').trim();
  var type = (document.getElementById('daily-field-type') || {}).value || 'textarea';
  var placeholder = ((document.getElementById('daily-field-placeholder') || {}).value || '').trim();
  var required = !!((document.getElementById('daily-field-required') || {}).checked);
  if (!label) { toast('กรุณากรอกชื่อช่อง', 'err'); return; }
  var config = getDailyFieldConfig();
  config[pos] = config[pos] || [];
  var duplicate = config[pos].some(function(field) {
    return String(field.label || '').trim().toLowerCase() === label.toLowerCase();
  });
  if (duplicate) { toast('มีชื่อช่องนี้อยู่แล้วในตำแหน่งที่เลือก', 'err'); return; }
  var id = 'custom_' + Date.now();
  pushDailyFieldHistory('เพิ่มช่อง ' + label);
  config[pos].push({ id:id, label:label, type:type, placeholder:placeholder, required:required, hidden:false, locked:false });
  saveDailyFieldConfig(config);
  document.getElementById('daily-field-label').value = '';
  document.getElementById('daily-field-placeholder').value = '';
  document.getElementById('daily-field-required').checked = false;
  renderDailyFieldAdmin();
  logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'Admin', 'เพิ่มช่อง Daily Report: ' + pos, '—', label);
  toast('เพิ่มช่องรายงานแล้ว', 'ok');
}

function deleteDailyField(position, id) {
  if (!userIsAdmin()) { toast('Admin only', 'err'); return; }
  var config = getDailyFieldConfig();
  var pos = normalizePositionName(position);
  var field = (config[pos] || []).find(function(item) { return item.id === id; });
  if (!field || field.locked) return;
  if (!confirm('ลบช่อง "' + field.label + '" หรือไม่?')) return;
  pushDailyFieldHistory('ลบช่อง ' + field.label);
  config[pos] = (config[pos] || []).filter(function(field) { return field.id !== id || field.locked; });
  saveDailyFieldConfig(config);
  renderDailyFieldAdmin();
  toast('ลบช่องแล้ว', 'ok');
}

renderAdminMatrix = function() {
  var tbody = document.getElementById('permission-matrix-body');
  if (!tbody) return;
  var perms = getRolePermissions();
  var roleClass = { admin:'premium-role-admin', editor:'premium-role-editor', viewer:'premium-role-viewer' };
  var icons = { sales:'🛍️', customers:'👥', contracts:'📑', employees:'👤', projects:'🏗️', reports:'📊', 'daily-report':'📝', calendar:'📅', ai:'🤖', activity:'≋', audit:'📋', backup:'💾', admin:'🛡️' };
  var html = PERMISSION_MODULE_CONFIG.map(function(mod) {
    var row = '<tr><td><span class="premium-module-title">' + (icons[mod.panel] || '▣') + ' ' + escapeHtml(mod.label) + '</span><span class="premium-module-sub">' + escapeHtml(mod.sub) + '</span></td>';
    ROLES.forEach(function(role) {
      var p = ((perms[role.key] || {})[mod.panel]) || {};
      row += '<td class="premium-perm-cell ' + (roleClass[role.key] || '') + '"><div class="premium-action-grid">';
      PERMISSION_ACTIONS.forEach(function(action) {
        var isDisabledAction = !mod.schema && action !== 'view';
        var mustStayOn = role.key === 'admin' && mod.panel === 'admin' && action === 'view';
        var disabled = isDisabledAction || mustStayOn;
        var checked = p[action] === true || mustStayOn;
        if (isDisabledAction) {
          row += '<span class="premium-na">—</span>';
        } else {
          row += '<label class="premium-check-wrap ' + (checked ? 'is-on' : 'is-off') + '" title="' + role.label + ' · ' + action + '">' +
            '<input class="perm-toggle" type="checkbox" data-role="' + role.key + '" data-panel="' + mod.panel + '" data-action="' + action + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
          '</label>';
        }
      });
      row += '</div></td>';
    });
    row += '</tr>';
    return row;
  }).join('');
  tbody.innerHTML = html;
};

saveAdminChanges = function() {
  adminUsers.forEach(function(u) {
    var row = document.getElementById('admin-user-row-' + u.id);
    if (row) {
      var sel = row.querySelector('select');
      if (sel) u.role = sel.value;
    }
  });
  var perms = getRolePermissions();
  document.querySelectorAll('#permission-matrix-body .perm-toggle').forEach(function(input) {
    var role = input.getAttribute('data-role');
    var panel = input.getAttribute('data-panel');
    var action = input.getAttribute('data-action');
    perms[role] = perms[role] || {};
    perms[role][panel] = perms[role][panel] || {};
    perms[role][panel][action] = input.checked;
  });
  perms.admin = perms.admin || {};
  perms.admin.admin = Object.assign({}, perms.admin.admin || {}, { view:true });
  localStorage.setItem(ADMIN_USERS_KEY, JSON.stringify(adminUsers));
  syncAdminUsersToLoginDb();
  saveRolePermissions(perms);
  syncRoleAccess();
  logAudit('admin', CURRENT_USER ? CURRENT_USER.name : 'Admin', 'บันทึก role permissions', 'matrix', 'saved');
  toast('บันทึกผู้ใช้และสิทธิ์รายเมนูแล้ว ✅', 'ok');
};

syncRoleAccess = function() {
  document.querySelectorAll('.nav-item[data-panel]').forEach(function(nav) {
    var panel = nav.getAttribute('data-panel');
    nav.style.display = userCanViewPanel(panel) ? 'flex' : 'none';
  });
  var addBtn = document.getElementById('btn-add');
  if (addBtn) addBtn.style.display = (SCHEMAS[CURRENT_PANEL] && userCanCreate(CURRENT_PANEL)) ? 'inline-flex' : 'none';
  updateSidebarDropdownState();
  if (CURRENT_USER && CURRENT_PANEL !== 'dashboard' && !userCanViewPanel(CURRENT_PANEL)) switchPanelByName('dashboard');
};

var baseUpdateSidebarDropdownState = updateSidebarDropdownState;
updateSidebarDropdownState = function() {
  if (typeof baseUpdateSidebarDropdownState === 'function') baseUpdateSidebarDropdownState();
  if (CURRENT_USER && CURRENT_USER.role === 'admin') {
    var systemBtn = document.getElementById('system-menu-btn');
    var systemDropdown = document.getElementById('system-menu-dropdown');
    if (systemBtn && systemDropdown) {
      systemBtn.classList.add('open');
      systemDropdown.classList.add('open');
      systemDropdown.style.maxHeight = systemDropdown.scrollHeight + 'px';
    }
  }
};

var finalSwitchPanel = switchPanel;
switchPanel = function(el) {
  var panel = el && el.getAttribute ? el.getAttribute('data-panel') : '';
  if (panel && !userCanViewPanel(panel)) {
    toast('Role นี้ไม่มีสิทธิ์เปิดเมนูนี้', 'err');
    return;
  }
  finalSwitchPanel(el);
  if (panel === 'daily-report') renderDailyReportPanel();
  syncRoleAccess();
  updateSidebarDropdownState();
};

switchPanelByName = function(name) {
  var el = document.querySelector('.nav-item[data-panel="' + name + '"]');
  if (el) switchPanel(el);
};

openAddModal = function() {
  if (!userCanCreate(CURRENT_PANEL)) { toast('Role นี้เพิ่มข้อมูลไม่ได้', 'err'); return; }
  originalOpenAddModalRole();
  var saveBtn = document.getElementById('modal-save');
  if (saveBtn) {
    saveBtn.onclick = saveModal;
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 บันทึก';
  }
};

editRow = async function(sheet, id) {
  if (!userCanEdit(sheet)) { toast('Role นี้แก้ไขข้อมูลไม่ได้', 'err'); return; }
  await originalEditRowRole(sheet, id);
  var saveBtn = document.getElementById('modal-save');
  if (saveBtn) {
    saveBtn.onclick = saveModal;
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 บันทึก';
  }
};

var finalDeleteImpl = doDelete;
doDelete = async function(sheet, id) {
  if (!userCanDelete(sheet)) { toast('Role นี้ลบข้อมูลไม่ได้', 'err'); closeConfirm(); return; }
  await finalDeleteImpl(sheet, id);
};

var finalLoadPanel = loadPanel;
loadPanel = async function(sheet, page, search) {
  if (!userCanViewPanel(sheet)) {
    toast('Role นี้ไม่มีสิทธิ์ดูข้อมูล', 'err');
    return;
  }
  await finalLoadPanel(sheet, page, search);
};

saveModal = async function() {
  var sheet = CURRENT_PANEL;
  if (EDIT_ID ? !userCanEdit(sheet) : !userCanCreate(sheet)) {
    toast(EDIT_ID ? 'Role นี้แก้ไขข้อมูลไม่ได้' : 'Role นี้เพิ่มข้อมูลไม่ได้', 'err');
    return;
  }
  var fields = SCHEMAS[sheet] || [];
  var data = {};
  fields.forEach(function(f) {
    var el = document.getElementById('field-' + f);
    if (el) data[f] = el.value;
  });
  var validationErrors = validateFormData(sheet, data);
  if (validationErrors.length) { toast(validationErrors[0], 'err'); return; }
  var editedId = EDIT_ID;
  if (CONNECTED) {
    try {
      var apiData = prepareApiDataForSheet(data);
      var result = editedId
        ? await apiPost({ action:'update', sheet:sheet, id:editedId, data:apiData })
        : await apiPost({ action:'write', sheet:sheet, data:apiData });
      if (result && result.ok) {
        closeModal();
        loadPanel(sheet);
        loadStats();
        logAudit(editedId ? 'update' : 'create', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', (editedId ? 'แก้ไข ' : 'เพิ่ม ') + sheet, editedId || '—', 'api');
        EDIT_ID = null;
        toast(result.msg || 'บันทึกสำเร็จ', 'ok');
        return;
      }
    } catch(e) {
      setStatus('ok', 'เชื่อมต่อแล้ว');
    }
  }
  var oldRow = editedId ? localUpdate(sheet, editedId, data) : null;
  var newRow = editedId ? null : localWrite(sheet, data);
  closeModal();
  loadPanel(sheet);
  loadStats();
  logAudit(editedId ? 'update' : 'create', CURRENT_USER ? CURRENT_USER.name : 'ระบบ', (editedId ? 'แก้ไข ' : 'เพิ่ม ') + sheet, editedId || '—', 'local');
  if (editedId && oldRow) {
    showUndo('แก้ไข ' + sheet, function() {
      localUpdate(sheet, editedId, oldRow);
      loadPanel(sheet);
      toast('Undo การแก้ไขแล้ว', 'ok');
    });
  } else if (newRow) {
    showUndo('เพิ่ม ' + sheet, function() {
      localDelete(sheet, newRow.ID);
      loadPanel(sheet);
      toast('Undo การเพิ่มแล้ว', 'ok');
    });
  }
  toast(CONNECTED ? 'บันทึกในเครื่องสำเร็จ (รอซิงก์)' : 'บันทึกในเครื่องสำเร็จ', 'ok');
};

var PREMIUM_TABLE_COLUMNS = {
  sales: ['วันที่','ลูกค้า','สินค้า','ยอดรวม','สถานะ'],
  customers: ['ชื่อ','บริษัท','อีเมล','โทรศัพท์','สถานะ'],
  contracts: ['ชื่อลูกค้า','สัญญางานสร้างบ้าน','วันสิ้นสุดสัญญา','มูลค่าสัญญา','สถานะ'],
  employees: ['ชื่อ','ตำแหน่ง','อีเมล','โทรศัพท์','สถานะ'],
  projects: ['ชื่องาน/โปรเจกต์','ลูกค้า','วันส่งมอบ','งบประมาณ','สถานะ']
};

function premiumStatusBadge(val) {
  var text = val || '—';
  var v = String(text).toLowerCase();
  var cls = '';
  if (['inactive','ยกเลิก','หมดอายุ','ปฏิเสธ'].indexOf(v) > -1) cls = ' danger';
  else if (['pending','รอดำเนินการ','รอ','รออนุมัติ','กำลังดำเนินการ','in progress','ดำเนินการ'].indexOf(v) > -1) cls = ' warn';
  return '<span class="premium-status' + cls + '">' + escapeHtml(text) + '</span>';
}

function premiumCell(sheet, col, val, idx) {
  var text = val == null || val === '' ? '—' : String(val);
  if (col === 'สถานะซิงก์') {
    var syncClass = text === 'ซิงก์แล้ว' ? 'badge-green' : text === 'ซิงก์ไม่สำเร็จ' ? 'badge-red' : 'badge-amber';
    return '<span class="badge ' + syncClass + '">' + escapeHtml(text) + '</span>';
  }
  if (col === 'สถานะ') return premiumStatusBadge(text);
  if (NUM_FIELDS.indexOf(col) > -1) return '<span class="premium-money">' + fmtCurrency(text) + '</span>';
  var cls = idx === 0 ? 'premium-strong' : '';
  if (/สัญญา|รายละเอียด|หมายเหตุ|สินค้า|โครงการ|โปรเจกต์/.test(col)) cls += (cls ? ' ' : '') + 'premium-truncate';
  return '<span class="' + cls + '">' + escapeHtml(text) + '</span>';
}

var originalPremiumRenderTable = renderTable;
renderTable = function(sheet, data, wrap) {
  if (!wrap) return;
  var card = wrap.closest ? wrap.closest('.table-card') : null;
  if (card) card.classList.add('premium-table-card');
  if (!data || !data.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">ไม่มีข้อมูล</div></div>';
    return;
  }
  syncSchemaFromRows(sheet, data);
  CACHED_DATA[sheet] = data;
  var sourceCols = Object.keys(data[0] || {}).filter(function(k) { return k !== 'ID'; });
  var cols = (PREMIUM_TABLE_COLUMNS[sheet] || sourceCols.slice(0, 5)).filter(function(c) {
    return sourceCols.indexOf(c) > -1;
  });
  if (!cols.length) cols = sourceCols.slice(0, 5);
  var html = '<table class="premium-data-table"><thead><tr>';
  cols.forEach(function(c) {
    html += '<th onclick="sortTable(\'' + sheet + '\',\'' + c + '\')">' + escapeHtml(c) + '</th>';
  });
  html += '<th style="text-align:center">การจัดการ</th></tr></thead><tbody>';
  data.forEach(function(row) {
    var id = row['ID'] || '';
    html += '<tr>';
    cols.forEach(function(c, idx) {
      html += '<td>' + premiumCell(sheet, c, row[c], idx) + '</td>';
    });
    html += '<td><div class="premium-row-actions">' +
      '<button class="premium-detail-btn" onclick="openDetailDrawer(\'' + sheet + '\',\'' + String(id).replace(/'/g, "\\'") + '\')">ดูข้อมูล</button>' +
      (userCanDelete(sheet) ? '<button class="premium-icon-btn danger" title="ลบ" onclick="confirmDelete(\'' + sheet + '\',\'' + String(id).replace(/'/g, "\\'") + '\')">×</button>' : '') +
      '</div></td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
};

var originalPremiumRenderPagination = renderPagination;
renderPagination = function(sheet, p) {
  var wrap = document.getElementById('page-' + sheet);
  if (!wrap || !p) return;
  var pageSize = p.pageSize || 10;
  var page = p.page || 1;
  var total = p.total || 0;
  var totalPages = Math.max(1, p.totalPages || Math.ceil(total / pageSize));
  var start = total ? ((page - 1) * pageSize + 1) : 0;
  var end = Math.min(page * pageSize, total);
  var search = PAGE_STATE[sheet] ? PAGE_STATE[sheet].search : '';
  var html = '<div class="premium-pagination"><span>แสดงผล ' + start + ' - ' + end + ' จาก ' + fmt(total) + ' รายการ</span><div class="premium-page-btns">';
  html += '<button class="premium-page-btn" onclick="loadPanel(\'' + sheet + '\',' + (page - 1) + ',\'' + search + '\')" ' + (page > 1 ? '' : 'disabled') + '>← ก่อน</button>';
  var s = Math.max(1, page - 2), e = Math.min(totalPages, page + 2);
  for (var i = s; i <= e; i++) {
    html += '<button class="premium-page-btn' + (i === page ? ' active' : '') + '" onclick="loadPanel(\'' + sheet + '\',' + i + ',\'' + search + '\')">' + i + '</button>';
  }
  html += '<button class="premium-page-btn" onclick="loadPanel(\'' + sheet + '\',' + (page + 1) + ',\'' + search + '\')" ' + (page < totalPages ? '' : 'disabled') + '>ถัดไป →</button>';
  html += '</div></div>';
  wrap.innerHTML = html;
};

function findDisplayRow(sheet, id) {
  var pools = [CACHED_DATA[sheet] || [], SMART_DATA_CACHE[sheet] || [], getLocalRows(sheet) || []];
  for (var i = 0; i < pools.length; i++) {
    var row = pools[i].find(function(r) { return String(r['ID']) === String(id); });
    if (row) return row;
  }
  return null;
}

function openDetailDrawer(sheet, id) {
  var row = findDisplayRow(sheet, id);
  if (!row) { toast('ไม่พบข้อมูล', 'err'); return; }
  if (userCanEdit(sheet)) {
    CURRENT_PANEL = sheet;
    EDIT_ID = id;
    document.getElementById('modal-title').textContent = 'แก้ไขข้อมูล — ' + sheet;
    buildForm(sheet, row);
    var editSaveBtn = document.getElementById('modal-save');
    if (editSaveBtn) {
      editSaveBtn.style.display = '';
      editSaveBtn.disabled = false;
      editSaveBtn.textContent = '💾 บันทึก';
      editSaveBtn.onclick = saveModal;
    }
    document.getElementById('modal-overlay').classList.add('open');
    return;
  }
  EDIT_ID = null;
  document.getElementById('modal-title').textContent = 'ดูข้อมูล — ' + sheet;
  var fields = Object.keys(row).filter(function(k) { return k !== 'ID'; });
  var html = fields.map(function(f) {
    var value = row[f] == null || row[f] === '' ? '—' : row[f];
    var longText = String(value).length > 80 || /รายละเอียด|หมายเหตุ|สัญญา|งานเพิ่มเติม/.test(f);
    return '<div class="form-group' + (longText ? ' full' : '') + '">' +
      '<label class="form-label">' + escapeHtml(f) + '</label>' +
      (longText
        ? '<textarea class="form-input textarea" readonly>' + escapeHtml(value) + '</textarea>'
        : '<input class="form-input" readonly value="' + escapeHtml(value) + '">') +
      '</div>';
  }).join('');
  document.getElementById('modal-form').innerHTML = html;
  var saveBtn = document.getElementById('modal-save');
  if (saveBtn) saveBtn.style.display = 'none';
  document.getElementById('modal-overlay').classList.add('open');
}

var finalPremiumOpenAddModal = openAddModal;
openAddModal = function() {
  var saveBtn = document.getElementById('modal-save');
  if (saveBtn) saveBtn.style.display = '';
  finalPremiumOpenAddModal();
};

var finalPremiumEditRow = editRow;
editRow = async function(sheet, id) {
  var saveBtn = document.getElementById('modal-save');
  if (saveBtn) saveBtn.style.display = '';
  await finalPremiumEditRow(sheet, id);
};

// ── Feature Pack: Kanban / Invoice / Webhooks / Custom Fields / Bulk ──
var WEBHOOKS_KEY = 'erp-webhooks';
var CUSTOM_FIELDS_KEY = 'erp-custom-fields';
var CUSTOM_FIELD_CONFIG_KEY = 'erp-custom-field-configs';
var CUSTOM_FIELD_AUDIT_KEY = 'erp-custom-field-audit';
var CUSTOM_FIELD_EDIT_INDEX = -1;

function fieldConfigMap() {
  return readJsonKey(CUSTOM_FIELD_CONFIG_KEY, {});
}

function getFieldConfig(sheet, field) {
  var map = fieldConfigMap();
  var cfg = map[sheet] && map[sheet][field] ? map[sheet][field] : {};
  return {
    type: cfg.type || inferFieldType(field),
    options: Array.isArray(cfg.options) && cfg.options.length ? cfg.options : defaultFieldOptions(field),
    placeholder: cfg.placeholder || defaultFieldPlaceholder(field),
    required: !!cfg.required,
    visiblePositions: Array.isArray(cfg.visiblePositions) ? cfg.visiblePositions : [],
    hidden: !!cfg.hidden,
    hiddenAt: cfg.hiddenAt || ''
  };
}

function setFieldConfig(sheet, field, cfg) {
  var map = fieldConfigMap();
  map[sheet] = map[sheet] || {};
  map[sheet][field] = {
    type: cfg.type || 'text',
    options: Array.isArray(cfg.options) ? cfg.options.filter(Boolean) : [],
    placeholder: cfg.placeholder || '',
    required: !!cfg.required,
    visiblePositions: Array.isArray(cfg.visiblePositions) ? cfg.visiblePositions.filter(Boolean) : [],
    hidden: !!cfg.hidden,
    hiddenAt: cfg.hiddenAt || ''
  };
  writeJsonKey(CUSTOM_FIELD_CONFIG_KEY, map);
}

function writeCustomFieldAudit(action, sheet, field, beforeValue, afterValue) {
  var items = readJsonKey(CUSTOM_FIELD_AUDIT_KEY, []);
  items.unshift({
    action: action,
    sheet: sheet,
    field: field || '',
    before: beforeValue || '',
    after: afterValue || '',
    who: CURRENT_USER ? (CURRENT_USER.name || CURRENT_USER.employeeId || CURRENT_USER.role) : 'ระบบ',
    at: new Date().toISOString()
  });
  writeJsonKey(CUSTOM_FIELD_AUDIT_KEY, items.slice(0, 80));
}

function normalizeCustomPosition(pos) {
  return (typeof normalizePositionName === 'function') ? normalizePositionName(pos || '') : String(pos || '').trim().toLowerCase();
}

function getCurrentUserPosition() {
  return CURRENT_USER ? (CURRENT_USER.position || CURRENT_USER.pos || CURRENT_USER.role || '') : '';
}

function customFieldVisibleForPosition(sheet, field, position, includeHidden) {
  var cfg = getFieldConfig(sheet, field);
  if (includeHidden) return true;
  if (cfg.hidden && !includeHidden) return false;
  if (!cfg.visiblePositions.length) return true;
  var pos = normalizeCustomPosition(position || getCurrentUserPosition());
  return cfg.visiblePositions.some(function(item) { return normalizeCustomPosition(item) === pos; });
}

function customFieldsForContext(sheet, position, includeHidden) {
  return (SCHEMAS[sheet] || []).filter(function(field) {
    return customFieldVisibleForPosition(sheet, field, position, includeHidden);
  });
}

function renameFieldConfig(sheet, oldName, newName) {
  var map = fieldConfigMap();
  if (map[sheet] && map[sheet][oldName]) {
    map[sheet][newName] = map[sheet][oldName];
    delete map[sheet][oldName];
    writeJsonKey(CUSTOM_FIELD_CONFIG_KEY, map);
  }
}

function deleteFieldConfig(sheet, field) {
  var map = fieldConfigMap();
  if (map[sheet] && map[sheet][field]) {
    delete map[sheet][field];
    writeJsonKey(CUSTOM_FIELD_CONFIG_KEY, map);
  }
}

function inferFieldType(field) {
  if (/วันที่|วันเริ่ม|วันสิ้นสุด|วันส่งมอบ|วันเริ่มสัญญา|วันสิ้นสุดสัญญา|วันเริ่มงาน|วันที่เพิ่ม/.test(field)) return 'date';
  if (NUM_FIELDS.indexOf(field) > -1) return 'number';
  if (field === 'สถานะ') return 'select';
  if (['หมายเหตุ','รายละเอียด','รายละเอียดของแต่ละงาน','สัญญางานสร้างบ้าน','งานเพิ่มเติม'].indexOf(field) > -1) return 'textarea';
  return 'text';
}

function defaultFieldOptions(field) {
  if (field === 'สถานะ') return ['ใช้งาน','รอดำเนินการ','กำลังดำเนินการ','เสร็จสิ้น','ยกเลิก','หมดอายุ','inactive'];
  return [];
}

function defaultFieldPlaceholder(field) {
  if (/วันที่|วันเริ่ม|วันสิ้นสุด|วันส่งมอบ|วันเริ่มสัญญา|วันสิ้นสุดสัญญา/.test(field)) return '';
  if (NUM_FIELDS.indexOf(field) > -1 || /ยอด|ราคา|จำนวน|มูลค่า|งบประมาณ|เงิน|ค่าจ้าง/.test(field)) return '0.00';
  if (/หมายเหตุ|รายละเอียด|สัญญา|ที่อยู่|ทำเล|งานเพิ่มเติม/.test(field)) return 'พิมพ์รายละเอียด...';
  return 'ระบุ' + field;
}

function parseOptionText(text) {
  return String(text || '').split(',').map(function(v) { return v.trim(); }).filter(Boolean);
}

function customFieldModuleLabel(sheet) {
  return { sales:'Sales', customers:'Customers', contracts:'Contracts', employees:'Employees', projects:'Projects' }[sheet] || sheet;
}

function customModuleKeys() {
  return ['sales','customers','contracts','employees','projects'];
}

function customModuleIcon(sheet) {
  return { sales:'↗', customers:'◎', contracts:'◻', employees:'◷', projects:'⬡' }[sheet] || '▣';
}

function customFieldTypeLabel(type) {
  return { text:'ข้อความสั้น', number:'ตัวเลข/เงิน', date:'วันที่', textarea:'ข้อความยาว', select:'Dropdown' }[type] || 'ข้อความสั้น';
}

function getCustomFieldPositions() {
  var positions = (typeof getAdminPositionOptions === 'function') ? getAdminPositionOptions() : ['ฝ่ายขาย','ฝ่ายบัญชี','ผู้จัดการ'];
  return positions.filter(Boolean);
}

function renderCustomFieldPositionOptions() {
  var positions = getCustomFieldPositions();
  var visibleSelect = document.getElementById('custom-field-visible-position');
  var previewSelect = document.getElementById('custom-field-preview-position');
  if (visibleSelect) {
    var currentVisible = visibleSelect.value || '';
    visibleSelect.innerHTML = '<option value="">ทุกตำแหน่ง</option>' + positions.map(function(pos) {
      return '<option value="' + escapeHtml(pos) + '"' + (pos === currentVisible ? ' selected' : '') + '>' + escapeHtml(pos) + '</option>';
    }).join('');
  }
  if (previewSelect) {
    var currentPreview = previewSelect.value || '';
    previewSelect.innerHTML = '<option value="">ทุกตำแหน่ง</option>' + positions.map(function(pos) {
      return '<option value="' + escapeHtml(pos) + '"' + (pos === currentPreview ? ' selected' : '') + '>' + escapeHtml(pos) + '</option>';
    }).join('');
  }
}

function renderCustomFieldAudit() {
  var wrap = document.getElementById('custom-field-audit-list');
  if (!wrap) return;
  var items = readJsonKey(CUSTOM_FIELD_AUDIT_KEY, []);
  if (!items.length) {
    wrap.innerHTML = '<div class="empty"><div class="empty-text">ยังไม่มีประวัติการแก้ไข Custom Fields</div></div>';
    return;
  }
  wrap.innerHTML = items.slice(0, 20).map(function(item) {
    var d = item.at ? new Date(item.at) : new Date();
    return '<div class="custom-field-audit-item">' +
      '<div class="custom-field-audit-title">' + escapeHtml(item.action) + ' · ' + escapeHtml(customFieldModuleLabel(item.sheet)) + ' · ' + escapeHtml(item.field || '-') + '</div>' +
      '<div class="custom-field-audit-meta">' + escapeHtml(item.who || 'ระบบ') + ' · ' + d.toLocaleString('th-TH') + '</div>' +
      ((item.before || item.after) ? '<div class="custom-field-audit-meta">' + escapeHtml(item.before || '—') + ' → ' + escapeHtml(item.after || '—') + '</div>' : '') +
    '</div>';
  }).join('');
}
var SELECTED_ROWS = {};

function ensureFeaturePermissions() {
  var moduleMeta = {
    kanban: { panel:'kanban', name:'📌 Kanban', sub:'บอร์ดติดตามสถานะงาน', schema:false },
    invoice: { panel:'invoice', name:'🧾 Invoice', sub:'สร้างใบแจ้งหนี้จากสัญญา', schema:false },
    webhooks: { panel:'webhooks', name:'🔔 Webhooks', sub:'ตั้งค่าการแจ้งเตือนภายนอก', schema:false },
    'custom-fields': { panel:'custom-fields', name:'🧩 Custom Fields', sub:'เพิ่มช่องข้อมูลเอง', schema:false }
  };
  if (Array.isArray(PERMISSION_MODULES)) {
    Object.keys(moduleMeta).forEach(function(panel) {
      if (!PERMISSION_MODULES.some(function(mod) { return mod.panel === panel; })) PERMISSION_MODULES.push(moduleMeta[panel]);
    });
  }
  var panels = ['kanban','invoice','webhooks','custom-fields'];
  ['admin','editor','viewer'].forEach(function(role) {
    DEFAULT_ROLE_PERMISSIONS[role] = DEFAULT_ROLE_PERMISSIONS[role] || {};
    panels.forEach(function(panel) {
      var adminOnly = panel === 'webhooks' || panel === 'custom-fields';
      DEFAULT_ROLE_PERMISSIONS[role][panel] = DEFAULT_ROLE_PERMISSIONS[role][panel] || {
        view: role === 'admin' || !adminOnly,
        create: role === 'admin',
        edit: role === 'admin',
        delete: role === 'admin'
      };
    });
  });
}
ensureFeaturePermissions();

function readJsonKey(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch(e) { return fallback; }
}

function writeJsonKey(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getRowsForFeature(sheet) {
  var localRows = getLocalRows(sheet);
  if (localRows && localRows.length) return localRows;
  return (SMART_DATA_CACHE && SMART_DATA_CACHE[sheet]) || CACHED_DATA[sheet] || [];
}

function featureTitle(row, sheet) {
  return row['ชื่องาน/โปรเจกต์'] || row['ชื่อลูกค้า'] || row['ลูกค้า'] || row['ชื่อ'] || row['สินค้า'] || row['ID'] || sheet;
}

function loadKanban() {
  var sheet = (document.getElementById('kanban-sheet') || {}).value || 'projects';
  var board = document.getElementById('kanban-board');
  if (!board) return;
  var rows = getRowsForFeature(sheet);
  var cols = [
    { id:'todo', label:'📋 รอดำเนินการ', match:['รอดำเนินการ','pending','ใหม่','รอ','draft'] },
    { id:'doing', label:'🔨 กำลังดำเนินการ', match:['กำลังดำเนินการ','in progress','ดำเนินการ','รออนุมัติ'] },
    { id:'done', label:'✅ เสร็จสิ้น', match:['เสร็จสิ้น','สำเร็จ','ใช้งาน','active','อนุมัติแล้ว'] }
  ];
  function rowCol(row) {
    var status = String(row['สถานะ'] || '').toLowerCase();
    return cols.find(function(col) { return col.match.some(function(m) { return status === String(m).toLowerCase(); }); }) || cols[0];
  }
  board.innerHTML = cols.map(function(col) {
    var cards = rows.filter(function(row) { return rowCol(row).id === col.id; });
    var cardsHtml = cards.map(function(row) {
      var money = row['มูลค่าสัญญา'] || row['งบประมาณ'] || row['ยอดรวม'] || '';
      return '<div class="kanban-card">' +
        '<div class="kanban-card-title">' + escapeHtml(featureTitle(row, sheet)) + '</div>' +
        '<div class="kanban-card-sub">' + escapeHtml(row['สถานะ'] || 'ไม่ระบุสถานะ') + (money ? ' · ' + fmtCurrency(money) : '') + '</div>' +
      '</div>';
    }).join('');
    return '<div class="kanban-col"><div class="kanban-col-hd"><span>' + col.label + '</span><span class="kanban-col-count">' + cards.length + '</span></div>' +
      '<div class="kanban-cards">' + (cardsHtml || '<div class="empty" style="padding:18px"><div class="empty-text">ว่าง</div></div>') + '</div></div>';
  }).join('');
}

function loadInvoiceContracts() {
  var select = document.getElementById('invoice-contract-select');
  if (!select) return;
  var rows = getRowsForFeature('contracts');
  if (!rows.length) { select.innerHTML = '<option value="">ยังไม่มีสัญญา</option>'; return; }
  select.innerHTML = rows.map(function(row, idx) {
    return '<option value="' + idx + '">' + escapeHtml((row['ชื่อลูกค้า'] || 'ไม่ระบุลูกค้า') + ' · ' + (row['สัญญางานสร้างบ้าน'] || row['ID'] || 'สัญญา')) + '</option>';
  }).join('');
}

function generateInvoice() {
  var rows = getRowsForFeature('contracts');
  var idx = Number((document.getElementById('invoice-contract-select') || {}).value || 0);
  var row = rows[idx];
  var wrap = document.getElementById('invoice-preview');
  if (!wrap) return;
  if (!row) {
    wrap.innerHTML = '<div class="empty"><div class="empty-icon">🧾</div><div class="empty-text">ยังไม่มีสัญญาสำหรับสร้างใบแจ้งหนี้</div></div>';
    return;
  }
  var value = Number(row['มูลค่าสัญญา'] || row['ข้อมูลมัดจำ/เซ็นสัญญา'] || 0) || 0;
  var vat = Math.round(value * 0.07);
  var total = value + vat;
  var invNo = 'INV-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-5);
  wrap.innerHTML = '<div class="invoice-wrap" id="printable-invoice">' +
    '<div class="invoice-hd"><div><div class="invoice-logo">ERP System</div><div class="feature-card-sub">ใบแจ้งหนี้จากระบบ ERP</div></div>' +
    '<div class="invoice-meta"><strong>ใบแจ้งหนี้ / Invoice</strong><br>เลขที่: ' + invNo + '<br>วันที่: ' + new Date().toLocaleDateString('th-TH') + '</div></div>' +
    '<div class="invoice-parties"><div class="invoice-party"><div class="invoice-party-lbl">ผู้ออกใบแจ้งหนี้</div><div class="invoice-party-name">ERP Admin</div></div>' +
    '<div class="invoice-party"><div class="invoice-party-lbl">ลูกค้า / Bill To</div><div class="invoice-party-name">' + escapeHtml(row['ชื่อลูกค้า'] || 'ไม่ระบุ') + '</div><div class="settings-row-sub">อ้างอิง: ' + escapeHtml(row['สัญญางานสร้างบ้าน'] || row['ID'] || '—') + '</div></div></div>' +
    '<table class="invoice-table"><thead><tr><th>รายการ</th><th class="num">จำนวนเงิน</th></tr></thead><tbody><tr><td>' + escapeHtml(row['สัญญางานสร้างบ้าน'] || 'ค่างานตามสัญญา') + '</td><td class="num">' + fmtCurrency(value) + '</td></tr></tbody></table>' +
    '<div class="invoice-totals"><div class="invoice-totals-row"><span>ยอดก่อนภาษี</span><span>' + fmtCurrency(value) + '</span></div><div class="invoice-totals-row"><span>VAT 7%</span><span>' + fmtCurrency(vat) + '</span></div><div class="invoice-totals-row grand"><span>รวมทั้งสิ้น</span><span>' + fmtCurrency(total) + '</span></div></div></div>';
}

function printInvoice() {
  var el = document.getElementById('printable-invoice');
  if (!el) { toast('กรุณาสร้างใบแจ้งหนี้ก่อน', 'err'); return; }
  window.print();
}

function renderWebhooks() {
  var list = document.getElementById('webhook-list');
  if (!list) return;
  var items = readJsonKey(WEBHOOKS_KEY, []);
  if (!items.length) { list.innerHTML = '<div class="empty"><div class="empty-text">ยังไม่มี Webhook</div></div>'; return; }
  list.innerHTML = items.map(function(item, idx) {
    return '<div class="settings-row"><div class="settings-row-main"><div class="settings-row-title">' + escapeHtml(item.name) + '</div><div class="settings-row-sub">' + escapeHtml(item.url) + '</div></div><button class="btn btn-danger btn-sm" onclick="deleteWebhook(' + idx + ')">ลบ</button></div>';
  }).join('');
}

function addWebhook() {
  var name = (document.getElementById('webhook-name') || {}).value || '';
  var url = (document.getElementById('webhook-url') || {}).value || '';
  if (!name.trim() || !url.trim()) { toast('กรุณากรอกชื่อและ URL', 'err'); return; }
  var items = readJsonKey(WEBHOOKS_KEY, []);
  items.push({ name:name.trim(), url:url.trim(), createdAt:new Date().toISOString() });
  writeJsonKey(WEBHOOKS_KEY, items);
  document.getElementById('webhook-name').value = '';
  document.getElementById('webhook-url').value = '';
  renderWebhooks();
  toast('เพิ่ม Webhook แล้ว', 'ok');
}

function deleteWebhook(idx) {
  var items = readJsonKey(WEBHOOKS_KEY, []);
  items.splice(idx, 1);
  writeJsonKey(WEBHOOKS_KEY, items);
  renderWebhooks();
}

function renderCustomModuleRail(activeSheet) {
  var wrap = document.getElementById('custom-module-list');
  if (!wrap) return;
  wrap.innerHTML = customModuleKeys().map(function(sheet) {
    var count = (SCHEMAS[sheet] || []).length;
    return '<button type="button" class="custom-module-btn' + (sheet === activeSheet ? ' active' : '') + '" onclick="setCustomFieldModule(&quot;' + sheet + '&quot;)">' +
      '<span>' + customModuleIcon(sheet) + ' ' + escapeHtml(customFieldModuleLabel(sheet)) + '</span>' +
      '<span class="table-count">' + count + '</span>' +
    '</button>';
  }).join('');
}

function setCustomFieldModule(sheet) {
  var select = document.getElementById('custom-field-sheet');
  if (select) select.value = sheet;
  changeCustomFieldModule();
}

function renderCustomFields() {
  var list = document.getElementById('custom-field-list');
  if (!list) return;
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var fields = (SCHEMAS[sheet] || []).slice();
  var moduleLabel = document.getElementById('custom-field-module-label');
  var activeTitle = document.getElementById('custom-field-active-title');
  var activeCount = document.getElementById('custom-field-active-count');
  var title = document.getElementById('custom-field-list-title');
  var count = document.getElementById('custom-field-count');
  if (moduleLabel) moduleLabel.value = customFieldModuleLabel(sheet);
  if (activeTitle) activeTitle.textContent = customFieldModuleLabel(sheet);
  if (activeCount) activeCount.textContent = fields.length + ' ช่องฟิลด์';
  if (title) title.textContent = 'รายการช่องปัจจุบัน: ' + customFieldModuleLabel(sheet);
  if (count) count.textContent = fields.length + ' ช่อง';
  renderCustomFieldPositionOptions();
  renderCustomModuleRail(sheet);
  renderCustomFieldAudit();
  if (!fields.length) {
    list.innerHTML = '<div class="empty"><div class="empty-text">ยังไม่มีช่องในโมดูลนี้</div></div>';
    renderCustomFieldPreview(sheet);
    return;
  }
  list.innerHTML = fields.map(function(field, idx) {
    var cfg = getFieldConfig(sheet, field);
    if (CUSTOM_FIELD_EDIT_INDEX === idx) {
      return '<div class="settings-row custom-field-row">' +
        '<div class="custom-field-inline-editor">' +
          '<div class="custom-field-move-placeholder" aria-hidden="true"><span>▲</span><span>▼</span></div>' +
          '<div class="form-group"><input class="form-input" aria-label="ชื่อหัวข้อ" id="custom-inline-name-' + idx + '" value="' + escapeHtml(field) + '" onkeydown="if(event.key===&quot;Enter&quot;){event.preventDefault();saveCustomFieldInline(' + idx + ')}"></div>' +
          '<div class="form-group"><select class="form-select" aria-label="รูปแบบช่อง" id="custom-inline-type-' + idx + '">' +
            ['text','number','date','textarea','select'].map(function(type) {
              return '<option value="' + type + '"' + (cfg.type === type ? ' selected' : '') + '>' + escapeHtml(customFieldTypeLabel(type)) + '</option>';
            }).join('') +
          '</select></div>' +
          '<div class="custom-field-row-actions"><button class="btn btn-primary btn-sm" onclick="saveCustomFieldInline(' + idx + ')">💾 บันทึก</button><button class="btn btn-ghost btn-sm" onclick="cancelCustomFieldInline()">❌ ยกเลิก</button></div>' +
        '</div>' +
      '</div>';
    }
    var badges = '<span class="table-count">' + escapeHtml(customFieldTypeLabel(cfg.type)) + '</span>' +
      (cfg.required ? '<span class="table-count" style="border-color:rgba(239,68,68,.28);color:#f87171">Required</span>' : '') +
      (cfg.visiblePositions.length ? '<span class="table-count">เห็น: ' + escapeHtml(cfg.visiblePositions.join(', ')) + '</span>' : '<span class="table-count">ทุกตำแหน่ง</span>') +
      (cfg.hidden ? '<span class="table-count" style="border-color:rgba(245,158,11,.35);color:#fbbf24">Hidden</span>' : '') +
      '<span class="custom-field-placeholder-chip" title="' + escapeHtml(cfg.placeholder || '—') + '">Placeholder: ' + escapeHtml(cfg.placeholder || '—') + '</span>';
    return '<div class="settings-row custom-field-row">' +
      '<div class="custom-field-row-head' + (cfg.hidden ? ' custom-field-hidden' : '') + '">' +
        '<span class="custom-field-index">' + String(idx + 1).padStart(2, '0') + '</span>' +
        '<div class="settings-row-main">' +
          '<div class="custom-field-title-wrap">' +
            '<div class="custom-field-row-name" title="' + escapeHtml(field) + '">' + escapeHtml(field) + '</div>' +
            '<div class="custom-field-row-meta">' + badges + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="custom-field-row-actions">' +
          '<button class="btn btn-ghost btn-sm" title="เลื่อนขึ้น" onclick="moveCustomField(' + idx + ',-1)" ' + (idx === 0 ? 'disabled' : '') + '>↑</button>' +
          '<button class="btn btn-ghost btn-sm" title="เลื่อนลง" onclick="moveCustomField(' + idx + ',1)" ' + (idx === fields.length - 1 ? 'disabled' : '') + '>↓</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="duplicateCustomField(' + idx + ')">Duplicate</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="toggleCustomFieldRequired(' + idx + ')">' + (cfg.required ? 'Optional' : 'Required') + '</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="configureCustomFieldVisibility(' + idx + ')">สิทธิ์</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="editCustomFieldInline(' + idx + ')">✏️ แก้ไข</button>' +
          (cfg.hidden ? '<button class="btn btn-ghost btn-sm" onclick="restoreCustomField(' + idx + ')">คืนค่า</button>' : '<button class="btn btn-danger btn-sm" onclick="deleteCustomField(' + idx + ')">🗑️ ลบ</button>') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  renderCustomFieldPreview(sheet);
}

function editCustomFieldInline(idx) {
  CUSTOM_FIELD_EDIT_INDEX = idx;
  renderCustomFields();
  var input = document.getElementById('custom-inline-name-' + idx);
  if (input) { input.focus(); input.select(); }
}

function cancelCustomFieldInline() {
  CUSTOM_FIELD_EDIT_INDEX = -1;
  renderCustomFields();
}

function saveCustomFieldInline(idx) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var fields = (SCHEMAS[sheet] || []).slice();
  var oldName = fields[idx];
  if (!oldName) return;
  var oldCfg = getFieldConfig(sheet, oldName);
  var name = ((document.getElementById('custom-inline-name-' + idx) || {}).value || '').trim();
  var type = ((document.getElementById('custom-inline-type-' + idx) || {}).value || 'text');
  if (!name) { toast('ชื่อช่องห้ามว่าง', 'err'); return; }
  if (fields.some(function(f, i) { return i !== idx && f === name; })) { toast('มีชื่อช่องนี้แล้ว', 'err'); return; }
  fields[idx] = name;
  SCHEMAS[sheet] = fields;
  saveSheetSchema(sheet, fields);
  if (oldName !== name) renameFieldConfig(sheet, oldName, name);
  var options = type === 'select'
    ? ((oldCfg.options || []).length ? oldCfg.options : defaultFieldOptions(name).length ? defaultFieldOptions(name) : ['ตัวเลือก 1'])
    : [];
  setFieldConfig(sheet, name, { type:type, options:options, placeholder:oldCfg.placeholder || defaultFieldPlaceholder(name) });
  rebuildCustomFieldMap();
  writeCustomFieldAudit('edit', sheet, name, oldName + ' / ' + oldCfg.type, name + ' / ' + type);
  CUSTOM_FIELD_EDIT_INDEX = -1;
  renderCustomFields();
  toast('บันทึกการแก้ไขแล้ว', 'ok');
}

function uniqueCustomFieldName(sheet, baseName) {
  var fields = SCHEMAS[sheet] || [];
  var base = String(baseName || 'ช่องใหม่').trim() || 'ช่องใหม่';
  var name = base + ' Copy';
  var i = 2;
  while (fields.indexOf(name) > -1) {
    name = base + ' Copy ' + i;
    i += 1;
  }
  return name;
}

function duplicateCustomField(idx) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var fields = (SCHEMAS[sheet] || []).slice();
  var field = fields[idx];
  if (!field) return;
  var next = uniqueCustomFieldName(sheet, field);
  var cfg = getFieldConfig(sheet, field);
  fields.splice(idx + 1, 0, next);
  SCHEMAS[sheet] = fields;
  saveSheetSchema(sheet, fields);
  setFieldConfig(sheet, next, cfg);
  rebuildCustomFieldMap();
  writeCustomFieldAudit('duplicate', sheet, next, field, next);
  renderCustomFields();
  toast('Duplicate ช่องแล้ว', 'ok');
}

function toggleCustomFieldRequired(idx) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var field = (SCHEMAS[sheet] || [])[idx];
  if (!field) return;
  var cfg = getFieldConfig(sheet, field);
  cfg.required = !cfg.required;
  setFieldConfig(sheet, field, cfg);
  writeCustomFieldAudit('required', sheet, field, cfg.required ? 'optional' : 'required', cfg.required ? 'required' : 'optional');
  renderCustomFields();
  toast(cfg.required ? 'ตั้งเป็นบังคับกรอกแล้ว' : 'ตั้งเป็นไม่บังคับแล้ว', 'ok');
}

function configureCustomFieldVisibility(idx) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var field = (SCHEMAS[sheet] || [])[idx];
  if (!field) return;
  var cfg = getFieldConfig(sheet, field);
  var positions = getCustomFieldPositions();
  var message = 'ใส่ตำแหน่งที่เห็นช่องนี้ คั่นด้วย comma\\nปล่อยว่าง = ทุกตำแหน่ง\\nตำแหน่งในระบบ: ' + positions.join(', ');
  var value = prompt(message, (cfg.visiblePositions || []).join(', '));
  if (value === null) return;
  cfg.visiblePositions = parseOptionText(value).filter(function(pos) {
    return !positions.length || positions.indexOf(pos) > -1 || getAdminPositionOptions(pos).indexOf(pos) > -1;
  });
  setFieldConfig(sheet, field, cfg);
  writeCustomFieldAudit('visibility', sheet, field, '—', cfg.visiblePositions.length ? cfg.visiblePositions.join(', ') : 'ทุกตำแหน่ง');
  renderCustomFields();
  toast('อัปเดตสิทธิ์ตามตำแหน่งแล้ว', 'ok');
}

function restoreCustomField(idx) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var field = (SCHEMAS[sheet] || [])[idx];
  if (!field) return;
  var cfg = getFieldConfig(sheet, field);
  cfg.hidden = false;
  cfg.hiddenAt = '';
  setFieldConfig(sheet, field, cfg);
  writeCustomFieldAudit('restore', sheet, field, 'hidden', 'visible');
  renderCustomFields();
  toast('คืนค่าช่องแล้ว', 'ok');
}

function exportCustomFieldConfig() {
  var payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    schemas: customModuleKeys().reduce(function(acc, sheet) {
      acc[sheet] = (SCHEMAS[sheet] || []).slice();
      return acc;
    }, {}),
    configs: fieldConfigMap()
  };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'erp-custom-fields-config.json';
  a.click();
  URL.revokeObjectURL(url);
  writeCustomFieldAudit('export', (document.getElementById('custom-field-sheet') || {}).value || 'sales', 'config', '—', 'downloaded');
  renderCustomFieldAudit();
  toast('Export Custom Field Config แล้ว', 'ok');
}

function importCustomFieldConfig(input) {
  var file = input && input.files && input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function() {
    try {
      var payload = JSON.parse(reader.result || '{}');
      if (!payload.schemas || !payload.configs) { toast('ไฟล์ Config ไม่ถูกต้อง', 'err'); return; }
      customModuleKeys().forEach(function(sheet) {
        if (Array.isArray(payload.schemas[sheet])) {
          SCHEMAS[sheet] = payload.schemas[sheet].filter(function(field) { return field && field !== 'ID'; });
          saveSheetSchema(sheet, SCHEMAS[sheet]);
        }
      });
      writeJsonKey(CUSTOM_FIELD_CONFIG_KEY, payload.configs || {});
      rebuildCustomFieldMap();
      writeCustomFieldAudit('import', (document.getElementById('custom-field-sheet') || {}).value || 'sales', 'config', 'file', file.name);
      renderCustomFields();
      toast('Import Custom Field Config แล้ว', 'ok');
    } catch(e) {
      toast('อ่านไฟล์ Config ไม่ได้', 'err');
    } finally {
      input.value = '';
    }
  };
  reader.readAsText(file, 'utf-8');
}

function fieldHasStoredData(sheet, field) {
  var rows = getRowsForFeature(sheet) || [];
  return rows.some(function(row) {
    return row && row[field] != null && String(row[field]).trim() !== '';
  });
}

function renderCustomFieldPreview(sheet) {
  var preview = document.getElementById('custom-field-preview');
  if (!preview) return;
  var previewPosition = (document.getElementById('custom-field-preview-position') || {}).value || '';
  var fields = customFieldsForContext(sheet, previewPosition, false);
  if (!fields.length) {
    preview.innerHTML = '<div class="empty"><div class="empty-text">ยังไม่มีช่องให้แสดงตัวอย่าง</div></div>';
    return;
  }
  var html = '<div class="modal" style="position:relative;display:block;max-width:none;box-shadow:none;border-radius:14px">' +
    '<div class="modal-head"><span class="modal-title">+ เพิ่มข้อมูล — ' + escapeHtml(sheet) + '</span><span style="color:var(--muted)">Preview</span></div>' +
    '<div class="modal-body"><div class="form-grid">';
  fields.forEach(function(field) {
    var cfg = getFieldConfig(sheet, field);
    var isWide = cfg.type === 'textarea' || ['ชื่อสัญญา','ชื่อโปรเจกต์','ชื่องาน/โปรเจกต์','ที่อยู่','ทำเลที่ดินของลูกค้า'].indexOf(field) > -1;
    html += '<div class="form-group' + (isWide ? ' full' : '') + '">' +
      '<label class="form-label">' + escapeHtml(field) + (cfg.required ? ' <span style="color:#f87171">*</span>' : '') + '</label>';
    if (cfg.type === 'select') {
      html += '<select class="form-select" disabled>' + (cfg.options || []).map(function(o) {
        return '<option>' + escapeHtml(o) + '</option>';
      }).join('') + '</select>';
    } else if (cfg.type === 'textarea') {
      html += '<textarea class="form-input textarea" disabled placeholder="' + escapeHtml(cfg.placeholder || field) + '"></textarea>';
    } else {
      html += '<input class="form-input" disabled type="' + (cfg.type === 'date' ? 'date' : (cfg.type === 'number' ? 'number' : 'text')) + '" placeholder="' + escapeHtml(cfg.placeholder || field) + '">';
    }
    html += '</div>';
  });
  html += '</div><div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;border-top:1px solid var(--border);padding-top:14px">' +
    '<button class="btn btn-ghost btn-sm" disabled>ยกเลิก</button><button class="btn btn-primary btn-sm" disabled>💾 บันทึก</button>' +
    '</div></div></div>';
  preview.innerHTML = html;
}

function addCustomField() {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var field = ((document.getElementById('custom-field-name') || {}).value || '').trim();
  var type = ((document.getElementById('custom-field-type') || {}).value || 'text');
  var placeholder = ((document.getElementById('custom-field-placeholder') || {}).value || '').trim();
  var required = !!((document.getElementById('custom-field-required') || {}).checked);
  var visiblePosition = ((document.getElementById('custom-field-visible-position') || {}).value || '').trim();
  var options = parseOptionText((document.getElementById('custom-field-options') || {}).value || '');
  if (!field) { toast('กรุณากรอกชื่อช่อง', 'err'); return; }
  if (type === 'select' && !options.length) options = defaultFieldOptions(field).length ? defaultFieldOptions(field) : ['ตัวเลือก 1'];
  if ((SCHEMAS[sheet] || []).indexOf(field) > -1) { toast('มีช่องนี้แล้ว', 'err'); return; }
  SCHEMAS[sheet] = (SCHEMAS[sheet] || []).concat([field]);
  saveSheetSchema(sheet, SCHEMAS[sheet]);
  setFieldConfig(sheet, field, { type:type, options:options, placeholder:placeholder, required:required, visiblePositions:visiblePosition ? [visiblePosition] : [] });
  rebuildCustomFieldMap();
  writeCustomFieldAudit('add', sheet, field, '—', field);
  CUSTOM_FIELD_EDIT_INDEX = -1;
  document.getElementById('custom-field-name').value = '';
  document.getElementById('custom-field-placeholder').value = '';
  document.getElementById('custom-field-options').value = '';
  document.getElementById('custom-field-required').checked = false;
  document.getElementById('custom-field-visible-position').value = '';
  renderCustomFields();
  toast('เพิ่ม Custom Field แล้ว', 'ok');
}

function changeCustomFieldModule() {
  CUSTOM_FIELD_EDIT_INDEX = -1;
  clearCustomFieldDraft();
  renderCustomFields();
}

function clearCustomFieldDraft() {
  var name = document.getElementById('custom-field-name');
  var type = document.getElementById('custom-field-type');
  var placeholder = document.getElementById('custom-field-placeholder');
  var options = document.getElementById('custom-field-options');
  var required = document.getElementById('custom-field-required');
  var visible = document.getElementById('custom-field-visible-position');
  if (name) name.value = '';
  if (type) type.value = 'text';
  if (placeholder) placeholder.value = '';
  if (options) options.value = '';
  if (required) required.checked = false;
  if (visible) visible.value = '';
  toggleCustomFieldOptions();
}

function resetCustomFieldsForModule() {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  if (!DEFAULT_SCHEMAS[sheet]) { toast('ไม่มีค่าเริ่มต้นของโมดูลนี้', 'err'); return; }
  var confirmId = document.getElementById('confirm-id');
  var confirmOk = document.getElementById('confirm-ok');
  if (confirmId && confirmOk) {
    confirmId.textContent = 'Reset Custom Fields · Module: ' + customFieldModuleLabel(sheet);
    confirmOk.onclick = function() { performCustomFieldReset(sheet); };
    document.getElementById('confirm-overlay').classList.add('open');
    return;
  }
  performCustomFieldReset(sheet);
}

function performCustomFieldReset(sheet) {
  var beforeFields = (SCHEMAS[sheet] || []).join(', ');
  SCHEMAS[sheet] = DEFAULT_SCHEMAS[sheet].slice();
  saveSheetSchema(sheet, SCHEMAS[sheet]);
  var map = fieldConfigMap();
  delete map[sheet];
  writeJsonKey(CUSTOM_FIELD_CONFIG_KEY, map);
  rebuildCustomFieldMap();
  closeConfirm();
  renderCustomFields();
  writeCustomFieldAudit('reset', sheet, customFieldModuleLabel(sheet), beforeFields, SCHEMAS[sheet].join(', '));
  toast('รีเซ็ตโมดูลแล้ว', 'ok');
}

function toggleCustomFieldOptions() {
  var type = ((document.getElementById('custom-field-type') || {}).value || 'text');
  var wrap = document.getElementById('custom-field-options-wrap');
  if (wrap) wrap.style.display = type === 'select' ? '' : 'none';
}

function updateCustomFieldType(idx, type) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var field = (SCHEMAS[sheet] || [])[idx];
  if (!field) return;
  var cfg = getFieldConfig(sheet, field);
  cfg.type = type || 'text';
  if (cfg.type === 'select' && !(cfg.options || []).length) cfg.options = defaultFieldOptions(field).length ? defaultFieldOptions(field) : ['ตัวเลือก 1'];
  setFieldConfig(sheet, field, cfg);
  renderCustomFields();
  toast('เปลี่ยนรูปแบบช่องแล้ว', 'ok');
}

function updateCustomFieldOptions(idx, text) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var field = (SCHEMAS[sheet] || [])[idx];
  if (!field) return;
  var cfg = getFieldConfig(sheet, field);
  cfg.type = 'select';
  cfg.options = parseOptionText(text);
  if (!cfg.options.length) { toast('กรุณาใส่ตัวเลือกอย่างน้อย 1 รายการ', 'err'); renderCustomFields(); return; }
  setFieldConfig(sheet, field, cfg);
  renderCustomFields();
  toast('อัปเดตตัวเลือกแล้ว', 'ok');
}

function renameCustomField(idx, value) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var fields = (SCHEMAS[sheet] || []).slice();
  var next = String(value || '').trim();
  if (!next) { toast('ชื่อช่องห้ามว่าง', 'err'); renderCustomFields(); return; }
  if (fields.some(function(f, i) { return i !== idx && f === next; })) { toast('มีชื่อช่องนี้แล้ว', 'err'); renderCustomFields(); return; }
  var old = fields[idx];
  fields[idx] = next;
  SCHEMAS[sheet] = fields;
  saveSheetSchema(sheet, fields);
  renameFieldConfig(sheet, old, next);
  rebuildCustomFieldMap();
  renderCustomFields();
  toast('เปลี่ยนหัวข้อ "' + old + '" เป็น "' + next + '" แล้ว', 'ok');
}

function moveCustomField(idx, dir) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var fields = (SCHEMAS[sheet] || []).slice();
  var target = idx + dir;
  if (target < 0 || target >= fields.length) return;
  var temp = fields[idx];
  fields[idx] = fields[target];
  fields[target] = temp;
  SCHEMAS[sheet] = fields;
  saveSheetSchema(sheet, fields);
  rebuildCustomFieldMap();
  CUSTOM_FIELD_EDIT_INDEX = -1;
  renderCustomFields();
  toast('เรียงลำดับช่องแล้ว', 'ok');
}

function deleteCustomField(idx) {
  var sheet = (document.getElementById('custom-field-sheet') || {}).value || 'sales';
  var fields = (SCHEMAS[sheet] || []).slice();
  var target = fields[idx];
  if (!target) return;
  var confirmId = document.getElementById('confirm-id');
  var confirmOk = document.getElementById('confirm-ok');
  if (confirmId && confirmOk) {
    confirmId.textContent = (fieldHasStoredData(sheet, target) ? 'มีข้อมูลแล้ว ระบบจะซ่อนช่องแทนการลบถาวร · ' : '') + 'Custom Field: ' + target + ' · Module: ' + customFieldModuleLabel(sheet);
    confirmOk.onclick = function() { performCustomFieldDelete(sheet, idx); };
    document.getElementById('confirm-overlay').classList.add('open');
    return;
  }
  performCustomFieldDelete(sheet, idx);
}

function performCustomFieldDelete(sheet, idx) {
  var fields = (SCHEMAS[sheet] || []).slice();
  var removed = fields.splice(idx, 1)[0];
  if (!removed) return;
  if (fieldHasStoredData(sheet, removed)) {
    var cfg = getFieldConfig(sheet, removed);
    cfg.hidden = true;
    cfg.hiddenAt = new Date().toISOString();
    setFieldConfig(sheet, removed, cfg);
    closeConfirm();
    CUSTOM_FIELD_EDIT_INDEX = -1;
    renderCustomFields();
    writeCustomFieldAudit('hide', sheet, removed, 'visible', 'hidden');
    toast('ช่องนี้มีข้อมูลแล้ว จึงซ่อนไว้แทนการลบถาวร', 'ok');
    return;
  }
  SCHEMAS[sheet] = fields;
  saveSheetSchema(sheet, fields);
  deleteFieldConfig(sheet, removed);
  rebuildCustomFieldMap();
  CUSTOM_FIELD_EDIT_INDEX = -1;
  closeConfirm();
  renderCustomFields();
  writeCustomFieldAudit('delete', sheet, removed, removed, 'deleted');
  toast('ลบช่อง "' + removed + '" แล้ว', 'ok');
}

Object.assign(window, {
  setCustomFieldModule: setCustomFieldModule,
  addCustomField: addCustomField,
  changeCustomFieldModule: changeCustomFieldModule,
  toggleCustomFieldOptions: toggleCustomFieldOptions,
  resetCustomFieldsForModule: resetCustomFieldsForModule,
  editCustomFieldInline: editCustomFieldInline,
  saveCustomFieldInline: saveCustomFieldInline,
  cancelCustomFieldInline: cancelCustomFieldInline,
  moveCustomField: moveCustomField,
  deleteCustomField: deleteCustomField,
  performCustomFieldDelete: performCustomFieldDelete,
  duplicateCustomField: duplicateCustomField,
  toggleCustomFieldRequired: toggleCustomFieldRequired,
  configureCustomFieldVisibility: configureCustomFieldVisibility,
  restoreCustomField: restoreCustomField,
  exportCustomFieldConfig: exportCustomFieldConfig,
  importCustomFieldConfig: importCustomFieldConfig,
  customFieldsForContext: customFieldsForContext,
  renderCustomFields: renderCustomFields
});

function rebuildCustomFieldMap() {
  var map = {};
  Object.keys(SCHEMAS).forEach(function(sheet) {
    map[sheet] = (SCHEMAS[sheet] || []).slice();
  });
  writeJsonKey(CUSTOM_FIELDS_KEY, map);
}

function applyCustomFieldsToSchemas() {
  var map = readJsonKey(CUSTOM_FIELDS_KEY, {});
  Object.keys(map).forEach(function(sheet) {
    SCHEMAS[sheet] = SCHEMAS[sheet] || [];
    (map[sheet] || []).forEach(function(field) {
      if (SCHEMAS[sheet].indexOf(field) === -1) SCHEMAS[sheet].push(field);
    });
  });
}

var featureSwitchPanel = switchPanel;
switchPanel = function(el) {
  featureSwitchPanel(el);
  var panel = el && el.getAttribute ? el.getAttribute('data-panel') : '';
  if (panel === 'kanban') loadKanban();
  if (panel === 'invoice') { loadInvoiceContracts(); generateInvoice(); }
  if (panel === 'webhooks') renderWebhooks();
  if (panel === 'custom-fields') renderCustomFields();
};

var featureLoadPanel = loadPanel;
loadPanel = async function(sheet, page, search) {
  page = page || 1;
  search = search || '';
  PAGE_STATE[sheet] = { page: page, search: search };
  if (!userCanViewPanel(sheet)) {
    toast('Role นี้ไม่มีสิทธิ์ดูข้อมูล', 'err');
    return;
  }
  if (!CONNECTED && SCHEMAS[sheet]) {
    var wrap = document.getElementById('table-' + sheet);
    if (!wrap) return;
    var pageSize = 10;
    var allRows = getLocalRows(sheet);
    var q = String(search || '').trim().toLowerCase();
    if (q) {
      allRows = allRows.filter(function(row) {
        return Object.keys(row).some(function(k) { return String(row[k] || '').toLowerCase().indexOf(q) > -1; });
      });
    }
    var total = allRows.length;
    var totalPages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(Math.max(1, page), totalPages);
    var start = (page - 1) * pageSize;
    var pageRows = allRows.slice(start, start + pageSize);
    CACHED_DATA[sheet] = pageRows;
    SMART_DATA_CACHE[sheet] = allRows;
    renderTable(sheet, pageRows, wrap);
    renderPagination(sheet, { page: page, pageSize: pageSize, total: total, totalPages: totalPages, hasPrev: page > 1, hasNext: page < totalPages });
    var countEl = document.getElementById('count-' + sheet);
    if (countEl) countEl.textContent = total + ' รายการ';
    var badge = document.getElementById('badge-' + sheet);
    if (badge) badge.textContent = fmt(total);
    injectBulkBar(sheet);
    return;
  }
  if (CONNECTED && SCHEMAS[sheet]) {
    var remoteWrap = document.getElementById('table-' + sheet);
    if (!remoteWrap) return;
    remoteWrap.innerHTML = '<div class="loading"><span class="spinner"></span>กำลังโหลด...</div>';
    try {
      var r = await apiGet({ action:'read', sheet:sheet, page:page, pageSize:10, search:search });
      if (!r || !r.ok) {
        remoteWrap.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">' + escapeHtml((r && r.msg) || 'โหลดข้อมูลไม่ได้') + '</div></div>';
        return;
      }
      var rows = r.data || [];
      if (Array.isArray(r.headers) && r.headers.length) saveSheetSchema(sheet, r.headers);
      else syncSchemaFromRows(sheet, rows);
      var p = r.pagination || { page:page, pageSize:10, total:rows.length, totalPages:Math.max(1, Math.ceil(rows.length / 10)), hasPrev:false, hasNext:false };
      if (!p.totalPages) p.totalPages = Math.max(1, Math.ceil((p.total || rows.length) / (p.pageSize || 10)));
      CACHED_DATA[sheet] = rows;
      SMART_DATA_CACHE[sheet] = rows;
      renderTable(sheet, rows, remoteWrap);
      renderPagination(sheet, p);
      var remoteCount = document.getElementById('count-' + sheet);
      if (remoteCount) remoteCount.textContent = (p.total || 0) + ' รายการ';
      var remoteBadge = document.getElementById('badge-' + sheet);
      if (remoteBadge) remoteBadge.textContent = fmt(p.total || 0);
      injectBulkBar(sheet);
      return;
    } catch(e) {
      var fallbackRows = getLocalRows(sheet);
      CACHED_DATA[sheet] = fallbackRows;
      SMART_DATA_CACHE[sheet] = fallbackRows;
      renderTable(sheet, fallbackRows, remoteWrap);
      renderPagination(sheet, { page:1, pageSize:10, total:fallbackRows.length, totalPages:Math.max(1, Math.ceil(fallbackRows.length / 10)), hasPrev:false, hasNext:false });
      var fallbackCount = document.getElementById('count-' + sheet);
      if (fallbackCount) fallbackCount.textContent = fallbackRows.length + ' รายการ';
      injectBulkBar(sheet);
      setStatus('ok', 'เชื่อมต่อแล้ว');
      return;
    }
  }
  await featureLoadPanel(sheet, page, search);
  injectBulkBar(sheet);
};

function injectBulkBar(sheet) {
  if (!SCHEMAS[sheet]) return;
  var card = document.querySelector('#panel-' + sheet + ' .table-card');
  if (!card || document.getElementById('bulk-bar-' + sheet)) return;
  var bar = document.createElement('div');
  bar.id = 'bulk-bar-' + sheet;
  bar.className = 'bulk-bar';
  bar.innerHTML = '<span class="bulk-count">เลือก 0 รายการ</span><button class="bulk-btn" onclick="bulkExportSelected(\'' + sheet + '\')">⬇ Export</button><button class="bulk-btn danger" onclick="bulkDeleteSelected(\'' + sheet + '\')">ลบ</button><button class="bulk-btn" onclick="clearBulkSelection(\'' + sheet + '\')">ยกเลิก</button>';
  card.insertBefore(bar, card.firstChild);
}

var featureRenderTable = renderTable;
renderTable = function(sheet, data, wrap) {
  featureRenderTable(sheet, data, wrap);
  addBulkCheckboxes(sheet, data || []);
};

function addBulkCheckboxes(sheet, data) {
  injectBulkBar(sheet);
  var table = document.querySelector('#table-' + sheet + ' table');
  if (!table || !SCHEMAS[sheet]) return;
  SELECTED_ROWS[sheet] = SELECTED_ROWS[sheet] || {};
  var headRow = table.querySelector('thead tr');
  if (headRow && !headRow.querySelector('.bulk-head-cell')) headRow.insertAdjacentHTML('afterbegin', '<th class="bulk-head-cell"><input class="bulk-check" type="checkbox" onchange="toggleAllBulk(\'' + sheet + '\',this.checked)"></th>');
  Array.from(table.querySelectorAll('tbody tr')).forEach(function(tr, idx) {
    if (tr.querySelector('.bulk-row-cell')) return;
    var id = (data[idx] || {})['ID'] || '';
    tr.insertAdjacentHTML('afterbegin', '<td class="bulk-row-cell"><input class="bulk-check bulk-row-check" type="checkbox" data-id="' + escapeHtml(id) + '" onchange="toggleBulkRow(\'' + sheet + '\',this)"></td>');
  });
  updateBulkBar(sheet);
}

function toggleBulkRow(sheet, input) {
  SELECTED_ROWS[sheet] = SELECTED_ROWS[sheet] || {};
  var id = input.getAttribute('data-id');
  if (input.checked) SELECTED_ROWS[sheet][id] = true;
  else delete SELECTED_ROWS[sheet][id];
  updateBulkBar(sheet);
}

function toggleAllBulk(sheet, checked) {
  SELECTED_ROWS[sheet] = {};
  document.querySelectorAll('#table-' + sheet + ' .bulk-row-check').forEach(function(input) {
    input.checked = checked;
    if (checked) SELECTED_ROWS[sheet][input.getAttribute('data-id')] = true;
  });
  updateBulkBar(sheet);
}

function selectedBulkIds(sheet) {
  return Object.keys(SELECTED_ROWS[sheet] || {}).filter(Boolean);
}

function updateBulkBar(sheet) {
  var bar = document.getElementById('bulk-bar-' + sheet);
  if (!bar) return;
  var count = selectedBulkIds(sheet).length;
  bar.classList.toggle('show', count > 0);
  var label = bar.querySelector('.bulk-count');
  if (label) label.textContent = 'เลือก ' + count + ' รายการ';
}

function clearBulkSelection(sheet) {
  SELECTED_ROWS[sheet] = {};
  document.querySelectorAll('#table-' + sheet + ' .bulk-check').forEach(function(input) { input.checked = false; });
  updateBulkBar(sheet);
}

function bulkExportSelected(sheet) {
  var ids = selectedBulkIds(sheet);
  if (!ids.length) { toast('ยังไม่ได้เลือกรายการ', 'err'); return; }
  var rows = getRowsForFeature(sheet).filter(function(row) { return ids.indexOf(String(row.ID)) > -1; });
  downloadCSV(sheet + '-selected', rows);
}

function bulkDeleteSelected(sheet) {
  var ids = selectedBulkIds(sheet);
  if (!ids.length) { toast('ยังไม่ได้เลือกรายการ', 'err'); return; }
  if (!userCanDelete(sheet)) { toast('Role นี้ลบข้อมูลไม่ได้', 'err'); return; }
  ids.forEach(function(id) { localDelete(sheet, id); });
  clearBulkSelection(sheet);
  loadPanel(sheet);
  toast('ลบรายการที่เลือกแล้ว', 'ok');
}

function downloadCSV(name, rows) {
  if (!rows || !rows.length) { toast('ไม่มีข้อมูลสำหรับ Export', 'err'); return; }
  var cols = Object.keys(rows[0]);
  var csv = cols.join(',') + '\n' + rows.map(function(row) {
    return cols.map(function(c) { return '"' + String(row[c] == null ? '' : row[c]).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  var blob = new Blob(['\ufeff' + csv], { type:'text/csv;charset=utf-8;' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.csv';
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}

applyCustomFieldsToSchemas();
document.addEventListener('DOMContentLoaded', function() {
  applyCustomFieldsToSchemas();
  renderWebhooks();
  renderCustomFields();
  loadInvoiceContracts();
});

refreshSmartDataIndex = async function(force) {
  var sheets = ['sales','customers','contracts','employees','projects'];
  if (!force && Object.keys(SMART_DATA_CACHE).length) return SMART_DATA_CACHE;
  await Promise.all(sheets.map(async function(sheet) {
    var remoteRows = [];
    try {
      if (CONNECTED) {
        var r = await apiGet({ action:'read', sheet:sheet, pageSize:200 });
        remoteRows = (r && r.ok && r.data) ? r.data : [];
      }
    } catch(e) {}
    var localRows = getLocalRows(sheet);
    SMART_DATA_CACHE[sheet] = remoteRows.concat(localRows);
  }));
  return SMART_DATA_CACHE;
};

initOfflineDashboard = function() {
  var statMap = { sales:'stat-sales', customers:'stat-customers', contracts:'stat-contracts', employees:'stat-employees' };
  Object.keys(statMap).forEach(function(sheet) {
    var el = document.getElementById(statMap[sheet]);
    if (el) el.textContent = getLocalRows(sheet).length;
  });
  var usersEl = document.getElementById('stat-users');
  if (usersEl) usersEl.textContent = getDbUsers().length;
  renderDashboardAlerts();
};

collectBackupData = function() {
  var keys = [ADMIN_USERS_KEY, AUDIT_KEY, ADMIN_PASS_KEY, 'erp-theme', 'erp-users-db', LOCAL_DB_KEY, PERMISSION_KEY, DAILY_REPORT_KEY, DAILY_FIELD_CONFIG_KEY, WEBHOOKS_KEY, CUSTOM_FIELDS_KEY, CUSTOM_FIELD_CONFIG_KEY, CUSTOM_FIELD_AUDIT_KEY, SHEET_SCHEMA_KEY, CALENDAR_APPOINTMENT_KEY];
  var data = { version:'erp-final-v6.1', exportedAt:new Date().toISOString(), keys:{} };
  keys.forEach(function(key) { data.keys[key] = localStorage.getItem(key); });
  return data;
};

renderBackupSummary = function() {
  var wrap = document.getElementById('backup-summary');
  if (!wrap) return;
  var data = collectBackupData();
  var rows = Object.keys(data.keys).map(function(key) {
    var val = data.keys[key];
    return '<div style="display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:8px 0"><span style="font-family:var(--mono);color:var(--text);overflow-wrap:anywhere">' + escapeHtml(key) + '</span><span>' + (val ? (String(val).length + ' chars') : 'empty') + '</span></div>';
  }).join('');
  wrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px"><div style="color:var(--text);font-weight:700">ข้อมูลที่จะถูกสำรอง</div><div class="backup-actions"><button class="btn btn-primary btn-sm" onclick="downloadBackup()">⬇ Download</button><button class="btn btn-ghost btn-sm" onclick="document.getElementById(&quot;backup-file-input&quot;).click()">↥ Restore</button></div></div>' + rows;
};

document.addEventListener('DOMContentLoaded', function() {
  syncRoleAccess();
});

// Final navigation stabilizer: several feature layers extend switchPanel above.
// This version keeps the actual panel change in one predictable place.
var baseUserCanViewPanel = userCanViewPanel;
userCanViewPanel = function(panel) {
  if (CURRENT_USER && CURRENT_USER.role === 'admin') return true;
  return baseUserCanViewPanel(panel);
};

switchPanel = function(el) {
  var panel = el && el.getAttribute ? el.getAttribute('data-panel') : '';
  if (!panel) return;
  if (panel === 'calendar') {
    openDashboardCalendar(el);
    return;
  }
  if (!userCanViewPanel(panel)) {
    toast('Role นี้ไม่มีสิทธิ์เปิดเมนูนี้', 'err');
    return;
  }

  document.querySelectorAll('.nav-item').forEach(function(nav) {
    nav.classList.remove('active');
  });
  el.classList.add('active');

  CURRENT_PANEL = panel;
  var title = document.getElementById('page-title');
  if (title) title.textContent = el.textContent.trim().replace(/[0-9—\s]+$/, '').trim();

  document.querySelectorAll('.panel').forEach(function(p) {
    p.classList.remove('active');
  });
  var target = document.getElementById('panel-' + panel);
  if (target) target.classList.add('active');

  var addBtn = document.getElementById('btn-add');
  if (addBtn) addBtn.style.display = (SCHEMAS[panel] && userCanCreate(panel)) ? 'inline-flex' : 'none';

  if (panel === 'admin') openAdminPanelForCurrentUser();
  else if (panel === 'dashboard') {
    loadStats();
    setTimeout(function() { renderWorkCalendar(false); }, 80);
  }
  else if (panel === 'activity') loadActivity(1);
  else if (panel === 'audit') renderAuditTrail();
  else if (panel === 'ai') renderAIInsights();
  else if (panel === 'backup') renderBackupSummary();
  else if (panel === 'reports') loadReports();
  else if (panel === 'kanban') loadKanban();
  else if (panel === 'invoice') { loadInvoiceContracts(); generateInvoice(); }
  else if (panel === 'webhooks') renderWebhooks();
  else if (panel === 'custom-fields') renderCustomFields();
  else if (panel === 'daily-report') renderDailyReportPanel();
  else if (SCHEMAS[panel]) loadPanel(panel, 1, '');

  updateSidebarDropdownState();
  if (window.innerWidth <= 768) closeMobileMenu();
};

switchPanelByName = function(name) {
  var el = document.querySelector('.nav-item[data-panel="' + name + '"]');
  if (el) switchPanel(el);
};

document.addEventListener('click', function(e) {
  var nav = e.target.closest && e.target.closest('.nav-item[data-panel]');
  if (!nav) return;
  e.preventDefault();
  e.stopPropagation();
  switchPanel(nav);
}, true);

// Close import on overlay click
function bindImportOverlayClose() {
  var overlay = document.getElementById('import-overlay');
  if (!overlay || overlay.dataset.bound === '1') return;
  overlay.dataset.bound = '1';
  overlay.addEventListener('click', function(e){ if(e.target===this) closeImport(); });
}
bindImportOverlayClose();
document.addEventListener('DOMContentLoaded', bindImportOverlayClose);

/* ---- Consolidated legacy extension ---- */

(function dashboardLocalSyncPatch() {
  var DASHBOARD_SHEETS = ['sales','customers','contracts','employees','projects','activity','documents'];
  var PRIMARY_DASHBOARD_SHEETS = ['sales','customers','contracts','employees','projects'];

  function readDbSafe() {
    try { return JSON.parse(localStorage.getItem('erp-local-db') || '{}'); }
    catch(e) { return {}; }
  }

  function writeDbSafe(db) {
    try { localStorage.setItem('erp-local-db', JSON.stringify(db || {})); }
    catch(e) {}
  }

  function dashEscape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];
    });
  }

  function dashCurrency(value) {
    var n = Number(String(value).replace(/,/g, ''));
    return isNaN(n) ? dashEscape(value) : '฿' + n.toLocaleString('th-TH');
  }

  function dashMoneyShort(value) {
    var n = Number(value || 0);
    return '฿' + n.toLocaleString('th-TH', { maximumFractionDigits: 0 });
  }

  function parseDashMoney(value) {
    if (value === null || value === undefined) return 0;
    var cleaned = String(value).replace(/[^\d.-]/g, '');
    var n = Number(cleaned);
    return isNaN(n) ? 0 : n;
  }

  function getDashDate(row, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = row && row[keys[i]];
      if (!value) continue;
      var d = new Date(value);
      if (!isNaN(d)) return d;
      var parts = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (parts) {
        d = new Date(Number(parts[3]), Number(parts[2]) - 1, Number(parts[1]));
        if (!isNaN(d)) return d;
      }
    }
    return null;
  }

  function isThisMonthDash(row, keys) {
    var d = getDashDate(row, keys);
    if (!d) return true;
    var now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }

  function isThisYearDash(row, keys) {
    var d = getDashDate(row, keys);
    if (!d) return true;
    return d.getFullYear() === new Date().getFullYear();
  }

  function getFirstMoney(row, keys) {
    for (var i = 0; i < keys.length; i++) {
      var amount = parseDashMoney(row && row[keys[i]]);
      if (amount) return amount;
    }
    return 0;
  }

  function dashStatus(value) {
    var label = value || '—';
    return '<span class="premium-status">' + dashEscape(label) + '</span>';
  }

  function rowsForDashboard(sheet) {
    var db = readDbSafe();
    var localRows = Array.isArray(db[sheet]) ? db[sheet] : [];
    var smartRows = (window.SMART_DATA_CACHE && Array.isArray(window.SMART_DATA_CACHE[sheet])) ? window.SMART_DATA_CACHE[sheet] : [];
    var cachedRows = (window.CACHED_DATA && Array.isArray(window.CACHED_DATA[sheet])) ? window.CACHED_DATA[sheet] : [];
    var byId = {};
    return smartRows.concat(cachedRows, localRows).filter(function(row) {
      if (!row) return false;
      var key = String(row.ID || JSON.stringify(row));
      if (byId[key]) return false;
      byId[key] = true;
      return true;
    });
  }

  function readArrayKey(key) {
    try {
      var value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch(e) {
      return [];
    }
  }

  function countLocalActivity() {
    var seen = {};
    var total = 0;
    ['erp-audit-log','erp-custom-field-audit','erp-daily-report-data','erp-daily-reports'].forEach(function(key) {
      readArrayKey(key).forEach(function(item, index) {
        var id = key + ':' + (item.id || item.ID || item.time || item.createdAt || item.date || index);
        if (!seen[id]) {
          seen[id] = true;
          total++;
        }
      });
    });
    rowsForDashboard('activity').forEach(function(row, index) {
      var id = 'activity:' + (row.ID || row.id || row.time || index);
      if (!seen[id]) {
        seen[id] = true;
        total++;
      }
    });
    return total;
  }

  function countDocumentRows() {
    var directDocs = rowsForDashboard('documents');
    if (directDocs.length) return directDocs.length;
    var count = 0;
    ['contracts','projects','customers','sales'].forEach(function(sheet) {
      rowsForDashboard(sheet).forEach(function(row) {
        var hasDocumentSignal = false;
        Object.keys(row || {}).forEach(function(key) {
          var value = row[key];
          if (/เอกสาร|สัญญา|ใบเสนอราคา|ไฟล์|แนบ|document|file|contract|quote/i.test(key)) {
            if (value !== null && value !== undefined && String(value).trim() !== '') hasDocumentSignal = true;
          }
        });
        if (hasDocumentSignal) count++;
      });
    });
    return count;
  }

  function sumAdditionalWorkThisMonth() {
    return rowsForDashboard('projects').reduce(function(total, row) {
      if (!isThisMonthDash(row, ['วันเริ่ม','วันส่งมอบ','วันที่','createdAt','_updatedAt'])) return total;
      return total + getFirstMoney(row, ['มูลค่างานเพิ่มเติม','งานเพิ่มเติม','งบประมาณ','ยอดรวม','มูลค่า','ราคา']);
    }, 0);
  }

  function sumContractsThisMonth() {
    return rowsForDashboard('contracts').reduce(function(total, row) {
      if (!isThisMonthDash(row, ['วันเริ่มสัญญา','วันสิ้นสุดสัญญา','วันที่','createdAt','_updatedAt'])) return total;
      return total + getFirstMoney(row, ['มูลค่าสัญญา','ข้อมูลมัดจำ/เซ็นสัญญา','ยอดรวม','มูลค่า','ราคา']);
    }, 0);
  }

  function sumAnnualValue() {
    var contractTotal = rowsForDashboard('contracts').reduce(function(total, row) {
      if (!isThisYearDash(row, ['วันเริ่มสัญญา','วันสิ้นสุดสัญญา','วันที่','createdAt','_updatedAt'])) return total;
      return total + getFirstMoney(row, ['มูลค่าสัญญา','ข้อมูลมัดจำ/เซ็นสัญญา','ยอดรวม','มูลค่า','ราคา']);
    }, 0);
    var extraTotal = rowsForDashboard('projects').reduce(function(total, row) {
      if (!isThisYearDash(row, ['วันเริ่ม','วันส่งมอบ','วันที่','createdAt','_updatedAt'])) return total;
      return total + getFirstMoney(row, ['มูลค่างานเพิ่มเติม','งานเพิ่มเติม','งบประมาณ','ยอดรวม','มูลค่า','ราคา']);
    }, 0);
    return contractTotal + extraTotal;
  }

  function setDashText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function fmtDash(n) {
    return Number(n || 0).toLocaleString('th-TH');
  }

  function renderDashboardLatestSalesLocal(rows) {
    var wrap = document.getElementById('latest-sales-wrap');
    if (!wrap) return;
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty"><div class="empty-text">ยังไม่มี Sales ล่าสุด</div></div>';
      return;
    }
    var cols = ['วันที่','ลูกค้า','สินค้า','ยอดรวม','สถานะ'].filter(function(col) {
      return rows.some(function(row) { return row[col] != null && row[col] !== ''; });
    });
    if (!cols.length) cols = Object.keys(rows[0]).filter(function(k) { return k !== 'ID'; }).slice(0, 5);
    var html = '<div class="table-wrap"><table><thead><tr>' +
      cols.map(function(col) { return '<th>' + dashEscape(col) + '</th>'; }).join('') +
      '</tr></thead><tbody>';
    rows.slice(0, 5).forEach(function(row) {
      html += '<tr>' + cols.map(function(col) {
        var value = row[col] == null || row[col] === '' ? '—' : String(row[col]);
        if (col === 'ยอดรวม' || col === 'ราคา' || col === 'มูลค่าสัญญา' || col === 'งบประมาณ') return '<td>' + dashCurrency(value) + '</td>';
        if (col === 'สถานะ') return '<td>' + dashStatus(value) + '</td>';
        return '<td>' + dashEscape(value) + '</td>';
      }).join('') + '</tr>';
    });
    wrap.innerHTML = html + '</tbody></table></div>';
  }

  function getCurrentPanelName() {
    try {
      if (typeof CURRENT_PANEL !== 'undefined') return CURRENT_PANEL;
    } catch(e) {}
    return window.CURRENT_PANEL || '';
  }

  function getCurrentEditId() {
    try {
      if (typeof EDIT_ID !== 'undefined') return EDIT_ID;
    } catch(e) {}
    return window.EDIT_ID || null;
  }

  function getSchemaForSheet(sheet) {
    try {
      if (typeof SCHEMAS !== 'undefined' && SCHEMAS[sheet]) return SCHEMAS[sheet];
    } catch(e) {}
    return (window.SCHEMAS && window.SCHEMAS[sheet]) || [];
  }

  function collectOpenModalData(sheet) {
    var data = {};
    getSchemaForSheet(sheet).forEach(function(field) {
      var el = document.getElementById('field-' + field);
      if (el) data[field] = el.value;
    });
    if (!Object.keys(data).length) {
      var form = document.getElementById('modal-form');
      if (form) {
        Array.prototype.forEach.call(form.querySelectorAll('input[id^="field-"], textarea[id^="field-"], select[id^="field-"]'), function(el) {
          data[el.id.replace(/^field-/, '')] = el.value;
        });
      }
    }
    return data;
  }

  function rowSignature(row) {
    var copy = {};
    Object.keys(row || {}).sort().forEach(function(key) {
      if (key !== 'ID' && key !== '_synced' && key !== '_updatedAt') copy[key] = row[key] == null ? '' : String(row[key]);
    });
    return JSON.stringify(copy);
  }

  function rememberDashboardLocalSave(sheet, editId, data) {
    if (PRIMARY_DASHBOARD_SHEETS.indexOf(sheet) === -1 || !data || !Object.keys(data).length) return;
    var db = readDbSafe();
    if (!Array.isArray(db[sheet])) db[sheet] = [];
    var rows = db[sheet];
    var now = new Date().toISOString();
    var next = Object.assign({}, data, {
      ID: editId || data.ID || ('LOCAL-' + sheet + '-' + Date.now()),
      _updatedAt: now
    });
    var idx = editId ? rows.findIndex(function(row) { return String(row.ID) === String(editId); }) : -1;
    if (idx < 0) {
      var sig = rowSignature(next);
      idx = rows.findIndex(function(row) { return rowSignature(row) === sig; });
    }
    if (idx >= 0) rows[idx] = Object.assign({}, rows[idx], next);
    else rows.unshift(next);
    writeDbSafe(db);
  }

  window.syncDashboardFromLocalData = function() {
    var counts = {};
    PRIMARY_DASHBOARD_SHEETS.forEach(function(sheet) {
      var rows = rowsForDashboard(sheet);
      counts[sheet] = rows.length;
      if (window.SMART_DATA_CACHE) window.SMART_DATA_CACHE[sheet] = rows;
      var badge = document.getElementById('badge-' + sheet);
      if (badge) badge.textContent = fmtDash(rows.length);
      var countEl = document.getElementById('count-' + sheet);
      if (countEl && rows.length) countEl.textContent = rows.length + ' รายการ';
    });
    setDashText('s-sales', fmtDash(counts.sales));
    setDashText('s-customers', fmtDash(counts.customers));
    setDashText('s-contracts', fmtDash(counts.contracts));
    setDashText('s-employees', fmtDash(counts.employees));
    setDashText('s-projects', dashMoneyShort(sumAdditionalWorkThisMonth()));
    setDashText('s-activity', dashMoneyShort(sumContractsThisMonth()));
    setDashText('s-docs', dashMoneyShort(sumAnnualValue()));
    setDashText('kpi-employees-change', counts.employees + ' คน');
    renderDashboardLatestSalesLocal(rowsForDashboard('sales'));
  };

  var previousLoadStats = window.loadStats;
  window.loadStats = async function() {
    if (typeof previousLoadStats === 'function') {
      try { await previousLoadStats(); } catch(e) {}
    }
    window.syncDashboardFromLocalData();
  };

  var previousSaveModal = window.saveModal;
  window.saveModal = async function() {
    var sheet = getCurrentPanelName();
    var editId = getCurrentEditId();
    var dataBeforeSave = collectOpenModalData(sheet);
    if (typeof previousSaveModal === 'function') await previousSaveModal();
    rememberDashboardLocalSave(sheet, editId, dataBeforeSave);
    setTimeout(window.syncDashboardFromLocalData, 250);
  };

  var previousSwitchPanelByName = window.switchPanelByName;
  if (typeof previousSwitchPanelByName === 'function') {
    window.switchPanelByName = function(panel) {
      var result = previousSwitchPanelByName.apply(this, arguments);
      if (panel === 'dashboard') setTimeout(window.syncDashboardFromLocalData, 150);
      return result;
    };
  }

  document.addEventListener('DOMContentLoaded', function() {
    placeDashboardCalendarBelowGrowth();
    setTimeout(window.syncDashboardFromLocalData, 500);
    setTimeout(function() {
      if (typeof renderWorkCalendar === 'function') renderWorkCalendar(false);
    }, 700);
  });
  setTimeout(window.syncDashboardFromLocalData, 1000);
})();
/* =========================================================
   ERP stability layer: filters, validation, sync, data states
   ========================================================= */
(function () {
  "use strict";

  var SYNC_KEY = "erp-sync-queue-v1";
  var FILTERS = {};
  var loadTokens = {};
  var baseApiPost = apiPost;
  var baseLoadPanel = loadPanel;
  var baseRenderTable = renderTable;
  var baseValidateFormData = validateFormData;

  if (typeof PREMIUM_TABLE_COLUMNS !== "undefined") {
    Object.keys(PREMIUM_TABLE_COLUMNS).forEach(function (sheet) {
      if (PREMIUM_TABLE_COLUMNS[sheet].indexOf("สถานะซิงก์") < 0) PREMIUM_TABLE_COLUMNS[sheet].push("สถานะซิงก์");
    });
  }

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch (error) { return fallback; }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function queueItems() {
    return readJson(SYNC_KEY, []);
  }

  function saveQueue(items) {
    writeJson(SYNC_KEY, items.slice(-100));
    renderSyncQueue();
  }

  function enqueueSync(payload, error) {
    var items = queueItems();
    items.push({
      id: "SYNC-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      sheet: payload.sheet || "unknown",
      action: payload.action || "write",
      payload: payload,
      status: "pending",
      attempts: 0,
      error: error ? String(error.message || error) : "",
      createdAt: new Date().toISOString()
    });
    saveQueue(items);
  }

  function renderSyncQueue() {
    var items = queueItems();
    var pending = items.filter(function (item) { return item.status === "pending" || item.status === "syncing"; });
    var failed = items.filter(function (item) { return item.status === "failed"; });
    var pendingEl = document.getElementById("sync-pending-count");
    var failedEl = document.getElementById("sync-failed-count");
    var list = document.getElementById("sync-queue-list");
    if (pendingEl) pendingEl.textContent = pending.length;
    if (failedEl) failedEl.textContent = failed.length;
    if (!list) return;
    var visible = items.filter(function (item) { return item.status !== "synced"; }).slice(-8).reverse();
    if (!visible.length) {
      list.innerHTML = '<div class="sync-empty">ไม่มีข้อมูลรอซิงก์</div>';
      return;
    }
    list.innerHTML = visible.map(function (item) {
      var status = item.status === "failed" ? "ซิงก์ไม่สำเร็จ" : item.status === "syncing" ? "กำลังซิงก์" : "รอซิงก์";
      return '<div class="sync-item"><strong>' + escapeHtml(item.sheet + " · " + item.action) +
        '</strong><span class="' + (item.status === "failed" ? "failed" : "pending") + '">' + status +
        '</span><small>' + escapeHtml(item.error || new Date(item.createdAt).toLocaleString("th-TH")) + '</small></div>';
    }).join("");
  }

  apiPost = function (data) {
    return baseApiPost(data).then(function (result) {
      if (!result || result.ok === false) throw new Error(result && result.msg ? result.msg : "API rejected the request");
      return result;
    }).catch(function (error) {
      enqueueSync(data, error);
      throw error;
    });
  };

  window.retrySyncQueue = async function () {
    if (!navigator.onLine || !CONNECTED) {
      showNetworkState("offline", "ยังออฟไลน์หรือไม่ได้เชื่อมต่อ API");
      return;
    }
    var items = queueItems();
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].status === "synced") continue;
      items[i].status = "syncing";
      saveQueue(items);
      try {
        var result = await baseApiPost(items[i].payload);
        if (!result || result.ok === false) throw new Error(result && result.msg ? result.msg : "Sync failed");
        items[i].status = "synced";
        items[i].error = "";
      } catch (error) {
        items[i].status = "failed";
        items[i].attempts += 1;
        items[i].error = String(error.message || error);
      }
      saveQueue(items);
    }
    items = items.filter(function (item) { return item.status !== "synced"; });
    saveQueue(items);
    if (!items.length) toast("ซิงก์ข้อมูลสำเร็จทั้งหมด", "ok");
  };

  function showNetworkState(type, message) {
    var el = document.getElementById("app-network-state");
    if (!el) {
      el = document.createElement("div");
      el.id = "app-network-state";
      el.className = "app-network-state";
      document.body.appendChild(el);
    }
    el.className = "app-network-state show " + (type || "");
    el.textContent = message;
    clearTimeout(showNetworkState.timer);
    if (type !== "offline") {
      showNetworkState.timer = setTimeout(function () { el.classList.remove("show"); }, 5000);
    }
  }

  function stateMarkup(type, message, retrySheet) {
    var icon = type === "loading" ? '<span class="spinner"></span>' : type === "offline" ? "◌" : "!";
    var retry = retrySheet ? '<button class="btn btn-ghost btn-sm" type="button" onclick="loadPanel(&quot;' +
      retrySheet + '&quot;,1,&quot;&quot;)">ลองใหม่</button>' : "";
    return '<div class="data-state ' + type + '"><span>' + icon + '</span><span>' + escapeHtml(message) + '</span>' + retry + '</div>';
  }

  loadPanel = async function (sheet, page, search) {
    var wrap = document.getElementById("table-" + sheet);
    var token = Date.now() + Math.random();
    loadTokens[sheet] = token;
    if (wrap) {
      wrap.innerHTML = stateMarkup(
        navigator.onLine ? "loading" : "offline",
        navigator.onLine ? "กำลังโหลดข้อมูล..." : "ใช้งานแบบ Offline จะแสดงข้อมูลในเครื่อง",
        ""
      );
    }
    if (!navigator.onLine && typeof getLocalRows === "function") {
      var offlineRows = getLocalRows(sheet);
      if (wrap) baseRenderTable(sheet, offlineRows, wrap);
      return;
    }
    var timeout = setTimeout(function () {
      if (wrap && loadTokens[sheet] === token && wrap.querySelector(".data-state.loading")) {
        wrap.innerHTML = stateMarkup("error", "API ตอบสนองช้าเกินไป กรุณาลองใหม่", sheet);
      }
    }, 12000);
    try {
      await baseLoadPanel(sheet, page, search);
    } finally {
      clearTimeout(timeout);
      if (wrap && typeof allRows === "function" && typeof renderTable === "function") {
        var hasRenderedRows = !!wrap.querySelector("tbody tr");
        var cachedRows = allRows(sheet);
        if (!hasRenderedRows && cachedRows.length && !wrap.querySelector(".data-state.loading")) {
          renderTable(sheet, cachedRows, wrap);
        }
        setTimeout(function () {
          if (!wrap || wrap.querySelector("tbody tr") || wrap.querySelector(".data-state.loading")) return;
          var delayedRows = allRows(sheet);
          if (delayedRows.length) renderTable(sheet, delayedRows, wrap);
          else {
            var filterInput = document.querySelector('#panel-' + sheet + ' .module-filter-bar input[type="search"]');
            if (filterInput) filterInput.dispatchEvent(new Event("input", { bubbles:true }));
          }
        }, 700);
      }
    }
  };

  function firstValue(row, patterns) {
    var keys = Object.keys(row || {});
    for (var i = 0; i < patterns.length; i += 1) {
      var found = keys.find(function (key) { return patterns[i].test(key); });
      if (found && row[found] !== "") return row[found];
    }
    return "";
  }

  function rowDate(row) {
    var value = firstValue(row, [/วันที่/i, /date/i, /created/i, /เริ่ม/i, /สิ้นสุด/i]);
    if (!value) return null;
    var date = new Date(value);
    return isNaN(date) ? null : date;
  }

  function allRows(sheet) {
    var rows = [];
    if (typeof SMART_DATA_CACHE !== "undefined" && SMART_DATA_CACHE[sheet] && SMART_DATA_CACHE[sheet].length) rows = SMART_DATA_CACHE[sheet];
    else if (typeof CACHED_DATA !== "undefined" && CACHED_DATA[sheet] && CACHED_DATA[sheet].length) rows = CACHED_DATA[sheet];
    else if (typeof getLocalRows === "function") rows = getLocalRows(sheet);
    return Array.isArray(rows) ? rows.slice() : [];
  }

  function storedEmployeeUsers() {
    var users = [];
    if (Array.isArray(USERS_DB)) users = users.concat(USERS_DB);
    try { users = users.concat(JSON.parse(localStorage.getItem(ADMIN_USERS_KEY) || "[]")); } catch (error) {}
    var seen = {};
    return users.filter(function (user) {
      var id = String(user && (user.employeeId || user.id) || "").trim();
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  function employeeOptionFromUser(user) {
    var id = String(user && (user.employeeId || user.id) || "").trim();
    if (!id) return null;
    var name = String(user.name || user.fullName || id).trim();
    return { value:id, label:id + " · " + name, name:name, dept:user.dept || user.department || "", position:user.position || user.pos || "" };
  }

  function employeeOptionsForRows(rows) {
    var options = storedEmployeeUsers().map(employeeOptionFromUser).filter(Boolean);
    var seen = {};
    options.forEach(function (option) { seen[option.value] = true; });
    (rows || []).forEach(function (row) {
      var id = String(firstValue(row, [/รหัสพนักงาน/i, /รหัสผู้รับผิดชอบ/i, /employee/i, /owner/i]) || "").trim();
      var name = String(firstValue(row, [/ผู้รับผิดชอบ/i, /ผู้บันทึก/i, /^ชื่อ$/i, /name/i]) || "").trim();
      if (id && !seen[id]) {
        seen[id] = true;
        options.push({ value:id, label:id + (name ? " · " + name : ""), name:name });
      }
    });
    return options;
  }

  function selectedEmployeeOption(value) {
    var selected = String(value || "").trim().toLowerCase();
    if (!selected) return null;
    return employeeOptionsForRows([]).find(function (option) {
      return String(option.value || "").toLowerCase() === selected;
    }) || { value:value, label:value, name:value };
  }

  function rowMatchesEmployeeFilter(row, selectedValue) {
    if (!selectedValue) return true;
    var option = selectedEmployeeOption(selectedValue);
    var needles = [option.value, option.name, option.dept, option.position].filter(Boolean).map(function (value) {
      return String(value).trim().toLowerCase();
    });
    var haystack = Object.keys(row || {}).map(function (key) { return row[key]; }).join(" ").toLowerCase();
    return needles.some(function (needle) { return needle && haystack.indexOf(needle) > -1; });
  }

  function refreshEmployeeFilterOptions(sheet, rows) {
    var select = document.querySelector('[data-filter-sheet="' + sheet + '"] select[data-filter="employee"]');
    if (!select) return;
    var current = select.value;
    var options = employeeOptionsForRows(rows);
    select.innerHTML = '<option value="">พนักงานทั้งหมด</option>' + options.map(function (option) {
      return '<option value="' + escapeHtml(option.value) + '"' + (current === option.value ? ' selected' : '') + '>' + escapeHtml(option.label) + '</option>';
    }).join('');
    if (current && !select.value) select.value = current;
  }

  function matchesFilters(sheet, row) {
    var f = FILTERS[sheet] || {};
    var text = Object.keys(row || {}).map(function (key) { return row[key]; }).join(" ").toLowerCase();
    if (f.query && text.indexOf(f.query.toLowerCase()) < 0) return false;
    if (f.employee && !rowMatchesEmployeeFilter(row, f.employee)) return false;
    var status = String(firstValue(row, [/สถานะ/i, /status/i]) || "");
    if (f.status && status !== f.status) return false;
    var date = rowDate(row);
    if (f.start && (!date || date < new Date(f.start + "T00:00:00"))) return false;
    if (f.end && (!date || date > new Date(f.end + "T23:59:59"))) return false;
    return true;
  }

  function installModuleFilters() {
    ["sales", "customers", "contracts", "employees", "projects"].forEach(function (sheet) {
      var table = document.getElementById("table-" + sheet);
      var card = table && table.closest(".table-card");
      var header = card && card.querySelector(".table-header");
      if (!header || card.querySelector('[data-filter-sheet="' + sheet + '"]')) return;
      var bar = document.createElement("div");
      bar.className = "module-filter-bar";
      bar.setAttribute("data-filter-sheet", sheet);
      bar.innerHTML =
        '<select data-filter="employee" class="employee-filter-select"><option value="">พนักงานทั้งหมด</option></select>' +
        '<input type="search" placeholder="ค้นหาลูกค้า ผู้รับผิดชอบ หรือรายละเอียด" data-filter="query">' +
        '<input type="date" title="วันที่เริ่มต้น" data-filter="start">' +
        '<input type="date" title="วันที่สิ้นสุด" data-filter="end">' +
        '<select data-filter="status"><option value="">ทุกสถานะ</option><option>ใช้งาน</option><option>รอดำเนินการ</option><option>กำลังดำเนินการ</option><option>เสร็จสิ้น</option><option>ยกเลิก</option></select>' +
        '<button type="button" class="btn btn-ghost btn-sm filter-reset">ล้างตัวกรอง</button>';
      header.insertAdjacentElement("afterend", bar);
      refreshEmployeeFilterOptions(sheet, allRows(sheet));
      bar.addEventListener("input", function (event) {
        var key = event.target.getAttribute("data-filter");
        if (!key) return;
        FILTERS[sheet] = FILTERS[sheet] || {};
        FILTERS[sheet][key] = event.target.value;
        var wrap = document.getElementById("table-" + sheet);
        renderTable(sheet, allRows(sheet).filter(function (row) { return matchesFilters(sheet, row); }), wrap);
      });
      bar.addEventListener("change", function (event) {
        var key = event.target.getAttribute("data-filter");
        if (!key) return;
        FILTERS[sheet] = FILTERS[sheet] || {};
        FILTERS[sheet][key] = event.target.value;
        var wrap = document.getElementById("table-" + sheet);
        renderTable(sheet, allRows(sheet).filter(function (row) { return matchesFilters(sheet, row); }), wrap);
      });
      bar.querySelector(".filter-reset").addEventListener("click", function () {
        FILTERS[sheet] = {};
        bar.querySelectorAll("input,select").forEach(function (control) { control.value = ""; });
        var wrap = document.getElementById("table-" + sheet);
        renderTable(sheet, allRows(sheet), wrap);
      });
    });
  }

  renderTable = function (sheet, data, wrap) {
    var rows = Array.isArray(data) ? data : [];
    CACHED_DATA[sheet] = rows.slice();
    var queue = queueItems();
    var renderedRows = rows.filter(function (row) { return matchesFilters(sheet, row); }).map(function (row) {
      var copy = Object.assign({}, row);
      var queued = queue.find(function (item) {
        var queuedId = item.payload && (item.payload.id || (item.payload.data && item.payload.data.ID));
        return item.sheet === sheet && queuedId && String(queuedId) === String(row.ID);
      });
      copy["สถานะซิงก์"] = queued ? (queued.status === "failed" ? "ซิงก์ไม่สำเร็จ" : "รอซิงก์") : "ซิงก์แล้ว";
      return copy;
    });
    refreshEmployeeFilterOptions(sheet, rows);
    baseRenderTable(sheet, renderedRows, wrap);
  };

  function normalizedDigits(value) {
    return String(value || "").replace(/[^\d+]/g, "");
  }

  validateFormData = function (sheet, data) {
    var errors = baseValidateFormData(sheet, data) || [];
    var keys = Object.keys(data || {});
    keys.forEach(function (key) {
      var value = data[key];
      if (/โทร|เบอร์|phone|tel/i.test(key) && value) {
        var phone = normalizedDigits(value);
        if (!/^(?:\+66|0)\d{8,9}$/.test(phone)) errors.push(key + " รูปแบบเบอร์โทรไม่ถูกต้อง");
      }
    });
    var start = firstValue(data, [/วัน.*เริ่ม/i, /start.*date/i]);
    var end = firstValue(data, [/วัน.*สิ้นสุด/i, /วัน.*ส่งมอบ/i, /end.*date/i]);
    if (start && end && new Date(end) < new Date(start)) {
      errors.push("วันที่สิ้นสุดต้องไม่น้อยกว่าวันเริ่มต้น");
    }
    var existing = allRows(sheet);
    var currentId = typeof EDIT_ID !== "undefined" ? String(EDIT_ID || "") : "";
    if (sheet === "customers") {
      var name = String(firstValue(data, [/ชื่อ.*ลูกค้า/i, /^ชื่อ$/i, /customer/i]) || "").trim().toLowerCase();
      var phoneValue = normalizedDigits(firstValue(data, [/โทร|เบอร์|phone|tel/i]));
      var duplicateCustomer = existing.some(function (row) {
        if (String(row.ID || "") === currentId) return false;
        var rowName = String(firstValue(row, [/ชื่อ.*ลูกค้า/i, /^ชื่อ$/i, /customer/i]) || "").trim().toLowerCase();
        var rowPhone = normalizedDigits(firstValue(row, [/โทร|เบอร์|phone|tel/i]));
        return (name && rowName === name) || (phoneValue && rowPhone === phoneValue);
      });
      if (duplicateCustomer) errors.push("พบข้อมูลลูกค้าซ้ำจากชื่อหรือเบอร์โทร");
    }
    if (sheet === "contracts") {
      var customer = String(firstValue(data, [/ชื่อ.*ลูกค้า/i, /customer/i]) || "").trim().toLowerCase();
      var contract = String(firstValue(data, [/สัญญา/i, /contract/i]) || "").trim().toLowerCase();
      if (customer && contract && existing.some(function (row) {
        return String(row.ID || "") !== currentId &&
          String(firstValue(row, [/ชื่อ.*ลูกค้า/i, /customer/i]) || "").trim().toLowerCase() === customer &&
          String(firstValue(row, [/สัญญา/i, /contract/i]) || "").trim().toLowerCase() === contract;
      })) errors.push("พบสัญญาซ้ำของลูกค้ารายนี้");
    }
    return Array.from(new Set(errors));
  };

  function numberValue(row, patterns) {
    var value = firstValue(row, patterns);
    return Number(String(value || "0").replace(/[^0-9.-]/g, "")) || 0;
  }

  function inDashboardRange(row, start, end) {
    var date = rowDate(row);
    if (!date) return false;
    return date >= start && date <= end;
  }

  function sumRows(rows, patterns) {
    return rows.reduce(function (sum, row) { return sum + numberValue(row, patterns); }, 0);
  }

  applyAccountFilter = function () {
    var startEl = document.getElementById("start_date");
    var endEl = document.getElementById("end_date");
    if (!startEl || !endEl || !startEl.value || !endEl.value) {
      toast("กรุณาเลือกวันที่เริ่มต้นและวันที่สิ้นสุด", "err");
      return;
    }
    var start = new Date(startEl.value + "T00:00:00");
    var end = new Date(endEl.value + "T23:59:59");
    if (start > end) {
      toast("วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด", "err");
      return;
    }
    var sales = allRows("sales").filter(function (row) { return inDashboardRange(row, start, end); });
    var customers = allRows("customers").filter(function (row) { return inDashboardRange(row, start, end); });
    var contracts = allRows("contracts").filter(function (row) { return inDashboardRange(row, start, end); });
    var projects = allRows("projects").filter(function (row) { return inDashboardRange(row, start, end); });
    setText("s-sales", fmt(sales.length));
    setText("s-customers", fmt(customers.length));
    setText("s-contracts", fmt(contracts.length));
    setText("s-projects", fmtCurrency(sumRows(projects, [/มูลค่า/i, /ยอดรวม/i, /amount/i, /total/i])));
    renderLatestSales(sales.slice().sort(function (a, b) { return (rowDate(b) || 0) - (rowDate(a) || 0); }).slice(0, 6));
    var monthly = Array(12).fill(0);
    sales.concat(contracts).forEach(function (row) {
      var date = rowDate(row);
      if (date) monthly[date.getMonth()] += numberValue(row, [/ยอดรวม/i, /มูลค่า/i, /ราคา/i, /amount/i, /total/i]);
    });
    ["chart-bar", "chart-line"].forEach(function (id) {
      if (typeof CHARTS !== "undefined" && CHARTS[id]) {
        CHARTS[id].data.datasets[0].data = monthly;
        CHARTS[id].update();
      }
    });
    toast("กรอง Dashboard ตามช่วงวันที่แล้ว", "ok");
  };

  function setDefaultDashboardDates() {
    var start = document.getElementById("start_date");
    var end = document.getElementById("end_date");
    var now = new Date();
    if (start) start.value = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
    if (end) end.value = now.toISOString().slice(0, 10);
  }

  window.addEventListener("online", function () {
    showNetworkState("", "กลับมาออนไลน์แล้ว กำลังลองซิงก์ข้อมูล");
    retrySyncQueue();
  });
  window.addEventListener("offline", function () {
    showNetworkState("offline", "กำลังใช้งาน Offline ข้อมูลใหม่จะถูกเก็บในคิว");
  });

  document.addEventListener("DOMContentLoaded", function () {
    installModuleFilters();
    renderSyncQueue();
    setDefaultDashboardDates();
    if (!navigator.onLine) showNetworkState("offline", "กำลังใช้งาน Offline ข้อมูลใหม่จะถูกเก็บในคิว");
  });
})();

/* Resize charts and mobile navigation after the viewport changes. */
(function initializeDailyFieldBuilderSafely() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeDailyFieldBuilder, { once:true });
  } else {
    initializeDailyFieldBuilder();
  }
})();

/* Resize charts and mobile navigation after the viewport changes. */
(function () {
  "use strict";
  var resizeTimer = 0;

  function resizeErpLayout() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (typeof CHARTS !== "undefined") {
        Object.keys(CHARTS).forEach(function (key) {
          var chart = CHARTS[key];
          if (chart && typeof chart.resize === "function") chart.resize();
        });
      }
      if (window.innerWidth > 768 && typeof closeMobileMenu === "function") closeMobileMenu();
      if (typeof renderPremiumLayout === "function") renderPremiumLayout();
    }, 120);
  }

  window.addEventListener("resize", resizeErpLayout, { passive: true });
  window.addEventListener("orientationchange", resizeErpLayout, { passive: true });
})();

/* Prefer backend authentication when the deployed API supports it. */
(function () {
  "use strict";
  var localLogin = doLogin;

  function finishBackendLogin(user) {
    CURRENT_USER = {
      id: user.employeeId || user.id,
      employeeId: user.employeeId || user.id,
      name: user.name || user.fullName || user.employeeId || user.id,
      email: user.email || "",
      position: user.position || "",
      role: String(user.role || "viewer").toLowerCase(),
      status: user.status || "active"
    };
    var navAdmin = document.getElementById("nav-admin");
    if (navAdmin) navAdmin.style.display = CURRENT_USER.role === "admin" ? "flex" : "none";
    syncRoleAccess();
    updateTopbarUser(CURRENT_USER);
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("erp-app").classList.add("visible");
    var error = document.getElementById("lc-err");
    if (error) error.style.display = "none";
    if (typeof logAudit === "function") logAudit("login", CURRENT_USER.name, "เข้าสู่ระบบผ่าน Backend", "—", CURRENT_USER.role);
  }

  doLogin = async function (event) {
    if (event) event.preventDefault();
    var idEl = document.getElementById("login-user");
    var passEl = document.getElementById("login-pass");
    var id = idEl ? idEl.value.trim().toUpperCase() : "";
    var password = passEl ? passEl.value : "";
    if (!ERP_REQUIRE_BACKEND_LOGIN && (id === "EMP-005" || id === "EMP-007" || id === "EMP-EXEC") && password === "aa123") {
      var fixedLocalTestUsers = {
        "EMP-EXEC": {
          id: "EMP-EXEC",
          employeeId: "EMP-EXEC",
          name: "Executive",
          role: "executive",
          dept: "ผู้บริหาร",
          position: "ผู้บริหาร",
          pos: "ผู้บริหาร",
          avatar: "EX"
        },
        "EMP-005": {
          id: "EMP-005",
          employeeId: "EMP-005",
          name: "พนักงานทดสอบ",
          role: "editor",
          dept: "ฝ่ายขาย",
          position: "พนักงานขาย (Sales)",
          pos: "พนักงานขาย (Sales)",
          avatar: "พท"
        },
        "EMP-007": {
          id: "EMP-007",
          employeeId: "EMP-007",
          name: "หลิว",
          role: "editor",
          dept: "การตลาด",
          position: "นักยิงแอด / การตลาด",
          pos: "นักยิงแอด / การตลาด",
          avatar: "หล"
        }
      };
      finishBackendLogin(fixedLocalTestUsers[id]);
      return;
    }
    if (!ERP_REQUIRE_BACKEND_LOGIN && (id === "EMP-005" || id === "EMP-007") && password === "aa123") {
      var employee007 = getDbUsers().find(function (user) {
        return String(user.id || user.employeeId || "").trim().toUpperCase() === id;
      }) || {
        id: id,
        employeeId: id,
        name: "หลิว",
        role: "editor",
        dept: "การตลาด",
        position: "นักยิงแอด / การตลาด",
        pos: "นักยิงแอด / การตลาด",
        avatar: "หล"
      };
      finishBackendLogin(employee007);
      return;
    }
    if (API_URL && id && password && navigator.onLine) {
      try {
        var result = await apiGet({ action: "login", employeeId: id, password: password });
        if (result && result.ok && result.session && result.user) {
          window.ERP_SECURITY.setSession({ session: result.session, expiresAt: Date.now() + (result.expiresIn || 21600) * 1000 });
          finishBackendLogin(result.user);
          return;
        }
      } catch (error) {
        console.warn("Backend login unavailable; using local account cache.");
      }
    }
    if (ERP_REQUIRE_BACKEND_LOGIN) {
      var backendError = document.getElementById("lc-err");
      if (backendError) {
        backendError.textContent = "ไม่สามารถเข้าสู่ระบบจาก Backend ได้ กรุณาตรวจ Apps Script URL หรือ Session API";
        backendError.style.display = "block";
      }
      return;
    }
    var compatibilityHashes = {
      "EMP-ADM": "ac9689e2272427085e35b9d3e3e8bed88cb3434828b43b86fc0596cad4c6e270",
      "EMP-001": "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "EMP-002": "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "EMP-003": "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      "EMP-004": "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"
    };
    if (compatibilityHashes[id] && window.ERP_SECURITY) {
      var suppliedHash = await window.ERP_SECURITY.sha256(password);
      if (suppliedHash === compatibilityHashes[id]) {
        var cachedUser = getDbUsers().find(function (user) {
          return String(user.id || user.employeeId || "").toUpperCase() === id;
        });
        if (cachedUser) {
          finishBackendLogin(cachedUser);
          return;
        }
      }
    }
    localLogin(event);
  };
})();

/* =========================================================
   Admin security and operations suite
   ========================================================= */
(function () {
  "use strict";

  var SYNC_HISTORY_KEY = "erp-sync-history-v1";
  var ADMIN_ALERT_KEY = "erp-admin-alerts-v1";
  var AUTO_BACKUP_KEY = "erp-auto-backups-v1";
  var AUTO_BACKUP_DATE_KEY = "erp-auto-backup-date";
  var SESSION_TIMEOUT_KEY = "erp-session-timeout-minutes";
  var MAINTENANCE_KEY = "erp-maintenance-mode";
  var LAST_SYNC_KEY = "erp-last-sync-at";
  var SESSION_LAST_ACTIVE_KEY = "erp-session-last-active";
  var sessionTimer = null;
  var healthTimer = null;

  function readStoredJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch (error) { return fallback; }
  }

  function writeStoredJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function currentActor() {
    return CURRENT_USER ? (CURRENT_USER.name || CURRENT_USER.employeeId || CURRENT_USER.id || CURRENT_USER.role) : "ระบบ";
  }

  function safeAudit(type, action, oldValue, newValue) {
    if (typeof logAudit === "function") logAudit(type, currentActor(), action, oldValue == null ? "—" : oldValue, newValue == null ? "—" : newValue);
  }

  function classifyApiError(error) {
    var message = String(error && (error.message || error) || "Unknown error");
    if (/401|403|unauthorized|invalid token/i.test(message)) return "Token ไม่ถูกต้องหรือไม่มีสิทธิ์";
    if (/404|not found/i.test(message)) return "ไม่พบ Web App URL หรือ Deployment";
    if (/failed to fetch|network|load failed|offline/i.test(message)) return "เครือข่ายหรือ CORS ไม่สามารถเชื่อมต่อได้";
    if (/timeout|timed out/i.test(message)) return "API ตอบสนองช้าเกินกำหนด";
    if (/sheet|spreadsheet/i.test(message)) return "Google Sheets ไม่พร้อมใช้งานหรือไม่มีสิทธิ์";
    return message;
  }

  function setConnectionResult(type, text) {
    var result = document.getElementById("connection-test-result");
    if (!result) return;
    result.className = "connection-test-result " + (type || "");
    result.textContent = text;
  }

  function directApiTest(url, token) {
    if (!url) return Promise.reject(new Error("กรุณากรอก Web App URL"));
    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("Web App URL ต้องขึ้นต้นด้วย http:// หรือ https://"));
    var testUrl = url + (url.indexOf("?") > -1 ? "&" : "?") +
      "token=" + encodeURIComponent(token || "") +
      "&origin=" + encodeURIComponent(ERP_CLIENT_ORIGIN) +
      "&action=read&sheet=sales&page=1&pageSize=1";
    return Promise.race([
      fetchJsonWithProxy(testUrl),
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error("API timeout after 12 seconds")); }, 12000); })
    ]).then(function (result) {
      if (!result || result.ok === false) throw new Error(result && (result.msg || result.error) || "API rejected request");
      return result;
    });
  }

  window.toggleSecretVisibility = function (id, button) {
    var input = document.getElementById(id);
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    if (button) button.textContent = input.type === "password" ? "👁" : "🙈";
  };

  window.testApiConnection = async function () {
    var urlEl = document.getElementById("api-url");
    var tokenEl = document.getElementById("api-token");
    var url = urlEl ? urlEl.value.trim() : "";
    var token = tokenEl ? tokenEl.value.trim() : "";
    if (!token && window.ERP_SECURITY) token = window.ERP_SECURITY.getApiToken();
    setConnectionResult("", "กำลังทดสอบ API และ Google Sheets...");
    var started = Date.now();
    try {
      var result = await directApiTest(url, token);
      var latency = Date.now() - started;
      setConnectionResult("ok", "เชื่อมต่อสำเร็จ · Google Sheets ตอบกลับ · " + latency + " ms");
      updateSystemStatus(true);
      return { ok:true, result:result, latency:latency, url:url, token:token };
    } catch (error) {
      var reason = classifyApiError(error);
      setConnectionResult("error", "เชื่อมต่อไม่สำเร็จ: " + reason);
      updateSystemStatus(false);
      pushAdminAlert("api", "API เชื่อมต่อไม่สำเร็จ", reason);
      safeAudit("admin", "ทดสอบการเชื่อมต่อ API ไม่สำเร็จ", url, reason);
      return { ok:false, error:reason };
    }
  };

  connect = async function () {
    var tested = await window.testApiConnection();
    if (!tested.ok) return;
    API_URL = tested.url;
    API_TOKEN = tested.token;
    CONNECTED = true;
    localStorage.setItem("erp-url", API_URL);
    if (window.ERP_SECURITY) window.ERP_SECURITY.setApiToken(API_TOKEN);
    var tokenEl = document.getElementById("api-token");
    if (tokenEl) { tokenEl.value = ""; tokenEl.placeholder = "Token ถูกเข้ารหัสและบันทึกแล้ว"; }
    setStatus("ok", "เชื่อมต่อแล้ว");
    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    safeAudit("admin", "เปลี่ยนการเชื่อมต่อ API", "ค่าก่อนหน้า", API_URL);
    toast("ทดสอบและบันทึกการเชื่อมต่อแล้ว", "ok");
    refreshSystemHealth(false);
    loadStats();
  };
  window.erpConnectApi = connect;

  window.replaceStoredToken = function () {
    var tokenEl = document.getElementById("access-token-input");
    if (!tokenEl) return;
    tokenEl.value = "";
    tokenEl.type = "password";
    tokenEl.placeholder = "วาง Token ใหม่";
    tokenEl.focus();
  };

  saveAccessToken = async function () {
    var input = document.getElementById("access-token-input");
    var candidate = input ? input.value.trim() : "";
    if (!candidate) { toast("กรุณากรอก Token ใหม่ก่อน", "err"); return; }
    var urlEl = document.getElementById("api-url");
    var url = urlEl ? urlEl.value.trim() : API_URL;
    setConnectionResult("", "กำลังตรวจสอบ Token ใหม่...");
    try {
      await directApiTest(url, candidate);
      if (window.ERP_SECURITY) window.ERP_SECURITY.setApiToken(candidate);
      API_TOKEN = candidate;
      sessionStorage.setItem("erp-access-token", candidate);
      input.value = "";
      input.placeholder = "Token ถูกเข้ารหัสและบันทึกแล้ว";
      setConnectionResult("ok", "Token ใหม่ผ่านการตรวจสอบและบันทึกแบบเข้ารหัสแล้ว");
      safeAudit("admin", "เปลี่ยน API Token", "Token เดิมถูกซ่อน", "Token ใหม่ผ่านการตรวจสอบ");
      toast("Token ใหม่ใช้งานได้และบันทึกแล้ว", "ok");
      refreshSystemHealth(false);
    } catch (error) {
      var reason = classifyApiError(error);
      setConnectionResult("error", "ไม่บันทึก Token: " + reason);
      pushAdminAlert("api", "Token ใหม่ไม่ผ่านการตรวจสอบ", reason);
      safeAudit("admin", "ปฏิเสธการเปลี่ยน API Token", "Token เดิม", reason);
      toast("ไม่บันทึก Token: " + reason, "err");
    }
  };

  function syncHistory() { return readStoredJson(SYNC_HISTORY_KEY, []); }
  function addSyncHistory(status, item, detail) {
    var rows = syncHistory();
    rows.unshift({
      id:"H-" + Date.now() + "-" + Math.random().toString(36).slice(2,5),
      ts:new Date().toISOString(),
      status:status,
      sheet:item && item.sheet || "system",
      action:item && item.action || "sync",
      detail:String(detail || "")
    });
    writeStoredJson(SYNC_HISTORY_KEY, rows.slice(0, 150));
    if (status === "success") localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    renderSyncHistory();
  }

  function renderSyncHistory() {
    var wrap = document.getElementById("sync-history-list");
    if (!wrap) return;
    var rows = syncHistory();
    if (!rows.length) { wrap.innerHTML = '<div class="admin-history-empty">ยังไม่มีประวัติการซิงก์</div>'; return; }
    wrap.innerHTML = rows.slice(0, 30).map(function (row) {
      var ok = row.status === "success";
      return '<div class="admin-history-item"><div class="admin-history-icon">' + (ok ? "✓" : "✕") +
        '</div><div class="admin-history-main"><div class="admin-history-title">' + escapeHtml(row.sheet + " · " + row.action) +
        '</div><div class="admin-history-detail">' + escapeHtml(row.detail || (ok ? "ซิงก์สำเร็จ" : "ซิงก์ไม่สำเร็จ")) +
        '</div></div><div class="admin-history-time">' + new Date(row.ts).toLocaleString("th-TH") + '</div></div>';
    }).join("");
  }

  window.clearSyncHistory = function () {
    writeStoredJson(SYNC_HISTORY_KEY, []);
    renderSyncHistory();
    safeAudit("admin", "ล้างประวัติการซิงก์", "history", "empty");
  };

  function adminAlerts() { return readStoredJson(ADMIN_ALERT_KEY, []); }
  function pushAdminAlert(type, title, detail) {
    var alerts = adminAlerts();
    var duplicate = alerts[0] && alerts[0].title === title && alerts[0].detail === detail && (Date.now() - new Date(alerts[0].ts).getTime() < 60000);
    if (!duplicate) {
      alerts.unshift({ id:"A-" + Date.now(), ts:new Date().toISOString(), type:type, title:title, detail:String(detail || "") });
      writeStoredJson(ADMIN_ALERT_KEY, alerts.slice(0, 100));
    }
    renderAdminAlerts();
    if (CURRENT_USER && CURRENT_USER.role === "admin" && typeof addNotif === "function") addNotif(title, detail, "danger", "!");
  }
  window.pushAdminAlert = pushAdminAlert;

  function renderAdminAlerts() {
    var wrap = document.getElementById("admin-alert-list");
    if (!wrap) return;
    var alerts = adminAlerts();
    if (!alerts.length) { wrap.innerHTML = '<div class="admin-history-empty">ระบบยังไม่มีการแจ้งเตือน</div>'; return; }
    wrap.innerHTML = alerts.slice(0, 30).map(function (row) {
      return '<div class="admin-history-item"><div class="admin-history-icon">!</div><div class="admin-history-main"><div class="admin-history-title">' +
        escapeHtml(row.title) + '</div><div class="admin-history-detail">' + escapeHtml(row.detail) +
        '</div></div><div class="admin-history-time">' + new Date(row.ts).toLocaleString("th-TH") + '</div></div>';
    }).join("");
  }

  window.clearAdminAlerts = function () {
    writeStoredJson(ADMIN_ALERT_KEY, []);
    renderAdminAlerts();
    safeAudit("admin", "ล้างการแจ้งเตือนผู้ดูแล", "alerts", "empty");
  };

  var trackedApiPost = apiPost;
  apiPost = function (payload) {
    return trackedApiPost(payload).then(function (result) {
      addSyncHistory("success", payload, result && result.msg || "ซิงก์สำเร็จ");
      return result;
    }).catch(function (error) {
      var reason = classifyApiError(error);
      addSyncHistory("failed", payload, reason);
      pushAdminAlert("sync", "ซิงก์ข้อมูลไม่สำเร็จ", (payload.sheet || "unknown") + ": " + reason);
      throw error;
    });
  };

  function backupRows() { return readStoredJson(AUTO_BACKUP_KEY, []); }
  function automaticBackupPayload() {
    var keys = {};
    for (var i = 0; i < localStorage.length; i += 1) {
      var key = localStorage.key(i);
      if (key && key !== AUTO_BACKUP_KEY && key !== "erp-api-token-encrypted") keys[key] = localStorage.getItem(key);
    }
    return { version:"erp-final-v6-auto", exportedAt:new Date().toISOString(), keys:keys };
  }

  window.createAutomaticBackup = function (manual) {
    var today = new Date().toISOString().slice(0,10);
    if (!manual && localStorage.getItem(AUTO_BACKUP_DATE_KEY) === today) return;
    var rows = backupRows();
    var payload = automaticBackupPayload();
    rows.unshift({ id:"B-" + Date.now(), ts:payload.exportedAt, reason:manual ? "manual" : "daily", data:payload });
    writeStoredJson(AUTO_BACKUP_KEY, rows.slice(0,7));
    localStorage.setItem(AUTO_BACKUP_DATE_KEY, today);
    safeAudit("admin", manual ? "สร้าง Backup ด้วยตนเอง" : "สร้าง Backup อัตโนมัติรายวัน", "—", payload.exportedAt);
    renderAutoBackups();
    if (manual) toast("สร้าง Backup ในเครื่องแล้ว", "ok");
  };

  window.restoreAutomaticBackup = function (id) {
    var backup = backupRows().find(function (row) { return row.id === id; });
    if (!backup || !backup.data || !backup.data.keys) return;
    if (!confirm("คืนค่าข้อมูลจาก Backup วันที่ " + new Date(backup.ts).toLocaleString("th-TH") + " หรือไม่?")) return;
    Object.keys(backup.data.keys).forEach(function (key) { localStorage.setItem(key, backup.data.keys[key]); });
    safeAudit("admin", "Restore Auto Backup", backup.ts, "restored");
    toast("คืนค่า Backup แล้ว กำลังโหลดระบบใหม่", "ok");
    setTimeout(function () { location.reload(); }, 700);
  };

  function renderAutoBackups() {
    var wrap = document.getElementById("auto-backup-history");
    var status = document.getElementById("auto-backup-status");
    var rows = backupRows();
    if (status) status.textContent = rows.length ? "ล่าสุด " + new Date(rows[0].ts).toLocaleString("th-TH") + " · เก็บ " + rows.length + "/7" : "ยังไม่มี Backup · เก็บประวัติ 7 วัน";
    if (!wrap) return;
    if (!rows.length) { wrap.innerHTML = '<div class="admin-history-empty">ยังไม่มี Backup อัตโนมัติ</div>'; return; }
    wrap.innerHTML = rows.map(function (row) {
      return '<div class="admin-history-item"><div class="admin-history-icon">💾</div><div class="admin-history-main"><div class="admin-history-title">' +
        (row.reason === "daily" ? "Backup รายวัน" : "Backup ด้วยตนเอง") + '</div><div class="admin-history-detail">' +
        Object.keys(row.data.keys || {}).length + ' ชุดข้อมูล</div></div><div><button class="btn btn-ghost btn-sm" type="button" onclick="restoreAutomaticBackup(&quot;' +
        row.id + '&quot;)">Restore</button></div></div>';
    }).join("");
  }

  function maintenanceEnabled() { return localStorage.getItem(MAINTENANCE_KEY) === "1"; }
  window.setMaintenanceMode = function (enabled) {
    localStorage.setItem(MAINTENANCE_KEY, enabled ? "1" : "0");
    applyMaintenanceUi();
    safeAudit("admin", "เปลี่ยน Maintenance Mode", enabled ? "ปิด" : "เปิด", enabled ? "เปิด" : "ปิด");
    toast(enabled ? "เปิด Maintenance Mode แล้ว" : "ปิด Maintenance Mode แล้ว", enabled ? "info" : "ok");
  };

  function applyMaintenanceUi() {
    var enabled = maintenanceEnabled();
    var toggle = document.getElementById("maintenance-toggle");
    if (toggle) toggle.checked = enabled;
    var banner = document.getElementById("maintenance-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "maintenance-banner";
      banner.className = "maintenance-banner";
      banner.textContent = "🛠 ระบบอยู่ระหว่างปรับปรุง พนักงานสามารถดูข้อมูลได้แต่ไม่สามารถเพิ่ม แก้ไข หรือลบ";
      var main = document.querySelector(".main");
      var topbar = main && main.querySelector(".topbar");
      if (topbar) topbar.insertAdjacentElement("afterend", banner);
    }
    banner.classList.toggle("show", enabled && !(CURRENT_USER && CURRENT_USER.role === "admin"));
  }

  var permissionCreate = userCanCreate;
  var permissionEdit = userCanEdit;
  var permissionDelete = userCanDelete;
  userCanCreate = function (panel) { return maintenanceEnabled() && !userIsAdmin() ? false : permissionCreate(panel); };
  userCanEdit = function (panel) { return maintenanceEnabled() && !userIsAdmin() ? false : permissionEdit(panel); };
  userCanDelete = function (panel) { return maintenanceEnabled() && !userIsAdmin() ? false : permissionDelete(panel); };

  function isSalesUser() {
    if (!CURRENT_USER || CURRENT_USER.role === "admin") return false;
    return /ฝ่ายขาย|พนักงานขาย|sales/i.test(String(CURRENT_USER.position || CURRENT_USER.pos || CURRENT_USER.department || CURRENT_USER.dept || ""));
  }

  function ownerValue(row, patterns) {
    var keys = Object.keys(row || {});
    var found = keys.find(function (key) { return patterns.some(function (pattern) { return pattern.test(key); }); });
    return found ? String(row[found] || "").trim().toLowerCase() : "";
  }

  function applyDataScope(rows) {
    if (!isSalesUser()) return rows;
    var userId = String(CURRENT_USER.employeeId || CURRENT_USER.id || "").trim().toLowerCase();
    var userName = String(CURRENT_USER.name || "").trim().toLowerCase();
    return rows.filter(function (row) {
      var ownerId = ownerValue(row, [/รหัส.*ผู้รับผิดชอบ/i, /owner.*id/i, /employee.*id/i, /authorId/i]);
      var ownerName = ownerValue(row, [/ผู้รับผิดชอบ/i, /พนักงานขาย/i, /เจ้าของ/i, /owner/i, /salesperson/i, /author/i]);
      return (ownerId && ownerId === userId) || (ownerName && (ownerName === userName || ownerName === userId));
    });
  }

  var scopedRenderTable = renderTable;
  renderTable = function (sheet, rows, wrap) {
    scopedRenderTable(sheet, applyDataScope(Array.isArray(rows) ? rows : []), wrap);
  };

  var scopedLocalRead = localRead;
  localRead = function (sheet, search) {
    return applyDataScope(scopedLocalRead(sheet, search));
  };

  var scopedLocalWrite = localWrite;
  localWrite = function (sheet, data) {
    var payload = Object.assign({}, data || {});
    if (isSalesUser()) {
      payload["ผู้รับผิดชอบ"] = CURRENT_USER.name || CURRENT_USER.employeeId || CURRENT_USER.id;
      payload["รหัสผู้รับผิดชอบ"] = CURRENT_USER.employeeId || CURRENT_USER.id;
    }
    return scopedLocalWrite(sheet, payload);
  };

  var alertingValidation = validateFormData;
  validateFormData = function (sheet, data) {
    var errors = alertingValidation(sheet, data) || [];
    var duplicate = errors.find(function (error) { return /ซ้ำ|duplicate/i.test(error); });
    if (duplicate) {
      pushAdminAlert("duplicate", "ตรวจพบข้อมูลซ้ำใน " + sheet, duplicate);
      safeAudit("info", "ระบบป้องกันข้อมูลซ้ำ", sheet, duplicate);
    }
    return errors;
  };

  function sessionMinutes() { return Math.max(5, Number(localStorage.getItem(SESSION_TIMEOUT_KEY) || 30)); }
  function touchSession() {
    if (!CURRENT_USER) return;
    sessionStorage.setItem(SESSION_LAST_ACTIVE_KEY, String(Date.now()));
    renderSessionStatus();
  }

  function renderSessionStatus() {
    var text = document.getElementById("session-status-text");
    var select = document.getElementById("session-timeout-select");
    if (select) select.value = String(sessionMinutes());
    if (!text) return;
    var last = Number(sessionStorage.getItem(SESSION_LAST_ACTIVE_KEY) || Date.now());
    var remaining = Math.max(0, sessionMinutes() * 60 - Math.floor((Date.now() - last) / 1000));
    text.textContent = "ออกจากระบบเมื่อไม่มีการใช้งาน · เหลือประมาณ " + Math.ceil(remaining / 60) + " นาที";
  }

  window.saveSessionTimeout = function (value) {
    var old = sessionMinutes();
    localStorage.setItem(SESSION_TIMEOUT_KEY, String(Math.max(5, Number(value) || 30)));
    touchSession();
    safeAudit("admin", "เปลี่ยน Session timeout", old + " นาที", sessionMinutes() + " นาที");
  };

  function checkSessionTimeout() {
    if (!CURRENT_USER) return;
    var last = Number(sessionStorage.getItem(SESSION_LAST_ACTIVE_KEY) || Date.now());
    if (Date.now() - last >= sessionMinutes() * 60000) {
      safeAudit("login", "Session หมดอายุอัตโนมัติ", CURRENT_USER.employeeId || CURRENT_USER.id, "logout");
      toast("Session หมดอายุ กรุณาเข้าสู่ระบบใหม่", "err");
      doLogout();
      return;
    }
    renderSessionStatus();
  }

  ["click","keydown","pointerdown","scroll"].forEach(function (eventName) {
    document.addEventListener(eventName, touchSession, { passive:true });
  });

  var logoutWithSecurity = doLogout;
  doLogout = function () {
    sessionStorage.removeItem(SESSION_LAST_ACTIVE_KEY);
    if (window.ERP_SECURITY) window.ERP_SECURITY.setSession(null);
    logoutWithSecurity();
  };

  function healthCard(label, value, sub, status) {
    return '<div class="health-card"><div class="health-card-head"><span>' + escapeHtml(label) +
      '</span><span class="health-dot ' + status + '"></span></div><div class="health-card-value">' + escapeHtml(value) +
      '</div><div class="health-card-sub">' + escapeHtml(sub) + '</div></div>';
  }

  window.refreshSystemHealth = async function (testRemote) {
    var wrap = document.getElementById("system-health-grid");
    if (!wrap) return;
    var queue = readStoredJson("erp-sync-queue-v1", []);
    var failed = queue.filter(function (item) { return item.status === "failed"; }).length;
    var pending = queue.filter(function (item) { return item.status !== "synced" && item.status !== "failed"; }).length;
    var apiOk = CONNECTED;
    var sheetsOk = CONNECTED;
    var detail = CONNECTED ? "พร้อมใช้งาน" : "ยังไม่ได้เชื่อมต่อ";
    if (testRemote && API_URL) {
      try {
        await directApiTest(API_URL, API_TOKEN || (window.ERP_SECURITY && window.ERP_SECURITY.getApiToken()));
        apiOk = sheetsOk = true; detail = "ตอบสนองล่าสุด " + new Date().toLocaleTimeString("th-TH");
      } catch (error) {
        apiOk = sheetsOk = false; detail = classifyApiError(error);
        pushAdminAlert("api", "System Health ตรวจพบ API ล้มเหลว", detail);
      }
    }
    var lastSync = localStorage.getItem(LAST_SYNC_KEY);
    var backups = backupRows();
    wrap.innerHTML =
      healthCard("API", apiOk ? "ออนไลน์" : "ออฟไลน์", detail, apiOk ? "ok" : "error") +
      healthCard("Google Sheets", sheetsOk ? "เชื่อมต่อแล้ว" : "ไม่พร้อม", sheetsOk ? "อ่านข้อมูลได้" : detail, sheetsOk ? "ok" : "error") +
      healthCard("Sync Queue", pending + " รอ · " + failed + " ล้มเหลว", lastSync ? "ล่าสุด " + new Date(lastSync).toLocaleString("th-TH") : "ยังไม่เคยซิงก์", failed ? "error" : pending ? "warn" : "ok") +
      healthCard("Backup / Session", backups.length + "/7 Backup", "Session " + sessionMinutes() + " นาที", backups.length ? "ok" : "warn");
    renderSyncHistory();
    renderAdminAlerts();
    renderAutoBackups();
    applyMaintenanceUi();
  };

  var adminPanelHook = openAdminPanelForCurrentUser;
  openAdminPanelForCurrentUser = function () {
    adminPanelHook();
    setTimeout(function () { refreshSystemHealth(false); }, 30);
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (window.ERP_SECURITY && window.ERP_SECURITY.restoreApiToken) {
      window.ERP_SECURITY.restoreApiToken().then(function (token) {
        if (token) {
          API_TOKEN = token;
          var tokenEl = document.getElementById("api-token");
          if (tokenEl) tokenEl.placeholder = "Token ถูกเข้ารหัสและบันทึกแล้ว";
          var accessEl = document.getElementById("access-token-input");
          if (accessEl) accessEl.placeholder = "Token ถูกเข้ารหัสและบันทึกแล้ว";
        }
      });
    }
    createAutomaticBackup(false);
    renderSyncHistory();
    renderAdminAlerts();
    renderAutoBackups();
    applyMaintenanceUi();
    var timeoutSelect = document.getElementById("session-timeout-select");
    if (timeoutSelect) timeoutSelect.value = String(sessionMinutes());
    sessionTimer = setInterval(checkSessionTimeout, 15000);
    healthTimer = setInterval(function () { if (CURRENT_USER && CURRENT_USER.role === "admin") refreshSystemHealth(false); }, 30000);
  });
})();

/* Responsive UX and Admin workspace navigation. */
(function () {
  "use strict";

  var ADMIN_TAB_KEY = "erp-admin-active-tab";

  window.switchAdminTab = function (name, button) {
    var valid = ["access", "reports", "system", "security"];
    if (valid.indexOf(name) < 0) name = "access";
    document.querySelectorAll("[data-admin-pane]").forEach(function (pane) {
      pane.classList.toggle("active", pane.getAttribute("data-admin-pane") === name);
    });
    document.querySelectorAll("[data-admin-tab]").forEach(function (tabButton) {
      var active = tabButton.getAttribute("data-admin-tab") === name;
      tabButton.classList.toggle("active", active);
      tabButton.setAttribute("aria-selected", active ? "true" : "false");
    });
    localStorage.setItem(ADMIN_TAB_KEY, name);
    if (button && typeof button.scrollIntoView === "function") {
      button.scrollIntoView({ block:"nearest", inline:"nearest" });
    }
    if (name === "system" && typeof refreshSystemHealth === "function") {
      setTimeout(function () { refreshSystemHealth(false); }, 30);
    }
    if (name === "reports" && typeof renderDailyFieldAdmin === "function") {
      setTimeout(renderDailyFieldAdmin, 30);
    }
  };

  function decorateResponsiveTable(table) {
    if (!table || table.closest(".premium-perm-scroll") || table.dataset.mobileReady === "1") return;
    var headers = Array.from(table.querySelectorAll("thead th")).map(function (th, index) {
      var label = th.textContent.trim();
      if (!label && index === 0) return "เลือก";
      return label || "ข้อมูล";
    });
    Array.from(table.querySelectorAll("tbody tr")).forEach(function (row) {
      Array.from(row.children).forEach(function (cell, index) {
        cell.setAttribute("data-label", headers[index] || "ข้อมูล");
      });
    });
    var host = table.closest(".table-wrap") || table.parentElement;
    if (host) host.classList.add("responsive-card-table");
    table.dataset.mobileReady = "1";
  }

  function decorateAllResponsiveTables(root) {
    (root || document).querySelectorAll(".table-wrap table, #latest-sales-wrap table").forEach(decorateResponsiveTable);
  }

  function applyRoleUx(sheet) {
    if (!sheet || !SCHEMAS[sheet]) return;
    var panel = document.getElementById("panel-" + sheet);
    if (!panel) return;
    var canCreate = userCanCreate(sheet);
    var canDelete = userCanDelete(sheet);
    panel.querySelectorAll('[onclick*="openAddModal"],[onclick*="openImportModal"]').forEach(function (button) {
      button.style.display = canCreate ? "" : "none";
    });
    panel.querySelectorAll('.premium-icon-btn.danger,[onclick*="confirmDelete"],.bulk-btn.danger').forEach(function (button) {
      button.style.display = canDelete ? "" : "none";
    });
  }

  function applyAllRoleUx() {
    Object.keys(SCHEMAS).forEach(applyRoleUx);
    document.querySelectorAll('[onclick^="quickAdd"]').forEach(function (button) {
      var match = String(button.getAttribute("onclick") || "").match(/quickAdd\(['"]([^'"]+)/);
      button.style.display = match && userCanCreate(match[1]) ? "" : "none";
    });
  }

  var responsiveRenderTable = renderTable;
  renderTable = function (sheet, rows, wrap) {
    responsiveRenderTable(sheet, rows, wrap);
    var table = wrap && wrap.querySelector("table");
    if (table) decorateResponsiveTable(table);
    applyRoleUx(sheet);
  };

  var responsiveRoleAccess = syncRoleAccess;
  syncRoleAccess = function () {
    responsiveRoleAccess();
    applyAllRoleUx();
  };

  var responsiveAdminOpen = openAdminPanelForCurrentUser;
  openAdminPanelForCurrentUser = function () {
    responsiveAdminOpen();
    var saved = localStorage.getItem(ADMIN_TAB_KEY) || "access";
    setTimeout(function () { switchAdminTab(saved); }, 20);
  };

  document.addEventListener("DOMContentLoaded", function () {
    decorateAllResponsiveTables(document);
    applyAllRoleUx();
    var observer = new MutationObserver(function (changes) {
      changes.forEach(function (change) {
        Array.from(change.addedNodes || []).forEach(function (node) {
          if (!node || node.nodeType !== 1) return;
          if (node.matches && node.matches("table")) decorateResponsiveTable(node);
          else decorateAllResponsiveTables(node);
        });
      });
      applyAllRoleUx();
    });
    var observeRoot = document.getElementById("erp-app") || document.body || document.documentElement;
    if (observeRoot && observeRoot.nodeType === 1) {
      observer.observe(observeRoot, { childList:true, subtree:true });
    }
  });
})();

/* Employee owner lock and hidden system fields. */
(function () {
  "use strict";

  var SYSTEM_FIELD_PATTERNS = [
    /^_?updatedAt$/i,
    /^_synced$/i,
    /^syncStatus$/i,
    /^sheetStatus$/i,
    /สถานะ\s*ซิงก์/i
  ];
  var OWNER_FIELD_PATTERNS = [
    /^รหัสพนักงาน$/i,
    /^ผู้บันทึก$/i,
    /^ผู้รับผิดชอบ$/i,
    /^รหัสผู้รับผิดชอบ$/i,
    /^employee\s*id$/i,
    /^owner$/i
  ];

  function matchesAnyFieldPattern(name, patterns) {
    var text = String(name || "").trim();
    return patterns.some(function (pattern) { return pattern.test(text); });
  }

  function isSystemManagedField(name) {
    return matchesAnyFieldPattern(name, SYSTEM_FIELD_PATTERNS);
  }

  function isOwnerLockedField(name) {
    return matchesAnyFieldPattern(name, OWNER_FIELD_PATTERNS);
  }

  function currentEmployeeOwnerName() {
    if (!CURRENT_USER) return "";
    return CURRENT_USER.name || CURRENT_USER.fullName || CURRENT_USER.employeeId || CURRENT_USER.id || "";
  }

  function syncSystemSchemas() {
    if (typeof SCHEMAS === "undefined") return;
    Object.keys(SCHEMAS).forEach(function (sheet) {
      if (!Array.isArray(SCHEMAS[sheet])) return;
      var clean = SCHEMAS[sheet].filter(function (field) { return !isSystemManagedField(field); });
      if (clean.length !== SCHEMAS[sheet].length) {
        SCHEMAS[sheet] = clean;
        if (typeof saveSheetSchema === "function") saveSheetSchema(sheet, clean);
      }
    });
    if (typeof PREMIUM_TABLE_COLUMNS !== "undefined") {
      Object.keys(PREMIUM_TABLE_COLUMNS).forEach(function (sheet) {
        PREMIUM_TABLE_COLUMNS[sheet] = (PREMIUM_TABLE_COLUMNS[sheet] || []).filter(function (field) {
          return !isSystemManagedField(field);
        });
      });
    }
  }

  function stripSystemFieldsFromRows(rows) {
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      var clean = {};
      Object.keys(row || {}).forEach(function (key) {
        if (!isSystemManagedField(key)) clean[key] = row[key];
      });
      return clean;
    });
  }

  function removeSystemFieldsFromModal() {
    var form = document.getElementById("modal-form");
    if (!form) return;
    Array.prototype.forEach.call(form.querySelectorAll(".form-group"), function (group) {
      var label = group.querySelector(".form-label");
      var control = group.querySelector("[id^='field-']");
      var fieldName = control ? control.id.replace(/^field-/, "") : label ? label.textContent.replace("*", "").trim() : "";
      if (isSystemManagedField(fieldName)) group.remove();
    });
  }

  function lockOwnerFieldsInModal(data) {
    var form = document.getElementById("modal-form");
    if (!form) return;
    Array.prototype.forEach.call(form.querySelectorAll("[id^='field-']"), function (control) {
      var fieldName = control.id.replace(/^field-/, "");
      if (!isOwnerLockedField(fieldName)) return;
      var storedValue = data && data[fieldName];
      var ownerValue = EDIT_ID && storedValue ? storedValue : currentEmployeeOwnerName();
      control.value = ownerValue || control.value || "";
      control.readOnly = true;
      control.setAttribute("readonly", "readonly");
      control.setAttribute("aria-readonly", "true");
      control.classList.add("locked-owner-field");
      control.title = "ระบบล็อกตามผู้เข้าสู่ระบบ";
    });
  }

  function applyLockedDataDefaults(data, sheet) {
    var next = Object.assign({}, data || {});
    var fields = (SCHEMAS && SCHEMAS[sheet || CURRENT_PANEL]) || [];
    fields.forEach(function (field) {
      if (isOwnerLockedField(field) && !EDIT_ID) next[field] = currentEmployeeOwnerName();
    });
    next._synced = true;
    next._updatedAt = new Date().toISOString();
    return next;
  }

  syncSystemSchemas();

  var ownerLockBuildForm = buildForm;
  buildForm = window.buildForm = function (sheet, data) {
    ownerLockBuildForm(sheet, data);
    removeSystemFieldsFromModal();
    lockOwnerFieldsInModal(data || {});
  };

  var ownerLockPrepareApiData = prepareApiDataForSheet;
  prepareApiDataForSheet = window.prepareApiDataForSheet = function (data) {
    return ownerLockPrepareApiData(applyLockedDataDefaults(data, CURRENT_PANEL));
  };

  var ownerLockLocalWrite = localWrite;
  localWrite = window.localWrite = function (sheet, data) {
    return ownerLockLocalWrite(sheet, applyLockedDataDefaults(data, sheet));
  };

  var ownerLockLocalUpdate = localUpdate;
  localUpdate = window.localUpdate = function (sheet, id, data) {
    return ownerLockLocalUpdate(sheet, id, applyLockedDataDefaults(data, sheet));
  };

  var ownerLockRenderTable = renderTable;
  renderTable = window.renderTable = function (sheet, rows, wrap) {
    syncSystemSchemas();
    ownerLockRenderTable(sheet, stripSystemFieldsFromRows(rows), wrap);
    if (!wrap) return;
    var headers = Array.prototype.map.call(wrap.querySelectorAll("thead th"), function (th) {
      return th.textContent.replace("↕", "").trim();
    });
    headers.forEach(function (header, index) {
      if (!isSystemManagedField(header)) return;
      Array.prototype.forEach.call(wrap.querySelectorAll("tr"), function (row) {
        if (row.children[index]) row.children[index].remove();
      });
    });
  };

  document.addEventListener("DOMContentLoaded", syncSystemSchemas);
})();

/* Admin-only historical edit guard. */
(function () {
  "use strict";
  var previousUserCanEdit = userCanEdit;
  userCanEdit = window.userCanEdit = function (panel) {
    return !!(CURRENT_USER && CURRENT_USER.role === "admin" && (!previousUserCanEdit || previousUserCanEdit(panel) !== false));
  };
  var previousEditRow = editRow;
  editRow = window.editRow = function (sheet, id) {
    if (!CURRENT_USER || CURRENT_USER.role !== "admin") {
      toast("เฉพาะ Admin เท่านั้นที่แก้ไขข้อมูลย้อนหลังได้", "err");
      return;
    }
    return previousEditRow(sheet, id);
  };
})();

/* Final Executive visibility guard by employee id. */
(function () {
  "use strict";
  var EXECUTIVE_ID = "EMP-EXEC";
  var EXECUTIVE_VISIBLE_PANELS = [
    "dashboard",
    "sales",
    "customers",
    "contracts",
    "employees",
    "projects",
    "reports",
    "invoice",
    "kanban",
    "calendar",
    "ai",
    "marketing-dept",
    "marketing-contracts",
    "lead-connect",
    "construction",
    "finance"
  ];

  function isExecutiveUser() {
    var id = String(CURRENT_USER && (CURRENT_USER.employeeId || CURRENT_USER.id) || "").toUpperCase();
    return id === EXECUTIVE_ID || !!(CURRENT_USER && CURRENT_USER.role === "executive");
  }

  var executiveGuardCanView = userCanViewPanel;
  userCanViewPanel = window.userCanViewPanel = function (panel) {
    if (isExecutiveUser()) return EXECUTIVE_VISIBLE_PANELS.indexOf(panel) > -1;
    return executiveGuardCanView(panel);
  };

  var executiveGuardCanCreate = userCanCreate;
  var executiveGuardCanEdit = userCanEdit;
  var executiveGuardCanDelete = userCanDelete;
  userCanCreate = window.userCanCreate = function (panel) {
    if (isExecutiveUser()) return false;
    return executiveGuardCanCreate(panel);
  };
  userCanEdit = window.userCanEdit = function (panel) {
    if (isExecutiveUser()) return false;
    return executiveGuardCanEdit(panel);
  };
  userCanDelete = window.userCanDelete = function (panel) {
    if (isExecutiveUser()) return false;
    return executiveGuardCanDelete(panel);
  };
})();

/* Executive account and read-only permissions. */
(function () {
  "use strict";
  var executiveUser = {
    id: "EMP-EXEC",
    employeeId: "EMP-EXEC",
    name: "Executive",
    role: "executive",
    dept: "ผู้บริหาร",
    position: "ผู้บริหาร",
    pos: "ผู้บริหาร",
    avatar: "EX",
    email: "executive@erp.local",
    password: "aa123"
  };
  if (Array.isArray(USERS_DB) && !USERS_DB.some(function (user) {
    return String(user.employeeId || user.id || "").toUpperCase() === "EMP-EXEC";
  })) {
    USERS_DB.push(executiveUser);
  }
  DEFAULT_ROLE_PERMISSIONS.executive = Object.assign({}, DEFAULT_ROLE_PERMISSIONS.executive || {}, {
    sales: { view: true, create: false, edit: false, delete: false },
    customers: { view: true, create: false, edit: false, delete: false },
    contracts: { view: true, create: false, edit: false, delete: false },
    employees: { view: true, create: false, edit: false, delete: false },
    projects: { view: true, create: false, edit: false, delete: false },
    reports: { view: true },
    invoice: { view: true },
    kanban: { view: true },
    calendar: { view: true },
    ai: { view: true },
    "company-backoffice": { view: false },
    "marketing-dept": { view: true },
    "marketing-contracts": { view: true },
    "lead-connect": { view: true },
    construction: { view: true },
    finance: { view: true },
    "daily-report": { view: false },
    activity: { view: false },
    audit: { view: false },
    backup: { view: false },
    webhooks: { view: false },
    "custom-fields": { view: false },
    admin: { view: false }
  });
  var executiveBaseUserCanViewPanel = userCanViewPanel;
  userCanViewPanel = window.userCanViewPanel = function (panel) {
    if (CURRENT_USER && CURRENT_USER.role === "executive" && panel === "daily-report") return false;
    return executiveBaseUserCanViewPanel(panel);
  };
})();

/* Company backoffice structure: marketing first, remaining departments scaffolded. */
(function () {
  "use strict";

  var COMPANY_DEPARTMENTS = [
    {
      key: "executive",
      icon: "👨‍💼",
      name: "ผู้บริหาร",
      status: "โครงสร้าง",
      tasks: ["วางแผนกลยุทธ์", "กำกับดูแลภาพรวม", "ตัดสินใจนโยบาย"]
    },
    {
      key: "marketing",
      icon: "📢",
      name: "แผนกการตลาด",
      status: "ใช้งานวันนี้",
      active: true,
      tasks: ["ยิงโฆษณา (ADS)", "สร้างคอนเทนต์", "ดูแลเพจ/โซเชียล", "วิเคราะห์ผลการตลาด"]
    },
    {
      key: "sales",
      icon: "💬",
      name: "แผนกขาย",
      status: "โครงสร้าง",
      tasks: ["ตอบลูกค้า", "ปิดการขาย", "ออกใบเสนอราคา", "ติดตามลูกค้า"]
    },
    {
      key: "admin",
      icon: "📋",
      name: "แผนกแอดมิน",
      status: "โครงสร้าง",
      tasks: ["งานเอกสาร", "ประสานงาน", "จัดเก็บข้อมูล", "ดูแลระบบภายใน"]
    },
    {
      key: "production",
      icon: "🏗️",
      name: "แผนกก่อสร้าง/ผลิต",
      status: "โครงสร้าง",
      tasks: ["ควบคุมงานหน้างาน", "วางแผนก่อสร้าง", "ตรวจคุณภาพงาน", "ส่งมอบงาน"]
    },
    {
      key: "finance",
      icon: "💰",
      name: "แผนกการเงินและบัญชี",
      status: "โครงสร้าง",
      tasks: ["รับ-จ่ายเงิน", "บัญชีรายรับรายจ่าย", "ภาษี", "รายงานการเงิน"]
    },
    {
      key: "hr",
      icon: "👥",
      name: "แผนกบุคคล (HR)",
      status: "โครงสร้าง",
      tasks: ["สรรหาพนักงาน", "อบรมพัฒนา", "ประเมินผล", "ดูแลสวัสดิการ"]
    }
  ];

  var MARKETING_PIPELINE = [
    { step: "ตรวจงบ ADS", detail: "ดูงบต่อวัน แคมเปญที่ใช้เงินสูง และยอด lead" },
    { step: "วางคอนเทนต์", detail: "กำหนดโพสต์/วิดีโอ/รีวิวที่ต้องผลิตวันนี้" },
    { step: "ตอบเพจและโซเชียล", detail: "แยกลูกค้าสนใจจริงส่งต่อฝ่ายขาย" },
    { step: "สรุปผล", detail: "บันทึก CTR, CPL, Lead และยอดนัดหมาย" }
  ];

  var MARKETING_HISTORY = [
    { date: "18 มิ.ย.", platform: "FB+TT", lead: 24, cpl: 185, budget: 4440 },
    { date: "17 มิ.ย.", platform: "FB+TT", lead: 18, cpl: 197, budget: 3546 },
    { date: "16 มิ.ย.", platform: "FB", lead: 11, cpl: 172, budget: 1892 },
    { date: "15 มิ.ย.", platform: "FB+TT", lead: 20, cpl: 181, budget: 3620 },
    { date: "14 มิ.ย.", platform: "TT", lead: 7, cpl: 240, budget: 1680 },
    { date: "13 มิ.ย.", platform: "FB+TT", lead: 22, cpl: 176, budget: 3872 },
    { date: "12 มิ.ย.", platform: "FB", lead: 14, cpl: 168, budget: 2352 }
  ];
  var MARKETING_CONTRACT_KEY = "erp-marketing-media-contracts";
  var MARKETING_CAMPAIGN_KEY = "erp-marketing-campaigns";
  var MARKETING_LIVE_ENDPOINT_KEY = "erp-marketing-ads-live-endpoint";
  var MARKETING_LIVE_CACHE_KEY = "erp-marketing-ads-live-cache";
  var MARKETING_LIVE_FETCHING = false;
  var MARKETING_LIVE_LAST_AUTO_FETCH = 0;
  var MARKETING_LIVE_STATE = { source: "manual", rows: null, updatedAt: null, message: "" };
  var MARKETING_CAMPAIGN_EDIT_ID = null;
  var MARKETING_CAMPAIGN_SEED = [
    { id: 1, name: "บ้านเดี่ยว 3 ห้องนอน", platform: "FB", budgetDay: 3000, spent: 52400, lead: 198, ctr: 3.9, reach: 120000, impression: 280000, status: "active", note: "" },
    { id: 2, name: "ทาวน์โฮม Start 1.59M", platform: "TT", budgetDay: 1500, spent: 18600, lead: 67, ctr: 1.2, reach: 45000, impression: 98000, status: "active", note: "" },
    { id: 3, name: "บ้านแฝด ราคาพิเศษ", platform: "FB", budgetDay: 2000, spent: 19800, lead: 88, ctr: 3.1, reach: 78000, impression: 160000, status: "active", note: "" },
    { id: 4, name: "คอนโด ใกล้ BTS", platform: "TT", budgetDay: 1000, spent: 13500, lead: 47, ctr: 2.8, reach: 32000, impression: 74000, status: "paused", note: "รอ Creative ใหม่" },
    { id: 5, name: "บ้านเดี่ยว Premium", platform: "FB", budgetDay: 2500, spent: 0, lead: 0, ctr: 0, reach: 0, impression: 0, status: "active", note: "" }
  ];
  var MARKETING_CONTRACT_SEED = [
    { id: 1, name: "Billboard ถนนพหลโยธิน", location: "หน้า Central Ladprao", type: "Billboard", start: "2026-01-01", end: "2026-07-15", cost: 25000, note: "ต่อสัญญาล่วงหน้า 1 เดือน" },
    { id: 2, name: "ป้ายไฟหน้าโครงการ", location: "สำนักงานขาย", type: "Lightbox", start: "2026-02-01", end: "2026-06-30", cost: 8000, note: "" },
    { id: 3, name: "ป้ายโครงการลาดกระบัง", location: "ถนนลาดกระบัง กม.5", type: "Project Sign", start: "2026-01-01", end: "2026-06-20", cost: 5000, note: "ตรวจสภาพป้ายก่อนต่ออายุ" },
    { id: 4, name: "Billboard รามอินทรา", location: "แยกรามอินทรา-วัชรพล", type: "Billboard", start: "2026-06-01", end: "2027-05-31", cost: 32000, note: "สัญญา 12 เดือน" }
  ];
  var MARKETING_CONTRACT_EDIT_ID = null;
  var MARKETING_CONTRACT_PHOTO = "";

  function rowsForBackoffice(sheet) {
    if (typeof allRows === "function") return allRows(sheet) || [];
    if (typeof getLocalRows === "function") return getLocalRows(sheet) || [];
    return [];
  }

  function moneyForBackoffice(value) {
    var num = Number(value || 0);
    if (!isFinite(num)) num = 0;
    return "฿" + num.toLocaleString("th-TH", { maximumFractionDigits: 0 });
  }

  function marketingEmployeeCount() {
    var users = typeof getDbUsers === "function" ? getDbUsers() : [];
    return users.filter(function (user) {
      return /การตลาด|ยิงแอด|marketing/i.test(String(user.dept || user.position || user.pos || ""));
    }).length;
  }

  function renderCompanyOrgTree() {
    var wrap = document.getElementById("company-org-tree");
    if (!wrap) return;
    var html = COMPANY_DEPARTMENTS.map(function (dept) {
      return '<article class="company-dept-node' + (dept.active ? " is-active" : "") + '" data-dept="' + dept.key + '">' +
        '<div class="company-dept-head">' +
          '<div class="company-dept-icon">' + dept.icon + '</div>' +
          '<div><div class="company-dept-name">' + escapeHtml(dept.name) + '</div><div class="company-dept-status">' + escapeHtml(dept.status) + '</div></div>' +
        '</div>' +
        '<ul>' + dept.tasks.map(function (task) { return '<li>' + escapeHtml(task) + '</li>'; }).join("") + '</ul>' +
      '</article>';
    }).join("");
    wrap.innerHTML = html;
    var count = document.getElementById("company-dept-count");
    if (count) count.textContent = COMPANY_DEPARTMENTS.length + " แผนก";
  }

  function renderMarketingWorkspace() {
    var salesRows = rowsForBackoffice("sales");
    var customerRows = rowsForBackoffice("customers");
    var totalSales = salesRows.reduce(function (sum, row) {
      var amount = row["ยอดขาย"] || row["มูลค่า"] || row["จำนวนเงิน"] || row.amount || row.total || 0;
      return sum + (Number(String(amount).replace(/[^0-9.-]/g, "")) || 0);
    }, 0);
    var stats = [
      { label: "ADS", value: "4 งาน", sub: "แคมเปญเริ่มต้น", tone: "blue" },
      { label: "Lead/ลูกค้า", value: customerRows.length || 0, sub: "จากข้อมูลลูกค้า", tone: "green" },
      { label: "ยอดขายที่เกี่ยวข้อง", value: moneyForBackoffice(totalSales), sub: "อ่านจาก Sales", tone: "teal" },
      { label: "ทีมการตลาด", value: marketingEmployeeCount() || 1, sub: "พนักงานในระบบ", tone: "amber" }
    ];
    var statWrap = document.getElementById("marketing-stat-grid");
    if (statWrap) {
      statWrap.innerHTML = stats.map(function (stat) {
        return '<div class="marketing-stat ' + stat.tone + '">' +
          '<div class="marketing-stat-label">' + escapeHtml(stat.label) + '</div>' +
          '<div class="marketing-stat-value">' + escapeHtml(String(stat.value)) + '</div>' +
          '<div class="marketing-stat-sub">' + escapeHtml(stat.sub) + '</div>' +
        '</div>';
      }).join("");
    }

    var taskWrap = document.getElementById("marketing-task-list");
    if (taskWrap) {
      var marketing = COMPANY_DEPARTMENTS.find(function (dept) { return dept.key === "marketing"; });
      taskWrap.innerHTML = marketing.tasks.map(function (task, index) {
        var labels = ["แคมเปญ", "Content", "Social", "Report"];
        return '<div class="marketing-task-item">' +
          '<span class="marketing-task-check">✓</span>' +
          '<div><b>' + escapeHtml(task) + '</b><small>' + escapeHtml(labels[index] || "Marketing") + '</small></div>' +
        '</div>';
      }).join("");
    }

    var pipelineWrap = document.getElementById("marketing-pipeline");
    if (pipelineWrap) {
      pipelineWrap.innerHTML = MARKETING_PIPELINE.map(function (item, index) {
        return '<div class="marketing-pipeline-row">' +
          '<span class="marketing-pipeline-no">' + String(index + 1).padStart(2, "0") + '</span>' +
          '<div><b>' + escapeHtml(item.step) + '</b><small>' + escapeHtml(item.detail) + '</small></div>' +
        '</div>';
      }).join("");
    }

    var analysisWrap = document.getElementById("marketing-analysis-grid");
    if (analysisWrap) {
      var analysis = [
        ["CTR", "อัตราคลิกโฆษณา", "รอเชื่อมข้อมูล ADS"],
        ["CPL", "ต้นทุนต่อ lead", "ใช้กรอกงบโฆษณา"],
        ["Content", "จำนวนโพสต์/ชิ้นงาน", "เชื่อมกับรายงานประจำวัน"],
        ["Conversion", "ลูกค้าสนใจเป็นยอดขาย", "ดึง Sales + ลูกค้า"]
      ];
      analysisWrap.innerHTML = analysis.map(function (row) {
        return '<div class="marketing-analysis-item"><b>' + escapeHtml(row[0]) + '</b><span>' + escapeHtml(row[1]) + '</span><small>' + escapeHtml(row[2]) + '</small></div>';
      }).join("");
    }
  }

  function renderMarketingDeptSummary() {
    var wrap = document.getElementById("marketing-dept-summary");
    if (!wrap) return;
    var rows = [
      { label: "CTR เฉลี่ย", value: "3.2%", sub: "+0.4% จากเมื่อวาน", tone: "blue" },
      { label: "CPL เฉลี่ย", value: "฿185", sub: "เป้าหมายไม่เกิน ฿200", tone: "amber" },
      { label: "Lead ทั้งหมด", value: "24", sub: "Facebook 16 / TikTok 8", tone: "green" },
      { label: "งบที่ใช้", value: "฿4,440", sub: "เป้า ฿5,000/วัน", tone: "teal" },
      { label: "Reach รวม", value: "18,200", sub: "+2,100 วันนี้", tone: "blue" },
      { label: "Impression", value: "31,450", sub: "รวม 2 platform", tone: "green" }
    ];
    wrap.innerHTML = rows.map(function (item) {
      return '<div class="marketing-dept-stat ' + item.tone + '">' +
        '<div class="marketing-dept-stat-label">' + escapeHtml(item.label) + '</div>' +
        '<div class="marketing-dept-stat-value">' + escapeHtml(item.value) + '</div>' +
        '<div class="marketing-dept-stat-sub">' + escapeHtml(item.sub) + '</div>' +
      '</div>';
    }).join("");
  }

  function renderMarketingDeptTasks() {
    var taskWrap = document.getElementById("marketing-dept-task-list");
    if (taskWrap) {
      var marketing = COMPANY_DEPARTMENTS.find(function (dept) { return dept.key === "marketing"; });
      var labels = ["Campaign", "Content", "Social", "Report"];
      taskWrap.innerHTML = marketing.tasks.map(function (task, index) {
        return '<div class="marketing-dept-task">' +
          '<span>✓</span><div><b>' + escapeHtml(task) + '</b><small>' + escapeHtml(labels[index] || "Marketing") + '</small></div>' +
        '</div>';
      }).join("");
    }
    var pipelineWrap = document.getElementById("marketing-dept-pipeline");
    if (pipelineWrap) {
      pipelineWrap.innerHTML = MARKETING_PIPELINE.map(function (item, index) {
        return '<div class="marketing-dept-pipeline-row">' +
          '<span>' + String(index + 1).padStart(2, "0") + '</span><div><b>' + escapeHtml(item.step) + '</b><small>' + escapeHtml(item.detail) + '</small></div>' +
        '</div>';
      }).join("");
    }
  }

  function platformMetricCard(label, value, sub, tone) {
    return '<div class="marketing-mini-metric ' + (tone || "") + '"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b><small>' + escapeHtml(sub || "") + '</small></div>';
  }

  function marketingCampaigns() {
    try {
      var saved = JSON.parse(localStorage.getItem(MARKETING_CAMPAIGN_KEY) || "null");
      return Array.isArray(saved) ? saved : MARKETING_CAMPAIGN_SEED.slice();
    } catch (e) {
      return MARKETING_CAMPAIGN_SEED.slice();
    }
  }

  function saveMarketingCampaigns(rows) {
    localStorage.setItem(MARKETING_CAMPAIGN_KEY, JSON.stringify(rows || []));
  }

  function marketingLiveEndpoint() {
    return String((window.ADS_LIVE_ENDPOINT || localStorage.getItem(MARKETING_LIVE_ENDPOINT_KEY) || "")).trim();
  }

  function marketingNumber(value) {
    if (value == null || value === "") return 0;
    var cleaned = String(value).replace(/[^\d.-]/g, "");
    var number = Number(cleaned);
    return isFinite(number) ? number : 0;
  }

  function marketingLivePlatform(value) {
    var text = String(value || "").toLowerCase();
    if (text.indexOf("tiktok") > -1 || text === "tt") return "TT";
    return "FB";
  }

  function marketingLiveStatus(value) {
    var text = String(value || "").toLowerCase();
    if (text.indexOf("pause") > -1 || text.indexOf("พัก") > -1) return "paused";
    if (text.indexOf("end") > -1 || text.indexOf("complete") > -1 || text.indexOf("จบ") > -1) return "ended";
    return "active";
  }

  function marketingLivePayloadRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    if (payload.ok === false) throw new Error(payload.msg || payload.error || "ADS API rejected");
    return payload.campaigns || payload.rows || payload.data || payload.ads || payload.items || [];
  }

  function normalizeMarketingLiveRows(payload) {
    return marketingLivePayloadRows(payload).map(function (row, index) {
      var name = row.name || row.campaignName || row.campaign_name || row.campaign || row.ad_name || row.adset_name;
      return {
        id: row.id || row.campaignId || row.campaign_id || ("live-" + index),
        name: String(name || ("Campaign " + (index + 1))),
        platform: marketingLivePlatform(row.platform || row.source || row.channel || row.accountPlatform),
        accountId: String(row.accountId || row.account_id || row.adAccountId || row.ad_account_id || ""),
        budgetDay: marketingNumber(row.budgetDay || row.dailyBudget || row.daily_budget || row.budget),
        spent: marketingNumber(row.spent || row.spend || row.amount_spent || row.cost),
        lead: marketingNumber(row.lead || row.leads || row.lead_count || row.results || row.conversions),
        ctr: marketingNumber(row.ctr || row.ctr_percent || row.click_through_rate),
        reach: marketingNumber(row.reach || row.unique_reach),
        impression: marketingNumber(row.impression || row.impressions),
        status: marketingLiveStatus(row.status || row.effective_status),
        note: String(row.note || row.objective || row.optimization_goal || "")
      };
    }).filter(function (row) {
      return row.name && (row.spent || row.lead || row.reach || row.impression || row.budgetDay);
    });
  }

  function getMarketingLiveSession() {
    return window.ERP_SECURITY && window.ERP_SECURITY.getSession && window.ERP_SECURITY.getSession();
  }

  async function fetchMarketingLivePayload() {
    var endpoint = marketingLiveEndpoint();
    if (endpoint) {
      var url = endpoint + (endpoint.indexOf("?") > -1 ? "&" : "?") + "v=" + Date.now();
      return fetchJsonUrl(url);
    }
    if (API_URL && (API_TOKEN || getMarketingLiveSession())) {
      var actions = ["adsLive", "ads_live", "marketingAds", "marketing_ads"];
      var lastError = null;
      for (var i = 0; i < actions.length; i += 1) {
        try {
          return await apiGet({ action: actions[i] });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("ADS API unavailable");
    }
    throw new Error("ยังไม่ได้ตั้งค่า ADS Live API");
  }

  function loadMarketingLiveCache() {
    try {
      var saved = JSON.parse(localStorage.getItem(MARKETING_LIVE_CACHE_KEY) || "null");
      if (saved && Array.isArray(saved.rows) && saved.rows.length) return saved;
    } catch (e) {}
    return null;
  }

  function saveMarketingLiveCache(rows, source) {
    localStorage.setItem(MARKETING_LIVE_CACHE_KEY, JSON.stringify({
      rows: rows || [],
      source: source || "live",
      updatedAt: new Date().toISOString()
    }));
  }

  function marketingDashboardRows() {
    if (MARKETING_LIVE_STATE.rows && MARKETING_LIVE_STATE.rows.length) return MARKETING_LIVE_STATE.rows;
    var cache = loadMarketingLiveCache();
    if (cache) {
      MARKETING_LIVE_STATE = { source: cache.source || "cache", rows: cache.rows, updatedAt: cache.updatedAt, message: "ข้อมูลล่าสุดที่บันทึกไว้" };
      return cache.rows;
    }
    return marketingCampaigns();
  }

  function setMarketingLiveSource(source, rows, message) {
    MARKETING_LIVE_STATE = {
      source: source || "manual",
      rows: rows && rows.length ? rows : null,
      updatedAt: new Date().toISOString(),
      message: message || ""
    };
  }

  function marketingLiveStatusText() {
    if (MARKETING_LIVE_FETCHING) return "กำลังเชื่อมต่อ";
    if (MARKETING_LIVE_STATE.source === "live") return "Live API";
    if (MARKETING_LIVE_STATE.source === "cache") return "Cache ล่าสุด";
    return "Manual Data";
  }

  function updateMarketingConnectBanner() {
    var banner = document.getElementById("marketing-connect-banner");
    if (!banner) return;
    var endpoint = marketingLiveEndpoint();
    var title = MARKETING_LIVE_STATE.source === "live" ? "ADS Live เชื่อมต่อ Backend แล้ว" : "ADS Manager ใช้ข้อมูล Manual ในระบบ";
    var detail = MARKETING_LIVE_STATE.source === "live"
      ? "ข้อมูลถูกดึงผ่าน Backend/API แล้วแปลงเข้า Dashboard อัตโนมัติ"
      : (endpoint ? "ตั้งค่า API ไว้แล้ว กด Refresh เพื่อดึงข้อมูลล่าสุด" : "กด เชื่อม API เพื่อใส่ URL Backend/Apps Script ที่ดึงข้อมูลโฆษณาไว้แล้ว");
    if (MARKETING_LIVE_STATE.message) detail = MARKETING_LIVE_STATE.message;
    banner.querySelector("b").textContent = title;
    banner.querySelector("span").textContent = detail;
  }

  async function refreshMarketingLiveData(showToast) {
    if (MARKETING_LIVE_FETCHING) return;
    MARKETING_LIVE_FETCHING = true;
    updateMarketingConnectBanner();
    try {
      var payload = await fetchMarketingLivePayload();
      var rows = normalizeMarketingLiveRows(payload);
      if (!rows.length) throw new Error("API ไม่มีข้อมูลแคมเปญ");
      setMarketingLiveSource("live", rows, "");
      saveMarketingLiveCache(rows, "live");
      renderMarketingAdsOverview();
      renderMarketingCampaigns();
      if (showToast) toast("เชื่อมข้อมูล ADS Live สำเร็จ", "ok");
    } catch (error) {
      var cache = loadMarketingLiveCache();
      if (cache) {
        setMarketingLiveSource("cache", cache.rows, "ใช้ข้อมูลล่าสุดที่เคยเชื่อมได้ เพราะ API ยังไม่ตอบกลับ");
      } else {
        setMarketingLiveSource("manual", null, error.message || "ใช้ข้อมูล Manual เพราะ API ยังไม่พร้อม");
      }
      renderMarketingAdsOverview();
      renderMarketingCampaigns();
      if (showToast) toast((error.message || "ADS API ยังไม่พร้อม") + " - ใช้ข้อมูลสำรอง", "info");
    } finally {
      MARKETING_LIVE_FETCHING = false;
      updateMarketingConnectBanner();
    }
  }

  function marketingMoney(value) {
    return "฿" + Number(value || 0).toLocaleString("th-TH", { maximumFractionDigits: 0 });
  }

  function marketingCampaignTotals(rows) {
    return rows.reduce(function (sum, row) {
      sum.spent += Number(row.spent || 0);
      sum.lead += Number(row.lead || 0);
      sum.reach += Number(row.reach || 0);
      sum.impression += Number(row.impression || 0);
      if (Number(row.ctr || 0) > 0) {
        sum.ctrTotal += Number(row.ctr || 0);
        sum.ctrCount += 1;
      }
      return sum;
    }, { spent: 0, lead: 0, reach: 0, impression: 0, ctrTotal: 0, ctrCount: 0 });
  }

  function marketingLiveAccounts(rows) {
    return ["FB", "TT"].map(function (platform) {
      var list = rows.filter(function (row) { return row.platform === platform; });
      var totals = marketingCampaignTotals(list);
      return {
        id: platform,
        platform: platform,
        name: platform === "FB" ? "Facebook / Meta Ads" : "TikTok Ads",
        accountId: (list[0] && list[0].accountId) || (platform === "FB" ? "act_demo_meta" : "tt_demo_ads"),
        dailyBudget: list.reduce(function (sum, row) { return sum + Number(row.budgetDay || 0); }, 0),
        campaigns: list,
        totals: totals
      };
    }).filter(function (account) { return account.campaigns.length; });
  }

  function marketingLiveStatusLabel(status) {
    return ({ active:"กำลังรัน", paused:"พักไว้", ended:"จบแล้ว" })[status] || status || "-";
  }

  function marketingLiveKpi(label, value, sub, tone) {
    return '<article class="marketing-live-kpi ' + (tone || "") + '"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b><small>' + escapeHtml(sub || "") + '</small></article>';
  }

  function renderMarketingLiveDashboard(rows, totals, totalBudget, cpl, ctrAvg) {
    var overview = document.getElementById("marketing-overview-grid");
    var accountWrap = document.getElementById("marketing-platform-overview");
    var update = document.getElementById("marketing-live-update");
    var status = document.getElementById("marketing-live-status");
    if (update) update.textContent = "อัปเดตล่าสุด: " + new Date().toLocaleTimeString("th-TH", { hour:"2-digit", minute:"2-digit" });
    if (status) status.innerHTML = "<i></i> " + escapeHtml(marketingLiveStatusText());
    updateMarketingConnectBanner();
    if (overview) {
      overview.innerHTML =
        marketingLiveKpi("Lead รวมทั้งหมด", String(totals.lead || 0), "ทุก Account", "up") +
        marketingLiveKpi("CPL เฉลี่ย", marketingMoney(cpl || 0), "บาท/Lead", "") +
        marketingLiveKpi("งบรวมที่ใช้", marketingMoney(totals.spent || 0), "จาก " + marketingMoney(totalBudget || 0), "") +
        marketingLiveKpi("CTR เฉลี่ย", (ctrAvg || "0.0") + "%", "ทุกแคมเปญที่มีข้อมูล", "up") +
        marketingLiveKpi("แคมเปญทั้งหมด", String(rows.length || 0), marketingLiveAccounts(rows).length + " Account", "warn");
    }
    if (!accountWrap) return;
    var accounts = marketingLiveAccounts(rows);
    if (overview) {
      overview.innerHTML =
        marketingLiveKpi("งบที่ใช้", marketingMoney(totals.spent || 0), "จาก " + marketingMoney(totalBudget || 0), "") +
        marketingLiveKpi("Lead รวม", String(totals.lead || 0), "ทุกแคมเปญ", "up") +
        marketingLiveKpi("CPL เฉลี่ย", marketingMoney(cpl || 0), "ต้นทุนต่อ Lead", "") +
        marketingLiveKpi("CTR เฉลี่ย", (ctrAvg || "0.0") + "%", "เฉลี่ยแคมเปญที่มีข้อมูล", "up") +
        marketingLiveKpi("Reach", Number(totals.reach || 0).toLocaleString("th-TH"), "รวมทุก Platform", "") +
        marketingLiveKpi("Impression", Number(totals.impression || 0).toLocaleString("th-TH"), "รวมทุก Platform", "");
    }
    if (!accounts.length) {
      accountWrap.innerHTML = '<div class="empty"><div class="empty-icon">📊</div><div class="empty-text">ยังไม่มีแคมเปญ กด + เพิ่มแคมเปญ เพื่อเริ่มใช้งาน</div></div>';
      return;
    }
    accountWrap.innerHTML = accounts.map(function (account) {
      var accountCpl = account.totals.lead ? Math.round(account.totals.spent / account.totals.lead) : 0;
      var accountCtr = account.totals.ctrCount ? (account.totals.ctrTotal / account.totals.ctrCount).toFixed(1) : "0.0";
      var activeCount = account.campaigns.filter(function (row) { return row.status === "active"; }).length;
      var logoClass = account.platform === "FB" ? "fb" : "tt";
      var logoText = account.platform === "FB" ? "f" : "TT";
      var body = account.campaigns.map(function (campaign) {
        var budgetBase = Math.max(1, Number(campaign.budgetDay || 0) * 30);
        var budgetPct = Math.min(100, Math.round(Number(campaign.spent || 0) / budgetBase * 100));
        var barColor = budgetPct > 85 ? "var(--red)" : budgetPct > 60 ? "var(--amber)" : "var(--green)";
        var campaignCpl = Number(campaign.lead || 0) ? Math.round(Number(campaign.spent || 0) / Number(campaign.lead || 1)) : 0;
        return '<div class="marketing-live-campaign-row">' +
          '<div><b>' + escapeHtml(campaign.name) + '</b><small>' + escapeHtml(campaign.note || marketingLiveStatusLabel(campaign.status)) + '</small></div>' +
          '<div>' + Number(campaign.lead || 0).toLocaleString("th-TH") + '</div>' +
          '<div><b>' + marketingMoney(campaign.spent) + '</b><div class="marketing-live-progress"><i style="width:' + budgetPct + '%;background:' + barColor + '"></i></div></div>' +
          '<div>' + marketingMoney(campaignCpl) + '</div>' +
          '<div>' + Number(campaign.ctr || 0).toFixed(1) + '%</div>' +
          '<div><select class="marketing-live-status-select ' + escapeHtml(campaign.status || "") + '" onchange="setMarketingCampaignStatus(' + Number(campaign.id) + ',this.value)">' +
            '<option value="active"' + (campaign.status === "active" ? " selected" : "") + '>กำลังรัน</option>' +
            '<option value="paused"' + (campaign.status === "paused" ? " selected" : "") + '>พักไว้</option>' +
            '<option value="ended"' + (campaign.status === "ended" ? " selected" : "") + '>จบแล้ว</option>' +
          '</select></div>' +
          '<button class="marketing-live-icon-btn" type="button" onclick="deleteMarketingCampaignLive(' + Number(campaign.id) + ')" title="ลบ">×</button>' +
        '</div>';
      }).join("");
      return '<article class="marketing-live-account open" data-marketing-account="' + account.platform + '">' +
        '<button class="marketing-live-account-head" type="button" onclick="toggleMarketingLiveAccount(&quot;' + account.platform + '&quot;)">' +
          '<div class="marketing-platform-logo ' + logoClass + '">' + logoText + '</div>' +
          '<div class="marketing-live-account-name"><b>' + escapeHtml(account.name) + '</b><small>' + escapeHtml(account.accountId) + ' · งบ/วัน ' + marketingMoney(account.dailyBudget) + ' · ' + activeCount + '/' + account.campaigns.length + ' แคมเปญรัน</small></div>' +
          '<div class="marketing-live-account-stats"><div><span>Lead</span><b>' + Number(account.totals.lead || 0).toLocaleString("th-TH") + '</b></div><div><span>CPL</span><b>' + marketingMoney(accountCpl) + '</b></div><div><span>CTR</span><b>' + accountCtr + '%</b></div><div><span>งบ</span><b>' + marketingMoney(account.totals.spent) + '</b></div></div>' +
          '<span class="marketing-live-chevron">⌄</span>' +
        '</button>' +
        '<div class="marketing-live-campaigns"><div class="marketing-live-campaign-head"><span>Campaign</span><span>Lead</span><span>ใช้แล้ว</span><span>CPL</span><span>CTR</span><span>สถานะ</span><span></span></div>' + body + '</div>' +
      '</article>';
    }).join("");
  }

  window.toggleMarketingLiveAccount = function (platform) {
    var account = document.querySelector('[data-marketing-account="' + platform + '"]');
    if (account) account.classList.toggle("open");
  };

  window.refreshMarketingLiveDashboard = function () {
    refreshMarketingLiveData(true);
  };

  window.openMarketingAdsConnection = function () {
    var current = marketingLiveEndpoint();
    var url = prompt("วาง URL Backend/Apps Script สำหรับ ADS Live (ปล่อยว่างเพื่อล้างค่า)", current);
    if (url === null) return;
    url = String(url || "").trim();
    if (!url) {
      localStorage.removeItem(MARKETING_LIVE_ENDPOINT_KEY);
      localStorage.removeItem(MARKETING_LIVE_CACHE_KEY);
      setMarketingLiveSource("manual", null, "ล้างการเชื่อม API แล้ว ใช้ข้อมูล Manual");
      renderMarketingAdsOverview();
      renderMarketingCampaigns();
      toast("กลับไปใช้ข้อมูล Manual แล้ว", "ok");
      return;
    }
    localStorage.setItem(MARKETING_LIVE_ENDPOINT_KEY, url);
    refreshMarketingLiveData(true);
  };

  window.useMarketingManualAds = function () {
    localStorage.removeItem(MARKETING_LIVE_CACHE_KEY);
    setMarketingLiveSource("manual", null, "ใช้ข้อมูล Manual จากแคมเปญที่บันทึกในระบบ");
    renderMarketingAdsOverview();
    renderMarketingCampaigns();
    toast("สลับเป็นข้อมูล Manual แล้ว", "ok");
  };

  window.setMarketingCampaignStatus = function (id, status) {
    var rows = marketingCampaigns();
    rows.forEach(function (row) {
      if (Number(row.id) === Number(id)) row.status = status;
    });
    saveMarketingCampaigns(rows);
    if (typeof renderMarketingLiveDashboardNow === "function") renderMarketingLiveDashboardNow();
    renderMarketingCampaigns();
  };

  window.deleteMarketingCampaignLive = function (id) {
    if (!confirm("ลบแคมเปญนี้?")) return;
    var rows = marketingCampaigns().filter(function (row) { return Number(row.id) !== Number(id); });
    saveMarketingCampaigns(rows);
    renderMarketingAdsOverview();
    renderMarketingCampaigns();
    toast("ลบแคมเปญแล้ว", "ok");
  };

  function renderMarketingAdsOverview() {
    var rows = marketingDashboardRows();
    var totals = marketingCampaignTotals(rows);
    var totalBudgetInput = document.getElementById("marketing-budget-total");
    var totalBudget = Number(totalBudgetInput && totalBudgetInput.value) || 150000;
    var left = Math.max(0, totalBudget - totals.spent);
    var pct = totalBudget > 0 ? Math.round((totals.spent / totalBudget) * 100) : 0;
    var cpl = totals.lead > 0 ? Math.round(totals.spent / totals.lead) : 0;
    var ctrAvg = totals.ctrCount ? (totals.ctrTotal / totals.ctrCount).toFixed(1) : "0.0";
    var used = document.getElementById("marketing-budget-used-label");
    var leftEl = document.getElementById("marketing-budget-left-label");
    var fill = document.getElementById("marketing-budget-progress-fill");
    var pctEl = document.getElementById("marketing-budget-percent-label");
    if (used) used.textContent = marketingMoney(totals.spent);
    if (leftEl) leftEl.textContent = "เหลือ " + marketingMoney(left);
    if (fill) {
      fill.style.width = Math.min(pct, 100) + "%";
      fill.style.background = pct > 80 ? "var(--red)" : "var(--amber)";
    }
    if (pctEl) pctEl.textContent = "ใช้ไปแล้ว " + pct + "% ของงบทั้งเดือน";
    var overview = document.getElementById("marketing-overview-grid");
    if (overview) {
      overview.innerHTML =
        platformMetricCard("งบที่ใช้", marketingMoney(totals.spent), "จาก " + marketingMoney(totalBudget), "") +
        platformMetricCard("Lead รวม", String(totals.lead), "ทุกแคมเปญ", "up") +
        platformMetricCard("CPL เฉลี่ย", marketingMoney(cpl), "ต้นทุนต่อ Lead", "") +
        platformMetricCard("CTR เฉลี่ย", ctrAvg + "%", "เฉลี่ยแคมเปญที่มีข้อมูล", "up") +
        platformMetricCard("Reach", totals.reach.toLocaleString("th-TH"), "รวมทุก Platform", "") +
        platformMetricCard("Impression", totals.impression.toLocaleString("th-TH"), "รวมทุก Platform", "");
    }
    var platformWrap = document.getElementById("marketing-platform-overview");
    if (platformWrap) {
      function platformCard(platform, label, logoClass, logoText) {
        var list = rows.filter(function (row) { return row.platform === platform; });
        var t = marketingCampaignTotals(list);
        return '<div class="marketing-platform-card"><div class="marketing-platform-head"><div class="marketing-platform-logo ' + logoClass + '">' + logoText + '</div><div><b>' + label + '</b><small>' + list.length + ' แคมเปญ</small></div></div><div class="marketing-mini-grid">' +
          platformMetricCard("งบที่ใช้", marketingMoney(t.spent), "", "") +
          platformMetricCard("Lead", String(t.lead), "", "up") +
          platformMetricCard("CTR", (t.ctrCount ? (t.ctrTotal / t.ctrCount).toFixed(1) : "0.0") + "%", "", "") +
          platformMetricCard("CPL", marketingMoney(t.lead ? Math.round(t.spent / t.lead) : 0), "", "") +
        '</div></div>';
      }
      platformWrap.innerHTML = platformCard("FB", "Facebook / Meta Ads", "fb", "f") + platformCard("TT", "TikTok Ads", "tt", "♪");
    }
    renderMarketingLiveDashboard(rows, totals, totalBudget, cpl, ctrAvg);
    var ai = document.getElementById("marketing-overview-ai");
    if (ai) {
      ai.innerHTML = '<b>สรุปจากข้อมูลแคมเปญ</b><p>Facebook ยังให้ Lead คุ้มกว่าในชุดข้อมูลตัวอย่าง ส่วน TikTok มีแคมเปญที่ CTR ต่ำ ควรปรับ Creative และเทียบ CPL รายแคมเปญก่อนเพิ่มงบ</p>';
    }
  }

  window.renderMarketingLiveDashboardNow = function () {
    var rows = marketingDashboardRows();
    var totals = marketingCampaignTotals(rows);
    var totalBudgetInput = document.getElementById("marketing-budget-total");
    var totalBudget = Number(totalBudgetInput && totalBudgetInput.value) || 150000;
    var cpl = totals.lead > 0 ? Math.round(totals.spent / totals.lead) : 0;
    var ctrAvg = totals.ctrCount ? (totals.ctrTotal / totals.ctrCount).toFixed(1) : "0.0";
    renderMarketingLiveDashboard(rows, totals, totalBudget, cpl, ctrAvg);
  };

  window.renderMarketingCampaigns = function () {
    var body = document.getElementById("marketing-campaign-table-body");
    if (!body) return;
    var pf = (document.getElementById("marketing-filter-platform") || {}).value || "all";
    var st = (document.getElementById("marketing-filter-status") || {}).value || "all";
    var readOnlyLive = MARKETING_LIVE_STATE.source !== "manual";
    var rows = marketingDashboardRows().filter(function (row) {
      return (pf === "all" || row.platform === pf) && (st === "all" || row.status === st);
    });
    var statusLabel = { active: "กำลังรัน", paused: "พักไว้", ended: "จบแล้ว" };
    var platformBadge = { FB: '<span class="marketing-platform-mini fb">f</span>', TT: '<span class="marketing-platform-mini tt">♪</span>' };
    body.innerHTML = rows.map(function (row) {
      var cpl = row.lead > 0 ? marketingMoney(Math.round(Number(row.spent || 0) / Number(row.lead || 1))) : "-";
      var budgetBase = Number(row.budgetDay || 0) * 30;
      var pct = budgetBase > 0 ? Math.min(100, Math.round((Number(row.spent || 0) / budgetBase) * 100)) : 0;
      return '<tr><td>' + (platformBadge[row.platform] || "") + '</td><td><b>' + escapeHtml(row.name) + '</b><small>' + escapeHtml(row.note || "") + '</small></td><td>' + marketingMoney(row.budgetDay) + '</td><td><div class="marketing-campaign-spent"><span>' + marketingMoney(row.spent) + '</span><div><i style="width:' + pct + '%"></i></div></div></td><td>' + Number(row.lead || 0).toLocaleString("th-TH") + '</td><td>' + cpl + '</td><td>' + Number(row.ctr || 0).toFixed(1) + '%</td><td><span class="marketing-campaign-status ' + row.status + '">' + (statusLabel[row.status] || row.status) + '</span></td><td>' + (readOnlyLive ? '<span class="tag">Live</span>' : '<button class="btn btn-ghost btn-sm" type="button" onclick="editMarketingCampaign(' + row.id + ')">แก้ไข</button>') + '</td></tr>';
    }).join("");
    var count = document.getElementById("marketing-campaign-count");
    if (count) count.textContent = rows.length + " แคมเปญ";
  };

  function renderMarketingCompare() {
    var wrap = document.getElementById("marketing-compare-grid");
    if (wrap) {
      wrap.innerHTML =
        '<div class="marketing-platform-card"><div class="marketing-platform-head"><div class="marketing-platform-logo fb">f</div><div><b>Facebook Ads</b><small>วันนี้</small></div></div><div class="marketing-mini-grid">' +
        platformMetricCard("CTR", "3.8%", "สูงกว่าเป้า", "up") +
        platformMetricCard("CPL", "฿162", "ถูกกว่า TikTok", "up") +
        platformMetricCard("Lead", "16", "คุณภาพดี", "up") +
        platformMetricCard("งบ", "฿2,592", "58% ของงบ", "") +
        '</div></div>' +
        '<div class="marketing-platform-card"><div class="marketing-platform-head"><div class="marketing-platform-logo tt">♪</div><div><b>TikTok Ads</b><small>วันนี้</small></div></div><div class="marketing-mini-grid">' +
        platformMetricCard("CTR", "2.1%", "ต้องปรับ creative", "") +
        platformMetricCard("CPL", "฿231", "สูงกว่า Facebook", "down") +
        platformMetricCard("Lead", "8", "ยังต่ำกว่าเป้า", "") +
        platformMetricCard("งบ", "฿1,848", "42% ของงบ", "") +
        '</div></div>';
    }
    var winner = document.getElementById("marketing-platform-winner");
    if (winner) {
      winner.innerHTML = '<b>แพลตฟอร์มที่คุ้มค่าวันนี้: Facebook</b><p>Facebook ให้ CPL ถูกกว่า TikTok ฿69/lead และ CTR สูงกว่า +1.7% แนะนำจัดสรรงบพรุ่งนี้เป็น 70:30 (FB:TikTok) พร้อมปรับ Creative TikTok ใหม่</p>';
    }
  }

  function renderMarketingHistory() {
    var body = document.getElementById("marketing-history-body");
    if (!body) return;
    body.innerHTML = MARKETING_HISTORY.map(function (row) {
      return '<tr><td>' + escapeHtml(row.date) + '</td><td>' + escapeHtml(row.platform) + '</td><td>' + row.lead + '</td><td>฿' + row.cpl + '</td><td>฿' + row.budget.toLocaleString("th-TH") + '</td></tr>';
    }).join("");
  }

  function renderMarketingResult() {
    var result = document.getElementById("marketing-result-section");
    if (!result) return;
    result.innerHTML = '<div class="marketing-dept-card-title">สรุปผลรวม — วันนี้</div>' +
      '<div class="marketing-mini-grid marketing-result-grid">' +
      platformMetricCard("CTR เฉลี่ย", "3.2%", "+0.4% จากเมื่อวาน", "up") +
      platformMetricCard("CPL เฉลี่ย", "฿185", "ยังอยู่ในเป้า", "") +
      platformMetricCard("Lead ทั้งหมด", "24", "+6 จากเมื่อวาน", "up") +
      platformMetricCard("งบที่ใช้", "฿4,440", "เป้า ฿5,000/วัน", "") +
      platformMetricCard("Reach รวม", "18,200", "+2,100", "up") +
      platformMetricCard("Impression", "31,450", "รวม 2 platform", "") +
      '</div><div class="marketing-ai-box"><b>สรุปจาก AI</b><p>วันนี้ Facebook Ads ให้ Lead 16 leads, CTR 3.8% ซึ่งดีกว่าเป้า ส่วน TikTok Ads ให้ 8 leads, CTR 2.1% แต่ CPL สูงกว่า Facebook 40% แนะนำเพิ่มงบ Facebook แคมเปญบ้านเดี่ยว 3 ห้อง และปรับ Creative TikTok ใหม่</p></div>';
  }

  function marketingContracts() {
    try {
      var saved = JSON.parse(localStorage.getItem(MARKETING_CONTRACT_KEY) || "null");
      return Array.isArray(saved) ? saved : MARKETING_CONTRACT_SEED.slice();
    } catch (e) {
      return MARKETING_CONTRACT_SEED.slice();
    }
  }

  function saveMarketingContracts(rows) {
    localStorage.setItem(MARKETING_CONTRACT_KEY, JSON.stringify(rows || []));
  }

  function marketingDateOnly(value) {
    var d = value ? new Date(value) : new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function marketingDaysLeft(end) {
    return Math.round((marketingDateOnly(end) - marketingDateOnly()) / 86400000);
  }

  function marketingDateThai(value) {
    if (!value) return "-";
    return new Date(value).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
  }

  function marketingRenewDate(end, days) {
    var d = marketingDateOnly(end);
    d.setDate(d.getDate() - days);
    return marketingDateThai(d.toISOString().slice(0, 10));
  }

  function marketingContractStatus(diff, warnDays) {
    if (diff < 0) return { key: "over", label: "หมดแล้ว", text: "เกิน " + Math.abs(diff) + " วัน" };
    if (diff <= warnDays) return { key: "warn", label: "ใกล้หมด", text: diff + " วัน" };
    return { key: "ok", label: "ปกติ", text: diff + " วัน" };
  }

  window.renderMarketingContracts = function () {
    var body = document.getElementById("marketing-contract-table-body");
    if (!body) return;
    var warnInput = document.getElementById("marketing-contract-notify-days");
    var warnDays = Number(warnInput && warnInput.value) || 30;
    var rows = marketingContracts();
    var counts = { ok: 0, warn: 0, over: 0 };
    var totalCost = 0;
    body.innerHTML = rows.map(function (row) {
      var diff = marketingDaysLeft(row.end);
      var status = marketingContractStatus(diff, warnDays);
      counts[status.key] += 1;
      totalCost += Number(row.cost || 0);
      return '<tr>' +
        '<td><div class="marketing-contract-name-cell">' + (row.photo ? '<img src="' + escapeHtml(row.photo) + '" alt="รูปป้าย">' : '<span>▣</span>') + '<div><b>' + escapeHtml(row.name) + '</b><small>' + escapeHtml(row.note || "-") + '</small></div></div></td>' +
        '<td>' + escapeHtml(row.location || "-") + '</td>' +
        '<td>' + escapeHtml(row.type || "-") + '</td>' +
        '<td>' + marketingDateThai(row.end) + '</td>' +
        '<td>' + marketingRenewDate(row.end, warnDays) + '</td>' +
        '<td><span class="marketing-days ' + status.key + '">' + status.text + '</span></td>' +
        '<td><span class="marketing-contract-badge ' + status.key + '">' + status.label + '</span></td>' +
        '<td>฿' + Number(row.cost || 0).toLocaleString("th-TH") + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" type="button" onclick="editMarketingContract(' + row.id + ')">แก้ไข</button></td>' +
      '</tr>';
    }).join("");
    var stat = document.getElementById("marketing-contract-stat-grid");
    if (stat) {
      stat.innerHTML =
        '<div class="marketing-contract-stat"><span>ทั้งหมด</span><b>' + rows.length + '</b><small>รายการ</small></div>' +
        '<div class="marketing-contract-stat ok"><span>ปกติ</span><b>' + counts.ok + '</b><small>ยังไม่ถึงรอบต่อ</small></div>' +
        '<div class="marketing-contract-stat warn"><span>ใกล้หมด</span><b>' + counts.warn + '</b><small>ภายใน ' + warnDays + ' วัน</small></div>' +
        '<div class="marketing-contract-stat over"><span>หมดแล้ว</span><b>' + counts.over + '</b><small>ต้องดำเนินการ</small></div>' +
        '<div class="marketing-contract-stat"><span>ค่าเช่ารวม</span><b>฿' + totalCost.toLocaleString("th-TH") + '</b><small>ต่อเดือน</small></div>';
    }
    var warning = document.getElementById("marketing-contract-warning");
    if (warning) {
      var risky = rows.filter(function (row) { return marketingDaysLeft(row.end) <= warnDays; });
      warning.innerHTML = risky.length ? '<div class="marketing-contract-warning">⚠ มีสัญญาสื่อ/ป้ายที่ต้องติดตาม ' + risky.length + ' รายการ กรุณาตรวจวันต่อสัญญา</div>' : "";
    }
  };

  window.openMarketingContractForm = function () {
    var rows = marketingContracts();
    var name = prompt("ชื่อสื่อ/ป้ายโฆษณา", "Billboard แคมเปญใหม่");
    if (!name) return;
    var location = prompt("สถานที่", "ระบุสถานที่") || "-";
    var type = prompt("ประเภท", "Billboard") || "-";
    var end = prompt("วันหมดอายุสัญญา (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
    if (!end) return;
    var cost = Number(prompt("ค่าเช่า/เดือน", "0") || 0);
    rows.push({ id: Date.now(), name: name, location: location, type: type, start: new Date().toISOString().slice(0, 10), end: end, cost: cost, note: "" });
    saveMarketingContracts(rows);
    renderMarketingContracts();
  };

  window.editMarketingContract = function (id) {
    var rows = marketingContracts();
    var row = rows.find(function (item) { return Number(item.id) === Number(id); });
    if (!row) return;
    var name = prompt("แก้ไขชื่อสื่อ/ป้าย", row.name);
    if (name === null) return;
    var end = prompt("แก้ไขวันหมดอายุ (YYYY-MM-DD)", row.end);
    if (end === null) return;
    var cost = prompt("แก้ไขค่าเช่า/เดือน", row.cost);
    row.name = name || row.name;
    row.end = end || row.end;
    row.cost = Number(cost || row.cost || 0);
    saveMarketingContracts(rows);
    renderMarketingContracts();
  };

  function marketingContractFieldValue(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function setMarketingContractFieldValue(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value || "";
  }

  function setMarketingContractPhotoPreview(photo) {
    var preview = document.getElementById("marketing-contract-preview");
    var img = document.getElementById("marketing-contract-preview-img");
    var upload = document.getElementById("marketing-contract-upload-zone");
    MARKETING_CONTRACT_PHOTO = photo || "";
    if (!preview || !img || !upload) return;
    if (MARKETING_CONTRACT_PHOTO) {
      img.src = MARKETING_CONTRACT_PHOTO;
      preview.hidden = false;
      upload.style.display = "none";
    } else {
      img.removeAttribute("src");
      preview.hidden = true;
      upload.style.display = "grid";
    }
  }

  function fillMarketingContractModal(row) {
    var today = new Date().toISOString().slice(0, 10);
    setMarketingContractFieldValue("marketing-contract-name", row && row.name || "");
    setMarketingContractFieldValue("marketing-contract-location", row && row.location || "");
    setMarketingContractFieldValue("marketing-contract-start", row && row.start || today);
    setMarketingContractFieldValue("marketing-contract-end", row && row.end || "");
    setMarketingContractFieldValue("marketing-contract-cost", row && row.cost || "");
    setMarketingContractFieldValue("marketing-contract-type", row && row.type || "");
    setMarketingContractFieldValue("marketing-contract-note", row && row.note || "");
    setMarketingContractPhotoPreview(row && row.photo || "");
    var photoInput = document.getElementById("marketing-contract-photo");
    if (photoInput) photoInput.value = "";
  }

  function openMarketingContractModal(titleText) {
    var title = document.getElementById("marketing-contract-modal-title");
    var modal = document.getElementById("marketing-contract-modal");
    if (title) title.textContent = titleText || "▧ เพิ่มสัญญาป้ายใหม่";
    if (modal) {
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
      setTimeout(function () {
        var first = document.getElementById("marketing-contract-name");
        if (first) first.focus();
      }, 40);
    }
  }

  window.openMarketingContractForm = function () {
    MARKETING_CONTRACT_EDIT_ID = null;
    fillMarketingContractModal(null);
    openMarketingContractModal("▧ เพิ่มสัญญาป้ายใหม่");
  };

  window.closeMarketingContractForm = function () {
    var modal = document.getElementById("marketing-contract-modal");
    if (modal) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
  };

  window.previewMarketingContractPhoto = function (input) {
    if (!input || !input.files || !input.files[0]) return;
    var reader = new FileReader();
    reader.onload = function (event) {
      setMarketingContractPhotoPreview(event.target.result);
    };
    reader.readAsDataURL(input.files[0]);
  };

  window.removeMarketingContractPhoto = function () {
    var input = document.getElementById("marketing-contract-photo");
    if (input) input.value = "";
    setMarketingContractPhotoPreview("");
  };

  window.saveMarketingContractForm = function () {
    var rows = marketingContracts();
    var payload = {
      id: MARKETING_CONTRACT_EDIT_ID || Date.now(),
      name: marketingContractFieldValue("marketing-contract-name"),
      location: marketingContractFieldValue("marketing-contract-location") || "-",
      start: marketingContractFieldValue("marketing-contract-start"),
      end: marketingContractFieldValue("marketing-contract-end"),
      cost: Number(marketingContractFieldValue("marketing-contract-cost").replace(/,/g, "")) || 0,
      type: marketingContractFieldValue("marketing-contract-type") || "-",
      note: marketingContractFieldValue("marketing-contract-note"),
      photo: MARKETING_CONTRACT_PHOTO || ""
    };
    if (!payload.name || !payload.end) {
      toast("กรุณากรอกชื่อป้ายและวันหมดอายุสัญญา", "err");
      return;
    }
    if (MARKETING_CONTRACT_EDIT_ID) {
      rows = rows.map(function (row) {
        return Number(row.id) === Number(MARKETING_CONTRACT_EDIT_ID) ? Object.assign({}, row, payload) : row;
      });
    } else {
      rows.push(payload);
    }
    saveMarketingContracts(rows);
    closeMarketingContractForm();
    renderMarketingContracts();
  };

  window.editMarketingContract = function (id) {
    var row = marketingContracts().find(function (item) { return Number(item.id) === Number(id); });
    if (!row) return;
    MARKETING_CONTRACT_EDIT_ID = row.id;
    fillMarketingContractModal(row);
    openMarketingContractModal("▧ แก้ไขสัญญาป้าย");
  };

  window.renderMarketingDepartment = function () {
    renderMarketingDeptSummary();
    renderMarketingDeptTasks();
    renderMarketingAdsOverview();
    renderMarketingLiveDashboardNow();
    if ((marketingLiveEndpoint() || (API_URL && (API_TOKEN || getMarketingLiveSession()))) && Date.now() - MARKETING_LIVE_LAST_AUTO_FETCH > 60000) {
      MARKETING_LIVE_LAST_AUTO_FETCH = Date.now();
      refreshMarketingLiveData(false);
    }
    renderMarketingCampaigns();
    renderMarketingCompare();
    renderMarketingHistory();
    renderMarketingResult();
    renderMarketingContracts();
  };

  window.switchMarketingAdsTab = function (name, button) {
    document.querySelectorAll(".marketing-ads-tab").forEach(function (tab) { tab.classList.remove("active"); });
    document.querySelectorAll(".marketing-ads-pane").forEach(function (pane) { pane.classList.remove("active"); });
    if (button) button.classList.add("active");
    var pane = document.getElementById("marketing-ads-" + name);
    if (pane) pane.classList.add("active");
    if (name === "overview") {
      renderMarketingAdsOverview();
      renderMarketingLiveDashboardNow();
    }
    if (name === "campaigns") renderMarketingCampaigns();
    if (name === "compare") renderMarketingCompare();
    if (name === "history") renderMarketingHistory();
  };

  function campaignField(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  }

  function setCampaignField(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value == null ? "" : value;
  }

  window.openMarketingCampaignModal = function () {
    MARKETING_CAMPAIGN_EDIT_ID = null;
    setCampaignField("marketing-campaign-name", "");
    setCampaignField("marketing-campaign-platform", "FB");
    setCampaignField("marketing-campaign-status", "active");
    ["marketing-campaign-budget", "marketing-campaign-spent", "marketing-campaign-lead", "marketing-campaign-ctr", "marketing-campaign-reach", "marketing-campaign-impression", "marketing-campaign-note"].forEach(function (id) { setCampaignField(id, ""); });
    var title = document.getElementById("marketing-campaign-modal-title");
    var del = document.getElementById("marketing-campaign-delete");
    var modal = document.getElementById("marketing-campaign-modal");
    if (title) title.textContent = "เพิ่มแคมเปญใหม่";
    if (del) del.style.display = "none";
    if (modal) {
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
      setTimeout(function () {
        var first = document.getElementById("marketing-campaign-name");
        if (first) first.focus();
      }, 40);
    }
    switchMarketingAdsTab("campaigns", document.querySelector('.marketing-ads-tab[data-marketing-tab="campaigns"]'));
  };

  window.closeMarketingCampaignModal = function () {
    var modal = document.getElementById("marketing-campaign-modal");
    if (modal) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
  };

  window.editMarketingCampaign = function (id) {
    var row = marketingCampaigns().find(function (item) { return Number(item.id) === Number(id); });
    if (!row) return;
    MARKETING_CAMPAIGN_EDIT_ID = row.id;
    setCampaignField("marketing-campaign-name", row.name);
    setCampaignField("marketing-campaign-platform", row.platform);
    setCampaignField("marketing-campaign-status", row.status);
    setCampaignField("marketing-campaign-budget", row.budgetDay);
    setCampaignField("marketing-campaign-spent", row.spent);
    setCampaignField("marketing-campaign-lead", row.lead);
    setCampaignField("marketing-campaign-ctr", row.ctr);
    setCampaignField("marketing-campaign-reach", row.reach);
    setCampaignField("marketing-campaign-impression", row.impression);
    setCampaignField("marketing-campaign-note", row.note);
    var title = document.getElementById("marketing-campaign-modal-title");
    var del = document.getElementById("marketing-campaign-delete");
    var modal = document.getElementById("marketing-campaign-modal");
    if (title) title.textContent = "แก้ไขแคมเปญ";
    if (del) del.style.display = "inline-flex";
    if (modal) {
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
    }
  };

  window.saveMarketingCampaign = function () {
    var rows = marketingCampaigns();
    var payload = {
      id: MARKETING_CAMPAIGN_EDIT_ID || Date.now(),
      name: campaignField("marketing-campaign-name"),
      platform: campaignField("marketing-campaign-platform") || "FB",
      status: campaignField("marketing-campaign-status") || "active",
      budgetDay: Number(campaignField("marketing-campaign-budget")) || 0,
      spent: Number(campaignField("marketing-campaign-spent")) || 0,
      lead: Number(campaignField("marketing-campaign-lead")) || 0,
      ctr: Number(campaignField("marketing-campaign-ctr")) || 0,
      reach: Number(campaignField("marketing-campaign-reach")) || 0,
      impression: Number(campaignField("marketing-campaign-impression")) || 0,
      note: campaignField("marketing-campaign-note")
    };
    if (!payload.name) {
      toast("กรุณากรอกชื่อแคมเปญ", "err");
      return;
    }
    if (MARKETING_CAMPAIGN_EDIT_ID) {
      rows = rows.map(function (row) { return Number(row.id) === Number(MARKETING_CAMPAIGN_EDIT_ID) ? payload : row; });
    } else {
      rows.push(payload);
    }
    saveMarketingCampaigns(rows);
    closeMarketingCampaignModal();
    renderMarketingAdsOverview();
    renderMarketingLiveDashboardNow();
    renderMarketingCampaigns();
  };

  window.deleteMarketingCampaign = function () {
    if (!MARKETING_CAMPAIGN_EDIT_ID) return;
    var rows = marketingCampaigns().filter(function (row) { return Number(row.id) !== Number(MARKETING_CAMPAIGN_EDIT_ID); });
    saveMarketingCampaigns(rows);
    closeMarketingCampaignModal();
    renderMarketingAdsOverview();
    renderMarketingLiveDashboardNow();
    renderMarketingCampaigns();
  };

  window.handleMarketingFile = function (input, type) {
    if (!input || !input.files || !input.files[0]) return;
    var prefix = String(type).indexOf("fb") === 0 ? "fb" : "tt";
    var el = document.getElementById("marketing-" + prefix + "-fname");
    if (el) {
      el.style.display = "block";
      el.textContent = "✓ " + input.files[0].name;
    }
  };

  window.marketingShowDemo = function () {
    if (typeof switchPanelByName === "function") switchPanelByName("marketing-dept");
    renderMarketingDepartment();
    var result = document.getElementById("marketing-result-section");
    if (result) {
      result.style.display = "block";
      setTimeout(function () { result.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, 80);
    }
  };

  window.openMarketingDepartment = function () {
    if (typeof switchPanelByName === "function") switchPanelByName("marketing-dept");
  };

  window.renderCompanyBackoffice = function () {
    renderCompanyOrgTree();
    renderMarketingWorkspace();
  };

  window.focusMarketingBackoffice = function () {
    if (typeof switchPanelByName === "function") switchPanelByName("company-backoffice");
    setTimeout(function () {
      var target = document.getElementById("marketing-workspace");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  };

  var previousBackofficeSwitchPanel = switchPanel;
  switchPanel = window.switchPanel = function (el) {
    previousBackofficeSwitchPanel(el);
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : "";
    if (panel === "company-backoffice") renderCompanyBackoffice();
    if (panel === "marketing-dept") renderMarketingDepartment();
    if (panel === "marketing-contracts") renderMarketingContracts();
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("panel-company-backoffice")) renderCompanyBackoffice();
    if (document.getElementById("panel-marketing-dept")) renderMarketingDepartment();
    if (document.getElementById("panel-marketing-contracts")) renderMarketingContracts();
  });
})();

/* Keep executive dashboard hook last, after all module switchPanel wrappers. */
(function () {
  "use strict";
  if (typeof window.renderExecutiveDashboard !== "function") return;

  var finalExecutiveSwitchPanel = switchPanel;
  switchPanel = window.switchPanel = function (el) {
    finalExecutiveSwitchPanel(el);
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : CURRENT_PANEL;
    if (panel === "dashboard" || CURRENT_PANEL === "dashboard") setTimeout(window.renderExecutiveDashboard, 30);
  };

  var finalExecutiveUpdateTopbarUser = updateTopbarUser;
  updateTopbarUser = window.updateTopbarUser = function (user) {
    finalExecutiveUpdateTopbarUser(user);
    setTimeout(window.renderExecutiveDashboard, 80);
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(window.renderExecutiveDashboard, 120);
  });
})();

/* Sales Hub: merge customers, contracts, employees and projects into Sales. */
(function () {
  "use strict";
  var SALES_HUB_MODULES = ["sales", "customers", "contracts", "employees", "projects"];
  var SALES_HUB_MERGED = ["customers", "contracts", "employees", "projects"];
  var SALES_HUB_LABELS = {
    sales: ["รายการขาย", "ยอดขายและรายการล่าสุด"],
    customers: ["ลูกค้า", "ฐานข้อมูลลูกค้า"],
    contracts: ["สัญญา", "เอกสารและมูลค่าสัญญา"],
    employees: ["พนักงาน", "ผู้รับผิดชอบงานขาย"],
    projects: ["โปรเจกต์", "สถานะงานและส่งมอบ"]
  };

  function salesHubRows(sheet) {
    try {
      if (typeof SMART_DATA_CACHE !== "undefined" && SMART_DATA_CACHE[sheet] && SMART_DATA_CACHE[sheet].length) return SMART_DATA_CACHE[sheet].slice();
      if (typeof CACHED_DATA !== "undefined" && CACHED_DATA[sheet] && CACHED_DATA[sheet].length) return CACHED_DATA[sheet].slice();
      if (typeof getLocalRows === "function") return getLocalRows(sheet) || [];
    } catch (error) {}
    return [];
  }

  function salesHubMoney(rows) {
    return (rows || []).reduce(function (sum, row) {
      var keys = Object.keys(row || {});
      var key = keys.find(function (candidate) {
        return /ยอดรวม|ยอดขาย|มูลค่า|ราคา|งบประมาณ|amount|total|price/i.test(candidate);
      });
      var value = key ? row[key] : 0;
      var num = Number(String(value || "").replace(/[^0-9.-]/g, ""));
      return sum + (isFinite(num) ? num : 0);
    }, 0);
  }

  function salesHubMoneyLabel(value) {
    var num = Number(value || 0);
    if (num >= 1000000) return "฿" + (num / 1000000).toFixed(num >= 10000000 ? 1 : 2).replace(/\.0$/, "") + "M";
    if (num >= 1000) return "฿" + Math.round(num / 1000).toLocaleString("th-TH") + "K";
    return "฿" + Math.round(num).toLocaleString("th-TH");
  }

  function renderSalesHubSummary() {
    var wrap = document.getElementById("sales-hub-summary");
    if (!wrap) return;
    var salesRows = salesHubRows("sales");
    var rows = [
      { key:"sales", label:"รายการขาย", value:salesRows.length.toLocaleString("th-TH"), sub:"มูลค่า " + salesHubMoneyLabel(salesHubMoney(salesRows)) },
      { key:"customers", label:"ลูกค้า", value:salesHubRows("customers").length.toLocaleString("th-TH"), sub:"ฐานข้อมูลลูกค้า" },
      { key:"contracts", label:"สัญญา", value:salesHubRows("contracts").length.toLocaleString("th-TH"), sub:"มูลค่า " + salesHubMoneyLabel(salesHubMoney(salesHubRows("contracts"))) },
      { key:"employees", label:"พนักงาน", value:salesHubRows("employees").length.toLocaleString("th-TH"), sub:"ทีมที่เกี่ยวข้อง" },
      { key:"projects", label:"โปรเจกต์", value:salesHubRows("projects").length.toLocaleString("th-TH"), sub:"งานที่กำลังติดตาม" }
    ];
    wrap.innerHTML = rows.map(function (item) {
      return '<button class="sales-hub-stat" type="button" onclick="openSalesHubTab(&quot;' + item.key + '&quot;)">' +
        '<span>' + item.label + '</span><b>' + item.value + '</b><small>' + item.sub + '</small></button>';
    }).join("");
  }

  function moveSalesHubCards() {
    SALES_HUB_MERGED.forEach(function (sheet) {
      var pane = document.getElementById("sales-hub-pane-" + sheet);
      var panel = document.getElementById("panel-" + sheet);
      if (!pane || !panel) return;
      var card = panel.querySelector(".table-card");
      if (card && card.parentElement !== pane) {
        card.setAttribute("data-sales-hub-card", sheet);
        pane.appendChild(card);
      }
    });
  }

  function activateSalesHubTab(sheet) {
    if (SALES_HUB_MODULES.indexOf(sheet) === -1) sheet = "sales";
    moveSalesHubCards();
    document.querySelectorAll(".sales-hub-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.getAttribute("data-sales-hub-tab") === sheet);
    });
    document.querySelectorAll(".sales-hub-pane").forEach(function (pane) {
      pane.classList.toggle("active", pane.getAttribute("data-sales-hub-pane") === sheet);
    });
    CURRENT_PANEL = sheet;
    if (typeof loadPanel === "function") loadPanel(sheet, 1, "");
    if (typeof syncRoleAccess === "function") syncRoleAccess();
    renderSalesHubSummary();
  }

  window.openSalesHubTab = function (sheet, button) {
    if (button && button.blur) button.blur();
    if (CURRENT_PANEL !== "sales" && typeof switchPanelByName === "function") {
      var salesNav = document.querySelector('.nav-item[data-panel="sales"]');
      if (salesNav) {
        document.querySelectorAll(".panel").forEach(function (panel) { panel.classList.remove("active"); });
        var salesPanel = document.getElementById("panel-sales");
        if (salesPanel) salesPanel.classList.add("active");
        document.querySelectorAll(".nav-item").forEach(function (nav) { nav.classList.remove("active"); });
        salesNav.classList.add("active");
      }
    }
    activateSalesHubTab(sheet);
  };

  window.refreshSalesHub = function () {
    SALES_HUB_MODULES.forEach(function (sheet) {
      if (typeof loadPanel === "function") loadPanel(sheet, 1, "");
    });
    renderSalesHubSummary();
  };

  function applySalesHubNavigation() {
    SALES_HUB_MERGED.forEach(function (sheet) {
      var nav = document.querySelector('.nav-item[data-panel="' + sheet + '"]');
      if (nav) nav.style.display = "none";
    });
  }

  var salesHubSwitchPanel = switchPanel;
  switchPanel = window.switchPanel = function (el) {
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : "";
    if (SALES_HUB_MERGED.indexOf(panel) > -1) {
      window.openSalesHubTab(panel);
      return;
    }
    salesHubSwitchPanel(el);
    if (panel === "sales") setTimeout(function () { activateSalesHubTab(CURRENT_PANEL === "sales" ? "sales" : CURRENT_PANEL); }, 40);
    applySalesHubNavigation();
  };

  var salesHubSwitchPanelByName = switchPanelByName;
  switchPanelByName = window.switchPanelByName = function (name) {
    if (SALES_HUB_MERGED.indexOf(name) > -1) {
      window.openSalesHubTab(name);
      return;
    }
    salesHubSwitchPanelByName(name);
    if (name === "sales") setTimeout(function () { activateSalesHubTab("sales"); }, 40);
    applySalesHubNavigation();
  };

  var salesHubSyncRoleAccess = syncRoleAccess;
  syncRoleAccess = window.syncRoleAccess = function () {
    salesHubSyncRoleAccess();
    applySalesHubNavigation();
  };

  var salesHubRenderTable = renderTable;
  renderTable = window.renderTable = function (sheet, rows, wrap) {
    salesHubRenderTable(sheet, rows, wrap);
    if (SALES_HUB_MODULES.indexOf(sheet) > -1) setTimeout(renderSalesHubSummary, 20);
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () {
      moveSalesHubCards();
      applySalesHubNavigation();
      renderSalesHubSummary();
    }, 120);
  });
})();

/* CRM Pipeline inside Sales Center. */
(function () {
  "use strict";
  var CRM_KEY = "erp-sales-crm-leads-v1";
  var CRM_STAGES = [
    { key:"new", label:"Lead ใหม่", color:"#378add", pct:16 },
    { key:"contacted", label:"ติดต่อแล้ว", color:"#9e7fdd", pct:32 },
    { key:"appointed", label:"นัดคุย", color:"#1d9e75", pct:48 },
    { key:"quoted", label:"เสนอราคา", color:"#ba7517", pct:64 },
    { key:"deposited", label:"มัดจำ", color:"#e07b39", pct:82 },
    { key:"signed", label:"เซ็นสัญญา", color:"#d85a30", pct:100 }
  ];

  function future(hours) {
    return new Date(Date.now() + hours * 3600000).toISOString();
  }
  function past(hours) {
    return new Date(Date.now() - hours * 3600000).toISOString();
  }

  var CRM_SEED = [
    { id:1, name:"คุณสมชาย วงศ์ดี", phone:"081-234-5678", source:"Facebook", campaign:"บ้านเดี่ยว 3 ห้องนอน", budget:3500000, interest:"บ้านเดี่ยว 2 ชั้น ลาดพร้าว", stage:"new", score:"hot", nextDate:future(2), owner:"คุณสมหญิง", note:"สนใจมาก โทรกลับด่วน" },
    { id:2, name:"คุณนภา ศรีสุข", phone:"082-345-6789", source:"TikTok", campaign:"Reel บ้านใหม่", budget:2800000, interest:"ทาวน์โฮม 3 ชั้น", stage:"contacted", score:"warm", nextDate:future(24), owner:"คุณวิชัย", note:"โทรแนะนำตัวแล้ว" },
    { id:3, name:"คุณวิชัย ใจกว้าง", phone:"083-456-7890", source:"Walk-in", campaign:"โชว์รูม", budget:5000000, interest:"บ้านเดี่ยว Premium", stage:"appointed", score:"hot", nextDate:future(3), owner:"คุณสมหญิง", note:"นัด 14:00 วันนี้" },
    { id:4, name:"คุณอรอุมา พรมดี", phone:"084-567-8901", source:"Line OA", campaign:"Line", budget:3200000, interest:"บ้านเดี่ยว 3 ห้อง", stage:"quoted", score:"warm", nextDate:future(48), owner:"คุณวิชัย", note:"ส่งใบเสนอราคาแล้ว" },
    { id:5, name:"คุณประเสริฐ มั่นคง", phone:"085-678-9012", source:"แนะนำ", campaign:"Referral", budget:4500000, interest:"บ้านเดี่ยว 4 ห้องนอน", stage:"deposited", score:"hot", nextDate:future(72), owner:"คุณสมหญิง", note:"มัดจำ 100,000 แล้ว" },
    { id:6, name:"คุณมาลี รุ่งเรือง", phone:"086-789-0123", source:"Facebook", campaign:"บ้านเดี่ยว Premium", budget:6000000, interest:"บ้านเดี่ยว Premium", stage:"signed", score:"hot", nextDate:"", owner:"คุณวิชัย", note:"เซ็นสัญญาแล้ว" },
    { id:7, name:"คุณชัยพร สดใส", phone:"087-890-1234", source:"TikTok", campaign:"Content บ้านเดี่ยว", budget:2500000, interest:"ทาวน์โฮม 1.59M", stage:"new", score:"cold", nextDate:future(96), owner:"คุณวิชัย", note:"" },
    { id:8, name:"คุณกมลา ทองดี", phone:"088-901-2345", source:"Facebook", campaign:"ทาวน์โฮม 1.59M", budget:1800000, interest:"ทาวน์โฮม", stage:"contacted", score:"warm", nextDate:past(12), owner:"คุณสมหญิง", note:"เกินกำหนด ยังไม่ได้โทร" }
  ];

  function crmLeads() {
    try {
      var saved = JSON.parse(localStorage.getItem(CRM_KEY) || "null");
      if (Array.isArray(saved) && saved.length) return saved;
    } catch (error) {}
    return CRM_SEED.slice();
  }

  function saveCrmLeads(rows) {
    try { localStorage.setItem(CRM_KEY, JSON.stringify(rows || [])); } catch (error) {}
  }

  function crmMoney(value) {
    var num = Number(value || 0);
    if (num >= 1000000) return "฿" + (num / 1000000).toFixed(num >= 10000000 ? 1 : 2).replace(/\.0$/, "") + "M";
    return "฿" + Math.round(num).toLocaleString("th-TH");
  }

  function crmStage(stage) {
    return CRM_STAGES.find(function (item) { return item.key === stage; }) || CRM_STAGES[0];
  }

  function crmIsOverdue(lead) {
    if (!lead.nextDate || lead.stage === "signed") return false;
    var date = new Date(lead.nextDate);
    return !isNaN(date) && date < new Date();
  }

  function crmDate(value) {
    if (!value) return "-";
    var date = new Date(value);
    if (isNaN(date)) return value;
    return date.toLocaleDateString("th-TH", { day:"2-digit", month:"short" });
  }

  function crmTagClass(value) {
    if (/facebook/i.test(value)) return "fb";
    if (/tiktok/i.test(value)) return "tt";
    return "";
  }

  function renderSalesCrmKpis() {
    var rows = crmLeads();
    var today = new Date().toDateString();
    var totalValue = rows.reduce(function (sum, lead) { return sum + Number(lead.budget || 0); }, 0);
    var overdue = rows.filter(crmIsOverdue).length;
    var appointedToday = rows.filter(function (lead) {
      return lead.nextDate && new Date(lead.nextDate).toDateString() === today && lead.stage !== "signed";
    }).length;
    var kpis = [
      ["Lead ทั้งหมด", rows.length, "ทุกสถานะ", ""],
      ["Lead ใหม่", rows.filter(function (lead) { return lead.stage === "new"; }).length, "รอติดต่อ", "good"],
      ["นัดคุยวันนี้", appointedToday, "รายการ", ""],
      ["เซ็นสัญญา", rows.filter(function (lead) { return lead.stage === "signed"; }).length, "รายการ", "good"],
      ["มูลค่ารวม", crmMoney(totalValue), "Pipeline", "good"],
      ["งานล่าช้า", overdue, "ต้องติดตาม", overdue ? "danger" : ""]
    ];
    var wrap = document.getElementById("sales-crm-kpis");
    if (!wrap) return;
    wrap.innerHTML = kpis.map(function (item) {
      return '<article class="sales-crm-kpi ' + item[3] + '"><span>' + item[0] + '</span><b>' + item[1] + '</b><small>' + item[2] + '</small></article>';
    }).join("");
  }

  function buildCrmLeadCard(lead) {
    var overdue = crmIsOverdue(lead);
    return '<article class="sales-crm-lead' + (overdue ? " overdue" : "") + '" onclick="openSalesCrmLeadDetail(' + Number(lead.id) + ')">' +
      '<b>' + escapeHtml(lead.name) + '</b>' +
      '<small>' + escapeHtml(lead.phone || "-") + ' · ' + escapeHtml(lead.interest || "-") + '</small>' +
      '<div class="sales-crm-lead-row"><span class="sales-crm-money">' + crmMoney(lead.budget) + '</span><small>' + crmDate(lead.nextDate) + '</small></div>' +
      '<div class="sales-crm-tags"><span class="sales-crm-tag ' + crmTagClass(lead.source) + '">' + escapeHtml(lead.source || "-") + '</span><span class="sales-crm-tag ' + escapeHtml(lead.score || "") + '">' + escapeHtml(lead.score || "-") + '</span></div>' +
    '</article>';
  }

  function renderSalesCrmBoard() {
    var rows = crmLeads();
    var board = document.getElementById("sales-crm-board");
    if (!board) return;
    board.innerHTML = CRM_STAGES.map(function (stage) {
      var leads = rows.filter(function (lead) { return lead.stage === stage.key; });
      var value = leads.reduce(function (sum, lead) { return sum + Number(lead.budget || 0); }, 0);
      return '<section class="sales-crm-col"><div class="sales-crm-col-head"><div class="sales-crm-col-title"><i class="sales-crm-dot" style="background:' + stage.color + '"></i>' + stage.label + '<span class="exec-badge">' + leads.length + '</span></div><div class="sales-crm-col-meta">' + crmMoney(value) + '</div></div><div class="sales-crm-col-body">' +
        (leads.map(buildCrmLeadCard).join("") || '<div class="empty" style="padding:16px"><div class="empty-text">ว่าง</div></div>') +
      '</div></section>';
    }).join("");
  }

  window.renderSalesCrmList = function () {
    var q = String((document.getElementById("sales-crm-search") || {}).value || "").toLowerCase();
    var stage = (document.getElementById("sales-crm-stage-filter") || {}).value || "all";
    var source = (document.getElementById("sales-crm-source-filter") || {}).value || "all";
    var rows = crmLeads().filter(function (lead) {
      var hay = [lead.name, lead.phone, lead.interest, lead.campaign].join(" ").toLowerCase();
      return (!q || hay.indexOf(q) > -1) && (stage === "all" || lead.stage === stage) && (source === "all" || lead.source === source);
    });
    var body = document.getElementById("sales-crm-list");
    if (!body) return;
    body.innerHTML = rows.map(function (lead) {
      var st = crmStage(lead.stage);
      return '<tr><td><b>' + escapeHtml(lead.name) + '</b></td><td>' + escapeHtml(lead.phone || "-") + '</td><td>' + escapeHtml(lead.source || "-") + '</td><td>' + escapeHtml(lead.interest || "-") + '</td><td>' + crmMoney(lead.budget) + '</td><td><span class="exec-badge" style="color:' + st.color + '">' + st.label + '</span></td><td><span class="sales-crm-tag ' + escapeHtml(lead.score || "") + '">' + escapeHtml(lead.score || "-") + '</span></td><td>' + crmDate(lead.nextDate) + '</td></tr>';
    }).join("");
  };

  function renderSalesCrmReport() {
    var rows = crmLeads();
    var max = Math.max.apply(null, CRM_STAGES.map(function (stage) {
      return rows.filter(function (lead) { return lead.stage === stage.key; }).length;
    }).concat([1]));
    var funnel = document.getElementById("sales-crm-funnel");
    if (funnel) {
      funnel.innerHTML = CRM_STAGES.map(function (stage) {
        var count = rows.filter(function (lead) { return lead.stage === stage.key; }).length;
        return '<div class="sales-crm-funnel-row"><span>' + stage.label + '</span><div class="sales-crm-bar"><i style="width:' + Math.round(count / max * 100) + '%;background:' + stage.color + '"></i></div><b>' + count + '</b></div>';
      }).join("");
    }
    var sources = {};
    rows.forEach(function (lead) { sources[lead.source || "-"] = (sources[lead.source || "-"] || 0) + 1; });
    var sourceWrap = document.getElementById("sales-crm-source");
    if (sourceWrap) {
      sourceWrap.innerHTML = Object.keys(sources).map(function (source) {
        return '<div class="sales-crm-funnel-row"><span>' + escapeHtml(source) + '</span><div class="sales-crm-bar"><i style="width:' + Math.round(sources[source] / rows.length * 100) + '%;background:var(--accent)"></i></div><b>' + sources[source] + '</b></div>';
      }).join("");
    }
  }

  window.switchSalesCrmView = function (view) {
    ["board", "list", "report"].forEach(function (name) {
      var el = document.getElementById("sales-crm-" + name + "-view");
      if (el) el.classList.toggle("active", name === view);
    });
    if (view === "board") renderSalesCrmBoard();
    if (view === "list") window.renderSalesCrmList();
    if (view === "report") renderSalesCrmReport();
  };

  window.openSalesCrmLead = function () {
    if (typeof openSalesHubTab === "function") openSalesHubTab("customers");
    setTimeout(function () {
      if (typeof openAddModal === "function") openAddModal();
    }, 120);
  };

  window.openSalesCrmLeadDetail = function (id) {
    var lead = crmLeads().find(function (item) { return Number(item.id) === Number(id); });
    if (!lead) return;
    if (typeof toast === "function") toast(lead.name + " · " + crmStage(lead.stage).label + " · " + crmMoney(lead.budget), "info");
  };

  window.renderSalesCrmPipeline = function () {
    renderSalesCrmKpis();
    renderSalesCrmBoard();
    window.renderSalesCrmList();
    renderSalesCrmReport();
  };

  var crmSwitchPanel = switchPanel;
  switchPanel = window.switchPanel = function (el) {
    crmSwitchPanel(el);
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : CURRENT_PANEL;
    if (panel === "sales") setTimeout(window.renderSalesCrmPipeline, 80);
  };

  var crmSwitchPanelByName = switchPanelByName;
  switchPanelByName = window.switchPanelByName = function (name) {
    crmSwitchPanelByName(name);
    if (name === "sales") setTimeout(window.renderSalesCrmPipeline, 80);
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(window.renderSalesCrmPipeline, 160);
  });
})();

/* Restrict executive-only navigation from all other departments. */
(function () {
  "use strict";
  var EXECUTIVE_ID = "EMP-EXEC";
  var EXECUTIVE_ONLY_PANELS = ["reports", "calendar", "ai"];
  var ADMIN_ONLY_PANELS = ["company-backoffice"];

  function isExecutiveOrAdmin() {
    var id = String(CURRENT_USER && (CURRENT_USER.employeeId || CURRENT_USER.id) || "").trim().toUpperCase();
    var role = String(CURRENT_USER && CURRENT_USER.role || "").toLowerCase();
    return role === "admin" || role === "executive" || id === EXECUTIVE_ID;
  }

  function isAdmin() {
    return String(CURRENT_USER && CURRENT_USER.role || "").toLowerCase() === "admin";
  }

  function isExecutiveOnlyPanel(panel) {
    return EXECUTIVE_ONLY_PANELS.indexOf(String(panel || "")) > -1;
  }

  function isAdminOnlyPanel(panel) {
    return ADMIN_ONLY_PANELS.indexOf(String(panel || "")) > -1;
  }

  function applyExecutiveOnlyNav() {
    document.querySelectorAll('.nav-item[data-panel]').forEach(function (nav) {
      var panel = nav.getAttribute("data-panel");
      if (isExecutiveOnlyPanel(panel) && !isExecutiveOrAdmin()) nav.style.display = "none";
      if (isAdminOnlyPanel(panel) && !isAdmin()) nav.style.display = "none";
    });
    document.querySelectorAll('[onclick*="company-backoffice"]').forEach(function (button) {
      if (!isAdmin()) button.style.display = "none";
    });
    if (typeof updateSidebarDropdownState === "function") updateSidebarDropdownState();
  }

  var departmentMenuCanView = userCanViewPanel;
  userCanViewPanel = window.userCanViewPanel = function (panel) {
    if (isExecutiveOnlyPanel(panel) && !isExecutiveOrAdmin()) return false;
    if (isAdminOnlyPanel(panel) && !isAdmin()) return false;
    return departmentMenuCanView(panel);
  };

  var departmentMenuSyncRoleAccess = syncRoleAccess;
  syncRoleAccess = window.syncRoleAccess = function () {
    departmentMenuSyncRoleAccess();
    applyExecutiveOnlyNav();
  };

  var departmentMenuSwitchPanel = switchPanel;
  switchPanel = window.switchPanel = function (el) {
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : "";
    if (isExecutiveOnlyPanel(panel) && !isExecutiveOrAdmin()) {
      if (typeof toast === "function") toast("เมนูนี้เปิดให้เฉพาะผู้บริหารหรือ Admin", "err");
      return;
    }
    if (isAdminOnlyPanel(panel) && !isAdmin()) {
      if (typeof toast === "function") toast("เมนูนี้เปิดให้เฉพาะ Admin", "err");
      return;
    }
    departmentMenuSwitchPanel(el);
    applyExecutiveOnlyNav();
  };

  var departmentMenuSwitchPanelByName = switchPanelByName;
  switchPanelByName = window.switchPanelByName = function (name) {
    if (isExecutiveOnlyPanel(name) && !isExecutiveOrAdmin()) {
      if (typeof toast === "function") toast("เมนูนี้เปิดให้เฉพาะผู้บริหารหรือ Admin", "err");
      return;
    }
    if (isAdminOnlyPanel(name) && !isAdmin()) {
      if (typeof toast === "function") toast("เมนูนี้เปิดให้เฉพาะ Admin", "err");
      return;
    }
    departmentMenuSwitchPanelByName(name);
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(applyExecutiveOnlyNav, 120);
  });
})();

/* Connected department systems: Lead Connect, Construction, Finance. */
(function () {
  "use strict";
  var OPS_EXTRA_LEADS = [];
  var OPS_MODAL_CONTEXT = "";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function rows(sheet) {
    if (typeof CACHED_DATA !== "undefined" && Array.isArray(CACHED_DATA[sheet]) && CACHED_DATA[sheet].length) return CACHED_DATA[sheet].slice();
    if (typeof getLocalRows === "function") return (getLocalRows(sheet) || []).slice();
    return [];
  }

  function pick(row, keys, fallback) {
    for (var i = 0; i < keys.length; i += 1) {
      if (row && row[keys[i]] != null && String(row[keys[i]]).trim() !== "") return row[keys[i]];
    }
    return fallback == null ? "" : fallback;
  }

  function number(value) {
    var parsed = Number(String(value == null ? "" : value).replace(/[^\d.-]/g, ""));
    return isFinite(parsed) ? parsed : 0;
  }

  function money(value) {
    return "฿" + Math.round(number(value)).toLocaleString("th-TH");
  }

  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function kpi(label, value, sub, tone) {
    return '<div class="ops-kpi"><span>' + esc(label) + '</span><b>' + esc(value) + '</b><small>' + esc(sub || "") + '</small></div>';
  }

  function badge(text, tone) {
    return '<span class="ops-badge ' + esc(tone || "") + '">' + esc(text) + '</span>';
  }

  function demoLeads() {
    return [
      { name: "คุณศิริพร", source: "Facebook Ads", interest: "บ้านเดี่ยว 3 ห้องนอน", owner: "ทีมขาย A", status: "รอรับ" },
      { name: "คุณอนุชา", source: "TikTok Ads", interest: "ต่อเติมบ้าน", owner: "ทีมขาย B", status: "รับแล้ว" },
      { name: "คุณวิภา", source: "Line OA", interest: "ขอใบเสนอราคา", owner: "ทีมขาย A", status: "นัดหมาย" },
      { name: "คุณกิตติ", source: "Walk-in", interest: "โครงการลาดพร้าว", owner: "ทีมขาย C", status: "รอรับ" }
    ];
  }

  function buildLeadRows() {
    var customerRows = rows("customers");
    var salesRows = rows("sales");
    var built = customerRows.concat(salesRows).slice(0, 10).map(function (row, index) {
      var source = pick(row, ["source", "ช่องทาง", "leadSource", "channel"], index % 2 ? "Facebook Ads" : "Line OA");
      return {
        name: pick(row, ["name", "customer", "customerName", "ชื่อลูกค้า", "ชื่อ"], "ลูกค้า #" + (index + 1)),
        phone: pick(row, ["phone", "tel", "เบอร์", "โทร"], "08x-xxx-xxxx"),
        source: source,
        campaign: pick(row, ["campaign", "แคมเปญ"], source),
        score: pick(row, ["score", "ระดับ"], index % 3 === 0 ? "🔥 Hot" : index % 3 === 1 ? "🌤 Warm" : "❄️ Cold"),
        interest: pick(row, ["interest", "project", "product", "note", "ความสนใจ"], "สอบถามรายละเอียดโครงการ"),
        owner: pick(row, ["owner", "sales", "assignee", "ผู้รับผิดชอบ"], "ทีมขาย"),
        status: pick(row, ["status", "สถานะ"], index % 3 === 0 ? "รอรับ" : "รับแล้ว"),
        time: pick(row, ["createdAt", "date", "วันที่"], "วันนี้")
      };
    });
    var combined = OPS_EXTRA_LEADS.concat(built.length ? built : demoLeads());
    return combined;
  }

  function renderLeadConnectSystem() {
    var leadRows = buildLeadRows();
    var pending = leadRows.filter(function (row) { return /รอ|ใหม่|pending/i.test(row.status); }).length;
    var accepted = leadRows.length - pending;
    var sources = {};
    leadRows.forEach(function (row) {
      var source = String(row.source || "อื่นๆ");
      var key = /tiktok/i.test(source) ? "TikTok Ads" : /facebook|meta/i.test(source) ? "Facebook Ads" : /line/i.test(source) ? "Line OA" : "อื่นๆ";
      sources[key] = (sources[key] || 0) + 1;
    });
    setHtml("lead-connect-kpis",
      kpi("Lead ส่งมาวันนี้", leadRows.length, "จากการตลาด", "up") +
      kpi("รอทีมขายรับ", pending, "รายการที่ยังไม่รับงาน", "warn") +
      kpi("รับไปแล้ว", accepted, "วันนี้", "good") +
      kpi("Conversion Rate", leadRows.length ? Math.round((accepted / leadRows.length) * 100) + "%" : "—", "Lead → ปิดขาย", "good")
    );
    var inboxHtml = leadRows.map(function (row, index) {
      var tone = /รอ|ใหม่|pending/i.test(row.status) ? "warn" : "good";
      return '<tr><td><b>' + esc(row.name) + '</b><small>' + esc(row.interest) + '</small></td><td>' + esc(row.phone) + '</td><td>' + esc(row.source) + '</td><td>' + esc(row.campaign) + '</td><td>' + esc(row.score) + '</td><td>' + esc(row.owner) + '</td><td>' + esc(row.time) + '</td><td>' + badge(row.status, tone) + '</td><td><button class="btn btn-ghost btn-sm" type="button" onclick="acceptLeadSystem(' + index + ')">รับ Lead</button></td></tr>';
    }).join("");
    setHtml("lead-inbox-tbody", inboxHtml);
    setHtml("lead-history-tbody", leadRows.map(function (row) {
      var tone = /รอ|ใหม่|pending/i.test(row.status) ? "warn" : "good";
      return '<tr><td><b>' + esc(row.name) + '</b><small>' + esc(row.phone) + '</small></td><td>' + esc(row.source) + '</td><td>' + esc(row.campaign) + '</td><td>' + esc(row.score) + '</td><td>' + esc(row.owner) + '</td><td>' + esc(row.time) + '</td><td>' + badge(row.status, tone) + '</td><td>' + esc(/รอ|ใหม่|pending/i.test(row.status) ? "รอทีมขายรับ" : "ส่งเข้า CRM แล้ว") + '</td></tr>';
    }).join(""));
    var histCount = document.getElementById("lead-hist-count");
    if (histCount) histCount.textContent = leadRows.length + " รายการ";
  }

  function demoProjects() {
    return [
      { name: "บ้านเดี่ยว 3 ห้องนอน", client: "คุณศิริพร", stage: "โครงสร้าง", progress: 42, deadline: "30 มิ.ย.", status: "ตามแผน" },
      { name: "ต่อเติมครัว", client: "คุณอนุชา", stage: "ระบบ", progress: 64, deadline: "25 มิ.ย.", status: "ล่าช้า" },
      { name: "โครงการลาดพร้าว", client: "คุณวิภา", stage: "เก็บงาน", progress: 86, deadline: "5 ก.ค.", status: "ใกล้ส่งมอบ" }
    ];
  }

  function buildProjectRows() {
    var projectRows = rows("projects").slice(0, 9).map(function (row, index) {
      var progress = number(pick(row, ["progress", "percent", "ความคืบหน้า"], 25 + (index * 18) % 70));
      return {
        name: pick(row, ["name", "project", "projectName", "ชื่อโปรเจกต์", "โครงการ"], "โปรเจกต์ #" + (index + 1)),
        client: pick(row, ["customer", "client", "customerName", "ลูกค้า"], "ลูกค้าในระบบ"),
        stage: pick(row, ["stage", "ขั้นตอน"], ["เริ่มงาน", "โครงสร้าง", "ระบบ", "สถาปัตย์", "เก็บงาน"][index % 5]),
        progress: Math.max(5, Math.min(100, progress || (30 + index * 12))),
        deadline: pick(row, ["deadline", "dueDate", "ส่งมอบ"], "เดือนนี้"),
        status: pick(row, ["status", "สถานะ"], index % 4 === 1 ? "ล่าช้า" : index % 4 === 2 ? "ใกล้ส่งมอบ" : "ตามแผน")
      };
    });
    return projectRows.length ? projectRows : demoProjects();
  }

  function renderConstructionSystem() {
    var projectRows = buildProjectRows();
    var late = projectRows.filter(function (row) { return /ล่าช้า|late/i.test(row.status); }).length;
    var done = projectRows.filter(function (row) { return /ส่งมอบ|done|เสร็จ/i.test(row.status); }).length;
    var onTrack = projectRows.length - late;
    setHtml("construction-kpis",
      kpi("โครงการทั้งหมด", projectRows.length, "เชื่อมจาก Projects", "") +
      kpi("ตามแผน", onTrack, "ไม่มีสัญญาณล่าช้า", "good") +
      kpi("ล่าช้า", late, "ต้องติดตาม", "warn") +
      kpi("ส่งมอบแล้ว", done, "โครงการ", "") +
      kpi("ส่งมอบเดือนนี้", projectRows.filter(function(row) { return /ส่งมอบ|ใกล้/i.test(row.status); }).length, "โครงการ", "warn")
    );
    setHtml("construction-project-grid", projectRows.slice(0, 6).map(function (row) {
      var tone = /ล่าช้า|late/i.test(row.status) ? "danger" : /ส่งมอบ|เสร็จ/i.test(row.status) ? "good" : "warn";
      return '<article class="ops-project-card"><span>' + esc(row.client) + '</span><b>' + esc(row.name) + '</b><div class="ops-progress"><i style="width:' + esc(row.progress) + '%"></i></div><span>' + esc(row.stage) + ' · ' + esc(row.progress) + '%</span><div style="margin-top:10px">' + badge(row.status, tone) + '</div></article>';
    }).join(""));
    setHtml("construction-table", projectRows.map(function (row) {
      var tone = /ล่าช้า|late/i.test(row.status) ? "danger" : /ส่งมอบ|เสร็จ/i.test(row.status) ? "good" : "warn";
      return '<tr><td><b>' + esc(row.name) + '</b><small>' + esc(row.progress) + '% complete</small></td><td>' + esc(row.client) + '</td><td>' + esc(row.stage) + '</td><td>' + esc(row.progress) + '%</td><td>วันนี้</td><td>' + esc(row.deadline) + '</td><td>' + badge(row.status, tone) + '</td><td><button class="btn btn-ghost btn-sm" type="button" onclick="openConstructionAddProject()">แก้ไข</button></td></tr>';
    }).join(""));
  }

  function demoFinanceContracts() {
    return [
      { name: "คุณศิริพร", project: "บ้านเดี่ยว 3 ห้องนอน", total: 3500000, paid: 1400000, status: "ครบกำหนดเดือนนี้" },
      { name: "คุณอนุชา", project: "ต่อเติมครัว", total: 680000, paid: 220000, status: "ค้างชำระ" },
      { name: "คุณวิภา", project: "โครงการลาดพร้าว", total: 4200000, paid: 2800000, status: "จ่ายปกติ" }
    ];
  }

  function buildFinanceRows() {
    var contractRows = rows("contracts").concat(rows("sales")).slice(0, 10).map(function (row, index) {
      var total = number(pick(row, ["total", "amount", "value", "price", "มูลค่า", "ยอดรวม"], 0));
      if (!total) total = [3500000, 680000, 4200000, 1500000][index % 4];
      var paid = number(pick(row, ["paid", "deposit", "รับแล้ว", "มัดจำ"], 0));
      if (!paid) paid = Math.round(total * ([0.4, 0.3, 0.68, 0.15][index % 4]));
      return {
        name: pick(row, ["customer", "customerName", "name", "ชื่อลูกค้า"], "ลูกค้า #" + (index + 1)),
        project: pick(row, ["project", "contract", "product", "โครงการ"], "สัญญาในระบบ"),
        total: total,
        paid: paid,
        status: pick(row, ["paymentStatus", "status", "สถานะ"], index % 4 === 1 ? "ค้างชำระ" : index % 4 === 2 ? "ครบกำหนดเดือนนี้" : "จ่ายปกติ")
      };
    });
    return contractRows.length ? contractRows : demoFinanceContracts();
  }

  function renderFinanceSystem() {
    var financeRows = buildFinanceRows();
    var total = financeRows.reduce(function (sum, row) { return sum + row.total; }, 0);
    var paid = financeRows.reduce(function (sum, row) { return sum + row.paid; }, 0);
    var overdue = financeRows.filter(function (row) { return /ค้าง|overdue/i.test(row.status); });
    var due = financeRows.filter(function (row) { return /ครบกำหนด|due/i.test(row.status); });
    var alert = document.getElementById("finance-alert");
    if (alert) {
      alert.hidden = overdue.length === 0;
      alert.textContent = overdue.length ? "มีสัญญาค้างชำระ " + overdue.length + " รายการ ควรติดตามกับฝ่ายขาย/ลูกค้า" : "";
    }
    setHtml("finance-kpis",
      kpi("รายรับเดือนนี้", money(paid), "ที่รับแล้ว", "good") +
      kpi("ยอดค้างชำระ", money(total - paid), "รวมทุกสัญญา", "warn") +
      kpi("งวดครบกำหนด", money(due.reduce(function (sum, row) { return sum + Math.max(row.total - row.paid, 0); }, 0)), "เดือนนี้", "warn") +
      kpi("มัดจำรอรับ", money(Math.round((total - paid) * 0.18)), "รวมทุกสัญญา", "") +
      kpi("สัญญาทั้งหมด", financeRows.length, "สัญญา", "")
    );
    var months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย."];
    var values = months.map(function (_, index) { return Math.round((paid / 8) * (0.7 + (index % 3) * 0.22)); });
    var max = Math.max.apply(Math, values.concat([1]));
    setHtml("finance-monthly-bars", months.map(function (month, index) {
      return '<div class="ops-bar-row"><span>' + month + '</span><div class="ops-bar-track"><i style="width:' + Math.round(values[index] / max * 100) + '%"></i></div><b>' + money(values[index]) + '</b></div>';
    }).join(""));
    setHtml("finance-status-list",
      '<div class="ops-status-row"><span>จ่ายปกติ</span><b>' + (financeRows.length - overdue.length - due.length) + '</b></div>' +
      '<div class="ops-status-row"><span>ครบกำหนดเดือนนี้</span><b>' + due.length + '</b></div>' +
      '<div class="ops-status-row"><span>ค้างชำระ</span><b>' + overdue.length + '</b></div>'
    );
    setHtml("finance-table", financeRows.map(function (row) {
      var tone = /ค้าง|overdue/i.test(row.status) ? "danger" : /ครบกำหนด|due/i.test(row.status) ? "warn" : "good";
      var remain = Math.max(row.total - row.paid, 0);
      var progress = row.total ? Math.round(row.paid / row.total * 100) : 0;
      return '<tr><td><b>' + esc(row.name) + '</b><small>' + esc(row.project) + '</small></td><td>' + esc(row.project) + '</td><td>' + money(row.total) + '</td><td>' + money(row.paid) + '</td><td>' + money(remain) + '</td><td><div class="ops-progress"><i style="width:' + progress + '%"></i></div><small>' + progress + '%</small></td><td>' + badge(row.status, tone) + '</td><td><button class="btn btn-ghost btn-sm" type="button" onclick="openFinanceAddContract()">ดู</button></td></tr>';
    }).join(""));
    setHtml("finance-overdue-tbody", overdue.map(function (row, index) {
      return '<tr><td><b>' + esc(row.name) + '</b><small>' + esc(row.project) + '</small></td><td>งวดที่ ' + (index + 1) + '</td><td>' + money(Math.max(row.total - row.paid, 0)) + '</td><td>เดือนนี้</td><td>' + (7 + index * 3) + ' วัน</td><td>' + badge("ค้างชำระ", "danger") + '</td><td><button class="btn btn-ghost btn-sm" type="button">ติดตาม</button></td></tr>';
    }).join("") || '<tr><td colspan="7">ไม่มีรายการค้างชำระ</td></tr>');
    setHtml("finance-upcoming-tbody", due.map(function (row, index) {
      return '<tr><td><b>' + esc(row.name) + '</b><small>' + esc(row.project) + '</small></td><td>งวดที่ ' + (index + 1) + '</td><td>' + money(Math.max(row.total - row.paid, 0)) + '</td><td>เดือนนี้</td><td>' + (3 + index * 5) + ' วัน</td><td>' + badge("ครบกำหนดเร็วๆ นี้", "warn") + '</td><td><button class="btn btn-ghost btn-sm" type="button">แจ้งเตือน</button></td></tr>';
    }).join("") || '<tr><td colspan="7">ไม่มีงวดครบกำหนดเร็วๆ นี้</td></tr>');
  }

  function switchOpsTemplateTab(section, tab, button) {
    document.querySelectorAll('[id^="' + section + '-panel-"]').forEach(function (panel) {
      panel.classList.toggle("active", panel.id === section + "-panel-" + tab);
    });
    var wrap = button && button.closest ? button.closest(".ops-template-tabs") : null;
    if (wrap) {
      wrap.querySelectorAll(".ops-template-tab").forEach(function (item) {
        item.classList.toggle("active", item === button);
      });
    }
  }

  function sendLeadToSalesSystem() {
    var name = pick({ value: document.getElementById("sf-name") && document.getElementById("sf-name").value }, ["value"], "");
    var phone = pick({ value: document.getElementById("sf-phone") && document.getElementById("sf-phone").value }, ["value"], "");
    if (!String(name).trim() || !String(phone).trim()) {
      if (typeof toast === "function") toast("กรอกชื่อและเบอร์โทรก่อนส่ง Lead", "err");
      return;
    }
    OPS_EXTRA_LEADS.unshift({
      name: name,
      phone: phone,
      source: (document.getElementById("sf-source") || {}).value || "Facebook Ads",
      campaign: (document.getElementById("sf-campaign") || {}).value || "Manual Lead",
      score: (document.getElementById("sf-score") || {}).selectedOptions ? (document.getElementById("sf-score").selectedOptions[0] || {}).textContent : "Hot",
      interest: (document.getElementById("sf-interest") || {}).value || "สอบถามรายละเอียด",
      owner: (document.getElementById("sf-assign") || {}).value || "ทีมขาย",
      status: "รอรับ",
      time: new Date().toLocaleString("th-TH", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })
    });
    ["sf-name", "sf-phone", "sf-line", "sf-campaign", "sf-budget", "sf-interest", "sf-note"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = "";
    });
    var success = document.getElementById("lead-send-success");
    if (success) {
      success.hidden = false;
      setTimeout(function () { success.hidden = true; }, 2600);
    }
    renderLeadConnectSystem();
    if (typeof toast === "function") toast("ส่ง Lead ไปยังทีมขายแล้ว", "ok");
  }

  function acceptLeadSystem(index) {
    if (OPS_EXTRA_LEADS[index]) OPS_EXTRA_LEADS[index].status = "รับแล้ว";
    if (typeof toast === "function") toast("รับ Lead และส่งต่อ CRM แล้ว", "ok");
    renderLeadConnectSystem();
  }

  function openOpsFormModal(title, context, fields) {
    OPS_MODAL_CONTEXT = context;
    var modal = document.getElementById("ops-form-modal");
    var titleEl = document.getElementById("ops-form-modal-title");
    var body = document.getElementById("ops-form-modal-body");
    if (titleEl) titleEl.textContent = title;
    if (body) body.innerHTML = fields.map(function (field) {
      var tag = field.type === "textarea" ? "textarea" : field.type === "select" ? "select" : "input";
      if (tag === "select") {
        return '<label class="' + (field.full ? "full" : "") + '"><span>' + esc(field.label) + '</span><select class="ops-input" data-ops-field="' + esc(field.name) + '">' + (field.options || []).map(function (option) { return '<option>' + esc(option) + '</option>'; }).join("") + '</select></label>';
      }
      if (tag === "textarea") {
        return '<label class="' + (field.full ? "full" : "") + '"><span>' + esc(field.label) + '</span><textarea class="ops-input" data-ops-field="' + esc(field.name) + '" placeholder="' + esc(field.placeholder || "") + '"></textarea></label>';
      }
      return '<label class="' + (field.full ? "full" : "") + '"><span>' + esc(field.label) + '</span><input class="ops-input" data-ops-field="' + esc(field.name) + '" type="' + esc(field.type || "text") + '" placeholder="' + esc(field.placeholder || "") + '"></label>';
    }).join("");
    if (modal) modal.classList.add("open");
  }

  function closeOpsFormModal() {
    var modal = document.getElementById("ops-form-modal");
    if (modal) modal.classList.remove("open");
  }

  function saveOpsFormModal() {
    closeOpsFormModal();
    if (typeof toast === "function") toast(OPS_MODAL_CONTEXT === "finance" ? "บันทึกสัญญาแล้ว" : "บันทึกข้อมูลแล้ว", "ok");
    renderIntegratedSystems(OPS_MODAL_CONTEXT);
  }

  function openConstructionAddProject() {
    openOpsFormModal("+ เพิ่มโครงการใหม่", "construction", [
      { name: "name", label: "ชื่อโครงการ *", placeholder: "เช่น พิชญา วิลล่า หลังที่ 3", full: true },
      { name: "client", label: "ชื่อลูกค้า *", placeholder: "เช่น คุณสมชาย วงศ์ดี", full: true },
      { name: "location", label: "ที่ตั้ง", placeholder: "เช่น ลาดพร้าว ซอย 12", full: true },
      { name: "start", label: "วันเริ่มก่อสร้าง", type: "date" },
      { name: "deadline", label: "กำหนดส่งมอบ", type: "date" },
      { name: "stage", label: "ขั้นตอนปัจจุบัน", type: "select", options: ["เริ่มงาน", "โครงสร้าง", "ระบบ", "สถาปัตย์", "เก็บงาน", "ส่งมอบ"] },
      { name: "status", label: "สถานะ", type: "select", options: ["ตามแผน", "ล่าช้า", "ส่งมอบแล้ว"] },
      { name: "note", label: "หมายเหตุ / ปัญหา", type: "textarea", full: true }
    ]);
  }

  function openFinanceAddContract() {
    openOpsFormModal("+ เพิ่มสัญญาใหม่", "finance", [
      { name: "name", label: "ชื่อลูกค้า *", placeholder: "เช่น คุณสมชาย วงศ์ดี", full: true },
      { name: "project", label: "โครงการ / แบบบ้าน *", placeholder: "เช่น บ้านเดี่ยว 2ชั้น ลาดพร้าว", full: true },
      { name: "total", label: "มูลค่าสัญญา (บาท) *", type: "number" },
      { name: "deposit", label: "ยอดมัดจำ (บาท)", type: "number" },
      { name: "signDate", label: "วันเซ็นสัญญา", type: "date" },
      { name: "startDate", label: "วันเริ่มก่อสร้าง", type: "date" },
      { name: "installments", label: "จำนวนงวด", type: "select", options: ["3 งวด", "4 งวด", "5 งวด", "6 งวด"] },
      { name: "note", label: "หมายเหตุ", type: "textarea", full: true }
    ]);
  }

  function renderIntegratedSystems(panel) {
    if (!panel || panel === "lead-connect") renderLeadConnectSystem();
    if (!panel || panel === "construction") renderConstructionSystem();
    if (!panel || panel === "finance") renderFinanceSystem();
  }

  window.renderLeadConnectSystem = renderLeadConnectSystem;
  window.renderConstructionSystem = renderConstructionSystem;
  window.renderFinanceSystem = renderFinanceSystem;
  window.renderIntegratedSystems = renderIntegratedSystems;
  window.switchOpsTemplateTab = switchOpsTemplateTab;
  window.sendLeadToSalesSystem = sendLeadToSalesSystem;
  window.acceptLeadSystem = acceptLeadSystem;
  window.openConstructionAddProject = openConstructionAddProject;
  window.openFinanceAddContract = openFinanceAddContract;
  window.closeOpsFormModal = closeOpsFormModal;
  window.saveOpsFormModal = saveOpsFormModal;

  var baseSwitchPanel = window.switchPanel || switchPanel;
  switchPanel = window.switchPanel = function (el) {
    baseSwitchPanel(el);
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : "";
    if (panel === "lead-connect" || panel === "construction" || panel === "finance") {
      setTimeout(function () { renderIntegratedSystems(panel); }, 40);
    }
  };

  var baseSwitchPanelByName = window.switchPanelByName || switchPanelByName;
  switchPanelByName = window.switchPanelByName = function (name) {
    baseSwitchPanelByName(name);
    if (name === "lead-connect" || name === "construction" || name === "finance") {
      setTimeout(function () { renderIntegratedSystems(name); }, 40);
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () {
      if (CURRENT_PANEL === "lead-connect" || CURRENT_PANEL === "construction" || CURRENT_PANEL === "finance") {
        renderIntegratedSystems(CURRENT_PANEL);
      }
    }, 180);
  });
})();

/* Calendar source integration: open the provided full calendar page. */
(function () {
  "use strict";

  function openCalendarSourcePanel(sourceEl) {
    var panelName = "calendar";
    if (typeof userCanViewPanel === "function" && !userCanViewPanel(panelName)) {
      if (typeof toast === "function") toast("ไม่มีสิทธิ์เปิด Calendar", "err");
      return;
    }
    document.querySelectorAll(".panel").forEach(function (panel) {
      panel.classList.remove("active");
    });
    var panel = document.getElementById("panel-calendar");
    if (panel) panel.classList.add("active");
    CURRENT_PANEL = panelName;
    document.querySelectorAll(".nav-item[data-panel]").forEach(function (nav) {
      nav.classList.toggle("active", nav.getAttribute("data-panel") === panelName);
    });
    if (sourceEl && sourceEl.classList) sourceEl.classList.add("active");
    if (typeof updateSidebarDropdownState === "function") updateSidebarDropdownState();
  }

  window.openDashboardCalendar = openCalendarSourcePanel;
  openDashboardCalendar = openCalendarSourcePanel;

  var calendarSourceSwitchPanelByName = window.switchPanelByName || switchPanelByName;
  switchPanelByName = window.switchPanelByName = function (name) {
    if (name === "calendar") {
      openCalendarSourcePanel(document.querySelector('.nav-item[data-panel="calendar"]'));
      return;
    }
    calendarSourceSwitchPanelByName(name);
  };
})();

/* Keep local login alive after F5/reload. */
(function () {
  "use strict";

  var SESSION_USER_KEY = "erp-local-current-user";
  var SESSION_PANEL_KEY = "erp-local-current-panel";

  function cleanSessionUser(user) {
    if (!user) return null;
    return {
      id: user.id || user.employeeId || "",
      employeeId: user.employeeId || user.id || "",
      name: user.name || user.fullName || user.id || user.employeeId || "",
      fullName: user.fullName || user.name || "",
      email: user.email || "",
      dept: user.dept || user.department || "",
      department: user.department || user.dept || "",
      position: user.position || user.pos || "",
      pos: user.pos || user.position || "",
      role: String(user.role || "viewer").toLowerCase(),
      status: user.status || "active",
      avatar: user.avatar || ""
    };
  }

  function saveCurrentSession() {
    try {
      if (CURRENT_USER) localStorage.setItem(SESSION_USER_KEY, JSON.stringify(cleanSessionUser(CURRENT_USER)));
      if (CURRENT_PANEL) localStorage.setItem(SESSION_PANEL_KEY, CURRENT_PANEL);
    } catch (error) {}
  }

  function clearCurrentSession() {
    try {
      localStorage.removeItem(SESSION_USER_KEY);
      localStorage.removeItem(SESSION_PANEL_KEY);
    } catch (error) {}
  }

  function applyLoggedInState(user) {
    CURRENT_USER = cleanSessionUser(user);
    if (!CURRENT_USER || !CURRENT_USER.id) return false;
    var navAdmin = document.getElementById("nav-admin");
    if (navAdmin) navAdmin.style.display = CURRENT_USER.role === "admin" ? "flex" : "none";
    if (typeof syncRoleAccess === "function") syncRoleAccess();
    if (typeof updateTopbarUser === "function") updateTopbarUser(CURRENT_USER);
    var login = document.getElementById("login-screen");
    var app = document.getElementById("erp-app");
    if (login) login.classList.add("hidden");
    if (app) app.classList.add("visible");
    if (typeof initOfflineDashboard === "function") initOfflineDashboard();
    if (typeof initCharts === "function") initCharts();
    if (typeof setStatus === "function") setStatus(CONNECTED ? "ok" : "idle", CONNECTED ? "เชื่อมต่อแล้ว" : "ยังไม่ได้เชื่อมต่อ");
    if (CONNECTED && typeof loadStats === "function") loadStats();
    return true;
  }

  function restoreCurrentSession() {
    if (CURRENT_USER) return;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_USER_KEY) || "null"); }
    catch (error) { saved = null; }
    if (!saved || !saved.id) return;
    if (!applyLoggedInState(saved)) return;
    var panel = "";
    try { panel = localStorage.getItem(SESSION_PANEL_KEY) || ""; } catch (error) {}
    setTimeout(function () {
      if (panel && panel !== "admin" && typeof switchPanelByName === "function" && typeof userCanViewPanel === "function" && userCanViewPanel(panel)) {
        switchPanelByName(panel);
      } else if (typeof switchPanelByName === "function") {
        switchPanelByName("dashboard");
      }
      saveCurrentSession();
    }, 80);
  }

  var sessionDoLogin = doLogin;
  doLogin = window.doLogin = async function (event) {
    var result = await sessionDoLogin(event);
    setTimeout(function () {
      if (CURRENT_USER) saveCurrentSession();
    }, 20);
    return result;
  };

  var sessionDoLogout = doLogout;
  doLogout = window.doLogout = function () {
    clearCurrentSession();
    return sessionDoLogout();
  };

  var sessionSwitchPanel = window.switchPanel || switchPanel;
  switchPanel = window.switchPanel = function (el) {
    var result = sessionSwitchPanel(el);
    saveCurrentSession();
    return result;
  };

  var sessionSwitchPanelByName = window.switchPanelByName || switchPanelByName;
  switchPanelByName = window.switchPanelByName = function (name) {
    var result = sessionSwitchPanelByName(name);
    saveCurrentSession();
    return result;
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(restoreCurrentSession, 120);
  });
})();

/* Ordered page loading: defer heavy source iframes until their panel is opened. */
(function () {
  "use strict";

  var HEAVY_PANELS = {
    sales: ".sales-code-frame",
    "lead-connect": ".lead-code-frame",
    construction: ".construction-code-frame",
    finance: ".finance-code-frame",
    calendar: ".calendar-code-frame"
  };
  var loadedPanels = {};

  function frameForPanel(panel) {
    var selector = HEAVY_PANELS[panel];
    return selector ? document.querySelector(selector) : null;
  }

  function ensurePanelFrame(panel) {
    var frame = frameForPanel(panel);
    if (!frame || loadedPanels[panel]) return;
    var src = frame.getAttribute("data-src");
    if (!src || frame.getAttribute("src")) {
      loadedPanels[panel] = true;
      return;
    }
    frame.setAttribute("src", src);
    loadedPanels[panel] = true;
  }

  function afterPanelOpen(panel) {
    if (!panel) panel = CURRENT_PANEL;
    if (!HEAVY_PANELS[panel]) return;
    setTimeout(function () {
      ensurePanelFrame(panel);
    }, 40);
  }

  var orderedSwitchPanel = window.switchPanel || switchPanel;
  switchPanel = window.switchPanel = function (el) {
    var result = orderedSwitchPanel(el);
    var panel = el && el.getAttribute ? el.getAttribute("data-panel") : CURRENT_PANEL;
    afterPanelOpen(panel);
    return result;
  };

  var orderedSwitchPanelByName = window.switchPanelByName || switchPanelByName;
  switchPanelByName = window.switchPanelByName = function (name) {
    var result = orderedSwitchPanelByName(name);
    afterPanelOpen(name);
    return result;
  };

  window.ensurePanelFrame = ensurePanelFrame;

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () { afterPanelOpen(CURRENT_PANEL); }, 260);
  });
})();
