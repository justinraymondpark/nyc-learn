/* NYC Compass — TCW-skinned map app for learning NYC.
 * Lives at /index.html. Zero build, no framework, no npm. */
(function () {
  "use strict";

  // ──────────────── Theme ────────────────
  const root = document.documentElement;
  const THEME_KEY = "nyc.theme";
  function getTheme() { return root.getAttribute("data-theme") || "dark"; }
  function setTheme(t) {
    root.setAttribute("data-theme", t);
    localStorage.setItem(THEME_KEY, t);
    document.getElementById("theme-toggle").textContent = (t === "dark" ? "Light" : "Dark");
    swapTileLayer(t);
  }
  // Restore saved theme (default dark — TCW canonical)
  setTheme(localStorage.getItem(THEME_KEY) || "dark");
  document.getElementById("theme-toggle").addEventListener("click", () => {
    setTheme(getTheme() === "dark" ? "light" : "dark");
  });

  // ──────────────── Map ────────────────
  const map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    minZoom: 10,
    maxZoom: 18,
  }).setView([40.758, -73.975], 12);

  let tileLayer = null;
  function swapTileLayer(theme) {
    if (tileLayer) map.removeLayer(tileLayer);
    const url = theme === "light"
      ? "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";
    tileLayer = L.tileLayer(url, {
      subdomains: "abcd",
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);

    // Labels layer on top — keeps streets readable
    if (window._labels) map.removeLayer(window._labels);
    const lblUrl = theme === "light"
      ? "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png";
    window._labels = L.tileLayer(lblUrl, { subdomains: "abcd", maxZoom: 19 }).addTo(map);
  }
  swapTileLayer(getTheme());

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
    place: { remaining: [], current: null, rounds: 0, totalMiss: 0, best: null },
    hood:  { current: null },
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
    document.getElementById("score-value").textContent = State.streak;
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
    clearMapLayers();
    if (mode === "explore") initExplore();
    if (mode === "place")   initPlaceQuiz();
    if (mode === "hood")    initHoodQuiz();
    if (mode === "subway")  initSubway();
    if (mode === "basics")  initBasics();
  }

  // ──────────────── EXPLORE ────────────────
  function initExplore() {
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

  // ──────────────── PLACE QUIZ ────────────────
  function initPlaceQuiz() {
    map.setView([40.740, -73.990], 11);
    if (State.place.remaining.length === 0) {
      State.place.remaining = shuffle(window.LANDMARKS.filter((l) => l.kind !== "neighborhood"));
    }
    document.getElementById("place-result").textContent = "";
    document.getElementById("place-result").className = "result";
    nextPlace();
    map.on("click", onPlaceGuess);
    document.getElementById("place-next").onclick = () => { clearPlaceOverlays(); nextPlace(); };
    document.getElementById("place-skip").onclick = () => {
      clearPlaceOverlays();
      const r = document.getElementById("place-result");
      r.innerHTML = `<span class="marker">—</span>Skipped.`;
      r.className = "result";
      nextPlace();
    };
  }
  function clearPlaceOverlays() {
    if (State.quizMarker)  { map.removeLayer(State.quizMarker);  State.quizMarker  = null; }
    if (State.truthMarker) { map.removeLayer(State.truthMarker); State.truthMarker = null; }
    if (State.pathLine)    { map.removeLayer(State.pathLine);    State.pathLine    = null; }
  }
  function nextPlace() {
    if (State.place.remaining.length === 0) {
      State.place.remaining = shuffle(window.LANDMARKS.filter((l) => l.kind !== "neighborhood"));
    }
    State.place.current = State.place.remaining.pop();
    document.getElementById("place-prompt").innerHTML = `
      <div class="ask">Click where this is</div>
      <div class="target">${State.place.current.name}<span class="editorial" style="font-family:var(--font-editorial);font-style:italic;font-weight:300;color:var(--fg-3)">.</span></div>
      <div class="meta">${State.place.current.kind}</div>
    `;
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

    const res = document.getElementById("place-result");
    let label = "Way off";
    if (d < 250)       { label = "Bullseye"; bumpStreak(+1); res.className = "result good"; }
    else if (d < 1500) { label = "Close";    bumpStreak(+1); res.className = "result good"; }
    else if (d < 5000) { label = "Right borough-ish"; res.className = "result"; }
    else               { label = "Way off";  bumpStreak(-1); res.className = "result bad"; }
    res.innerHTML = `<span class="marker">${fmtDistance(d)}</span>${label}.`;

    document.getElementById("place-rounds").textContent = State.place.rounds;
    document.getElementById("place-avg").textContent = fmtDistance(State.place.totalMiss / State.place.rounds);
    document.getElementById("place-best").textContent = fmtDistance(State.place.best);
  }

  // ──────────────── HOOD QUIZ ────────────────
  function initHoodQuiz() {
    map.setView([40.730, -73.980], 12);
    nextHood();
    document.getElementById("hood-next").onclick = nextHood;
  }
  function nextHood() {
    if (State.hoodLayer) { map.removeLayer(State.hoodLayer); State.hoodLayer = null; }
    document.getElementById("hood-result").textContent = "";
    document.getElementById("hood-result").className = "result";

    const pool = window.NEIGHBORHOODS;
    const target = pool[Math.floor(Math.random() * pool.length)];
    State.hood.current = target;

    State.hoodLayer = L.polygon(target.poly, {
      color: lineColor(), weight: 1.5,
      fillColor: lineColor(), fillOpacity: .12,
    }).addTo(map);
    map.fitBounds(State.hoodLayer.getBounds().pad(1.2));

    const others = shuffle(pool.filter((n) => n.name !== target.name)).slice(0, 3);
    const choices = shuffle([target, ...others]);
    const host = document.getElementById("hood-choices");
    host.innerHTML = "";
    choices.forEach((c) => {
      const btn = document.createElement("button");
      btn.textContent = c.name;
      btn.onclick = () => answerHood(btn, c, target);
      host.appendChild(btn);
    });
  }
  function answerHood(btn, choice, target) {
    document.querySelectorAll("#hood-choices button").forEach((b) => (b.disabled = true));
    const res = document.getElementById("hood-result");
    if (choice.name === target.name) {
      btn.classList.add("correct");
      res.innerHTML = `<span class="marker">↗</span>${target.name} — ${target.borough}.`;
      res.className = "result good";
      bumpStreak(+1);
    } else {
      btn.classList.add("wrong");
      document.querySelectorAll("#hood-choices button").forEach((b) => {
        if (b.textContent === target.name) b.classList.add("correct");
      });
      res.innerHTML = `<span class="marker">—</span>That was ${target.name} (${target.borough}).`;
      res.className = "result bad";
      bumpStreak(-1);
    }
  }

  // ──────────────── SUBWAY ────────────────
  function initSubway() {
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
        if (c === q.a) {
          b.classList.add("correct");
          fb.innerHTML = `<span style="color:var(--fg-1)">↗ </span>${q.why}`;
          bumpStreak(+1);
        } else {
          b.classList.add("wrong");
          opts.querySelectorAll("button").forEach((x) => { if (x.textContent === q.a) x.classList.add("correct"); });
          fb.innerHTML = `<span style="color:var(--fg-2)">— </span>${q.a}. ${q.why}`;
          bumpStreak(-1);
        }
        setTimeout(renderSubwayQuiz, 4000);
      };
      opts.appendChild(b);
    });
  }

  // ──────────────── BASICS ────────────────
  function initBasics() {
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
