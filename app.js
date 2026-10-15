(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var elStatus = $("status");
  var elLat = $("lat");
  var elLng = $("lng");
  var elAcc = $("acc");
  var elSteps = $("steps");
  var elMotionStatus = $("motionStatus");
  var elPanel = $("panel");
  var btnToggle = $("toggle");
  var btnRecenter = $("recenter");
  var btnReset = $("reset");

  if (typeof L === "undefined") {
    elStatus.textContent = "Map library failed to load. Check your connection and reload.";
    elStatus.className = "status error";
    return;
  }

  // ---- Map ---------------------------------------------------------------
  var map = L.map("map", { zoomControl: false }).setView([25.033, 121.5654], 13);
  L.control.zoom({ position: "topright" }).addTo(map);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Keep the map sized correctly when mobile browser bars show/hide or rotate.
  function refreshSize() { map.invalidateSize(); }
  window.addEventListener("resize", refreshSize);
  window.addEventListener("orientationchange", function () { setTimeout(refreshSize, 300); });

  // Keep the re-centre button just above the (variable-height) bottom panel.
  function updatePanelHeight() {
    document.documentElement.style.setProperty("--panel-h", elPanel.offsetHeight + "px");
  }
  updatePanelHeight();
  if ("ResizeObserver" in window) {
    new ResizeObserver(updatePanelHeight).observe(elPanel);
  } else {
    window.addEventListener("resize", updatePanelHeight);
  }

  // ---- State -------------------------------------------------------------
  var watchId = null;
  var marker = null;
  var accuracyCircle = null;
  var following = true;
  var firstFix = true;
  var programmaticMove = false;
  var wakeLock = null;

  var markerIcon = L.divIcon({
    className: "",
    html: '<div class="me-marker"><div class="pulse"></div><div class="dot"></div></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11]
  });

  // ---- UI helpers --------------------------------------------------------
  function setStatus(text, kind) {
    elStatus.textContent = text;
    elStatus.className = "status" + (kind ? " " + kind : "");
  }

  function setMotionStatus(text, kind) {
    elMotionStatus.textContent = text;
    elMotionStatus.className = "motion-status" + (kind ? " " + kind : "");
  }

  function resetReadout() {
    elLat.textContent = "\u2013";
    elLng.textContent = "\u2013";
    elAcc.textContent = "\u2013";
  }

  // If the user pans/zooms manually, stop auto-following and offer Re-centre.
  map.on("dragstart zoomstart", function () {
    if (programmaticMove || watchId === null) return;
    following = false;
    btnRecenter.hidden = false;
  });

  function moveTo(latlng, accuracy) {
    programmaticMove = true;
    if (firstFix) {
      var bounds = L.latLng(latlng).toBounds(Math.max(accuracy * 2, 200));
      map.fitBounds(bounds, { maxZoom: 18, animate: false });
      firstFix = false;
    } else {
      map.panTo(latlng, { animate: true, duration: 0.5 });
    }
    setTimeout(function () { programmaticMove = false; }, 700);
  }

  btnRecenter.addEventListener("click", function () {
    following = true;
    btnRecenter.hidden = true;
    if (marker) {
      programmaticMove = true;
      map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17), { animate: true });
      setTimeout(function () { programmaticMove = false; }, 700);
    }
  });

  // ---- Geolocation -------------------------------------------------------
  function onPosition(pos) {
    var lat = pos.coords.latitude;
    var lng = pos.coords.longitude;
    var acc = pos.coords.accuracy;
    var latlng = [lat, lng];

    elLat.textContent = lat.toFixed(6);
    elLng.textContent = lng.toFixed(6);
    elAcc.textContent = Math.round(acc) + " m";

    if (!marker) {
      marker = L.marker(latlng, { icon: markerIcon, interactive: false, keyboard: false }).addTo(map);
      accuracyCircle = L.circle(latlng, {
        radius: acc,
        color: "#2563eb",
        weight: 1,
        fillColor: "#2563eb",
        fillOpacity: 0.12,
        interactive: false
      }).addTo(map);
    } else {
      marker.setLatLng(latlng);
      accuracyCircle.setLatLng(latlng);
      accuracyCircle.setRadius(acc);
    }

    if (following) moveTo(latlng, acc);

    var quality = acc <= 20 ? "Good signal" : acc <= 100 ? "Fair signal" : "Weak signal";
    setStatus("Tracking \u2013 " + quality + ".", "ok");
  }

  function onError(err) {
    var msg;
    switch (err.code) {
      case 1: // PERMISSION_DENIED
        msg = "Location permission denied. Allow location for this site in your browser/phone settings, then tap Start again.";
        stopTracking(true);
        break;
      case 2: // POSITION_UNAVAILABLE
        msg = "Position unavailable. Check that Location Services/GPS is on. Still trying\u2026";
        break;
      case 3: // TIMEOUT
        msg = "Timed out waiting for GPS. Try moving to open sky. Still trying\u2026";
        break;
      default:
        msg = "Location error: " + (err.message || "unknown");
    }
    setStatus(msg, "error");
  }

  // ---- Step counter (accelerometer via devicemotion) ---------------------
  var steps = 0;
  var motionListening = false;
  var motionToken = 0;          // guards against a late permission reply after Stop
  var motionCheckTimer = null;
  var gotMotionData = false;

  // Detector tuning (m/s^2 and ms). Works for a phone in hand or pocket.
  var STEP_THRESHOLD = 1.5;     // smoothed dynamic acceleration needed to count a peak
  var REARM_LEVEL = 0.5;        // must fall below this before the next peak counts
  var MIN_STEP_GAP = 300;       // fastest plausible step interval
  var MAX_STEP_GAP = 1500;      // longer gap = new walking burst
  var STREAK_TO_COMMIT = 3;     // ignore isolated bumps; need a few steps in a row

  var gravityEst = 0;
  var smooth = 0;
  var armed = true;
  var lastPeakTime = 0;
  var streak = 0;
  var haveBaseline = false;

  function renderSteps() { elSteps.textContent = String(steps); }

  function resetDetector() {
    gravityEst = 0;
    smooth = 0;
    armed = true;
    lastPeakTime = 0;
    streak = 0;
    haveBaseline = false;
  }

  function onMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null ||
        a.x === undefined || a.y === undefined || a.z === undefined) {
      return;
    }
    if (!gotMotionData) {
      gotMotionData = true;
      setMotionStatus("Counting steps", "ok");
    }

    // Magnitude is orientation-independent (and ignores iOS/Android sign differences).
    var mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

    if (!haveBaseline) {
      gravityEst = mag;
      haveBaseline = true;
      return;
    }

    // Slowly track gravity, then low-pass the remainder to get a clean walking signal.
    gravityEst += 0.02 * (mag - gravityEst);
    smooth += 0.3 * ((mag - gravityEst) - smooth);

    var now = Date.now();

    if (smooth < REARM_LEVEL) armed = true;

    if (armed && smooth > STEP_THRESHOLD && (now - lastPeakTime) >= MIN_STEP_GAP) {
      armed = false;

      if (lastPeakTime && (now - lastPeakTime) <= MAX_STEP_GAP) streak++;
      else streak = 1;
      lastPeakTime = now;

      if (streak === STREAK_TO_COMMIT) {
        steps += STREAK_TO_COMMIT;   // credit the steps that built up the streak
        renderSteps();
      } else if (streak > STREAK_TO_COMMIT) {
        steps += 1;
        renderSteps();
      }
    }
  }

  // Must be called synchronously from a tap so iOS will show its permission prompt.
  function requestMotionPermission() {
    if (typeof DeviceMotionEvent === "undefined") {
      return Promise.resolve("unsupported");
    }
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      try {
        return DeviceMotionEvent.requestPermission().then(
          function (r) { return r === "granted" ? "granted" : "denied"; },
          function () { return "denied"; }
        );
      } catch (err) {
        return Promise.resolve("denied");
      }
    }
    // Android Chrome and others: no explicit prompt needed.
    return Promise.resolve("granted");
  }

  function attachMotion(token) {
    if (token !== motionToken || motionListening) return;
    resetDetector();
    gotMotionData = false;
    window.addEventListener("devicemotion", onMotion);
    motionListening = true;
    setMotionStatus("Waiting for motion data\u2026");

    clearTimeout(motionCheckTimer);
    motionCheckTimer = setTimeout(function () {
      if (motionListening && !gotMotionData) {
        setMotionStatus("No motion data from this device or browser", "error");
      }
    }, 3000);
  }

  function detachMotion() {
    motionToken++;
    clearTimeout(motionCheckTimer);
    if (motionListening) {
      window.removeEventListener("devicemotion", onMotion);
      motionListening = false;
    }
  }

  function startMotion() {
    var token = ++motionToken;
    // Called right away (not after an await) to stay inside the tap gesture.
    requestMotionPermission().then(function (result) {
      if (token !== motionToken) return; // user already tapped Stop
      if (result === "granted") {
        attachMotion(token);
      } else if (result === "denied") {
        setMotionStatus("Motion access denied. Close and reopen Safari, tap Start, then choose Allow.", "error");
      } else {
        setMotionStatus("Motion sensor not supported here", "error");
      }
    });
  }

  btnReset.addEventListener("click", function () {
    steps = 0;
    streak = 0;
    renderSteps();
  });

  // ---- Wake lock ---------------------------------------------------------
  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", function () { wakeLock = null; });
      }
    } catch (e) { /* optional feature; ignore */ }
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }

  // Wake lock is dropped when the tab is hidden; re-acquire when visible again.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && watchId !== null) requestWakeLock();
  });

  // ---- Start / Stop ------------------------------------------------------
  function startTracking() {
    // 1) Motion permission first, synchronously inside the tap (required on iPhone).
    startMotion();

    // 2) Then GPS.
    if (!("geolocation" in navigator)) {
      setStatus("Geolocation is not supported by this browser.", "error");
      return;
    }
    if (!window.isSecureContext) {
      setStatus("Location needs a secure (HTTPS) page. Open the GitHub Pages https:// address.", "error");
      return;
    }

    following = true;
    firstFix = true;
    btnRecenter.hidden = true;
    setStatus("Requesting location\u2026 please allow access when prompted.");
    btnToggle.textContent = "Stop";
    btnToggle.classList.add("running");

    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    });
    requestWakeLock();
  }

  function stopTracking(keepMessage) {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    detachMotion();
    setMotionStatus("Motion sensor off");
    releaseWakeLock();
    btnToggle.textContent = "Start";
    btnToggle.classList.remove("running");
    btnRecenter.hidden = true;
    if (marker) { map.removeLayer(marker); marker = null; }
    if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
    resetReadout();
    if (!keepMessage) setStatus("Stopped. Tap Start to follow your location and count steps.");
  }

  btnToggle.addEventListener("click", function () {
    // Treat the session as running if either sensor is active, so Stop always works.
    if (watchId === null && !motionListening) startTracking();
    else stopTracking(false);
  });
})();
