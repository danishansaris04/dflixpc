// ==========================================================================
// D-FLIX front-end logic
// Talks to the native Android bridge exposed as window.Android
// (isLoggedIn, login, listFiles, searchFiles, resolvePoster, openFile,
//  downloadFile, downloadFolder)
//
// VIEW MODES:
//   'home'      -> Netflix-style rows: every top-level folder (Marvel, Anime &
//                  Animation, ...) is a row, and whatever folders/files are
//                  inside that folder show up as cards in that same row.
//   'browse'    -> Old grid-drilldown view (entering any folder shows
//                  everything in the same 3-column grid as it used to
//                  look before).
//   'downloads' -> Downloads tab: shows the list of anything that was
//                  tapped to download.
//
// CARD CLICK BEHAVIOUR:
//   Tapping any card (file or folder) opens an centered animated popup:
//     - If it's a file:   "Play" (stream instantly) or "Download" (save to device)
//     - If it's a folder: NO popup - it opens directly. Inside the folder an
//                       "All Download" button (next to search) downloads
//                       everything in that folder.
//   Pressing Download moves that item into the Downloads tab.
// ==========================================================================

var LOCKED_ROOT_FOLDER_ID = "17s88x00QQXAnTQtFWasBIOcgRqziTEnQ";

// ==========================================================================
// CUSTOM POSTERS (set from admin.html into Firebase Realtime Database)
// The admin panel saves a poster URL against a folder/file's exact name;
// the app fetches all of them at once here and caches them, and checks
// this BEFORE requesting a poster from TMDB - if the admin has set a
// custom poster, that one is used instead.
// ==========================================================================

var FIREBASE_DB_URL = "https://dflix-7b2d2-default-rtdb.firebaseio.com";
var customPosterMap = {}; // encodedKey(name) -> image URL

// Firebase Realtime Database keys don't allow ". # $ [ ] /", but dots
// are common in file/folder names (like "Movie.2023.1080p.mkv") - so we
// convert those characters into a safe, reversible-style encoding.
// admin.html has the exact same function, so the key always matches on
// both sides.
function posterKeyEncode(name) {
  var normalized = (name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.replace(/[.#$\[\]\/]/g, function (ch) {
    return "_" + ch.charCodeAt(0) + "_";
  });
}

function loadCustomPosters() {
  fetch(FIREBASE_DB_URL + "/posters.json")
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      var map = {};
      if (data) {
        Object.keys(data).forEach(function (key) {
          var entry = data[key];
          if (entry && entry.url) map[key] = entry.url;
        });
      }
      customPosterMap = map;
    })
    .catch(function () {
      // Firebase unreachable / offline - just fall back to TMDB posters
    });
}

var viewMode = "home";
var currentDownloadFolderName = null; // which folder we're currently inside, in the downloads tab
var folderStack = [{ id: LOCKED_ROOT_FOLDER_ID, name: "My Drive" }];
var currentFolderId = LOCKED_ROOT_FOLDER_ID;
var searchTimer = null;

var homeRowsCache = null;   // { folders: [...], looseFiles: [...] } - root listing cache
var pendingHeroChecks = 0;

// The hero banner is now a carousel: it collects 5-6 trending items and
// crossfades from one to the next every HERO_ROTATE_MS.
var HERO_MAX_CANDIDATES = 6;
var HERO_ROTATE_MS = 5000;
var heroCandidates = [];   // [{ id, name, rowTitle, poster }]
var heroCandidateIndex = 0;
var heroActiveLayer = 0;   // which bg layer (0/1) is currently visible
var heroRotateTimer = null;

// ---------- Elements ----------
var loginScreen = document.getElementById("loginScreen");
var loginBtn = document.getElementById("loginBtn");
var loginStatus = document.getElementById("loginStatus");
var appRoot = document.getElementById("app");
var breadcrumbEl = document.getElementById("breadcrumb");
var contentEl = document.getElementById("content");
var homeViewEl = document.getElementById("homeView");
var rowsContainerEl = document.getElementById("rowsContainer");
var heroSectionEl = document.getElementById("heroSection");
var heroTagEl = document.getElementById("heroTag");
var heroPlayBtn = document.getElementById("heroPlayBtn");
var heroBg0El = document.getElementById("heroBg0");
var heroBg1El = document.getElementById("heroBg1");
var heroDotsEl = document.getElementById("heroDots");

var searchOverlay = document.getElementById("searchOverlay");
var searchInput = document.getElementById("searchInput");
var searchBody = document.getElementById("searchBody");
var searchResultLabel = document.getElementById("searchResultLabel");
var btnClearSearch = document.getElementById("btnClearSearch");
var searchIdleState = document.getElementById("searchIdleState");

var navHome = document.getElementById("navHome");
var navMovies = document.getElementById("navMovies");
var navWebSeries = document.getElementById("navWebSeries");
var toastEl = document.getElementById("toast");

var actionSheetOverlay = document.getElementById("actionSheetOverlay");
var actionSheetTitle = document.getElementById("actionSheetTitle");
var actionSheetBody = document.getElementById("actionSheetBody");

var confirmOverlay = document.getElementById("confirmOverlay");
var confirmTitle = document.getElementById("confirmTitle");
var confirmMsg = document.getElementById("confirmMsg");
var confirmDeleteBtn = document.getElementById("confirmDeleteBtn");

var navDownloads = document.getElementById("navDownloads");
var downloadsViewEl = document.getElementById("downloadsView");
var downloadsListEl = document.getElementById("downloadsList");

var notifOverlay = document.getElementById("notifOverlay");
var notifListEl = document.getElementById("notifList");
var bellBadgeEl = document.getElementById("bellBadge");

var requestNameInput = document.getElementById("requestNameInput");
var requestNoteInput = document.getElementById("requestNoteInput");
var btnSendRequest = document.getElementById("btnSendRequest");

// ==========================================================================
// TV REMOTE NAVIGATION (bottom nav bar)
// On the Android side, D-pad key events get sent into the WebView as
// normal keyboard KeyboardEvents (ArrowLeft/ArrowRight/Enter), as long as
// the WebView has Android focus - see MainActivity.java. Here we just
// listen for those keys to move the left/right cursor between bottom-nav
// items, and pressing "Enter"/OK opens whichever tab the cursor is on.
// ==========================================================================

var tvNavItems = [];     // all bottom-nav buttons, in left-to-right order
var tvNavIndex = 0;      // which index the remote "cursor" is currently on
var tvNavActive = false; // no highlight shows until the user presses the D-pad for the first time

function initTvNav() {
  tvNavItems = Array.prototype.slice.call(document.querySelectorAll(".bottom-nav .nav-item"));
}

function isTypingContext() {
  var el = document.activeElement;
  return !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"));
}

function isOverlayOpen() {
  return searchOverlay.classList.contains("active")
    || confirmOverlay.classList.contains("active")
    || actionSheetOverlay.classList.contains("active")
    || notifOverlay.classList.contains("active")
    || resumeOverlay.classList.contains("active");
}

function setTvNavFocus(index) {
  if (tvNavItems.length === 0) return;
  if (index < 0) index = 0;
  if (index > tvNavItems.length - 1) index = tvNavItems.length - 1;

  for (var i = 0; i < tvNavItems.length; i++) tvNavItems[i].classList.remove("focused");
  tvNavIndex = index;
  var el = tvNavItems[tvNavIndex];
  el.classList.add("focused");
  try { el.focus(); } catch (e) { /* focus() can fail on some WebView versions - that's fine */ }
  tvNavActive = true;
}

function moveTvNavFocus(delta) {
  if (!tvNavActive) {
    // The first time the D-pad is pressed, start the cursor on whichever tab is currently active
    var activeIdx = 0;
    for (var i = 0; i < tvNavItems.length; i++) {
      if (tvNavItems[i].classList.contains("active")) { activeIdx = i; break; }
    }
    setTvNavFocus(activeIdx);
    return;
  }
  setTvNavFocus(tvNavIndex + delta);
}

function activateTvNavFocus() {
  if (!tvNavActive || !tvNavItems[tvNavIndex]) return;
  tvNavItems[tvNavIndex].click();
}

// If a nav item is tapped with touch/mouse, sync the remote-cursor to
// that same item, so the next D-pad press continues from there.
function syncTvNavToClickedItem(el) {
  var idx = tvNavItems.indexOf(el);
  if (idx !== -1) {
    tvNavIndex = idx;
    tvNavActive = true;
    for (var i = 0; i < tvNavItems.length; i++) tvNavItems[i].classList.remove("focused");
    el.classList.add("focused");
  }
}

document.addEventListener("keydown", function (e) {
  if (isTypingContext() || isOverlayOpen()) return;

  if (e.key === "ArrowLeft") {
    moveTvNavFocus(-1);
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    moveTvNavFocus(1);
    e.preventDefault();
  } else if (e.key === "Enter") {
    if (tvNavActive) {
      activateTvNavFocus();
      e.preventDefault();
    }
  }
});

document.addEventListener("click", function (e) {
  var navBtn = e.target.closest ? e.target.closest(".bottom-nav .nav-item") : null;
  if (navBtn) syncTvNavToClickedItem(navBtn);
});

// ---------- Init ----------
window.addEventListener("load", function () {
  if (isOnline()) {
    checkLogin();
  } else {
    // No internet - browsing Drive would just fail, so skip straight to
    // the Downloads tab (goDownloads() itself doesn't need a login).
    showToast("You're offline - showing your downloads");
    goDownloads();
  }
  loadCustomPosters();
  initTvNav();
  refreshBellBadge();
});

// If the network drops while the user is browsing (home/movies/web
// series/inside a folder), jump them to Downloads too instead of
// leaving them stuck on a screen full of load errors.
window.addEventListener("offline", function () {
  if (viewMode === "home" || viewMode === "browse" || viewMode === "movies" || viewMode === "webseries") {
    showToast("You're offline - showing your downloads");
    goDownloads();
  }
});

function isOnline() {
  try {
    return Android.isNetworkAvailable();
  } catch (e) {
    // Older APK build without isNetworkAvailable() - fall back to the
    // browser's own (less reliable) signal, defaulting to "online" so
    // this never blocks anyone unnecessarily.
    return navigator.onLine !== false;
  }
}

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && loginScreen && !loginScreen.classList.contains("hidden")) {
    checkLogin();
  }
  if (!document.hidden) {
    refreshBellBadge();
    resumeHeroCarousel();
  } else {
    pauseHeroCarousel();
  }
});

function checkLogin() {
  var isLoggedIn = false;
  try {
    isLoggedIn = Android.isLoggedIn();
  } catch (e) {
    isLoggedIn = false;
  }

  if (isLoggedIn) {
    showMain();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.classList.remove("hidden");
  appRoot.classList.add("hidden");
}

function showMain() {
  loginScreen.classList.add("hidden");
  // First time only: ask the user's name before opening the app
  if (!hasUserName()) {
    appRoot.classList.add("hidden");
    showNameScreen();
    return;
  }
  appRoot.classList.remove("hidden");
  goHome(false);
}

// ---------- Name screen (asked once, after login) ----------
var nameScreen = document.getElementById("nameScreen");
var nameInput = document.getElementById("nameInput");
var nameBtn = document.getElementById("nameBtn");
var nameError = document.getElementById("nameError");

function hasUserName() {
  try { return String(Android.getUserName() || "").trim().length > 0; }
  catch (e) { return true; } // old build without the bridge - don't block the app
}

function showNameScreen() {
  nameScreen.classList.add("active");
  setTimeout(function () { try { nameInput.focus(); } catch (e) {} }, 300);
}

function submitName() {
  var name = nameInput.value.replace(/\s+/g, " ").trim();
  if (name.length < 2) { nameError.textContent = "Please enter your name (at least 2 letters)"; return; }
  nameError.textContent = "";
  try { Android.saveUserName(name); } catch (e) {}
  nameScreen.classList.remove("active");
  appRoot.classList.remove("hidden");
  goHome(false);
}
nameBtn.addEventListener("click", submitName);
nameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submitName(); });

// ---------- Blocked by admin ----------
var blockOverlay = document.getElementById("blockOverlay");
var blockMsg = document.getElementById("blockMsg");

function applyBlocked(b) {
  if (b) {
    var n = ""; try { n = String(Android.getUserName() || ""); } catch (e) {}
    blockMsg.textContent = (n ? n + ", the" : "The") + " admin has blocked your access to D-FLIX.";
  }
  blockOverlay.classList.toggle("active", !!b);
}
/** Called live from PresenceManager.java when the block state changes. */
function onBlockedChanged(b) { applyBlocked(b === true); }
function checkBlockedLocal() {
  try { applyBlocked(Android.isBlocked() === true); } catch (e) {}
}
window.addEventListener("load", checkBlockedLocal);
document.addEventListener("visibilitychange", function () { if (!document.hidden) checkBlockedLocal(); });
setInterval(checkBlockedLocal, 5000);

// ---------- Login ----------
loginBtn.addEventListener("click", function () {
  loginStatus.textContent = "Opening Google login...";
  Android.login();
});

function onLoginComplete(success) {
  if (success) {
    loginStatus.textContent = "";
    showMain();
  } else {
    loginStatus.textContent = "Login failed, please try again.";
  }
}

// ---------- Bottom nav ----------
function goHome(force) {
  closeSearch();
  viewMode = "home";
  folderStack = [{ id: LOCKED_ROOT_FOLDER_ID, name: "My Drive" }];
  appRoot.classList.remove("browse-mode", "drive-browse");
  setActiveNav(navHome);
  homeViewEl.classList.remove("hidden");
  contentEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  profileViewEl.classList.add("hidden");
  browseReturnToProfile = false;
  loadHomeRows(!!force);
}

// ==========================================================================
// MOVIE / WEB SERIES TABS
// "Movie" tab = content of the root's "Bollywood" + "Hollywood" folders
// combined. "Web Series" tab = content of the root's "Web Series"
// folder. Names are matched case-insensitively.
// ==========================================================================

var tempCbSeq = 0;
function registerTempCallback(fn) {
  tempCbSeq++;
  var name = "onTempCb_" + tempCbSeq;
  window[name] = function (data) {
    delete window[name];
    fn(data);
  };
  return name;
}

// Use the cached root folder listing if it's already available, otherwise fetch it
function ensureRootFoldersLoaded(callback, forceRefresh) {
  if (!forceRefresh && homeRowsCache && homeRowsCache.folders) {
    callback(homeRowsCache.folders);
    return;
  }
  var cbName = registerTempCallback(function (data) {
    if (data && data.error) {
      if (data.error === "not_logged_in") { showLogin(); return; }
      callback([]);
      return;
    }
    var files = (data && data.files) ? data.files : [];
    var folders = [];
    var looseFiles = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i].mimeType === "application/vnd.google-apps.folder") folders.push(files[i]);
      else looseFiles.push(files[i]);
    }
    homeRowsCache = { folders: folders, looseFiles: looseFiles };
    callback(folders);
  });
  Android.listFiles(LOCKED_ROOT_FOLDER_ID, cbName);
}

// The Movie tab also includes files from these "nested paths" besides
// Bollywood/Hollywood - each entry is a sequence of folder names from the
// root going inward. Adding a new path here makes it easy to pull in
// files from any deeply nested folder into the Movie tab.
var MOVIE_TAB_EXTRA_PATHS = [
  ["Marvel", "Avengers", "480p"],
  ["Harry Potter", "480p"],
  ["Pirates of the Caribbean", "480p"],
  ["Transformer", "480p"],
  ["DC", "480p"],
  ["Marvel", "X-Men"]
];

function goMovies() {
  closeSearch();
  pauseHeroCarousel();
  viewMode = "movies";
  appRoot.classList.remove("browse-mode", "drive-browse");
  setActiveNav(navMovies);
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  profileViewEl.classList.add("hidden");
  browseReturnToProfile = false;
  contentEl.classList.remove("hidden");
  loadCategoryFolders(["Bollywood", "Hollywood", "Fast and Furious", "Mission Impossible",], "Movie", true, MOVIE_TAB_EXTRA_PATHS);
}

function goWebSeries() {
  closeSearch();
  pauseHeroCarousel();
  viewMode = "webseries";
  appRoot.classList.remove("browse-mode", "drive-browse");
  setActiveNav(navWebSeries);
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  profileViewEl.classList.add("hidden");
  browseReturnToProfile = false;
  contentEl.classList.remove("hidden");
  loadCategoryFolders(["Web Series"], "Web Series", false);
}

// When comparing folder names, ignore case, extra spaces, and punctuation
// (e.g. "Hollywood", "hollywood ", "Holly-Wood" will all match), so the
// category tab doesn't end up empty over a minor naming difference.
function normalizeFolderName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Fisher-Yates shuffle - so Bollywood/Hollywood don't show in a fixed
// order (like they're already sorted in Drive), but in a mixed/random
// order each time.
function shuffleArray(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

function loadCategoryFolders(folderNameList, label, shuffleResults, extraNestedPaths) {
  contentEl.innerHTML = '<div class="row-header" style="padding:16px 16px 6px;"><div class="row-title">'
    + escapeHtml(label) + '</div></div><div id="categoryGrid"></div>';
  var gridEl = document.getElementById("categoryGrid");
  showLoadingState(gridEl);

  var normalizedTargets = folderNameList.map(normalizeFolderName);

  ensureRootFoldersLoaded(function (rootFolders) {
    var matches = rootFolders.filter(function (f) {
      var normalizedName = normalizeFolderName(f.name);
      return normalizedTargets.some(function (n) {
        return normalizedName === n || normalizedName.indexOf(n) !== -1;
      });
    });

    var paths = extraNestedPaths || [];
    var totalTasks = matches.length + paths.length;

    if (totalTasks === 0) {
      showStateScreen(gridEl, "\uD83D\uDCED", "Nothing found",
        'No folder named "' + folderNameList.join(" / ") + '" was found in Drive.');
      return;
    }

    var combined = [];
    var remaining = totalTasks;

    function taskDone() {
      remaining--;
      if (remaining === 0) {
        if (combined.length === 0) {
          showStateScreen(gridEl, "\uD83D\uDCED", "Nothing found",
            'No folder named "' + folderNameList.join(" / ") + '" was found in Drive.');
          return;
        }
        renderGrid({ files: shuffleResults ? shuffleArray(combined) : combined }, gridEl, false);
      }
    }

    matches.forEach(function (folder) {
      var cbName = registerTempCallback(function (data) {
        var files = (data && data.files) ? data.files : [];
        combined = combined.concat(files);
        taskDone();
      });
      try {
        Android.listFiles(folder.id, cbName);
      } catch (e) {
        taskDone();
      }
    });

    paths.forEach(function (pathNames) {
      resolveNestedFolderFiles(rootFolders, pathNames, function (files) {
        combined = combined.concat(files);
        taskDone();
      });
    });
  }, true);
}

// Finds a folder by name inside the root (like "Marvel"), then the next
// name inside that (like "Avengers"), then the next (like "480p") - this
// way it reaches the last folder in the path and passes all its files to
// the callback. If a folder isn't found at any step, it passes an empty
// list (this doesn't affect the other category items).
function resolveNestedFolderFiles(rootFolders, pathNames, callback) {
  if (!pathNames || pathNames.length === 0) { callback([]); return; }

  var normalizedFirst = normalizeFolderName(pathNames[0]);
  var startFolder = null;
  for (var i = 0; i < rootFolders.length; i++) {
    var n = normalizeFolderName(rootFolders[i].name);
    if (n === normalizedFirst || n.indexOf(normalizedFirst) !== -1) {
      startFolder = rootFolders[i];
      break;
    }
  }
  if (!startFolder) { callback([]); return; }
  descendFolderPath(startFolder.id, pathNames.slice(1), callback);
}

function descendFolderPath(folderId, remainingNames, callback) {
  if (remainingNames.length === 0) {
    var cbName = registerTempCallback(function (data) {
      callback((data && data.files) ? data.files : []);
    });
    try {
      Android.listFiles(folderId, cbName);
    } catch (e) {
      callback([]);
    }
    return;
  }

  var targetName = normalizeFolderName(remainingNames[0]);
  var cbName = registerTempCallback(function (data) {
    var files = (data && data.files) ? data.files : [];
    var next = null;
    for (var i = 0; i < files.length; i++) {
      if (files[i].mimeType === "application/vnd.google-apps.folder") {
        var n = normalizeFolderName(files[i].name);
        if (n === targetName || n.indexOf(targetName) !== -1) {
          next = files[i];
          break;
        }
      }
    }
    if (!next) { callback([]); return; }
    descendFolderPath(next.id, remainingNames.slice(1), callback);
  });
  try {
    Android.listFiles(folderId, cbName);
  } catch (e) {
    callback([]);
  }
}

function comingSoon(label) {
  showToast(label + " is coming soon!");
}

// ==========================================================================
// NOTIFICATIONS (real-time, sent from the admin panel via Firebase ->
// FirebaseNotifyListener.java on the Android side). Two bridge calls are
// used: Android.getNotifications() (local history) and
// Android.markNotificationsRead() / Android.clearNotifications().
// A live one also arrives anytime via window.onPushNotification(...),
// called directly from FirebaseNotifyListener while the app is open.
// ==========================================================================

function refreshBellBadge() {
  var count = 0;
  try {
    var list = JSON.parse(Android.getNotifications() || "[]");
    list.forEach(function (n) { if (!n.read) count++; });
  } catch (e) { /* Android bridge not ready yet, or not on device */ }

  if (count > 0) {
    bellBadgeEl.textContent = count > 9 ? "9+" : String(count);
    bellBadgeEl.classList.remove("hidden");
  } else {
    bellBadgeEl.classList.add("hidden");
  }
}

function notifTimeAgo(ts) {
  var diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return "Just now";
  var diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return diffMin + "m ago";
  var diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return diffHr + "h ago";
  var diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return diffDay + "d ago";
  return new Date(ts).toLocaleDateString();
}

function renderNotifications() {
  var list = [];
  try {
    list = JSON.parse(Android.getNotifications() || "[]");
  } catch (e) { list = []; }

  if (list.length === 0) {
    notifListEl.innerHTML = '<div class="notif-empty"><div class="emoji">🔔</div>'
      + '<div>No notifications yet</div></div>';
    return;
  }

  var html = "";
  list.forEach(function (n) {
    var unreadClass = n.read ? "" : " unread";
    var iconHtml;
    if (n.poster) {
      iconHtml = '<div class="notif-icon has-poster"><img src="' + escapeHtml(n.poster) + '" alt=""></div>';
    } else {
      iconHtml = '<div class="notif-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>';
    }
    html += '<div class="notif-item' + unreadClass + '">'
      + iconHtml
      + '<div class="notif-body-text">'
      + '<div class="notif-item-title">' + escapeHtml(n.title || "D-FLIX") + '</div>'
      + '<div class="notif-item-msg">' + escapeHtml(n.body || "") + '</div>'
      + '<div class="notif-item-time">' + notifTimeAgo(n.ts) + '</div>'
      + '</div></div>';
  });
  notifListEl.innerHTML = html;
}

function escapeHtml(str) {
  var div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function openNotifications() {
  renderNotifications();
  notifOverlay.classList.add("active");
  try { Android.markNotificationsRead(); } catch (e) { }
  refreshBellBadge();
}

function closeNotifications() {
  notifOverlay.classList.remove("active");
}

function clearAllNotifications() {
  try { Android.clearNotifications(); } catch (e) { }
  renderNotifications();
  refreshBellBadge();
}

/** Called directly from FirebaseNotifyListener.java (MainActivity.pushToWeb)
 *  whenever a new notification arrives while the app is open. */
function onPushNotification(jsonStr) {
  try {
    var n = JSON.parse(jsonStr);
    showToast((n.title || "D-FLIX") + ": " + (n.body || ""));
  } catch (e) { }
  refreshBellBadge();
  if (notifOverlay.classList.contains("active")) {
    renderNotifications();
    try { Android.markNotificationsRead(); } catch (e2) { }
  }
}

/** Called directly from FirebaseNotifyListener.java (MainActivity.removeFromWeb)
 *  whenever a notification is deleted from the admin panel. */
function onNotificationRemoved(id) {
  refreshBellBadge();
  if (notifOverlay.classList.contains("active")) {
    renderNotifications();
  }
}

// ==========================================================================
// MOVIE / SERIES REQUEST (Profile tab). Saved into the same Firebase
// Realtime Database already used for posters/notifications, under
// "/requests/{pushId}" - the standalone admin_requests.html panel reads
// and manages this list.
// ==========================================================================

function sendMovieRequest() {
  var name = (requestNameInput.value || "").trim();
  var note = (requestNoteInput.value || "").trim();

  if (!name) {
    showToast("Please enter a movie or series name");
    try { requestNameInput.focus(); } catch (e) { }
    return;
  }

  btnSendRequest.disabled = true;
  btnSendRequest.textContent = "Sending...";

  var payload = { name: name, note: note, ts: Date.now() };

  function resetSendBtn() {
    btnSendRequest.disabled = false;
    btnSendRequest.textContent = "Send Request";
  }

  fetch(FIREBASE_DB_URL + "/requests.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  })
    .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("Request failed")); })
    .then(function () {
      showToast("Request sent! We'll try to add it soon.");
      requestNameInput.value = "";
      requestNoteInput.value = "";
      resetSendBtn();
    })
    .catch(function () {
      showToast("Couldn't send request - check your internet connection.");
      resetSendBtn();
    });
}

function setActiveNav(el) {
  var items = document.querySelectorAll(".nav-item");
  items.forEach(function (n) { n.classList.remove("active"); });
  if (el) el.classList.add("active");
}

// ---------- Hardware/gesture back button (called from MainActivity.java) ----------
function handleBackPress() {
  if (searchOverlay.classList.contains("active")) {
    closeSearch();
    return true;
  }
  if (confirmOverlay.classList.contains("active")) {
    closeConfirm();
    return true;
  }
  if (actionSheetOverlay.classList.contains("active")) {
    closeActionSheet();
    return true;
  }
  if (notifOverlay.classList.contains("active")) {
    closeNotifications();
    return true;
  }
  if (resumeOverlay.classList.contains("active")) {
    closeResumePopup();
    return true;
  }
  if (viewMode === "profile") {
    goHome(false);
    return true;
  }
  if (viewMode === "downloads" || viewMode === "movies" || viewMode === "webseries") {
    goHome(false);
    return true;
  }
  if (viewMode === "downloadFolder") {
    exitDownloadFolderLevel();
    return true;
  }
  if (viewMode === "browse" && folderStack.length > 1) {
    goBackFolder();
    return true;
  }
  return false;
}

// Both the visible back-chevron in the header (in browse-mode) and hardware-back use this
function goBackFolder() {
  if (viewMode === "downloadFolder") {
    exitDownloadFolderLevel();
    return;
  }
  if (folderStack.length <= 1) return;
  folderStack.pop();
  var top = folderStack[folderStack.length - 1];
  if (folderStack.length === 1) {
    if (browseReturnToProfile) { browseReturnToProfile = false; goProfile(); }
    else goHome(false);
  } else {
    loadFolder(top.id, top.name);
  }
}

// ---------- Breadcrumb (disabled) ----------
function renderBreadcrumb() {
  breadcrumbEl.classList.add("hidden");
  breadcrumbEl.innerHTML = "";
}

// ==========================================================================
// HOME VIEW (Netflix-style rows)
// ==========================================================================

function loadHomeRows(force) {
  if (homeRowsCache && !force) {
    renderHomeFromCache();
    resumeHeroCarousel();
    return;
  }
  resetHeroState();
  rowsContainerEl.innerHTML =
    '<div class="row-section"><div class="row-header"><div class="row-title">Loading...</div></div>' +
    '<div class="row-loading"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div></div>';
  Android.listFiles(LOCKED_ROOT_FOLDER_ID, "onHomeRootLoaded");
}

function onHomeRootLoaded(data) {
  if (data && data.error) {
    if (data.error === "not_logged_in") { showLogin(); return; }
    rowsContainerEl.innerHTML = "";
    showStateScreen(rowsContainerEl, "\u26A0\uFE0F", "Something went wrong", escapeHtml(data.error));
    return;
  }

  var files = (data && data.files) ? data.files : [];
  var folders = [];
  var looseFiles = [];

  for (var i = 0; i < files.length; i++) {
    if (files[i].mimeType === "application/vnd.google-apps.folder") {
      folders.push(files[i]);
    } else {
      looseFiles.push(files[i]);
    }
  }

  homeRowsCache = { folders: folders, looseFiles: looseFiles, rowChildren: {} };
  renderHomeFromCache();
}

function renderHomeFromCache() {
  var folders = homeRowsCache.folders;
  var looseFiles = homeRowsCache.looseFiles;

  if (folders.length === 0 && looseFiles.length === 0) {
    rowsContainerEl.innerHTML = "";
    showStateScreen(rowsContainerEl, "\uD83D\uDCED", "Nothing found", "This Drive folder is empty.");
    return;
  }

  rowsContainerEl.innerHTML = "";
  pendingHeroChecks = folders.length + (looseFiles.length > 0 ? 1 : 0);

  folders.forEach(function (folder, idx) {
    var rowId = "row" + idx + "_" + Date.now();
    var section = buildRowSkeleton(rowId, folder.name, folder);
    rowsContainerEl.appendChild(section);

    var cachedFiles = homeRowsCache.rowChildren && homeRowsCache.rowChildren[folder.id];
    if (cachedFiles) {
      // Already fetched this session - reuse it, no fresh network call.
      renderRow(rowId, cachedFiles, folder.name);
    } else {
      fetchRowChildren(rowId, folder);
    }
  });

  if (looseFiles.length > 0) {
    var rowId = "rowLoose_" + Date.now();
    rowsContainerEl.appendChild(buildRowSkeleton(rowId, "Files", null));
    renderRow(rowId, looseFiles);
    setHeroFromFiles(looseFiles, "Files");
    checkHeroFallback();
  }
}

function buildRowSkeleton(rowId, title, folder) {
  var section = document.createElement("div");
  section.className = "row-section";
  section.id = "section_" + rowId;

  var seeAllBtn = folder
    ? '<button class="row-seeall" data-see-all-id="' + folder.id + '" data-see-all-name="' + escapeHtml(folder.name) + '">See All</button>'
    : "";

  section.innerHTML =
    '<div class="row-header"><div class="row-title">' + escapeHtml(title) + '</div>' + seeAllBtn + '</div>' +
    '<div class="row-loading" id="loading_' + rowId + '"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>' +
    '<div class="movie-row hidden" id="row_' + rowId + '"></div>';

  if (folder) {
    var btn = section.querySelector("[data-see-all-id]");
    btn.addEventListener("click", function () {
      enterBrowseFolder(folder.id, folder.name);
    });
  }
  return section;
}

function fetchRowChildren(rowId, folder) {
  var cbName = "onRowLoaded_" + rowId;
  window[cbName] = function (data) {
    delete window[cbName];
    var files = (data && data.files) ? data.files : [];
    if (homeRowsCache && homeRowsCache.rowChildren) {
      homeRowsCache.rowChildren[folder.id] = files;
    }
    renderRow(rowId, files, folder.name);
    if (files.length > 0) setHeroFromFiles(files, folder.name);
    checkHeroFallback();
  };
  try {
    Android.listFiles(folder.id, cbName);
  } catch (e) {
    renderRow(rowId, []);
    checkHeroFallback();
  }
}

function renderRow(rowId, files) {
  var loadingEl = document.getElementById("loading_" + rowId);
  var rowEl = document.getElementById("row_" + rowId);
  if (!rowEl) return;

  if (loadingEl) loadingEl.remove();

  if (files.length === 0) {
    var section = document.getElementById("section_" + rowId);
    if (section) section.remove();
    return;
  }

  var html = "";
  files.forEach(function (f) {
    html += buildCardHtml(f);
  });
  rowEl.innerHTML = html;
  rowEl.classList.remove("hidden");

  attachCardHandlers(rowEl, false);
  lazyLoadPostersIn(rowEl);
}

// Picks one trending video file from each row and collects candidates up
// to HERO_MAX_CANDIDATES - the hero banner rotates between these.
function setHeroFromFiles(files, rowTitle) {
  if (heroCandidates.length >= HERO_MAX_CANDIDATES) return;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.mimeType !== "application/vnd.google-apps.folder" && isVideoFile(f.name)) {
      heroCandidates.push({ id: f.id, name: f.name, rowTitle: rowTitle, poster: null });
      if (heroCandidates.length >= HERO_MAX_CANDIDATES) return;
    }
  }
}

// All the home rows have finished loading - if at least one trending
// candidate was found, start the carousel, otherwise show "Coming Soon".
function checkHeroFallback() {
  pendingHeroChecks--;
  if (pendingHeroChecks <= 0) {
    if (heroCandidates.length > 0) {
      startHeroCarousel();
    } else {
      setHeroComingSoon();
    }
  }
}

function resetHeroState() {
  heroCandidates = [];
  heroCandidateIndex = 0;
  heroActiveLayer = 0;
  if (heroRotateTimer) {
    clearInterval(heroRotateTimer);
    heroRotateTimer = null;
  }
  [heroBg0El, heroBg1El].forEach(function (el) {
    if (el) { el.classList.remove("active"); el.style.backgroundImage = ""; }
  });
  if (heroDotsEl) heroDotsEl.innerHTML = "";
}

function startHeroCarousel() {
  if (heroRotateTimer) { clearInterval(heroRotateTimer); heroRotateTimer = null; }
  renderHeroDots();
  showHeroCandidate(0);
  if (heroCandidates.length > 1) {
    heroRotateTimer = setInterval(function () {
      var nextIdx = (heroCandidateIndex + 1) % heroCandidates.length;
      showHeroCandidate(nextIdx);
    }, HERO_ROTATE_MS);
  }
}

// Battery-saver: stop the auto-rotate interval whenever the hero banner
// isn't actually visible (user left Home tab, or app went to background).
// Position (heroCandidateIndex) is kept, so resuming just continues from
// where it left off instead of restarting the whole cycle.
function pauseHeroCarousel() {
  if (heroRotateTimer) {
    clearInterval(heroRotateTimer);
    heroRotateTimer = null;
  }
}

function resumeHeroCarousel() {
  if (!heroRotateTimer && heroCandidates.length > 1 && viewMode === "home" && !document.hidden) {
    heroRotateTimer = setInterval(function () {
      var nextIdx = (heroCandidateIndex + 1) % heroCandidates.length;
      showHeroCandidate(nextIdx);
    }, HERO_ROTATE_MS);
  }
}

function renderHeroDots() {
  if (!heroDotsEl) return;
  if (heroCandidates.length <= 1) { heroDotsEl.innerHTML = ""; return; }
  var html = "";
  for (var i = 0; i < heroCandidates.length; i++) {
    html += '<div class="dot' + (i === 0 ? " active" : "") + '"></div>';
  }
  heroDotsEl.innerHTML = html;
}

function showHeroCandidate(idx) {
  var c = heroCandidates[idx];
  if (!c) return;
  heroCandidateIndex = idx;

  heroTagEl.textContent = "TRENDING IN " + c.rowTitle.toUpperCase();
  heroPlayBtn.onclick = function () { playVideo(c.id, c.name, null); };

  if (c.poster) {
    applyHeroBackground(c.poster);
  } else {
    requestHeroPoster(c.name, idx);
  }

  if (heroDotsEl) {
    var dots = heroDotsEl.querySelectorAll(".dot");
    dots.forEach(function (d, i) { d.classList.toggle("active", i === idx); });
  }
}

function applyHeroBackground(url) {
  var showEl = heroActiveLayer === 0 ? heroBg1El : heroBg0El;
  var hideEl = heroActiveLayer === 0 ? heroBg0El : heroBg1El;
  if (!showEl || !hideEl) return;
  showEl.style.backgroundImage = url ? "url('" + url + "')" : "";
  showEl.classList.add("active");
  hideEl.classList.remove("active");
  heroActiveLayer = heroActiveLayer === 0 ? 1 : 0;
}

function setHeroComingSoon() {
  heroTagEl.textContent = "COMING SOON";
  applyHeroBackground(null);
  heroPlayBtn.onclick = function () { showToast("Coming soon!"); };
}

function requestHeroPoster(fileName, idx) {
  var customUrl = customPosterMap[posterKeyEncode(fileName)];
  if (customUrl) {
    heroCandidates[idx].poster = customUrl;
    if (idx === heroCandidateIndex) applyHeroBackground(customUrl);
    return;
  }
  try {
    Android.resolveBackdrop(fileName, "heroReq_" + idx);
  } catch (e) {
    // Older APK build without resolveBackdrop - fall back to the poster
    try { Android.resolvePoster(fileName, "heroReq_" + idx); } catch (e2) { /* ignore */ }
  }
}

// ==========================================================================
// BROWSE VIEW (old grid drilldown - after entering a folder)
// ==========================================================================

function enterBrowseFolder(id, name, prefetched) {
  viewMode = "browse";
  appRoot.classList.add("browse-mode", "drive-browse");
  folderStack.push({ id: id, name: name });
  profileViewEl.classList.add("hidden");
  homeViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  loadFolder(id, name, prefetched);
}

function loadFolder(folderId, folderName, prefetched) {
  currentFolderId = folderId;
  renderBreadcrumb();
  if (prefetched) { onFilesLoaded(prefetched); return; }
  showLoadingState(contentEl);
  Android.listFiles(folderId, "onFilesLoaded");
}

function onFilesLoaded(data) {
  renderGrid(data, contentEl, false);
}

// ---------- Search ----------
function openSearch() {
  searchOverlay.classList.add("active");
  setTimeout(function () { searchInput.focus(); }, 150);
}

function closeSearch() {
  searchOverlay.classList.remove("active");
  searchInput.value = "";
  btnClearSearch.style.display = "none";
  searchResultLabel.classList.add("hidden");
  searchBody.innerHTML = "";
  searchBody.appendChild(searchIdleState);
}

function clearSearch() {
  searchInput.value = "";
  btnClearSearch.style.display = "none";
  searchResultLabel.classList.add("hidden");
  searchBody.innerHTML = "";
  searchBody.appendChild(searchIdleState);
  searchInput.focus();
}

var searchRequestSeq = 0;

searchInput.addEventListener("input", function () {
  var keyword = searchInput.value.trim();
  btnClearSearch.style.display = keyword.length ? "flex" : "none";
  clearTimeout(searchTimer);

  if (keyword.length === 0) {
    searchResultLabel.classList.add("hidden");
    searchBody.innerHTML = "";
    searchBody.appendChild(searchIdleState);
    return;
  }

  searchTimer = setTimeout(function () {
    showLoadingState(searchBody);
    searchRequestSeq++;
    var mySeq = searchRequestSeq;
    var cbName = "onSearchResults_" + mySeq;

    // Per-request callback: if the user kept typing and a newer search has
    // since been fired, this (now-stale) response is dropped instead of
    // flashing outdated results over the current keyword's results.
    window[cbName] = function (data) {
      delete window[cbName];
      if (mySeq !== searchRequestSeq) return;
      var keyword2 = searchInput.value.trim();
      searchResultLabel.classList.remove("hidden");
      searchResultLabel.textContent = 'Results for "' + keyword2 + '"';
      renderGrid(data, searchBody, true);
    };

    Android.searchFiles(keyword, cbName);
  }, 200);
});

// ==========================================================================
// SHARED CARD RENDERING (used by both the grid and the row)
// ==========================================================================

var posterUidSeq = 0;
var browseReturnToProfile = false;
var actionSheetParentHint = null;

function buildCardHtml(f) {
  var isFolder = f.mimeType === "application/vnd.google-apps.folder";
  var isVideo = !isFolder && isVideoFile(f.name);
  var isHtml = !isFolder && !isVideo && isHtmlFile(f.name);
  posterUidSeq++;
  var uid = "poster_u" + posterUidSeq;

  var html = '<div class="grid-card' + (isFolder ? " folder-card" : "") + '" '
    + 'data-id="' + f.id + '" data-name="' + escapeHtml(f.name) + '" data-folder="' + isFolder + '" '
    + 'tabindex="0">';

  if (isVideo) {
    html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(f.name) + '"><div class="gi">\uD83C\uDFAC</div></div>';
    html += '<span class="badge">HD</span>';
  } else if (isFolder) {
    html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(f.name) + '"><div class="gi">\uD83D\uDCC1</div></div>';
  } else if (isHtml) {
    html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(f.name) + '" data-poster-mode="custom-only" data-fallback-icon="\uD83C\uDF10"><div class="gi">\uD83C\uDF10</div></div>';
    html += '<span class="badge">WEB</span>';
  } else {
    html += '<div class="no-poster"><div class="gi">' + getFileIcon(f.name) + '</div></div>';
  }

  html += '<div class="grid-name">' + escapeHtml(f.name) + '</div>';
  html += '</div>';
  return html;
}

function attachCardHandlers(container, isSearchContext) {
  var items = container.querySelectorAll(".grid-card");
  items.forEach(function (item) {
    item.addEventListener("click", function () {
      var id = item.getAttribute("data-id");
      var name = item.getAttribute("data-name");
      var isFolder = item.getAttribute("data-folder") === "true";

      if (isSearchContext) closeSearch();
      if (isFolder) {
        // Folder: no popup - open it directly (movie / episode folders with 1080p/720p/480p show a quality picker)
        openFolderSmart(id, name);
      } else {
        // Movie / file: centered Play + Download popup
        // (when browsing a folder, that folder is this file's parent - saves a Drive lookup)
        actionSheetParentHint = (!isSearchContext && container === contentEl && viewMode === "browse") ? currentFolderId : null;
        openActionSheet(id, name, isFolder);
      }
    });
  });
}

// ---------- Render (classic 3-column grid - used by both browse-mode and search) ----------
function renderGrid(data, container, isSearch) {
  if (data && data.error) {
    if (data.error === "not_logged_in") {
      showLogin();
      return;
    }
    showStateScreen(container, "\u26A0\uFE0F", "Something went wrong", escapeHtml(data.error));
    showToast("Error: " + data.error);
    return;
  }

  var files = (data && data.files) ? data.files : [];

  if (files.length === 0) {
    showStateScreen(container, "\uD83D\uDCED", "Nothing found",
      isSearch ? "No file found with this name." : "This folder is empty.");
    return;
  }

  var html = '<div class="movie-grid">';
  for (var i = 0; i < files.length; i++) {
    html += buildCardHtml(files[i]);
  }
  html += '</div>';
  container.innerHTML = html;

  attachCardHandlers(container, isSearch);
  lazyLoadPostersIn(container);
}

// ---------- State screens ----------
function showLoadingState(container) {
  container.innerHTML = '<div class="state-screen"><div class="spinner"></div><div class="msg">Loading...</div></div>';
}

function showStateScreen(container, emoji, title, msg) {
  container.innerHTML = '<div class="state-screen">'
    + '<div class="emoji">' + emoji + '</div>'
    + '<div class="title">' + title + '</div>'
    + '<div class="msg">' + msg + '</div>'
    + '</div>';
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(function () { toastEl.classList.remove("show"); }, 2500);
}

// ==========================================================================
// TMDB POSTERS (lazy load) - now used for both folder-cards and video-cards
// ==========================================================================

function isVideoFile(name) {
  var lower = name.toLowerCase();
  return lower.endsWith(".mkv") || lower.endsWith(".mp4") || lower.endsWith(".avi") || lower.endsWith(".mov");
}

// .html/.htm files get opened in the app's own in-app WebView
// (HtmlViewerActivity) with full JS + CSS support, instead of being
// played in the built-in player like video files are.
function isHtmlFile(name) {
  var lower = name.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

function lazyLoadPostersIn(container) {
  var targets = container.querySelectorAll("[data-poster-query]");
  function resolveEl(el) {
    if (el.getAttribute("data-poster-mode") === "custom-only") {
      requestCustomPosterOnly(el.getAttribute("data-poster-query"), el);
      return;
    }
    var persist = null;
    var pType = el.getAttribute("data-persist-type");
    if (pType === "file") persist = { type: "file", id: el.getAttribute("data-persist-id") };
    else if (pType === "folder") persist = { type: "folder", name: el.getAttribute("data-persist-name") };
    requestPoster(el.getAttribute("data-poster-query"), el, persist);
  }
  if (!("IntersectionObserver" in window)) {
    targets.forEach(resolveEl);
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        observer.unobserve(entry.target);
        resolveEl(entry.target);
      }
    });
  }, { rootMargin: "200px" });
  targets.forEach(function (el) { observer.observe(el); });
}

var LOCAL_SERVER_BASE = "http://127.0.0.1:8765";

// Turns a Drive fileId or folder name into a filesystem/URL-safe key for
// the poster saved on disk. A short numeric hash suffix is added so two
// names that only differ by punctuation (which both sanitize to the same
// string) don't collide and overwrite each other's poster.
function posterFileKey(prefix, raw) {
  raw = raw || "";
  var safe = raw.replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 80);
  var hash = 0;
  for (var i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return prefix + safe + "_" + Math.abs(hash);
}

function downloadPosterUrl(key) {
  return LOCAL_SERVER_BASE + "/poster/" + key + ".jpg";
}

var posterRequestSeq = 0;
var pendingPosterRequests = {};
var pendingPosterPersist = {};

// Same idea as requestPoster(), but ONLY ever checks the admin's Firebase
// custom-poster map - never falls back to a TMDB lookup, since an .html
// file isn't a movie/show and has no TMDB entry to match against. If no
// custom poster was set for it, the globe icon placeholder just stays as-is.
function requestCustomPosterOnly(query, iconEl) {
  if (!query || !iconEl) return;
  var customUrl = customPosterMap[posterKeyEncode(query)];
  if (!customUrl) return;

  var fallbackIcon = iconEl.getAttribute("data-fallback-icon") || "\uD83C\uDF10";
  var img = document.createElement("img");
  img.className = "thumb";
  img.src = customUrl;
  // If the Firebase poster URL 404s or fails to load, quietly fall back
  // to the globe icon instead of showing a broken-image icon forever.
  img.addEventListener("error", function () {
    var div = document.createElement("div");
    div.className = "no-poster";
    div.innerHTML = '<div class="gi">' + fallbackIcon + '</div>';
    img.replaceWith(div);
  }, { once: true });
  iconEl.replaceWith(img);
}

function requestPoster(query, iconEl, persist) {
  if (!query) return;
  var customUrl = customPosterMap[posterKeyEncode(query)];
  if (customUrl) {
    if (iconEl) applyPosterImage(iconEl, customUrl);
    if (persist) persistDownloadPoster(persist, customUrl);
    return;
  }
  try {
    posterRequestSeq++;
    var reqId = "p" + posterRequestSeq;
    if (iconEl) pendingPosterRequests[reqId] = iconEl;
    if (persist) pendingPosterPersist[reqId] = persist;
    Android.resolvePoster(query, reqId);
  } catch (e) {
    // Android.resolvePoster is not available (older build) - just leave the icon as is
  }
}

// Kicks off a poster fetch purely to save it for offline use later (no
// on-screen icon to fill in yet) - used the moment a download starts, so
// by the time it finishes the poster is already saved alongside it.
function prefetchDownloadPoster(query, persist) {
  requestPoster(query, null, persist);
}

// Downloaded items are meant to work fully offline, so once a poster is
// resolved for something the user downloaded, its JPEG bytes are saved
// as a small file on disk (via the native bridge) instead of as base64
// text inside WebView localStorage - localStorage has only a ~5-10MB
// total cap, which base64 posters for 100+ downloads would burn through
// fast. Only a short "posterKey" reference is kept in localStorage;
// the actual image is fetched back from the local server when needed.
//
// dataUrl here is USUALLY already a "data:image/jpeg;base64,..." string
// (that's what TMDB posters resolve to). But it can also be a plain
// "https://..." URL when an admin has set a CUSTOM poster (see
// customPosterMap above) - Android.savePosterFile() can only write real
// image bytes, not a remote URL. A plain URL is downloaded on the NATIVE
// side instead of via a JS fetch() (see saveCustomPosterFile / onCustomPosterSaved
// below) - a WebView fetch() would often get silently blocked by CORS for
// external image hosts, which used to leave a "posterKey" recorded as if
// saving had worked, so the poster would later show as a broken image
// (especially offline). Downloading it natively avoids the CORS problem
// entirely and only records the posterKey once the bytes are confirmed
// saved to disk.
var customPosterSaveSeq = 0;
var pendingCustomPosterSaves = {};

function persistDownloadPoster(persist, dataUrl) {
  if (!persist || !dataUrl) return;

  if (dataUrl.indexOf("data:") !== 0) {
    var key = persist.type === "file"
      ? posterFileKey("f_", persist.id)
      : posterFileKey("d_", persist.name);
    customPosterSaveSeq++;
    var reqId = "cp" + customPosterSaveSeq;
    pendingCustomPosterSaves[reqId] = { persist: persist, key: key };
    try {
      Android.saveCustomPosterFile(key, dataUrl, reqId);
    } catch (e) {
      // Older APK build without this bridge method yet - nothing more we
      // can safely do for a remote URL without risking a broken poster,
      // so just leave the placeholder icon in place.
      delete pendingCustomPosterSaves[reqId];
    }
    return;
  }

  savePosterBytesToDisk(persist, dataUrl);
}

// Called from Java once saveCustomPosterFile() finishes downloading (or
// fails to download) a custom poster URL.
function onCustomPosterSaved(requestId, ok) {
  var entry = pendingCustomPosterSaves[requestId];
  delete pendingCustomPosterSaves[requestId];
  if (!entry || !ok) return; // download failed - leave placeholder icon, try again next time
  var persist = entry.persist;
  if (persist.type === "file") {
    upsertDownloadEntry({ id: persist.id, posterKey: entry.key });
  } else if (persist.type === "folder") {
    saveDownloadFolderPoster(persist.name, entry.key);
  }
  if (viewMode === "downloads") renderDownloadsList();
}

function savePosterBytesToDisk(persist, dataUrl) {
  var key = persist.type === "file"
    ? posterFileKey("f_", persist.id)
    : posterFileKey("d_", persist.name);

  var savedToDisk = false;
  try {
    Android.savePosterFile(key, dataUrl);
    savedToDisk = true;
  } catch (e) {
    // Older APK build without this bridge method yet - fall back to
    // storing the base64 image directly, same as before.
  }

  if (persist.type === "file") {
    if (savedToDisk) upsertDownloadEntry({ id: persist.id, posterKey: key });
    else upsertDownloadEntry({ id: persist.id, poster: dataUrl });
  } else if (persist.type === "folder") {
    saveDownloadFolderPoster(persist.name, savedToDisk ? key : dataUrl);
  }
  if (viewMode === "downloads") renderDownloadsList();
}

var DOWNLOAD_FOLDER_POSTERS_KEY = "dflix_download_folder_posters";

function loadDownloadFolderPosters() {
  try {
    var raw = localStorage.getItem(DOWNLOAD_FOLDER_POSTERS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

// Stored value is either a small posterKey (new, disk-based) or - for
// entries saved by an older build - a full "data:image/..." base64
// string. Both are valid straight in an <img src>, so callers don't need
// to care which one it is; this just resolves it to a usable src.
function resolveStoredPosterSrc(value) {
  if (!value) return null;
  if (value.indexOf("data:") === 0) return value;
  return downloadPosterUrl(value);
}

function saveDownloadFolderPoster(folderName, keyOrDataUrl) {
  try {
    var map = loadDownloadFolderPosters();
    map[folderName] = keyOrDataUrl;
    localStorage.setItem(DOWNLOAD_FOLDER_POSTERS_KEY, JSON.stringify(map));
  } catch (e) { /* storage full/unavailable - ignore */ }
}

function removeDownloadFolderPoster(folderName) {
  try {
    var map = loadDownloadFolderPosters();
    var stored = map[folderName];
    if (stored) {
      delete map[folderName];
      localStorage.setItem(DOWNLOAD_FOLDER_POSTERS_KEY, JSON.stringify(map));
      if (stored.indexOf("data:") !== 0) {
        try { Android.deletePosterFile(stored); } catch (e) { /* older APK - ignore */ }
      }
    }
  } catch (e) { /* ignore */ }
}

function applyPosterImage(iconEl, url) {
  var img = document.createElement("img");
  img.className = "thumb";
  // image load fail ho (link toota / blocked) to wapas placeholder icon dikhao, broken-image nahi
  img.addEventListener("error", function () { if (img.parentNode) img.replaceWith(iconEl); }, { once: true });
  img.src = url;
  iconEl.replaceWith(img);
}

// Saved poster files are served from disk via the local server
// (http://127.0.0.1:8765/poster/{key}.jpg). If that file is ever missing
// (app data was cleared, the .jpg somehow never got written, etc.) the
// <img> would otherwise just show a broken-image icon forever. This swaps
// it back to the normal placeholder icon instead, so the UI never shows
// an error - it just falls back to looking like an unresolved poster.
function attachPosterErrorFallback(container) {
  container.querySelectorAll("img.thumb[data-fallback-icon]").forEach(function (img) {
    img.addEventListener("error", function () {
      var icon = img.getAttribute("data-fallback-icon");
      var div = document.createElement("div");
      div.className = "no-poster";
      div.innerHTML = '<div class="gi">' + icon + '</div>';
      img.replaceWith(div);
    }, { once: true });
  });
}

function onPosterResolved(requestId, dataUrl) {
  if (requestId.indexOf("heroReq_") === 0) {
    var idx = parseInt(requestId.slice(8), 10);
    if (dataUrl && heroCandidates[idx]) {
      heroCandidates[idx].poster = dataUrl;
      if (idx === heroCandidateIndex) applyHeroBackground(dataUrl);
    }
    return;
  }
  var iconEl = pendingPosterRequests[requestId];
  delete pendingPosterRequests[requestId];
  var persist = pendingPosterPersist[requestId];
  delete pendingPosterPersist[requestId];
  if (dataUrl && persist) persistDownloadPoster(persist, dataUrl);
  if (!iconEl || !dataUrl) return;
  applyPosterImage(iconEl, dataUrl);
}

// ==========================================================================
// ACTION SHEET (on every card tap: Play/View + Download)
// ==========================================================================

function formatBytes(bytes) {
  var n = parseInt(bytes, 10);
  if (!n || n <= 0) return "";
  var units = ["B", "KB", "MB", "GB", "TB"];
  var i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + " " + units[i];
}

function openActionSheet(id, name, isFolder) {
  actionSheetTitle.textContent = name;

  var playIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
  var downloadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

  var isHtml = !isFolder && isHtmlFile(name);

  var html = "";
  if (isFolder) {
    html += '<div class="action-option" id="actionPrimary">'
      + '<div class="a-icon">' + folderIcon + '</div>'
      + '<div><div class="a-label">View Folder</div><div class="a-sub">View files inside</div></div>'
      + '</div>';
    html += '<div class="action-option" id="actionDownload">'
      + '<div class="a-icon">' + downloadIcon + '</div>'
      + '<div><div class="a-label">Download Folder</div><div class="a-sub">Saved inside the app (offline)</div></div>'
      + '</div>';
  } else if (isHtml) {
    html += '<div class="action-option" id="actionPrimary">'
      + '<div class="a-icon">' + playIcon + '</div>'
      + '<div><div class="a-label">Open</div><div class="a-sub">View this page in-app (JS &amp; CSS supported)</div></div>'
      + '</div>';
    html += '<div class="action-option" id="actionDownload">'
      + '<div class="a-icon">' + downloadIcon + '</div>'
      + '<div><div class="a-label">Download</div><div class="a-sub">Saved inside the app (offline)</div></div>'
      + '</div>';
  } else {
    html += '<div class="action-option" id="actionPrimary">'
      + '<div class="a-icon">' + playIcon + '</div>'
      + '<div><div class="a-label">Play</div><div class="a-sub">Stream and watch instantly</div></div>'
      + '</div>';
    html += '<div class="action-option" id="actionDownload">'
      + '<div class="a-icon">' + downloadIcon + '</div>'
      + '<div><div class="a-label">Download</div><div class="a-sub">Saved inside the app (offline)</div></div>'
      + '</div>';
  }
  actionSheetBody.innerHTML = html;

  document.getElementById("actionPrimary").addEventListener("click", function () {
    closeActionSheet();
    if (isFolder) {
      openFolderSmart(id, name);
    } else if (isHtml) {
      // Opened from the SAME folder that's currently being browsed, so
      // any sibling .css/.js the page references resolves correctly too.
      Android.openHtmlFile(id, name, currentFolderId);
    } else {
      playVideo(id, name, actionSheetParentHint);
    }
  });

  document.getElementById("actionDownload").addEventListener("click", function () {
    closeActionSheet();
    if (isFolder) {
      startFolderDownload(id, name);
    } else {
      startFileDownload(id, name);
    }
  });

  clearTimeout(actionSheetCloseTimer);
  actionSheetOverlay.classList.remove("closing");
  actionSheetOverlay.classList.add("active");
}

var actionSheetCloseTimer = null;
function closeActionSheet() {
  if (!actionSheetOverlay.classList.contains("active")) return;
  actionSheetOverlay.classList.add("closing");
  clearTimeout(actionSheetCloseTimer);
  actionSheetCloseTimer = setTimeout(function () {
    actionSheetOverlay.classList.remove("active", "closing");
  }, 180);
}

// ==========================================================================
// DOWNLOADS
// Files are saved only in the app's own private storage (they don't show
// up in the public "Downloads" folder or in any file manager) - so no
// storage permission needs to be requested either. Progress (how much has
// downloaded, at what speed) is updated here through a live callback from Java:
//   onDownloadProgress(fileId, receivedBytes, totalBytes, speedBytesPerSec)
//   onDownloadComplete(fileId)
//   onDownloadError(fileId, message)
//   onDownloadCancelled(fileId)
//   onDownloadPaused(fileId)
//   onFolderDownloadQueued(filesJsonArrayString)  (folder scan ke baad)
// ==========================================================================

var DOWNLOADS_STORAGE_KEY = "dflix_downloads_v2";

function loadDownloads() {
  try {
    var raw = localStorage.getItem(DOWNLOADS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveDownloads(list) {
  try {
    localStorage.setItem(DOWNLOADS_STORAGE_KEY, JSON.stringify(list));
  } catch (e) { /* storage full/unavailable - ignore */ }
}

// When the app reopens, the real native task for items that had a
// "downloading" status doesn't survive (the process itself has
// restarted), so they're immediately marked as "error" (retry-able).
(function sanitizeStaleDownloadsOnLoad() {
  var list = loadDownloads();
  var changed = false;
  list.forEach(function (item) {
    if (item.status === "downloading") {
      item.status = "error";
      item.errorMsg = "Download stopped because the app was closed";
      changed = true;
    }
  });
  if (changed) saveDownloads(list);
})();

function upsertDownloadEntry(patch) {
  var list = loadDownloads();
  var idx = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === patch.id) { idx = i; break; }
  }
  if (idx === -1) {
    list.unshift(patch);
  } else {
    // Only update the fields, don't touch the position - otherwise on
    // every onDownloadProgress tick (which comes roughly every ~500ms)
    // this item would jump to the top of the list, and the whole
    // sequence (like Episode 1, Episode 2, Episode 3...) would keep
    // getting shuffled around.
    var merged = list[idx];
    for (var key in patch) {
      if (patch.hasOwnProperty(key)) merged[key] = patch[key];
    }
    list[idx] = merged;
  }
  if (list.length > 200) list = list.slice(0, 200);
  saveDownloads(list);
  return list;
}

// When a folder download starts, all its files are added to the list
// together, in their original (natural) order. Calling upsertDownloadEntry
// one at a time would reverse the order (the last file would end up on
// top) - so here the whole batch is prepended at once, in the correct order.
function upsertDownloadEntriesBatch(patches) {
  if (!patches || patches.length === 0) return;
  var list = loadDownloads();
  var newIds = {};
  patches.forEach(function (p) { newIds[p.id] = true; });
  list = list.filter(function (item) { return !newIds[item.id]; });
  list = patches.concat(list);
  if (list.length > 200) list = list.slice(0, 200);
  saveDownloads(list);
}

function findDownloadEntry(id) {
  var list = loadDownloads();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

// For automatic situations like cancel/error, remove from the list without
// a confirmation - the file has already been deleted natively (LocalDownloadManager).
function removeDownloadEntryQuiet(id) {
  var list = loadDownloads().filter(function (i) { return i.id !== id; });
  saveDownloads(list);
  renderDownloadsList();
  refreshDownloadFolderViewIfOpen();
}

// If the user presses the "Delete/Cancel" button, show a confirmation popup first.
function openConfirmDelete(id, name) {
  var item = findDownloadEntry(id);
  var isDownloading = item && item.status === "downloading";
  confirmTitle.textContent = isDownloading ? "Cancel download?" : "Delete?";
  confirmMsg.textContent = isDownloading
    ? 'Stopping the download of "' + name + '" will delete the incomplete file.'
    : '"' + name + '" will be permanently deleted. This cannot be undone.';
  confirmDeleteBtn.onclick = function () {
    closeConfirm();
    performDelete(id, name);
  };
  confirmOverlay.classList.add("active");
}

function closeConfirm() {
  confirmOverlay.classList.remove("active");
  confirmDeleteBtn.textContent = "Delete";
}

// For deleting an entire folder (all files inside it, whether already
// downloaded or still in progress) with a single confirmation.
function openConfirmDeleteFolder(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  confirmTitle.textContent = "Delete All";
  confirmMsg.textContent = 'All (' + items.length + ') files in "' + folderName + '" will be permanently deleted.';
  confirmDeleteBtn.onclick = function () {
    closeConfirm();
    performDeleteFolder(folderName);
  };
  confirmOverlay.classList.add("active");
}

function performDeleteFolder(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  items.forEach(function (item) {
    try { Android.deleteDownloadedFile(item.id, item.name); } catch (e) { /* even on an older APK, still remove it from the list */ }
  });
  var list = loadDownloads().filter(function (i) { return i.folderName !== folderName; });
  saveDownloads(list);
  removeDownloadFolderPoster(folderName);
  if (viewMode === "downloadFolder" && currentDownloadFolderName === folderName) {
    goDownloads();
  } else {
    renderDownloadsList();
  }
  showToast('"' + folderName + '" was deleted');
}

// The actual delete after confirmation: the native side also removes the file from disk.
function performDelete(id, name) {
  try {
    Android.deleteDownloadedFile(id, name);
  } catch (e) { /* even on an older APK, still remove it from the list */ }
  var item = findDownloadEntry(id);
  if (item && item.posterKey) {
    try { Android.deletePosterFile(item.posterKey); } catch (e) { /* older APK - ignore */ }
  }
  var list = loadDownloads().filter(function (i) { return i.id !== id; });
  saveDownloads(list);
  renderDownloadsList();
  refreshDownloadFolderViewIfOpen();
  showToast("Deleted");
}

function startFileDownload(fileId, fileName) {
  upsertDownloadEntry({
    id: fileId, name: fileName, isFolder: false,
    status: "downloading", received: 0, total: 0, speed: 0, ts: Date.now()
  });
  try {
    Android.downloadFile(fileId, fileName);
  } catch (e) {
    upsertDownloadEntry({ id: fileId, status: "error", errorMsg: "Download could not start" });
  }
  prefetchDownloadPoster(fileName, { type: "file", id: fileId });
  showToast("Download started: " + fileName);
  goDownloads();
}

function retryDownload(fileId) {
  var item = findDownloadEntry(fileId);
  if (!item) return;
  startFileDownload(item.id, item.name);
}

// Header button (next to search) - downloads everything inside the folder
// that is currently open.
function downloadCurrentFolder() {
  var top = folderStack[folderStack.length - 1];
  if (!top || folderStack.length <= 1) return;
  startFolderDownload(top.id, top.name);
}

function startFolderDownload(folderId, folderName) {
  smartFolderDownload(folderId, folderName);
}

function plainFolderDownload(folderId, folderName) {
  try {
    Android.downloadFolder(folderId, folderName);
  } catch (e) {
    showToast("Content download is not supported on this device");
    return;
  }
  prefetchDownloadPoster(folderName, { type: "folder", name: folderName });
  showToast("Scanning folder: " + folderName);
  goDownloads();
}

// Once the native folder listing is complete, a downloading entry is
// added for each file (Java itself starts downloading all of them too).
// These files are shown in the Downloads tab "folder-wise" (grouped
// inside one folder) by folderName - exactly like the folder structure
// in Drive.
function onFolderDownloadQueued(filesJson, folderName) {
  var files = [];
  try { files = JSON.parse(filesJson); } catch (e) { files = []; }
  var patches = files.map(function (f) {
    return {
      id: f.id, name: f.name, isFolder: false, folderName: folderName,
      subPath: f.subPath || [],
      status: "downloading", received: 0, total: 0, speed: 0, ts: Date.now()
    };
  });
  upsertDownloadEntriesBatch(patches);
  if (viewMode === "downloads") renderDownloadsList();
}

function onDownloadProgress(fileId, receivedBytes, totalBytes, speedBytesPerSec) {
  upsertDownloadEntry({ id: fileId, status: "downloading", received: receivedBytes, total: totalBytes, speed: speedBytesPerSec });
  if (viewMode === "downloads") renderDownloadsList();
}

function onDownloadComplete(fileId) {
  upsertDownloadEntry({ id: fileId, status: "completed", speed: 0 });
  if (viewMode === "downloads") renderDownloadsList();
  var item = findDownloadEntry(fileId);
  showToast("Download complete: " + (item ? item.name : ""));
}

function onDownloadError(fileId, message) {
  upsertDownloadEntry({ id: fileId, status: "error", errorMsg: message || "Download failed", speed: 0 });
  if (viewMode === "downloads") renderDownloadsList();
}

function onDownloadCancelled(fileId) {
  removeDownloadEntryQuiet(fileId);
}

// Pause keeps the partial file - so unlike cancel, the row just switches
// to a "paused" state (with a Resume button) instead of disappearing.
function onDownloadPaused(fileId) {
  upsertDownloadEntry({ id: fileId, status: "paused", speed: 0 });
  if (viewMode === "downloads") renderDownloadsList();
}

function pauseSingleDownload(fileId) {
  upsertDownloadEntry({ id: fileId, status: "paused", speed: 0 }); // optimistic, native callback confirms it
  try { Android.pauseDownload(fileId); } catch (e) { /* older APK - ignore */ }
  if (viewMode === "downloads") renderDownloadsList();
}

function resumeSingleDownload(fileId) {
  var item = findDownloadEntry(fileId);
  if (!item) return;
  upsertDownloadEntry({ id: fileId, status: "downloading" });
  try {
    Android.downloadFile(item.id, item.name); // native side resumes from the .part file automatically
  } catch (e) {
    upsertDownloadEntry({ id: fileId, status: "error", errorMsg: "Could not resume" });
  }
  if (viewMode === "downloads") renderDownloadsList();
}

// "Pause" on the whole folder: every file in it that's currently
// downloading (or still waiting its turn in the native queue) is paused
// one by one - each keeps its own partial progress.
function pauseFolderDownloads(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  items.forEach(function (item) {
    if (item.status === "downloading") pauseSingleDownload(item.id);
  });
  showToast('Paused "' + folderName + '"');
}

// "Continue"/Resume on the whole folder: every paused or failed file
// picks back up from where it stopped.
function continueFolderDownloads(folderName) {
  var items = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  items.forEach(function (item) {
    if (item.status === "paused" || item.status === "error") resumeSingleDownload(item.id);
  });
  showToast('Continuing "' + folderName + '"');
}

function goDownloads() {
  closeSearch();
  pauseHeroCarousel();
  viewMode = "downloads";
  currentDownloadFolderName = null;
  currentDownloadSubPath = [];

  // Downloads are saved locally on the device, so they don't need a Google
  // login to view - if the login screen is showing (no account linked, or
  // net was down when the app opened), still let the user through to it.
  if (loginScreen && !loginScreen.classList.contains("hidden")) {
    loginScreen.classList.add("hidden");
    appRoot.classList.remove("hidden");
  }

  appRoot.classList.remove("browse-mode", "drive-browse");
  setActiveNav(navDownloads);
  homeViewEl.classList.add("hidden");
  contentEl.classList.add("hidden");
  profileViewEl.classList.add("hidden");
  browseReturnToProfile = false;
  downloadsViewEl.classList.remove("hidden");
  renderDownloadsList();
}

function renderDownloadsList() {
  var list = loadDownloads();

  if (list.length === 0) {
    downloadsListEl.innerHTML = "";
    showStateScreen(downloadsListEl, "\u2B07\uFE0F", "No downloads",
      "Tap on any movie or folder and press \"Download\".");
    return;
  }

  // Files downloaded from a folder are grouped by that folder's name
  // (so it shows the same structure it had in Drive); files that were
  // downloaded directly (without a folder) are counted as standalone.
  var groups = {};
  var groupOrder = [];
  var standalone = [];

  list.forEach(function (item) {
    if (item.folderName) {
      if (!groups[item.folderName]) {
        groups[item.folderName] = [];
        groupOrder.push(item.folderName);
      }
      groups[item.folderName].push(item);
    } else {
      standalone.push(item);
    }
  });

  // Until all of a folder's files have downloaded, it shows below as
  // list-style progress rows. Once the whole folder is complete, it
  // becomes a normal folder card (just like on the home page - a 📁 icon
  // + name); tapping it opens the files inside in a poster-grid.
  var completeCardsHtml = "";
  var inProgressHtml = "";

  groupOrder.forEach(function (folderName) {
    var items = groups[folderName];
    var completedCount = items.filter(function (i) { return i.status === "completed"; }).length;
    var allDone = completedCount === items.length && items.length > 0;
    if (allDone) {
      completeCardsHtml += buildDownloadFolderCardHtml(folderName, items);
    } else {
      inProgressHtml += renderDownloadFolderGroupHtml(folderName, items, completedCount);
    }
  });

  standalone.forEach(function (item) {
    if (item.status === "completed") {
      completeCardsHtml += buildDownloadCardHtml(item);
    } else {
      inProgressHtml += renderDownloadRowHtml(item);
    }
  });

  var html = "";
  if (completeCardsHtml) {
    html += '<div class="movie-grid downloads-grid">' + completeCardsHtml + '</div>';
  }
  html += inProgressHtml;

  downloadsListEl.innerHTML = html;
  attachDownloadRowHandlers();
  attachDownloadCardHandlers(downloadsListEl);
  attachDownloadFolderCardHandlers(downloadsListEl);
  attachFolderGroupDeleteHandlers(downloadsListEl);
  lazyLoadPostersIn(downloadsListEl);
  attachPosterErrorFallback(downloadsListEl);
}

function attachFolderGroupDeleteHandlers(container) {
  container.querySelectorAll(".download-folder-header [data-remove-folder]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openConfirmDeleteFolder(btn.getAttribute("data-remove-folder"));
    });
  });
  container.querySelectorAll(".download-folder-header [data-pause-folder]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      pauseFolderDownloads(btn.getAttribute("data-pause-folder"));
    });
  });
  container.querySelectorAll(".download-folder-header [data-continue-folder]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      continueFolderDownloads(btn.getAttribute("data-continue-folder"));
    });
  });
}

// List-style progress rows only for folders that are currently
// downloading (or failed) - completed folders don't show up here, they
// become a folder-card in the grid above.
function renderDownloadFolderGroupHtml(folderName, items, completedCount) {
  var hasActive = items.some(function (i) { return i.status === "downloading"; });
  var hasResumable = items.some(function (i) { return i.status === "paused" || i.status === "error"; });
  var html = '<div class="download-folder-group">'
    + '<div class="download-folder-header">'
    + '<div class="d-icon">\uD83D\uDCC1</div>'
    + '<div class="d-info">'
    + '<div class="d-name">' + escapeHtml(folderName) + '</div>'
    + '<div class="d-sub">' + completedCount + ' / ' + items.length + ' files complete</div>'
    + '</div>'
    + '<div class="d-header-actions">';
  if (hasActive) {
    html += '<button class="d-btn pause" data-pause-folder="' + escapeHtml(folderName) + '" title="Pause all">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      + '</button>';
  }
  if (hasResumable) {
    html += '<button class="d-btn resume" data-continue-folder="' + escapeHtml(folderName) + '" title="Continue download">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      + '</button>';
  }
  html += '<button class="d-btn remove" data-remove-folder="' + escapeHtml(folderName) + '" title="Delete entire folder">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    + '</button>'
    + '</div>'
    + '</div>'
    + '<div class="download-folder-items">';
  items.forEach(function (item) { html += renderDownloadRowHtml(item); });
  html += '</div></div>';
  return html;
}

// A fully downloaded folder becomes a normal folder-card - just like on
// the home page (poster/📁 icon + name). The poster also comes from the
// same TMDB lookup used for folders during normal browsing.
function buildDownloadFolderCardHtml(folderName, items) {
  posterUidSeq++;
  var uid = "dlfolder_u" + posterUidSeq;
  var savedPosterSrc = resolveStoredPosterSrc(loadDownloadFolderPosters()[folderName]);

  var html = '<div class="grid-card folder-card download-complete-folder-card" '
    + 'data-folder-name="' + escapeHtml(folderName) + '" tabindex="0">';
  if (savedPosterSrc) {
    html += '<img class="thumb" src="' + savedPosterSrc + '" data-fallback-icon="\uD83D\uDCC1">';
  } else {
    html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(folderName) + '" data-persist-type="folder" data-persist-name="' + escapeHtml(folderName) + '"><div class="gi">\uD83D\uDCC1</div></div>';
  }
  html += '<button class="grid-remove-btn" data-remove-folder="' + escapeHtml(folderName) + '" title="Delete entire folder">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
  html += '<div class="grid-name">' + escapeHtml(folderName) + '</div>';
  html += '</div>';
  return html;
}

function attachDownloadFolderCardHandlers(container) {
  container.querySelectorAll(".download-complete-folder-card").forEach(function (card) {
    var folderName = card.getAttribute("data-folder-name");
    card.addEventListener("click", function (e) {
      if (e.target.closest(".grid-remove-btn")) return;
      enterDownloadFolder(folderName);
    });

    var removeBtn = card.querySelector(".grid-remove-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openConfirmDeleteFolder(folderName);
      });
    }
  });
}

// Entering a downloaded folder from the Downloads tab - if that folder
// had subfolders inside it, the same nested structure (folder -> subfolder
// -> file) is available here too, just like Drive browsing.
var currentDownloadSubPath = []; // which subfolder we're currently inside (chain of names)

function enterDownloadFolder(folderName) {
  closeSearch();
  currentDownloadFolderName = folderName;
  currentDownloadSubPath = [];
  viewMode = "downloadFolder";
  appRoot.classList.remove("drive-browse");
  appRoot.classList.add("browse-mode");
  homeViewEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  contentEl.classList.remove("hidden");
  renderDownloadFolderGrid(folderName, currentDownloadSubPath);
}

function enterDownloadSubfolder(name) {
  currentDownloadSubPath.push(name);
  renderDownloadFolderGrid(currentDownloadFolderName, currentDownloadSubPath);
}

// Go up one level - if inside a subfolder, go up a level, otherwise
// go straight to the Downloads tab. Both handleBackPress() and the
// header's back-chevron (goBackFolder) use this.
function exitDownloadFolderLevel() {
  if (currentDownloadSubPath.length > 0) {
    currentDownloadSubPath.pop();
    renderDownloadFolderGrid(currentDownloadFolderName, currentDownloadSubPath);
  } else {
    goDownloads();
  }
}

// What's at the exact level of the given subPath (folder-chain) -
// the direct files at that level, and the next subfolders inside that
// level (along with all their descendant items, so progress/completion
// can be figured out).
function getDownloadFolderLevel(folderName, subPath) {
  var allItems = loadDownloads().filter(function (i) { return i.folderName === folderName; });
  var files = [];
  var subfolderMap = {};
  var subfolderOrder = [];

  allItems.forEach(function (item) {
    var itemPath = item.subPath || [];
    for (var i = 0; i < subPath.length; i++) {
      if (itemPath[i] !== subPath[i]) return; // doesn't fall under this subPath
    }
    if (itemPath.length === subPath.length) {
      files.push(item);
    } else {
      var nextName = itemPath[subPath.length];
      if (!subfolderMap[nextName]) {
        subfolderMap[nextName] = [];
        subfolderOrder.push(nextName);
      }
      subfolderMap[nextName].push(item);
    }
  });

  return {
    files: files,
    subfolders: subfolderOrder.map(function (name) { return { name: name, items: subfolderMap[name] }; })
  };
}

function renderDownloadFolderGrid(folderName, subPath) {
  var level = getDownloadFolderLevel(folderName, subPath);
  var titleText = subPath.length > 0 ? subPath[subPath.length - 1] : folderName;

  contentEl.innerHTML = '<div class="row-header" style="padding:16px 16px 6px;"><div class="row-title">'
    + escapeHtml(titleText) + '</div>'
    + '<button class="row-seeall" id="btnDeleteWholeFolder">Delete All</button>'
    + '</div><div class="movie-grid" id="downloadFolderGrid"></div>';
  var gridEl = document.getElementById("downloadFolderGrid");

  var deleteAllBtn = document.getElementById("btnDeleteWholeFolder");
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", function () {
      openConfirmDeleteFolder(folderName);
    });
  }

  if (level.subfolders.length === 0 && level.files.length === 0) {
    showStateScreen(contentEl, "\uD83D\uDCED", "Empty",
      "All files in this folder have been deleted.");
    return;
  }

  var html = "";
  level.subfolders.forEach(function (sf) { html += buildDownloadSubfolderCardHtml(sf.name, sf.items); });
  level.files.forEach(function (item) { html += buildDownloadCardHtml(item); });
  gridEl.innerHTML = html;
  attachDownloadSubfolderCardHandlers(contentEl);
  attachDownloadCardHandlers(contentEl);
  lazyLoadPostersIn(contentEl);
  attachPosterErrorFallback(contentEl);
}

// Card for a subfolder inside a downloaded folder - poster/📁 icon +
// name, and if not everything inside that subfolder has downloaded yet,
// an "x/y" badge too (how many files are complete).
function buildDownloadSubfolderCardHtml(name, items) {
  posterUidSeq++;
  var uid = "dlsubfolder_u" + posterUidSeq;
  var completedCount = items.filter(function (i) { return i.status === "completed"; }).length;

  var html = '<div class="grid-card folder-card download-subfolder-card" '
    + 'data-subfolder-name="' + escapeHtml(name) + '" tabindex="0">';
  html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(name) + '"><div class="gi">\uD83D\uDCC1</div></div>';
  if (completedCount < items.length) {
    html += '<span class="badge">' + completedCount + '/' + items.length + '</span>';
  }
  html += '<div class="grid-name">' + escapeHtml(name) + '</div>';
  html += '</div>';
  return html;
}

function attachDownloadSubfolderCardHandlers(container) {
  container.querySelectorAll(".download-subfolder-card").forEach(function (card) {
    var name = card.getAttribute("data-subfolder-name");
    card.addEventListener("click", function () {
      enterDownloadSubfolder(name);
    });
  });
}

// If the user is currently inside a downloaded folder/subfolder, refresh
// that same level with fresh data after a delete. If that level is now
// empty, go up one level at a time until something is found or the root
// is reached; if the entire top-folder is now empty, send them back to
// the Downloads tab.
function refreshDownloadFolderViewIfOpen() {
  if (viewMode !== "downloadFolder" || !currentDownloadFolderName) return;
  var anyLeftInFolder = loadDownloads().some(function (i) { return i.folderName === currentDownloadFolderName; });
  if (!anyLeftInFolder) {
    goDownloads();
    return;
  }
  while (currentDownloadSubPath.length > 0) {
    var level = getDownloadFolderLevel(currentDownloadFolderName, currentDownloadSubPath);
    if (level.subfolders.length > 0 || level.files.length > 0) break;
    currentDownloadSubPath.pop();
  }
  renderDownloadFolderGrid(currentDownloadFolderName, currentDownloadSubPath);
}

// For a completed download, a card just like a normal grid-card
// (poster + name), except tapping it plays the local file directly, and
// there's a small remove button for deleting it.
function buildDownloadCardHtml(item) {
  posterUidSeq++;
  var uid = "dlposter_u" + posterUidSeq;

  var html = '<div class="grid-card download-complete-card" '
    + 'data-id="' + item.id + '" data-name="' + escapeHtml(item.name) + '" tabindex="0">';
  var savedPosterSrc = item.posterKey ? downloadPosterUrl(item.posterKey) : resolveStoredPosterSrc(item.poster);
  if (savedPosterSrc) {
    html += '<img class="thumb" src="' + savedPosterSrc + '" data-fallback-icon="' + getFileIcon(item.name) + '">';
  } else {
    html += '<div class="no-poster" id="' + uid + '" data-poster-query="' + escapeHtml(item.name) + '" data-persist-type="file" data-persist-id="' + escapeHtml(item.id) + '"><div class="gi">' + getFileIcon(item.name) + '</div></div>';
  }
  html += '<span class="badge saved">\u2713 Saved</span>';
  html += '<button class="grid-remove-btn" data-remove-id="' + item.id + '" title="Remove">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
  html += '<div class="grid-name">' + escapeHtml(item.name) + '</div>';
  html += '</div>';
  return html;
}

function attachDownloadCardHandlers(container) {
  container.querySelectorAll(".download-complete-card").forEach(function (card) {
    var id = card.getAttribute("data-id");
    var name = card.getAttribute("data-name");

    card.addEventListener("click", function (e) {
      if (e.target.closest(".grid-remove-btn")) return;
      try {
        Android.playLocalFile(id, name);
      } catch (err) {
        Android.openFile(id, name);
      }
    });

    var removeBtn = card.querySelector(".grid-remove-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openConfirmDelete(id, name);
      });
    }
  });
}

function renderDownloadRowHtml(item) {
  var pct = (item.total > 0) ? Math.min(100, Math.round((item.received / item.total) * 100)) : 0;
  var sizeLine = (item.total > 0)
    ? formatBytes(item.received) + " / " + formatBytes(item.total)
    : formatBytes(item.received);
  var subLine;
  if (item.status === "downloading") {
    subLine = pct + "%" + (sizeLine ? " \u00B7 " + sizeLine : "")
      + (item.speed > 0 ? " \u00B7 " + formatBytes(item.speed) + "/s" : " \u00B7 Starting...");
  } else if (item.status === "paused") {
    subLine = "\u23F8\uFE0F Paused" + (sizeLine ? " \u00B7 " + pct + "% \u00B7 " + sizeLine : "");
  } else if (item.status === "completed") {
    subLine = "Download complete" + (item.total > 0 ? " \u00B7 " + formatBytes(item.total) : "");
  } else {
    subLine = "\u26A0\uFE0F " + escapeHtml(item.errorMsg || "Download failed");
  }

  var html = '<div class="download-row" data-id="' + item.id + '">'
    + '<div class="d-icon">' + getFileIcon(item.name) + '</div>'
    + '<div class="d-info">'
    + '<div class="d-name">' + escapeHtml(item.name) + '</div>'
    + '<div class="d-sub">' + subLine + '</div>';
  if (item.status === "downloading" || item.status === "paused") {
    html += '<div class="d-progress-track"><div class="d-progress-fill" style="width:' + pct + '%"></div></div>';
  }
  html += '</div>'
    + '<div class="d-actions">';

  if (item.status === "completed") {
    html += '<button class="d-btn" data-act="play" title="Play">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      + '</button>';
  } else if (item.status === "error" || item.status === "paused") {
    html += '<button class="d-btn resume" data-act="resume" title="' + (item.status === "paused" ? "Resume" : "Retry") + '">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
      + '</button>';
  } else if (item.status === "downloading") {
    html += '<button class="d-btn pause" data-act="pause" title="Pause">'
      + '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>'
      + '</button>';
  }

  html += '<button class="d-btn remove" data-act="remove" title="' + (item.status === "downloading" ? "Cancel" : "Remove") + '">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>'
    + '</button>'
    + '</div>'
    + '</div>';
  return html;
}

function attachDownloadRowHandlers() {
  downloadsListEl.querySelectorAll(".download-row").forEach(function (row) {
    var id = row.getAttribute("data-id");
    var item = findDownloadEntry(id);
    if (!item) return;

    var playBtn = row.querySelector('[data-act="play"]');
    if (playBtn) {
      playBtn.addEventListener("click", function () {
        try {
          Android.playLocalFile(item.id, item.name);
        } catch (e) {
          Android.openFile(item.id, item.name);
        }
      });
    }

    var resumeBtn = row.querySelector('[data-act="resume"]');
    if (resumeBtn) {
      resumeBtn.addEventListener("click", function () {
        resumeSingleDownload(item.id);
      });
    }

    var pauseBtn = row.querySelector('[data-act="pause"]');
    if (pauseBtn) {
      pauseBtn.addEventListener("click", function () {
        pauseSingleDownload(item.id);
      });
    }

    row.querySelector('[data-act="remove"]').addEventListener("click", function () {
      openConfirmDelete(item.id, item.name);
    });
  });
}

// ---------- Helpers ----------
function getFileIcon(name) {
  var lower = name.toLowerCase();
  if (lower.endsWith(".mkv") || lower.endsWith(".mp4") || lower.endsWith(".avi") || lower.endsWith(".mov")) return "\uD83C\uDFAC";
  if (lower.endsWith(".mp3") || lower.endsWith(".m4a")) return "\uD83C\uDFB5";
  if (lower.endsWith(".jpg") || lower.endsWith(".png") || lower.endsWith(".jpeg")) return "\uD83D\uDDBC\uFE0F";
  if (lower.endsWith(".pdf")) return "\uD83D\uDCC4";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "\uD83C\uDF10";
  return "\uD83D\uDCE6";
}

function escapeHtml(str) {
  var div = document.createElement("div");
  div.innerText = str == null ? "" : str;
  return div.innerHTML;
}

// ==========================================================================
// PROFILE: HISTORY + RESUME POPUP + WEB-SERIES AUTO-NEXT
//
//  * Every played movie / web-series is saved natively (HistoryStore.java) and
//    listed in Profile > History, with the Request form below it.
//  * MOVIE  -> if it was stopped midway: popup "Resume" / "Play from start".
//  * SERIES -> tapping it in History continues automatically from where you
//              stopped (or the next episode if that one was finished).
//              Picking an episode by hand while another one is "in progress"
//              shows a popup: "Resume <last episode>" or "Play <chosen one>".
//  * SERIES -> when an episode ends, PlayerActivity starts the next one by itself
//              (movies never auto-continue).
// A "web series" = anything under the Drive folder named "Web Series".
// ==========================================================================

var profileViewEl = document.getElementById("profileView");
var historyListEl = document.getElementById("historyList");
var navProfile = document.getElementById("navProfile");
var resumeOverlay = document.getElementById("resumeOverlay");
var openingOverlay = document.getElementById("openingOverlay");
var rpRingFg = document.getElementById("rpRingFg");
var rpRingEl = document.getElementById("rpRing");

var folderInfoCache = {};   // startId -> { isSeries, parentId, seriesTitle } | null
var episodesCache = {};     // parentId -> { ts, eps }
var EPISODES_TTL_MS = 120000;
var openingTimer = null;
var resumeCloseTimer = null;

function goProfile() {
  closeSearch();
  pauseHeroCarousel();
  viewMode = "profile";
  if (loginScreen && !loginScreen.classList.contains("hidden")) {
    loginScreen.classList.add("hidden");
    appRoot.classList.remove("hidden");
  }
  appRoot.classList.remove("browse-mode", "drive-browse");
  setActiveNav(navProfile);
  homeViewEl.classList.add("hidden");
  contentEl.classList.add("hidden");
  downloadsViewEl.classList.add("hidden");
  profileViewEl.classList.remove("hidden");
  renderHistory();
  try { window.scrollTo(0, 0); } catch (e) { }
}

// Called from MainActivity.onResume (e.g. coming back from the player)
function onAppResumed() {
  if (viewMode === "profile") renderHistory();
}

// ---------- small helpers ----------
function fmtTime(ms) {
  var t = Math.max(0, Math.floor((ms || 0) / 1000));
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  function p(n) { return n < 10 ? "0" + n : "" + n; }
  return h > 0 ? h + ":" + p(m) + ":" + p(sec) : m + ":" + p(sec);
}

function cleanTitle(name) {
  return (name || "").replace(/\.[a-z0-9]{2,4}$/i, "");
}

function getPlayStateSafe(id) {
  try { return JSON.parse(Android.getPlayState(id)); } catch (e) { return { pos: 0, dur: 0, done: false }; }
}

function getHistorySafe() {
  try { return JSON.parse(Android.getHistory() || "[]"); } catch (e) { return []; }
}

function findHistoryEntry(key) {
  var list = getHistorySafe();
  for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
  return null;
}

function showOpening(on) {
  clearTimeout(openingTimer);
  if (!on) { openingOverlay.classList.remove("active"); return; }
  // only show the spinner if it takes a moment (no flicker on quick loads)
  openingTimer = setTimeout(function () { openingOverlay.classList.add("active"); }, 250);
  // safety net: never leave the spinner stuck
  setTimeout(function () { openingOverlay.classList.remove("active"); }, 15000);
}

// ---------- Drive lookups (series detection + episode list) ----------
function resolveFolderInfo(fileId, parentHint, cb) {
  var startId = parentHint || fileId;
  if (folderInfoCache.hasOwnProperty(startId)) { cb(folderInfoCache[startId]); return; }

  var done = false;
  var failTimer = setTimeout(function () { if (!done) { done = true; cb(null); } }, 8000);
  var cbName = registerTempCallback(function (res) {
    if (done) return;
    done = true;
    clearTimeout(failTimer);
    if (!res || res.error || !res.chain || res.chain.length === 0) { cb(null); return; }
    var chain = res.chain;
    var parent = chain[0];
    // A category folder ("Web Series", "Anime", "Cartoon", "Animation" ...) somewhere above the
    // file's folder -> the file's folder is one show, so its files are episodes.
    // (a file lying directly inside the category folder itself is not an episode list)
    var isSeries = false;
    for (var i = 0; i < chain.length; i++) {
      if (/series|anime|cartoon|animation/.test(normalizeFolderName(chain[i].name))) { isSeries = (i > 0); break; }
    }
    if (/season/.test(normalizeFolderName(parent.name))) isSeries = true;
    var title = parent.name;
    if (/season|^s\d+$/i.test((parent.name || "").trim()) && chain[1]) title = chain[1].name + " - " + parent.name;
    var info = { isSeries: isSeries, parentId: parent.id, seriesTitle: title };
    folderInfoCache[startId] = info;
    cb(info);
  });
  try { Android.getFolderChain(startId, cbName); } catch (e) { done = true; clearTimeout(failTimer); cb(null); }
}

function fetchEpisodes(parentId, cb) {
  var c = episodesCache[parentId];
  if (c && Date.now() - c.ts < EPISODES_TTL_MS) { cb(c.eps); return; }
  var done = false;
  var failTimer = setTimeout(function () { if (!done) { done = true; cb(null); } }, 10000);
  var cbName = registerTempCallback(function (data) {
    if (done) return;
    done = true;
    clearTimeout(failTimer);
    if (!data || data.error || !data.files) { cb(null); return; }
    var eps = [];
    data.files.forEach(function (f) {
      if (f.mimeType !== "application/vnd.google-apps.folder" && isVideoFile(f.name)) eps.push({ id: f.id, name: f.name });
    });
    // no plain video files, only folders -> every folder is one multi-quality episode (1080p/720p/480p inside)
    if (eps.length === 0) {
      data.files.forEach(function (f) {
        if (f.mimeType === "application/vnd.google-apps.folder") eps.push({ id: f.id, name: f.name, multi: true });
      });
    }
    episodesCache[parentId] = { ts: Date.now(), eps: eps };
    cb(eps);
  });
  try { Android.listFiles(parentId, cbName); } catch (e) { done = true; clearTimeout(failTimer); cb(null); }
}

var episodeFoldersCache = {};
function fetchEpisodeFolders(parentId, cb) {
  var c = episodeFoldersCache[parentId];
  if (c && Date.now() - c.ts < EPISODES_TTL_MS) { cb(c.eps); return; }
  var done = false;
  var failTimer = setTimeout(function () { if (!done) { done = true; cb(null); } }, 10000);
  var cbName = registerTempCallback(function (data) {
    if (done) return;
    done = true;
    clearTimeout(failTimer);
    if (!data || data.error || !data.files) { cb(null); return; }
    var eps = [];
    data.files.forEach(function (f) {
      if (f.mimeType === "application/vnd.google-apps.folder") eps.push({ id: f.id, name: f.name, multi: true });
    });
    episodeFoldersCache[parentId] = { ts: Date.now(), eps: eps };
    cb(eps);
  });
  try { Android.listFiles(parentId, cbName); } catch (e) { done = true; clearTimeout(failTimer); cb(null); }
}

function indexOfEp(eps, id) {
  for (var i = 0; i < eps.length; i++) if (eps[i].id === id) return i;
  return -1;
}

// ---------- launching the native player ----------
function launchMovie(id, name) {
  var meta = { htype: "movie", hkey: id, htitle: cleanTitle(name), hparent: "" };
  try { Android.openFileEx(id, name, JSON.stringify(meta)); }
  catch (e) { Android.openFile(id, name); }  // older APK
}

function launchSeriesEpisode(eps, idx, seriesTitle, parentId, prefH) {
  var ep = eps[idx];
  if (ep && ep.multi) {
    // multi-quality episode: same quality as chosen before (or the closest one)
    var h = prefH || getQualityPref(parentId);
    showOpening(true);
    resolveMultiJs(ep.id, h, function (res) {
      showOpening(false);
      if (!res) { showToast("Couldn't load this episode - check your internet connection"); return; }
      var list2 = [];
      for (var j = 0; j < eps.length; j++) list2.push({ id: eps[j].id, name: eps[j].name, multi: !!eps[j].multi });
      var meta2 = { htype: "series", hkey: parentId, htitle: seriesTitle, hparent: parentId, playlist: list2, pindex: idx,
                    mq: { sid: ep.id, h: res.height, variants: res.variants, fname: res.fileName } };
      try { if (res.height) Android.setQualityPref(parentId, res.height); } catch (e) { }
      Android.openFileEx(res.fileId, ep.name, JSON.stringify(meta2));
    });
    return;
  }
  var list = [];
  for (var i = 0; i < eps.length; i++) list.push({ id: eps[i].id, name: eps[i].name, multi: !!eps[i].multi });
  var meta = { htype: "series", hkey: parentId, htitle: seriesTitle, hparent: parentId, playlist: list, pindex: idx };
  try { Android.openFileEx(eps[idx].id, eps[idx].name, JSON.stringify(meta)); }
  catch (e) { Android.openFile(eps[idx].id, eps[idx].name); }
}

// ---------- entry point for every "Play" ----------
function looksLikeEpisode(name) {
  return /s\d{1,2}\s*[._ -]?\s*e\d{1,3}|\bep(isode)?[\s._-]*\d{1,3}\b|\be\d{2,3}\b/i.test(name || "");
}

function playVideo(id, name, parentHint) {
  showOpening(true);
  resolveFolderInfo(id, parentHint, function (info) {
    // folder couldn't be read / isn't a known series folder: a name like "S01E04" or "Episode 4" still counts
    if (info && !info.isSeries && looksLikeEpisode(name)) info = { isSeries: true, parentId: info.parentId, seriesTitle: info.seriesTitle };
    if (!info || !info.isSeries) { showOpening(false); playMovieWithChoice(id, name); return; }

    fetchEpisodes(info.parentId, function (eps) {
      showOpening(false);
      if (!eps) { launchMovie(id, name); return; }   // couldn't read the folder - just play the file
      var idx = indexOfEp(eps, id);
      if (idx < 0) { eps = [{ id: id, name: name }]; idx = 0; }
      handleSeriesPlay(info, eps, idx);
    });
  });
}

function playMovieWithChoice(id, name) {
  var st = getPlayStateSafe(id);
  if (st.pos > 5000 && !st.done) {
    showResumePopup({
      badge: "MOVIE",
      title: cleanTitle(name),
      sub: "You stopped at " + fmtTime(st.pos) + (st.dur > 0 ? " of " + fmtTime(st.dur) : ""),
      pct: st.dur > 0 ? st.pos / st.dur : 0.0,
      options: [
        { primary: true, icon: "play", label: "Resume", sub: "Continue from " + fmtTime(st.pos), onClick: function () { launchMovie(id, name); } },
        { icon: "restart", label: "Play from start", sub: "Start the movie again", onClick: function () { try { Android.clearPlayState(id); } catch (e) { } launchMovie(id, name); } }
      ]
    });
  } else {
    launchMovie(id, name);
  }
}

function handleSeriesPlay(info, eps, idx) {
  var chosen = eps[idx];
  var hist = findHistoryEntry(info.parentId);

  // A different episode is "in progress" (or was just finished) -> let the user decide
  if (hist && hist.lastId !== chosen.id) {
    var li = indexOfEp(eps, hist.lastId);
    var ci = -1, subTxt = "";
    if (li >= 0) {
      if (hist.done) {
        if (li + 1 < eps.length) { ci = li + 1; subTxt = "Next episode · starts from the beginning"; }
      } else if (hist.pos > 5000) {
        ci = li; subTxt = "Continue from " + fmtTime(hist.pos);
      }
    }
    if (ci >= 0 && ci !== idx) {
      var cont = eps[ci];
      showResumePopup({
        badge: "WEB SERIES",
        title: info.seriesTitle,
        sub: "Last time you were watching: " + cleanTitle(hist.lastName),
        pct: (!hist.done && hist.dur > 0) ? hist.pos / hist.dur : null,
        options: [
          { primary: true, icon: "play", label: "Resume", sub: cleanTitle(cont.name) + " · " + subTxt, onClick: function () { launchSeriesEpisode(eps, ci, info.seriesTitle, info.parentId); } },
          { icon: "list", label: "Play selected", sub: cleanTitle(chosen.name), onClick: function () { launchSeriesEpisode(eps, idx, info.seriesTitle, info.parentId); } }
        ]
      });
      return;
    }
  }

  // same episode as last time (or first time) - ask only if it was stopped midway
  var st = getPlayStateSafe(chosen.id);
  if (st.pos > 5000 && !st.done) {
    showResumePopup({
      badge: "WEB SERIES",
      title: cleanTitle(chosen.name),
      sub: info.seriesTitle + " · stopped at " + fmtTime(st.pos),
      pct: st.dur > 0 ? st.pos / st.dur : 0.0,
      options: [
        { primary: true, icon: "play", label: "Resume", sub: "Continue from " + fmtTime(st.pos), onClick: function () { launchSeriesEpisode(eps, idx, info.seriesTitle, info.parentId); } },
        { icon: "restart", label: "Play from start", sub: "Start this episode again", onClick: function () { try { Android.clearPlayState(chosen.id); } catch (e) { } launchSeriesEpisode(eps, idx, info.seriesTitle, info.parentId); } }
      ]
    });
    return;
  }
  launchSeriesEpisode(eps, idx, info.seriesTitle, info.parentId);
}

// ---------- animated popup ----------
var RP_ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>'
};

function showResumePopup(cfg) {
  clearTimeout(resumeCloseTimer);
  document.getElementById("rpBadge").textContent = cfg.badge || "";
  document.getElementById("rpTitle").textContent = cfg.title || "";
  document.getElementById("rpSub").textContent = cfg.sub || "";

  var actions = document.getElementById("rpActions");
  actions.innerHTML = "";
  cfg.options.forEach(function (o) {
    var b = document.createElement("div");
    b.className = "rp-btn" + (o.primary ? " primary" : "");
    b.setAttribute("tabindex", "0");
    b.innerHTML = '<div class="ic">' + (RP_ICONS[o.icon] || "") + '</div>'
      + '<div class="tx"><div class="lb"></div><div class="sb"></div></div>';
    b.querySelector(".lb").textContent = o.label;
    b.querySelector(".sb").textContent = o.sub || "";
    b.addEventListener("click", function () {
      closeResumePopup();
      o.onClick();
    });
    actions.appendChild(b);
  });

  // progress ring (animates from empty up to the watched amount)
  if (cfg.pct === null || cfg.pct === undefined) {
    rpRingEl.classList.add("hidden");
  } else {
    rpRingEl.classList.remove("hidden");
    rpRingFg.style.transition = "none";
    rpRingFg.style.strokeDashoffset = "264";
    void rpRingFg.getBoundingClientRect();
    rpRingFg.style.transition = "";
    var pct = Math.max(0.03, Math.min(1, cfg.pct));
    setTimeout(function () { rpRingFg.style.strokeDashoffset = String(264 * (1 - pct)); }, 30);
  }

  // restart the pop animation every time
  var card = document.getElementById("resumeCard");
  card.style.animation = "none";
  void card.offsetWidth;
  card.style.animation = "";
  resumeOverlay.classList.remove("closing");
  resumeOverlay.classList.add("active");
}

function closeResumePopup() {
  if (!resumeOverlay.classList.contains("active")) return;
  resumeOverlay.classList.add("closing");
  clearTimeout(resumeCloseTimer);
  resumeCloseTimer = setTimeout(function () {
    resumeOverlay.classList.remove("active", "closing");
  }, 200);
}

// ---------- Profile > History list ----------
function renderHistory() {
  var list = getHistorySafe();
  document.getElementById("btnClearHistory").style.display = list.length ? "" : "none";

  if (!list.length) {
    historyListEl.innerHTML = '<div class="hist-empty"><div class="e">\uD83D\uDD58</div>'
      + 'Abhi tak kuch nahi dekha.<br>Jo movie / web series aap dekhoge, yaha dikhegi.</div>';
    return;
  }

  var html = "";
  list.forEach(function (e, i) {
    var isSeries = e.type === "series";
    var pct = e.done ? 100 : (e.dur > 0 ? Math.min(100, Math.round(e.pos * 100 / e.dur)) : 0);
    var meta;
    if (isSeries) {
      meta = cleanTitle(e.lastName) + (e.done ? " · Finished" : (e.pos > 5000 ? " · " + fmtTime(e.pos) : ""));
    } else {
      meta = e.done ? "Finished" : (e.pos > 5000 ? "Stopped at " + fmtTime(e.pos) : "Not finished");
    }
    posterUidSeq++;
    html += '<div class="hist-item" data-idx="' + i + '" tabindex="0" style="animation-delay:' + Math.min(i, 8) * 0.05 + 's">'
      + '<div class="hist-thumb"><div class="no-poster" id="poster_u' + posterUidSeq + '" data-poster-query="' + escapeHtml(e.title || cleanTitle(e.lastName)) + '"><div class="gi">\uD83C\uDFAC</div></div>'
      + '<div class="hist-play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div></div>'
      + '<div class="hist-info">'
      + '<span class="hist-tag' + (isSeries ? ' series' : '') + '">' + (isSeries ? "WEB SERIES" : "MOVIE") + '</span>'
      + '<div class="hist-title">' + escapeHtml(e.title || cleanTitle(e.lastName)) + '</div>'
      + '<div class="hist-meta">' + escapeHtml(meta) + '</div>'
      + '<div class="hist-bar"><div class="hist-bar-fill" data-w="' + pct + '"></div></div>'
      + '</div>'
      + '<button class="hist-del" data-del="' + i + '" aria-label="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>'
      + '</div>';
  });
  historyListEl.innerHTML = html;

  historyListEl.querySelectorAll(".hist-item").forEach(function (el) {
    var entry = list[parseInt(el.getAttribute("data-idx"), 10)];
    el.addEventListener("click", function (ev) {
      if (ev.target.closest(".hist-del")) return;
      onHistoryTap(entry);
    });
    el.querySelector(".hist-del").addEventListener("click", function () {
      el.style.transition = "opacity 0.2s, transform 0.2s";
      el.style.opacity = "0";
      el.style.transform = "translateX(30px)";
      setTimeout(function () {
        try { Android.removeHistory(entry.key); } catch (err) { }
        renderHistory();
      }, 200);
    });
  });
  lazyLoadPostersIn(historyListEl);
  // animate the progress bars after first paint
  setTimeout(function () {
    historyListEl.querySelectorAll(".hist-bar-fill").forEach(function (b) { b.style.width = b.getAttribute("data-w") + "%"; });
  }, 60);
}

function confirmClearHistory() {
  confirmTitle.textContent = "Clear history?";
  confirmMsg.textContent = "Your watch history and saved resume points will be removed.";
  confirmDeleteBtn.textContent = "Clear";
  confirmDeleteBtn.onclick = function () {
    try { Android.clearHistory(); } catch (e) { }
    closeConfirm();
    confirmDeleteBtn.textContent = "Delete";
    renderHistory();
  };
  confirmOverlay.classList.add("active");
}

function onHistoryTap(entry) {
  if (entry.type === "series") continueSeriesFromHistory(entry);
  else if (entry.multi) openMultiMoviePicker(entry.lastId, entry.lastName);
  else playMovieWithChoice(entry.lastId, entry.lastName);   // movie: popup (Resume / start over) if stopped midway
}

// Series from History: popup -> Resume (last episode / next one) or pick another episode in the folder
function continueSeriesFromHistory(entry) {
  showOpening(true);
  (entry.multi ? fetchEpisodeFolders : fetchEpisodes)(entry.parentId, function (eps) {
    showOpening(false);
    if (!eps || eps.length === 0) { showToast("Couldn't load episodes - check your internet connection"); return; }
    var idx = indexOfEp(eps, entry.lastId);
    var label, subTxt, startOver = false;
    if (idx < 0) {
      idx = 0; label = "Play from episode 1"; subTxt = cleanTitle(eps[0].name);
    } else if (entry.done) {
      if (idx + 1 < eps.length) { idx = idx + 1; label = "Play next episode"; subTxt = cleanTitle(eps[idx].name); }
      else { label = "Watch last episode again"; subTxt = cleanTitle(eps[idx].name); startOver = true; }
    } else {
      label = "Resume";
      subTxt = cleanTitle(eps[idx].name) + (entry.pos > 5000 ? " · from " + fmtTime(entry.pos) : "");
    }
    var target = idx;
    showResumePopup({
      badge: "WEB SERIES",
      title: entry.title,
      sub: "Last watched: " + cleanTitle(entry.lastName) + (entry.done ? " (finished)" : ""),
      pct: entry.done ? 1 : (entry.dur > 0 ? entry.pos / entry.dur : 0.0),
      options: [
        { primary: true, icon: "play", label: label, sub: subTxt, onClick: function () {
            if (startOver) { try { Android.clearPlayState(entry.lastId); } catch (e) { } }
            launchSeriesEpisode(eps, target, entry.title, entry.parentId);
          } },
        { icon: "list", label: "Choose episode", sub: "Open the " + eps.length + " episodes of this series", onClick: function () { openSeriesFolderFromProfile(entry); } }
      ]
    });
  });
}

function openSeriesFolderFromProfile(entry) {
  folderStack = [{ id: LOCKED_ROOT_FOLDER_ID, name: "My Drive" }];
  enterBrowseFolder(entry.parentId, entry.title);
  browseReturnToProfile = true;   // back button returns to Profile
}


// ==========================================================================
// MULTI-QUALITY (movie folder / episode folder with 1080p, 720p, 480p ... folders)
//
//   Movie folder   -> tap -> quality popup -> plays
//   Series > Season (opens normally) > Episode folder -> tap -> quality popup -> plays
//   Next / auto-next episode keeps the quality that was chosen (player does it natively),
//   and the player has a quality button to change it while watching.
//   Folders / series WITHOUT quality sub-folders work exactly as before.
// ==========================================================================

var QUALITY_RE = /(2160|1440|1080|720|576|540|480|360|240)\s*p|\b4k\b|\buhd\b/i;

function qualityHeightOf(name) {
  var m = QUALITY_RE.exec(name || "");
  if (!m) return 0;
  return m[1] ? parseInt(m[1], 10) : 2160;
}
function qualityLabelOf(h) { return h >= 2160 ? "4K" : h + "p"; }

// Quality variants of a folder, best first: [{id,name,h,label}]
//  (a) quality FOLDERS : Movie/1080p/..., Movie/720p/...   (every sub-folder is just a quality name)
//  (b) quality FILES   : Episode folder holding the SAME episode as several video files
//                        (1080p / 720p / 480p in the file names)
function qualityRemainder(name) {
  return (name || "").replace(QUALITY_RE, "").replace(/[^a-z]/gi, "");
}

function sameItemKey(name) {
  var s = (name || "").toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, " ");
  var qi = s.search(QUALITY_RE);
  var cut = qi >= 0 ? s.substring(0, qi) : s;
  var m = /(s\d{1,2} ?e\d{1,3}|\b(19|20)\d{2}\b)/.exec(cut);
  if (m) cut = cut.substring(0, m.index + m[0].length);
  return cut.replace(/\s+/g, " ").trim();
}

function isSeasonLikeName(n) {
  return /season|^s\d+$|^part \d+$|^vol/i.test(normalizeFolderName(n || ""));
}

function detectQualityFolders(files, ownName) {
  if (!files || !files.length) return null;
  var folders = [], vids = [];
  files.forEach(function (f) {
    if (f.mimeType === "application/vnd.google-apps.folder") folders.push(f);
    else if (isVideoFile(f.name)) vids.push(f);
  });
  var q = [], i, h;

  if (folders.length) {
    // (a) every sub-folder must be a plain quality folder ("1080p", "720p HD", "4K" ...)
    for (i = 0; i < folders.length; i++) {
      h = qualityHeightOf(folders[i].name);
      if (!h || qualityRemainder(folders[i].name).length > 6) return null;
      for (var j = 0; j < q.length; j++) if (q[j].h === h) return null;   // same quality twice = not a quality list
      q.push({ id: folders[i].id, name: folders[i].name, h: h, label: qualityLabelOf(h) });
    }
  } else if (vids.length >= 1 && vids.length <= 6 && !isSeasonLikeName(ownName)) {
    // (b) the same movie / episode as 1-6 video files (quality in the name, or told apart by size)
    var key0 = null;
    for (i = 0; i < vids.length; i++) {
      var k = sameItemKey(vids[i].name);
      if (key0 === null) key0 = k; else if (k !== key0) return null;   // different titles = not one item
    }
    var hs = vids.map(function (v) { return qualityHeightOf(v.name); });
    var real = hs.every(function (x) { return x > 0; });
    if (real) for (i = 0; i < hs.length && real; i++) for (var j2 = i + 1; j2 < hs.length; j2++) if (hs[i] === hs[j2]) real = false;
    if (real) {
      for (i = 0; i < vids.length; i++) q.push({ id: vids[i].id, name: vids[i].name, h: hs[i], label: qualityLabelOf(hs[i]), isFile: true, size: parseInt(vids[i].size, 10) || 0 });
    } else {
      // names don't tell the quality -> biggest file = best; labelled by size (same rule as the native resolver)
      var order = vids.map(function (v, idx) { return { v: v, idx: idx, size: parseInt(v.size, 10) || 0 }; });
      order.sort(function (a, b) { return b.size - a.size || (a.v.name < b.v.name ? -1 : 1); });
      for (i = 0; i < order.length; i++) {
        var o = order[i], hh = hs[o.idx];
        var sz = formatBytes(o.size);
        var lab = (hh > 0 ? qualityLabelOf(hh) + (sz ? " \u00B7 " : "") : "") + (sz || (hh > 0 ? "" : "Original"));
        q.push({ id: o.v.id, name: o.v.name, h: 5000 + (order.length - 1 - i), label: lab, isFile: true, pseudo: true, size: o.size });
      }
    }
  } else {
    return null;
  }
  if (!q.length) return null;
  q.sort(function (a, b) { return b.h - a.h; });
  return q;
}

function getQualityPref(key) {
  try { return Android.getQualityPref(key) || 0; } catch (e) { return 0; }
}

function resolveMultiJs(folderId, preferH, cb) {
  var done = false;
  var failTimer = setTimeout(function () { if (!done) { done = true; cb(null); } }, 20000);
  var cbName = registerTempCallback(function (res) {
    if (done) return;
    done = true;
    clearTimeout(failTimer);
    if (!res || res.error || !res.fileId) { cb(null); return; }
    cb(res);
  });
  try { Android.resolveMulti(folderId, preferH || 0, cbName); }
  catch (e) { done = true; clearTimeout(failTimer); cb(null); }
}

// Clicking any folder: if it holds quality folders -> picker, else open normally (list is reused, no 2nd fetch)
function openFolderSmart(id, name) {
  // where the user is browsing right now (no network needed): [My Drive, Web Series, Show] -> parent = Show
  var stackCtx = null;
  try {
    var top = folderStack[folderStack.length - 1];
    if (viewMode === "browse" && top && top.id === currentFolderId && !searchOverlay.classList.contains("active")) {
      stackCtx = folderStack.slice();
    }
  } catch (e) { stackCtx = null; }
  showOpening(true);
  var done = false;
  var failTimer = setTimeout(function () { if (!done) { done = true; showOpening(false); enterBrowseFolder(id, name); } }, 12000);
  var cbName = registerTempCallback(function (data) {
    if (done) return;
    done = true;
    clearTimeout(failTimer);
    showOpening(false);
    if (!data || data.error) { enterBrowseFolder(id, name); return; }
    var q = detectQualityFolders(data.files, name);
    if (!q) { enterBrowseFolder(id, name, data); return; }
    onQualityFolderOpened(id, name, q, stackCtx);
  });
  try { Android.listFiles(id, cbName); }
  catch (e) { done = true; clearTimeout(failTimer); showOpening(false); enterBrowseFolder(id, name); }
}

// Is this multi-quality folder an EPISODE (Series > Season > Episode) or a MOVIE?
function onQualityFolderOpened(id, name, q, stackCtx) {
  if (stackCtx && stackCtx.length) {
    // chain[0] = this folder, chain[1] = parent (the folder being browsed), chain[2..] = ancestors
    var ch = [{ id: id, name: name }];
    for (var k = stackCtx.length - 1; k >= 0; k--) ch.push({ id: stackCtx[k].id, name: stackCtx[k].name });
    decideMultiKind(id, name, q, ch);
    return;
  }
  showOpening(true);
  var done = false;
  var failTimer = setTimeout(function () { if (!done) { done = true; showOpening(false); decideMultiKind(id, name, q, []); } }, 8000);
  var cbName = registerTempCallback(function (res) {
    if (done) return;
    done = true;
    clearTimeout(failTimer);
    showOpening(false);
    decideMultiKind(id, name, q, (res && res.chain) ? res.chain : []);
  });
  try { Android.getFolderChain(id, cbName); }
  catch (e) { done = true; clearTimeout(failTimer); showOpening(false); decideMultiKind(id, name, q, []); }
}

// MOVIE or EPISODE?  chain[0] = this folder, chain[1] = parent, chain[2..] = ancestors
function decideMultiKind(id, name, q, chain) {
  var parent = chain[1];
  var isSeries = false;
  if (parent && looksLikeEpisode(name)) isSeries = true;   // "...S01E01..." in the folder name = an episode
  if (parent && !isSeries) {
    var pn = normalizeFolderName(parent.name);
    if (/season|^s\d+$/.test(pn)) isSeries = true;
    else {
      for (var i = 1; i < chain.length; i++) {
        var cn = normalizeFolderName(chain[i].name);
        // the parent itself may be the show folder inside "Web Series" etc. -> look from the parent upwards
        if (i >= 2 && /series|anime|cartoon|animation|drama|tv ?show/.test(cn) && !/movie|film/.test(cn)) { isSeries = true; break; }
      }
    }
  }
  if (!isSeries) { openMultiMoviePicker(id, name, q); return; }
  var title = parent.name;
  if (/season|^s\d+$/i.test((parent.name || "").trim()) && chain[2]) title = chain[2].name + " - " + parent.name;
  openEpisodePicker(id, name, q, parent.id, title);
}

// ---------- quality popup (reuses the animated resume popup) ----------
function showQualityPicker(cfg) {
  // cfg: {badge,title,sub,stateId,qualities,prefH,onPick(h)}
  var st = getPlayStateSafe(cfg.stateId);
  var resumable = st.pos > 5000 && !st.done;
  var best = cfg.qualities[0].h;
  var def = cfg.prefH || 0;
  var hasDef = cfg.qualities.some(function (x) { return x.h === def; });
  if (!hasDef) def = best;
  var options = cfg.qualities.map(function (x) {
    return {
      primary: x.h === def, icon: "play", label: x.label,
      sub: (x.h === def && cfg.prefH ? "Last used" : (x.h >= 5000 ? (x.h === best ? "Best quality" : "Smaller file") : x.h >= 2160 ? "Ultra HD" : x.h >= 1080 ? "Full HD" : x.h >= 720 ? "HD" : "Data saver")) + (resumable ? " · resumes from " + fmtTime(st.pos) : ""),
      onClick: function () { cfg.onPick(x.h); }
    };
  });
  if (resumable) {
    options.push({ icon: "restart", label: "Start from beginning", sub: "Choose quality, play from 0:00", onClick: function () {
      try { Android.clearPlayState(cfg.stateId); } catch (e) { }
      showQualityPicker(cfg);
    } });
  }
  if (cfg.browse) {
    options.push({ icon: "list", label: "Browse files / Download", sub: "Open this folder", onClick: cfg.browse });
  }
  showResumePopup({
    badge: cfg.badge, title: cfg.title,
    sub: cfg.sub + (resumable ? " · stopped at " + fmtTime(st.pos) : ""),
    pct: resumable && st.dur > 0 ? st.pos / st.dur : null,
    options: options
  });
}

function openMultiMoviePicker(id, name, q) {
  if (q) { showMovieQuality(id, name, q); return; }
  // from History: need the quality list first
  showOpening(true);
  var cbName = registerTempCallback(function (data) {
    showOpening(false);
    var qq = (data && !data.error) ? detectQualityFolders(data.files, name) : null;
    if (!qq) { showToast("Couldn't load qualities - check your internet connection"); return; }
    showMovieQuality(id, name, qq);
  });
  try { Android.listFiles(id, cbName); } catch (e) { showOpening(false); }
}

function showMovieQuality(id, name, q) {
  showQualityPicker({
    badge: "MOVIE", title: cleanTitle(name), sub: "Choose quality", stateId: id, qualities: q,
    browse: function () { enterBrowseFolder(id, name); },
    prefH: getQualityPref(id),
    onPick: function (h) {
      try { Android.setQualityPref(id, h); } catch (e) { }
      showOpening(true);
      resolveMultiJs(id, h, function (res) {
        showOpening(false);
        if (!res) { showToast("Couldn't load this movie - check your internet connection"); return; }
        var meta = { htype: "movie", hkey: id, htitle: cleanTitle(name), hparent: "",
                     mq: { sid: id, h: res.height, variants: res.variants, fname: res.fileName } };
        Android.openFileEx(res.fileId, name, JSON.stringify(meta));
      });
    }
  });
}

function openEpisodePicker(epId, epName, q, seasonId, seriesTitle) {
  showQualityPicker({
    badge: "WEB SERIES", title: epName, sub: seriesTitle, stateId: epId, qualities: q,
    browse: function () { enterBrowseFolder(epId, epName); },
    prefH: getQualityPref(seasonId),
    onPick: function (h) {
      try { Android.setQualityPref(seasonId, h); } catch (e) { }
      showOpening(true);
      fetchEpisodeFolders(seasonId, function (eps) {
        showOpening(false);
        var idx = eps ? indexOfEp(eps, epId) : -1;
        if (!eps || idx < 0) { eps = [{ id: epId, name: epName, multi: true }]; idx = 0; showToast("Episode list not found - next episode won't be available"); }
        launchSeriesEpisode(eps, idx, seriesTitle, seasonId, h);
      });
    }
  });
}


// ==========================================================================
// DOWNLOAD ALL with quality choice
//   Scans the folder tree. Movie / episode folders that hold several qualities are "units".
//   1) pick ONE quality for everything,
//   2) a season that doesn't have it (or only some of its episodes do) tells you so and lets
//      you pick another quality for that season (or skip it),
//   3) only the chosen quality of each episode is downloaded - not every quality.
//   Folders without any quality structure download exactly like before.
// ==========================================================================

function dlListFolder(id, cb) {
  var done = false;
  var t = setTimeout(function () { if (!done) { done = true; cb(null); } }, 20000);
  var n = registerTempCallback(function (d) {
    if (done) return;
    done = true; clearTimeout(t);
    cb(d && !d.error && d.files ? d : null);
  });
  try { Android.listFiles(id, n); } catch (e) { done = true; clearTimeout(t); cb(null); }
}

function scanFolderForDownload(rootId, rootName, cb) {
  var units = [], plain = [], queue = [], active = 0, finished = false, failed = false, scanned = 0;

  function finish() {
    if (finished) return;
    if (active === 0 && queue.length === 0) { finished = true; cb({ units: units, plain: plain, failed: failed }); }
  }
  function pump() {
    while (active < 5 && queue.length) { var task = queue.shift(); active++; task(); }
    finish();
  }
  function enqueue(task) { queue.push(task); pump(); }
  function taskDone() { active--; pump(); }

  function walk(id, name, path, depth) {
    enqueue(function () {
      dlListFolder(id, function (data) {
        scanned++;
        if (scanned % 5 === 0) showOpening(true);
        if (!data) { failed = true; taskDone(); return; }
        var q = depth <= 8 ? detectQualityFolders(data.files, name) : null;
        if (q) {
          var unit = { id: id, name: name, subPath: path.length ? path.slice(0, path.length - 1) : [], variants: [] };
          units.push(unit);
          q.forEach(function (v) {
            if (v.isFile) {
              unit.variants.push({ h: v.h, label: v.label, file: { id: v.id, name: v.name, size: v.size || 0 } });
            } else {
              enqueue(function () {   // quality FOLDER -> find its video file
                dlListFolder(v.id, function (d2) {
                  if (d2) {
                    for (var i = 0; i < d2.files.length; i++) {
                      var f = d2.files[i];
                      if (f.mimeType !== "application/vnd.google-apps.folder" && isVideoFile(f.name)) {
                        unit.variants.push({ h: v.h, label: v.label, file: { id: f.id, name: f.name, size: parseInt(f.size, 10) || 0 } });
                        break;
                      }
                    }
                  } else { failed = true; }
                  taskDone();
                });
              });
            }
          });
        } else {
          data.files.forEach(function (f) {
            if (f.mimeType === "application/vnd.google-apps.folder") walk(f.id, f.name, path.concat(f.name), depth + 1);
            else plain.push({ id: f.id, name: f.name, size: parseInt(f.size, 10) || 0, subPath: path });
          });
        }
        taskDone();
      });
    });
  }
  walk(rootId, rootName, [], 0);
}

function smartFolderDownload(folderId, folderName) {
  showToast("Scanning folder: " + folderName);
  showOpening(true);
  scanFolderForDownload(folderId, folderName, function (res) {
    showOpening(false);
    var units = res.units.filter(function (u) { return u.variants.length > 0; });
    if (!units.length) { plainFolderDownload(folderId, folderName); return; }   // no quality structure: old behaviour

    // group the units by season (= the folder that holds the episode folders)
    var groups = {}, order = [];
    units.forEach(function (u) {
      var key = u.subPath.join("/");
      if (!groups[key]) {
        groups[key] = { key: key, label: u.subPath.length ? u.subPath[u.subPath.length - 1] : folderName, units: [] };
        order.push(key);
      }
      groups[key].units.push(u);
      u.byH = {};
      u.variants.forEach(function (v) { if (!u.byH[v.h]) u.byH[v.h] = v; });
    });
    var glist = order.map(function (k) { return groups[k]; });

    // coverage per quality over ALL units
    var cover = {}, labels = {};
    units.forEach(function (u) {
      Object.keys(u.byH).forEach(function (h) {
        var c = cover[h] || (cover[h] = { n: 0, bytes: 0 });
        c.n++; c.bytes += u.byH[h].file.size || 0;
        labels[h] = u.byH[h].label;
      });
    });
    var heights = Object.keys(cover).map(Number).sort(function (a, b) { return b - a; });
    var noun = glist.length > 1 || units.length > 1 ? "episodes" : "file";
    var pref = getQualityPref("download");
    var def = heights.indexOf(pref) >= 0 ? pref : heights[0];

    showResumePopup({
      badge: "DOWNLOAD", title: cleanTitle(folderName),
      sub: "Choose quality \u00B7 " + units.length + " " + (units.length > 1 ? "items" : "item") + (glist.length > 1 ? " in " + glist.length + " groups" : ""),
      pct: null,
      options: heights.map(function (h) {
        var c = cover[h];
        var info = (units.length > 1 ? c.n + "/" + units.length + " " + noun : "") + (c.bytes ? (units.length > 1 ? " \u00B7 " : "") + "\u2248 " + formatBytes(c.bytes) : "");
        if (units.length > 1 && c.n < units.length) info += " \u00B7 missing in some";
        return { primary: h === def, icon: "play", label: labels[h], sub: info, onClick: function () { dlResolveGroups(folderName, glist, h, labels, units, res.plain); } };
      })
    });
  });
}

// For every group (season): is the wanted quality there for ALL its episodes? If not -> ask what to do.
function dlResolveGroups(folderName, glist, wantH, labels, units, plain) {
  try { Android.setQualityPref("download", wantH); } catch (e) { }
  var choices = {};   // group key -> chosen height (null = skip)

  function next(i) {
    if (i >= glist.length) { dlStartDownload(folderName, glist, choices, plain); return; }
    var g = glist[i];
    var have = 0;
    g.units.forEach(function (u) { if (u.byH[wantH]) have++; });
    if (have === g.units.length) { choices[g.key] = wantH; next(i + 1); return; }

    // this season lacks the wanted quality (fully or partly) -> offer the qualities it does have
    var cov = {};
    g.units.forEach(function (u) { Object.keys(u.byH).forEach(function (h) { cov[h] = (cov[h] || 0) + 1; }); });
    var alts = Object.keys(cov).map(Number).sort(function (a, b) {
      var fa = cov[a] === g.units.length ? 0 : 1, fb = cov[b] === g.units.length ? 0 : 1;
      if (fa !== fb) return fa - fb;                       // qualities that cover the whole season first
      var da = (a <= wantH ? 0 : 100000) + Math.abs(a - wantH), db = (b <= wantH ? 0 : 100000) + Math.abs(b - wantH);
      return da - db;                                      // then the closest to the wanted one
    });
    var wantLabel = labels[wantH] || qualityLabelOf(wantH);
    var opts = alts.map(function (h, idx) {
      return { primary: idx === 0, icon: "play", label: labels[h] || qualityLabelOf(h),
               sub: cov[h] + "/" + g.units.length + " " + (g.units.length > 1 ? "episodes" : "file") + (cov[h] < g.units.length ? " \u00B7 rest get the closest quality" : ""),
               onClick: function () { choices[g.key] = h; next(i + 1); } };
    });
    opts.push({ icon: "restart", label: "Skip " + g.label, sub: "Don't download this one", onClick: function () { choices[g.key] = null; next(i + 1); } });
    showResumePopup({
      badge: "QUALITY NOT AVAILABLE", title: g.label,
      sub: have === 0 ? wantLabel + " is not available here. Choose another quality for " + g.label
                      : wantLabel + " is missing in " + (g.units.length - have) + " of " + g.units.length + " episodes. Choose a quality for " + g.label,
      pct: null, options: opts
    });
  }
  next(0);
}

function dlStartDownload(folderName, glist, choices, plain) {
  var files = [], skipped = 0, bytes = 0;
  glist.forEach(function (g) {
    var h = choices[g.key];
    if (h === null || h === undefined) { skipped += g.units.length; return; }
    g.units.forEach(function (u) {
      var v = u.byH[h];
      if (!v) {   // this episode lacks it: closest quality (lower first)
        var best = null, bestScore = 1e9;
        u.variants.forEach(function (x) {
          var sc = (x.h <= h ? 0 : 100000) + Math.abs(x.h - h);
          if (sc < bestScore) { bestScore = sc; best = x; }
        });
        v = best;
      }
      if (v) { files.push({ id: v.file.id, name: v.file.name, subPath: u.subPath }); bytes += v.file.size || 0; }
    });
  });
  (plain || []).forEach(function (f) { files.push({ id: f.id, name: f.name, subPath: f.subPath }); });
  if (!files.length) { showToast("Nothing selected to download"); return; }
  try { Android.downloadSelection(folderName, JSON.stringify(files)); }
  catch (e) { showToast("Content download is not supported on this device"); return; }
  prefetchDownloadPoster(folderName, { type: "folder", name: folderName });
  showToast("Downloading " + files.length + " file" + (files.length > 1 ? "s" : "") + (bytes ? " \u00B7 \u2248 " + formatBytes(bytes) : "") + (skipped ? " (" + skipped + " skipped)" : ""));
  goDownloads();
}
