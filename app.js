/* NYC Compass — single-page app that teaches NYC through a map. */
(function () {
  "use strict";

  // ---------- Map ----------
  const NYC_CENTER = [40.730610, -73.935242];
  const map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    minZoom: 10,
    maxZoom: 18,
  }).setView([40.758, -73.975], 12);

  // Dark-ish CartoDB tiles — matches the app's color scheme.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  // ---------- Shared state ----------
  const State = {
    mode: "explore",
    markers: [],           // explore-mode markers
    quizMarker: null,      // user's guess (place quiz)
    truthMarker: null,     // the correct answer (place quiz)
    pathLine: null,        // line between guess and truth
    hoodLayer: null,       // highlighted neighborhood polygon
    place: {
      remaining: [],       // landmarks left to ask
      current: null,
      rounds: 0,
      totalMiss: 0,
      best: null,          // best (smallest) miss in meters
    },
    hood: { current: null },
    streak: Number(localStorage.getItem("nyc.streak") || 0),
  };
  document.getElementById("score-value").textContent = State.streak;

  // ---------- Utilities ----------
  function pinIcon(kind) {
    return L.divIcon({
      className: "",
      html: `<div class="pin ${kind || ""}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  // Haversine in meters
  function distanceM(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const la1 = toRad(a[0]), la2 = toRad(b[0]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
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

  // ---------- Mode switching ----------
  const panels = {
    explore: document.getElementById("panel-explore"),
    place: document.getElementById("panel-place"),
    hood: document.getElementById("panel-hood"),
    subway: document.getElementById("panel-subway"),
    basics: document.getElementById("panel-basics"),
  };
  const modeLabel = {
    explore: "Streak",
    place: "Streak",
    hood: "Streak",
    subway: "Streak",
    basics: "Streak",
  };

  document.querySelectorAll(".mode").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  function setMode(mode) {
    State.mode = mode;
    document.querySelectorAll(".mode").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode)
    );
    Object.entries(panels).forEach(([k, el]) => el.classList.toggle("hidden", k !== mode));
    document.getElementById("score-label").textContent = modeLabel[mode];

    clearMapLayers();
    if (mode === "explore") initExplore();
    if (mode === "place")   initPlaceQuiz();
    if (mode === "hood")    initHoodQuiz();
    if (mode === "subway")  initSubway();
    if (mode === "basics")  initBasics();
  }

  // ---------- EXPLORE ----------
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
      m.bindPopup(`<strong>${l.name}</strong><br>${l.blurb}`, { maxWidth: 260 });
      m.on("click", () => showExploreDetails(l));
      m.addTo(map);
      State.markers.push(m);
    });
  }

  function showExploreDetails(l) {
    const el = document.getElementById("explore-details");
    el.innerHTML = `
      <div class="kind">${l.kind}</div>
      <h3 class="name">${l.name}</h3>
      <p>${l.blurb}</p>
    `;
  }

  // ---------- PLACE QUIZ ----------
  function initPlaceQuiz() {
    map.setView([40.740, -73.990], 11);
    if (State.place.remaining.length === 0) {
      // Only landmarks and museums for the place quiz — neighborhoods have their own mode.
      const pool = window.LANDMARKS.filter((l) => l.kind !== "neighborhood");
      State.place.remaining = shuffle(pool);
    }
    document.getElementById("place-result").textContent = "";
    document.getElementById("place-result").className = "result";
    nextPlace();

    map.on("click", onPlaceGuess);
    document.getElementById("place-next").onclick = () => {
      clearPlaceOverlays();
      nextPlace();
    };
    document.getElementById("place-skip").onclick = () => {
      clearPlaceOverlays();
      document.getElementById("place-result").textContent = "Skipped.";
      document.getElementById("place-result").className = "result";
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
      const pool = window.LANDMARKS.filter((l) => l.kind !== "neighborhood");
      State.place.remaining = shuffle(pool);
    }
    State.place.current = State.place.remaining.pop();
    const p = document.getElementById("place-prompt");
    p.innerHTML = `
      <div class="ask">Click where this is</div>
      <div class="target">${State.place.current.name}</div>
      <div class="hint">kind: ${State.place.current.kind}</div>
    `;
  }

  function onPlaceGuess(e) {
    if (!State.place.current || State.quizMarker) return; // one guess per round
    const guess = [e.latlng.lat, e.latlng.lng];
    const truth = [State.place.current.lat, State.place.current.lng];
    const d = distanceM(guess, truth);

    State.quizMarker = L.marker(guess, {
      icon: L.divIcon({ className: "", html: `<div class="guess-dot"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] }),
    }).addTo(map);
    State.truthMarker = L.marker(truth, {
      icon: L.divIcon({ className: "", html: `<div class="truth-dot"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
    }).bindPopup(`<strong>${State.place.current.name}</strong><br>${State.place.current.blurb}`).addTo(map);
    State.truthMarker.openPopup();
    State.pathLine = L.polyline([guess, truth], { color: "#ffb447", weight: 2, dashArray: "4 6", opacity: .8 }).addTo(map);
    map.fitBounds(State.pathLine.getBounds().pad(0.3));

    // Score
    State.place.rounds++;
    State.place.totalMiss += d;
    if (State.place.best == null || d < State.place.best) State.place.best = d;

    const res = document.getElementById("place-result");
    if (d < 250) {
      res.textContent = `Bullseye — ${fmtDistance(d)} off. ✶`;
      res.className = "result good";
      bumpStreak(+1);
    } else if (d < 1500) {
      res.textContent = `Close — ${fmtDistance(d)} off.`;
      res.className = "result good";
      bumpStreak(+1);
    } else if (d < 5000) {
      res.textContent = `Right borough-ish — ${fmtDistance(d)} off.`;
      res.className = "result";
    } else {
      res.textContent = `Way off — ${fmtDistance(d)} off.`;
      res.className = "result bad";
      bumpStreak(-1);
    }

    document.getElementById("place-rounds").textContent = State.place.rounds;
    document.getElementById("place-avg").textContent = fmtDistance(State.place.totalMiss / State.place.rounds);
    document.getElementById("place-best").textContent = fmtDistance(State.place.best);
  }

  // ---------- HOOD QUIZ ----------
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
      color: "#ffb447", weight: 2, fillColor: "#ffb447", fillOpacity: .25,
    }).addTo(map);
    map.fitBounds(State.hoodLayer.getBounds().pad(1.2));

    // Build 4-choice list: correct + 3 distractors from the same pool
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
    const buttons = document.querySelectorAll("#hood-choices button");
    buttons.forEach((b) => (b.disabled = true));
    const res = document.getElementById("hood-result");
    if (choice.name === target.name) {
      btn.classList.add("correct");
      res.textContent = `✓ ${target.name} — ${target.borough}`;
      res.className = "result good";
      bumpStreak(+1);
    } else {
      btn.classList.add("wrong");
      buttons.forEach((b) => { if (b.textContent === target.name) b.classList.add("correct"); });
      res.textContent = `✗ That's ${target.name} (${target.borough})`;
      res.className = "result bad";
      bumpStreak(-1);
    }
  }

  // ---------- SUBWAY ----------
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
      if (line.color === "#FCCC0A") b.style.color = "#000"; // yellow lines have black text
      b.onclick = () => {
        document.querySelectorAll(".bullet").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        renderSubwayDetail(line);
      };
      host.appendChild(b);
    });
  }

  function renderSubwayDetail(line) {
    const el = document.getElementById("subway-detail");
    el.innerHTML = `
      <div class="kind" style="color:${line.color}">${line.name}</div>
      <h3 class="name">The ${line.id} train</h3>
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
          fb.textContent = `✓ ${q.why}`;
          fb.style.color = "var(--good)";
          bumpStreak(+1);
        } else {
          b.classList.add("wrong");
          fb.textContent = `✗ Answer: ${q.a}. ${q.why}`;
          fb.style.color = "var(--bad)";
          bumpStreak(-1);
        }
        // Re-roll after a beat
        setTimeout(renderSubwayQuiz, 3500);
      };
      opts.appendChild(b);
    });
  }

  // ---------- BASICS ----------
  function initBasics() {
    map.setView([40.758, -73.975], 12);
    // Give the map a little visual context — drop explore pins lightly.
    window.LANDMARKS.slice(0, 30).forEach((l) => {
      const m = L.marker([l.lat, l.lng], { icon: pinIcon(l.kind), opacity: .55 });
      m.bindPopup(`<strong>${l.name}</strong>`);
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

  // ---------- Kickoff ----------
  setMode("explore");
})();
