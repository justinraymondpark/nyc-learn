/* NYC Compass — TCW-skinned map app for learning NYC.
 * Lives at /index.html. Zero build, no framework, no npm. */
(function () {
  "use strict";

  // ──────────────── Theme (state only, no map calls) ────────────────
  const root = document.documentElement;
  const THEME_KEY = "nyc.theme";
  function getTheme() { return root.getAttribute("data-theme") || "dark"; }
  function applyThemeAttr(t) {
    root.setAttribute("data-theme", t);
    localStorage.setItem(THEME_KEY, t);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = (t === "dark" ? "Light" : "Dark");
  }
  // Apply saved theme synchronously so the CSS doesn't flash.
  applyThemeAttr(localStorage.getItem(THEME_KEY) || "dark");

  // ──────────────── Map ────────────────
  const map = L.map("map", {
    zoomControl: false,        // pinch / scroll only — buttons crowd the HUD
    attributionControl: true,
    minZoom: 10,
    maxZoom: 18,
  }).setView([40.758, -73.975], 12);

  let tileLayer = null;
  let labelsLayer = null;
  let labelsVisible = true;       // hidden in quiz modes (otherwise labels reveal answers)
  function addLabelsLayer() {
    const lblUrl = getTheme() === "light"
      ? "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png";
    labelsLayer = L.tileLayer(lblUrl, { subdomains: "abcd", maxZoom: 19 }).addTo(map);
  }
  function setLabels(visible) {
    labelsVisible = visible;
    if (visible && !labelsLayer) addLabelsLayer();
    else if (!visible && labelsLayer) { map.removeLayer(labelsLayer); labelsLayer = null; }
  }
  function setZoomBounds(min, max) {
    map.setMinZoom(min);
    map.setMaxZoom(max);
    // If current zoom is outside the new bounds, snap it.
    if (map.getZoom() > max) map.setZoom(max);
    if (map.getZoom() < min) map.setZoom(min);
  }
  function swapTileLayer(theme) {
    if (tileLayer)   { map.removeLayer(tileLayer);   tileLayer = null; }
    if (labelsLayer) { map.removeLayer(labelsLayer); labelsLayer = null; }
    const baseUrl = theme === "light"
      ? "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
    tileLayer = L.tileLayer(baseUrl, {
      subdomains: "abcd",
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    if (labelsVisible) addLabelsLayer();
  }
  swapTileLayer(getTheme());

  // Wire the toggle now that both pieces exist.
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = getTheme() === "dark" ? "light" : "dark";
    applyThemeAttr(next);
    swapTileLayer(next);
  });

  // Leaflet sometimes needs a nudge if its container resolved size after init.
  setTimeout(() => map.invalidateSize(), 0);
  window.addEventListener("resize", () => map.invalidateSize());

  // ──────────────── Time / Open chip ────────────────
  function updateTimeChip() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const t = fmt.format(now);
    document.getElementById("time-chip").textContent = t;

    // "Open" 10am–6pm ET, M–F (matches TCW voice "10am–6pm M–F")
    const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = ny.getDay(); // 0 = Sun, 6 = Sat
    const hour = ny.getHours();
    const open = day >= 1 && day <= 5 && hour >= 10 && hour < 18;
    const dot = document.getElementById("open-dot");
    const lbl = document.getElementById("open-label");
    if (open) { dot.classList.remove("empty"); lbl.textContent = "Open"; }
    else      { dot.classList.add("empty");    lbl.textContent = "closed"; }
  }
  updateTimeChip();
  setInterval(updateTimeChip, 30000);

  // ──────────────── Shared state ────────────────
  const State = {
    mode: "explore",
    markers: [],
    quizMarker: null,
    truthMarker: null,
    pathLine: null,
    hoodLayer: null,
    place: {
      remaining: [], current: null,
      rounds: 0, totalMiss: 0, best: null,
      // Default ON. Only treats an explicit "false" as opt-out so the chip-toggle still wins.
      easyMode: localStorage.getItem("nyc.easy") !== "false",
      choices: [],         // easy-mode candidate landmarks (length 4)
      easyMarkers: [],     // easy-mode numbered markers
    },
    hood:  { remaining: [], current: null, rounds: 0 },
    streak: Number(localStorage.getItem("nyc.streak") || 0),
  };
  document.getElementById("score-value").textContent = State.streak;

  // ──────────────── Utilities ────────────────
  function pinIcon(kind) {
    return L.divIcon({
      className: "",
      html: `<div class="pin ${kind || ""}"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
  }
  function distanceM(a, b) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
    const la1 = toRad(a[0]), la2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDistance(m) {
    if (m == null) return "—";
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1609.34).toFixed(2)} mi`;
  }
  function bumpStreak(delta) {
    State.streak = Math.max(0, State.streak + delta);
    localStorage.setItem("nyc.streak", String(State.streak));
    const sv = document.getElementById("score-value");
    const ps = document.getElementById("place-streak");
    const hs = document.getElementById("hood-streak");
    if (sv) sv.textContent = State.streak;
    if (ps) ps.textContent = State.streak;
    if (hs) hs.textContent = State.streak;
    if (delta > 0) {
      [sv, ps, hs].filter(Boolean).forEach((el) => {
        el.classList.remove("flash");
        void el.offsetWidth;            // restart the animation
        el.classList.add("flash");
      });
    }
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function clearMapLayers() {
    State.markers.forEach((m) => map.removeLayer(m));
    State.markers = [];
    if (State.quizMarker)  { map.removeLayer(State.quizMarker);  State.quizMarker  = null; }
    if (State.truthMarker) { map.removeLayer(State.truthMarker); State.truthMarker = null; }
    if (State.pathLine)    { map.removeLayer(State.pathLine);    State.pathLine    = null; }
    if (State.hoodLayer)   { map.removeLayer(State.hoodLayer);   State.hoodLayer   = null; }
    map.off("click");
    const hudEl = document.getElementById("map-hud");
    if (hudEl) { hudEl.hidden = true; hudEl.innerHTML = ""; }
  }
  function lineColor() { return getTheme() === "light" ? "#000" : "#fff"; }

  // ──────────────── Mode switching ────────────────
  const panels = {
    explore: document.getElementById("panel-explore"),
    place:   document.getElementById("panel-place"),
    hood:    document.getElementById("panel-hood"),
    subway:  document.getElementById("panel-subway"),
    basics:  document.getElementById("panel-basics"),
  };
  document.querySelectorAll(".modes-bar .chip-nav").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
  function setMode(mode) {
    State.mode = mode;
    document.querySelectorAll(".modes-bar .chip-nav").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode)
    );
    Object.entries(panels).forEach(([k, el]) => el.classList.toggle("hidden", k !== mode));
    document.body.classList.toggle("quiz-mode", mode === "place" || mode === "hood");
    clearMapLayers();
    if (mode === "explore") initExplore();
    if (mode === "place")   initPlaceQuiz();
    if (mode === "hood")    initHoodQuiz();
    if (mode === "subway")  initSubway();
    if (mode === "basics")  initBasics();
    // Recompute Leaflet container size after the topbar collapse changes layout.
    setTimeout(() => map.invalidateSize(), 50);
  }

  // ──────────────── Feedback splash ────────────────
  // tone: "good" | "med" | "bad". Restarts the CSS animation cleanly.
  function flashSplash(tone) {
    const el = document.getElementById("splash");
    if (!el) return;
    el.className = "splash";
    void el.offsetWidth;            // force reflow so the animation re-runs
    el.classList.add(tone, "show");
  }

  // ──────────────── EXPLORE ────────────────
  function initExplore() {
    setLabels(true);
    setZoomBounds(10, 18);
    map.setView([40.758, -73.975], 12);
    renderExploreMarkers();
    document.querySelectorAll('#panel-explore .filters input').forEach((cb) => {
      cb.onchange = renderExploreMarkers;
    });
  }
  function activeFilters() {
    const set = new Set();
    document.querySelectorAll('#panel-explore .filters input:checked')
      .forEach((cb) => set.add(cb.value));
    return set;
  }
  function renderExploreMarkers() {
    State.markers.forEach((m) => map.removeLayer(m));
    State.markers = [];
    const filter = activeFilters();
    window.LANDMARKS.filter((l) => filter.has(l.kind)).forEach((l) => {
      const m = L.marker([l.lat, l.lng], { icon: pinIcon(l.kind), title: l.name });
      m.bindPopup(`<strong>${l.name}</strong>${l.blurb}`, { maxWidth: 280 });
      m.on("click", () => showExploreDetails(l));
      m.addTo(map);
      State.markers.push(m);
    });
  }
  function showExploreDetails(l) {
    const el = document.getElementById("explore-details");
    el.innerHTML = `
      <div class="tile-eyebrow">${l.kind}</div>
      <h3>${l.name}</h3>
      <p>${l.blurb}</p>
    `;
  }

  // ──────────────── Map HUD helpers ────────────────
  const hud = document.getElementById("map-hud");
  function showHud(html) {
    hud.innerHTML = html;
    hud.hidden = false;
  }
  function hideHud() { hud.hidden = true; hud.innerHTML = ""; }

  // ──────────────── PLACE QUIZ ────────────────
  function initPlaceQuiz() {
    setLabels(false);          // labels would just give away the answers
    setZoomBounds(11, 14);     // cap zoom — neighborhood-level only
    map.setView([40.740, -73.990], 11);
    if (State.place.remaining.length === 0) {
      State.place.remaining = shuffle(window.LANDMARKS.filter((l) => l.kind !== "neighborhood"));
    }
    document.getElementById("place-streak").textContent = State.streak;
    nextPlace();
  }
  function clearPlaceOverlays() {
    if (State.quizMarker)  { map.removeLayer(State.quizMarker);  State.quizMarker  = null; }
    if (State.truthMarker) { map.removeLayer(State.truthMarker); State.truthMarker = null; }
    if (State.pathLine)    { map.removeLayer(State.pathLine);    State.pathLine    = null; }
    State.place.easyMarkers.forEach((m) => map.removeLayer(m));
    State.place.easyMarkers = [];
    State.place.choices = [];
    map.off("click");
  }
  function nextPlace() {
    clearPlaceOverlays();
    if (State.place.remaining.length === 0) {
      State.place.remaining = shuffle(window.LANDMARKS.filter((l) => l.kind !== "neighborhood"));
    }
    State.place.current = State.place.remaining.pop();
    if (State.place.easyMode) {
      setupEasyChoices(State.place.current);
    } else {
      map.on("click", onPlaceGuess);
      map.setView([40.740, -73.990], 11);
    }
    renderPlaceHud();
  }

  // Pick 3 distractors of the same kind, drawn from spread distance bands
  // so the choice is interesting: 1 near, 1 mid-range, 1 far / cross-borough.
  function pickDistractors(target) {
    const pool = window.LANDMARKS.filter(
      (l) => l.kind === target.kind && l.name !== target.name
    );
    const t = [target.lat, target.lng];
    const sorted = pool.map((l) => ({ l, d: distanceM(t, [l.lat, l.lng]) }));
    const bands = [
      sorted.filter((x) => x.d >=   800 && x.d <  3000),    // ~0.5–2 mi
      sorted.filter((x) => x.d >=  3000 && x.d < 10000),    // ~2–6 mi
      sorted.filter((x) => x.d >= 10000),                   // >6 mi (often cross-borough)
    ];
    const picked = [];
    bands.forEach((band) => {
      if (band.length) picked.push(band[Math.floor(Math.random() * band.length)].l);
    });
    // Backfill if some band was empty (rare for small kinds like "transit")
    const remaining = pool.filter((l) => !picked.includes(l));
    while (picked.length < 3 && remaining.length) {
      picked.push(remaining.splice(Math.floor(Math.random() * remaining.length), 1)[0]);
    }
    return picked.slice(0, 3);
  }

  function setupEasyChoices(target) {
    const distractors = pickDistractors(target);
    const choices = shuffle([target, ...distractors]);
    State.place.choices = choices;
    choices.forEach((l, i) => {
      const marker = L.marker([l.lat, l.lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="easy-pin">${i + 1}</div>`,
          iconSize: [34, 34], iconAnchor: [17, 17],
        }),
      });
      marker.on("click", () => answerEasy(l, i, target));
      marker.addTo(map);
      State.place.easyMarkers.push(marker);
    });
    const bounds = L.latLngBounds(choices.map((l) => [l.lat, l.lng]));
    map.fitBounds(bounds.pad(0.4));
  }

  function renderPlaceHud(resultHtml) {
    const c = State.place.current;
    const easy = State.place.easyMode;
    showHud(`
      <div class="hud-card">
        <span class="ask">${easy ? "Which pin is" : "Click where"}</span>
        <span class="target">${c.name}</span>
        <span class="meta">${c.kind}</span>
      </div>
      ${resultHtml || `
        <div class="hud-row">
          <button class="chip-btn ghost" id="hud-easy" aria-pressed="${easy}">${easy ? "Easy ●" : "Easy"}</button>
          <button class="chip-btn ghost" id="hud-skip">Skip</button>
        </div>
      `}
    `);
    if (!resultHtml) {
      document.getElementById("hud-easy").onclick = () => {
        State.place.easyMode = !State.place.easyMode;
        localStorage.setItem("nyc.easy", String(State.place.easyMode));
        nextPlace();
      };
      document.getElementById("hud-skip").onclick = nextPlace;
    }
  }

  function onPlaceGuess(e) {
    if (!State.place.current || State.quizMarker) return;
    const guess = [e.latlng.lat, e.latlng.lng];
    const truth = [State.place.current.lat, State.place.current.lng];
    const d = distanceM(guess, truth);

    State.quizMarker = L.marker(guess, {
      icon: L.divIcon({ className: "", html: `<div class="guess-dot"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }),
    }).addTo(map);
    State.truthMarker = L.marker(truth, {
      icon: L.divIcon({ className: "", html: `<div class="truth-dot"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
    }).bindPopup(`<strong>${State.place.current.name}</strong>${State.place.current.blurb}`).addTo(map);
    State.truthMarker.openPopup();
    State.pathLine = L.polyline([guess, truth], {
      color: lineColor(), weight: 1, dashArray: "3 5", opacity: .8,
    }).addTo(map);
    map.fitBounds(State.pathLine.getBounds().pad(0.3));

    State.place.rounds++;
    State.place.totalMiss += d;
    if (State.place.best == null || d < State.place.best) State.place.best = d;

    let label = "Way off", tone = "bad";
    if (d < 250)       { label = "Bullseye";          tone = "good"; bumpStreak(+1); }
    else if (d < 1500) { label = "Close";             tone = "good"; bumpStreak(+1); }
    else if (d < 5000) { label = "Right borough-ish"; tone = "med"; }
    else               { label = "Way off";           tone = "bad"; bumpStreak(-1); }

    flashSplash(tone);

    renderPlaceHud(`
      <div class="hud-row">
        <div class="result-chip"><span class="marker">${fmtDistance(d)}</span>${label}.</div>
        <button class="chip-btn attract" id="hud-next">Next ↗</button>
      </div>
    `);
    document.getElementById("hud-next").onclick = nextPlace;
    updatePlaceStats();
  }

  function answerEasy(choice, idx, target) {
    // Stop further pin clicks
    State.place.easyMarkers.forEach((m) => m.off("click"));
    const correct = choice.name === target.name;

    // Mark each pin: correct one filled, picked-wrong dashed, others dimmed.
    State.place.easyMarkers.forEach((m, i) => {
      const el = m.getElement() && m.getElement().querySelector(".easy-pin");
      if (!el) return;
      const c = State.place.choices[i];
      if (c.name === target.name)        el.classList.add("correct");
      else if (i === idx)                el.classList.add("wrong");
      else                               el.classList.add("dim");
    });

    if (!correct) {
      // Open popup on the truth so the user sees what it was
      const tm = State.place.easyMarkers.find(
        (_, i) => State.place.choices[i].name === target.name
      );
      if (tm) tm.bindPopup(`<strong>${target.name}</strong>${target.blurb}`).openPopup();
    }

    State.place.rounds++;
    if (correct) bumpStreak(+1);
    else         bumpStreak(-1);

    flashSplash(correct ? "good" : "bad");

    renderPlaceHud(`
      <div class="hud-row">
        <div class="result-chip">
          <span class="marker">${correct ? "↗" : "—"}</span>
          ${correct ? "Correct." : `Pin ${State.place.choices.findIndex((c) => c.name === target.name) + 1} was it.`}
        </div>
        <button class="chip-btn attract" id="hud-next">Next ↗</button>
      </div>
    `);
    document.getElementById("hud-next").onclick = nextPlace;
    updatePlaceStats();
  }

  function updatePlaceStats() {
    document.getElementById("place-rounds").textContent = State.place.rounds;
    if (State.place.totalMiss > 0) {
      document.getElementById("place-avg").textContent = fmtDistance(State.place.totalMiss / State.place.rounds);
    }
    if (State.place.best != null) {
      document.getElementById("place-best").textContent = fmtDistance(State.place.best);
    }
  }

  // ──────────────── NEIGHBORHOOD QUIZ ────────────────
  function initHoodQuiz() {
    setLabels(false);
    setZoomBounds(11, 14);
    map.setView([40.730, -73.980], 12);
    document.getElementById("hood-rounds").textContent = State.hood.rounds;
    document.getElementById("hood-streak").textContent = State.streak;
    nextHood();
  }
  function nextHood() {
    if (State.hoodLayer) { map.removeLayer(State.hoodLayer); State.hoodLayer = null; }

    // Shuffle-and-pop so we don't repeat within a session. When the bag
    // is empty, reshuffle — but avoid immediately re-serving the last one.
    if (State.hood.remaining.length === 0) {
      let deck = shuffle(window.NEIGHBORHOODS);
      if (State.hood.current && deck[deck.length - 1].name === State.hood.current.name && deck.length > 1) {
        // Swap the would-be-next with something else so it's never two in a row.
        [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
      }
      State.hood.remaining = deck;
    }
    const target = State.hood.remaining.pop();
    State.hood.current = target;

    const pool = window.NEIGHBORHOODS;

    State.hoodLayer = L.polygon(target.poly, {
      color: lineColor(), weight: 1.5,
      fillColor: lineColor(), fillOpacity: .12,
    }).addTo(map);
    map.fitBounds(State.hoodLayer.getBounds().pad(1.2));

    const others = shuffle(pool.filter((n) => n.name !== target.name)).slice(0, 3);
    const choices = shuffle([target, ...others]);

    showHud(`
      <div class="hud-card">
        <span class="ask">Name this neighborhood</span>
      </div>
      <div class="hud-choices" id="hud-hood-choices"></div>
    `);
    const host = document.getElementById("hud-hood-choices");
    choices.forEach((c) => {
      const btn = document.createElement("button");
      btn.textContent = c.name;
      btn.onclick = () => answerHood(btn, c, target);
      host.appendChild(btn);
    });
  }
  function answerHood(btn, choice, target) {
    const buttons = document.querySelectorAll("#hud-hood-choices button");
    buttons.forEach((b) => (b.disabled = true));
    const correct = choice.name === target.name;
    if (correct) {
      btn.classList.add("correct");
      bumpStreak(+1);
    } else {
      btn.classList.add("wrong");
      buttons.forEach((b) => { if (b.textContent === target.name) b.classList.add("correct"); });
      bumpStreak(-1);
    }

    flashSplash(correct ? "good" : "bad");
    State.hood.rounds++;
    document.getElementById("hood-rounds").textContent = State.hood.rounds;

    // Append result chip + next button
    const card = hud.querySelector(".hud-card");
    card.innerHTML = `
      <span class="ask">${correct ? "↗ Correct" : "— That was"}</span>
      <span class="target">${target.name}</span>
      <span class="meta">${target.borough}</span>
    `;
    const row = document.createElement("div");
    row.className = "hud-row";
    row.innerHTML = `<button class="chip-btn attract" id="hud-hood-next">Next neighborhood ↗</button>`;
    hud.appendChild(row);
    document.getElementById("hud-hood-next").onclick = nextHood;
  }

  // ──────────────── SUBWAY ────────────────
  function initSubway() {
    setLabels(true);
    setZoomBounds(10, 18);
    map.setView([40.758, -73.985], 12);
    renderSubwayBullets();
    renderSubwayDetail(window.SUBWAY_LINES[0]);
    renderSubwayQuiz();
  }
  function renderSubwayBullets() {
    const host = document.getElementById("subway-lines");
    host.innerHTML = "";
    window.SUBWAY_LINES.forEach((line) => {
      const b = document.createElement("button");
      b.className = "bullet";
      b.style.background = line.color;
      b.textContent = line.id;
      if (line.color === "#FCCC0A" || line.color === "#A7A9AC") b.style.color = "#000";
      b.onclick = () => {
        document.querySelectorAll(".bullet").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        renderSubwayDetail(line);
      };
      host.appendChild(b);
    });
  }
  function renderSubwayDetail(line) {
    document.getElementById("subway-detail").innerHTML = `
      <div class="tile-eyebrow" style="color:${line.color}">${line.name}</div>
      <h3>The ${line.id} train</h3>
      <p>${line.fact}</p>
    `;
  }
  function renderSubwayQuiz() {
    const host = document.getElementById("subway-quiz");
    const q = window.SUBWAY_QUIZ[Math.floor(Math.random() * window.SUBWAY_QUIZ.length)];
    host.innerHTML = `
      <div class="q">${q.q}</div>
      <div class="opts"></div>
      <div class="feedback"></div>
    `;
    const opts = host.querySelector(".opts");
    shuffle(q.choices).forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c;
      b.onclick = () => {
        opts.querySelectorAll("button").forEach((x) => (x.disabled = true));
        const fb = host.querySelector(".feedback");
        const correct = c === q.a;
        if (correct) {
          b.classList.add("correct");
          fb.innerHTML = `<span style="color:var(--fg-1)">↗ </span>${q.why}`;
          bumpStreak(+1);
        } else {
          b.classList.add("wrong");
          opts.querySelectorAll("button").forEach((x) => { if (x.textContent === q.a) x.classList.add("correct"); });
          fb.innerHTML = `<span style="color:var(--fg-2)">— </span>${q.a}. ${q.why}`;
          bumpStreak(-1);
        }
        flashSplash(correct ? "good" : "bad");
        setTimeout(renderSubwayQuiz, 4000);
      };
      opts.appendChild(b);
    });
  }

  // ──────────────── BASICS ────────────────
  function initBasics() {
    setLabels(true);
    setZoomBounds(10, 18);
    map.setView([40.758, -73.975], 12);
    window.LANDMARKS.slice(0, 30).forEach((l) => {
      const m = L.marker([l.lat, l.lng], { icon: pinIcon(l.kind), opacity: .55 });
      m.bindPopup(`<strong>${l.name}</strong>${l.blurb || ""}`);
      m.addTo(map);
      State.markers.push(m);
    });
    const host = document.getElementById("basics-cards");
    host.innerHTML = "";
    window.BASICS.forEach((b) => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="front">
          <h4>${b.q}</h4>
          <p>Tap to reveal</p>
        </div>
        <div class="back">${b.a}</div>
      `;
      card.onclick = () => card.classList.toggle("flipped");
      host.appendChild(card);
    });
  }

  // ──────────────── Footer ticker ────────────────
  (function ticker() {
    const phrases = [
      "Rad maps for rad New Yorkers.",
      "It's HOW-stun, not Houston.",
      "The G never enters Manhattan.",
      "Stand right, walk left.",
      "There are five boroughs.",
      "The Bronx — with the article.",
      "472 stations and counting.",
      "Avenue addresses divide at 5th.",
      "The bodega cat is non-negotiable.",
      "Broadway predates the grid.",
      "Always tip the doorman in December.",
    ];
    const track = document.getElementById("ticker-track");
    const make = () => phrases.map((p) => `<span>${p}</span><span class="dot"></span>`).join("");
    track.innerHTML = make() + make();   // duplicate for seamless loop
  })();

  // ──────────────── Kickoff ────────────────
  setMode("explore");
})();
