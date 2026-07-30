(() => {
  "use strict";

  const SUPABASE_URL = "https://uftqqchwdksznxsjioat.supabase.co";
  const SUPABASE_KEY = "sb_publishable_b3D290QZUx-TwJHj7D_s-A_PzYdGNxw";
  const GROUP_KEY = "fairwash_group";
  const LOCAL_KEY = "fairwash_v6_local";
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  let group = null;
  let channel = null;
  let saveTimer = null;
  let saving = false;
  let saveAgain = false;
  let state = defaults();

  const $ = id => document.getElementById(id);

  function defaults() {
    return {
      participantCount: 2,
      names: ["Christoph", "Ramona", "Person 3", "Person 4", "Person 5"],
      factors: { amount: 2, fat: 2, difficulty: 2 },
      history: [],
      raffled: null,
      revision: 0
    };
  }

  function normalize(value) {
    const source = value && typeof value === "object" ? value : {};
    const fallback = defaults();
    const names = Array.isArray(source.names) ? source.names.map(String) : fallback.names.slice();
    while (names.length < 5) names.push(`Person ${names.length + 1}`);

    const count = Math.min(5, Math.max(2, Number(source.participantCount) || 2));
    const history = (Array.isArray(source.history) ? source.history : []).map(entry => ({
      person: Math.min(count - 1, Math.max(0, Number(entry.person ?? entry.washer) || 0)),
      amount: Math.min(3, Math.max(1, Number(entry.amount ?? entry.factors?.amount) || 1)),
      fat: Math.min(3, Math.max(1, Number(entry.fat ?? entry.factors?.fat) || 1)),
      difficulty: Math.min(3, Math.max(1, Number(entry.difficulty ?? entry.factors?.difficulty) || 1)),
      points: Number(entry.points ?? entry.value) || 3,
      createdAt: entry.createdAt || new Date().toISOString()
    }));

    return {
      participantCount: count,
      names: names.slice(0, 5),
      factors: {
        amount: Number(source.factors?.amount) || 2,
        fat: Number(source.factors?.fat) || 2,
        difficulty: Number(source.factors?.difficulty) || 2
      },
      history,
      raffled: Number.isInteger(source.raffled) ? source.raffled : null,
      revision: Number(source.revision) || 0
    };
  }

  function touchState() {
    state.revision = (Number(state.revision) || 0) + 1;
  }

  function toast(message) {
    const element = $("toast");
    element.textContent = message;
    element.className = "toast show";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = "toast"; }, 1900);
  }

  function tokenFrom(value) {
    const raw = String(value || "").trim();
    try { return new URL(raw).searchParams.get("group") || ""; }
    catch { return raw.replace(/^.*group=/, "").split(/[&#]/)[0]; }
  }

  async function ensureAuth() {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      const result = await db.auth.signInAnonymously();
      if (result.error) throw result.error;
    }
  }

  async function init() {
    try {
      await ensureAuth();
      $("bootStatus").textContent = "Bereit.";
      const token = new URL(location.href).searchParams.get("group") || localStorage.getItem(GROUP_KEY);
      if (token) await joinGroup(token, true);
    } catch (error) {
      $("bootStatus").textContent = `Verbindung fehlgeschlagen: ${error.message}`;
    }
  }

  async function createGroup() {
    const name = $("groupName").value.trim();
    if (!name) return toast("Bitte einen Gruppennamen eingeben.");
    try {
      await ensureAuth();
      $("createBtn").disabled = true;
      const result = await db.rpc("create_fairwash_group", { group_name: name, initial_state: state });
      if (result.error) throw result.error;
      openGroup(result.data[0]);
      toast("Gruppe erstellt.");
    } catch (error) {
      toast(`Erstellen fehlgeschlagen: ${error.message}`);
    } finally {
      $("createBtn").disabled = false;
    }
  }

  async function joinGroup(rawToken, silent = false) {
    const token = tokenFrom(rawToken);
    if (!token) {
      if (!silent) toast("Bitte Link oder Gruppencode eingeben.");
      return;
    }
    try {
      await ensureAuth();
      const result = await db.rpc("join_fairwash_group", { token });
      if (result.error) throw result.error;
      openGroup(result.data[0]);
      if (!silent) toast("Gruppe beigetreten.");
    } catch (error) {
      if (silent) {
        localStorage.removeItem(GROUP_KEY);
        $("bootStatus").textContent = "Gespeicherte Gruppe konnte nicht geöffnet werden.";
      } else {
        toast("Gruppe nicht gefunden oder Zugriff fehlgeschlagen.");
      }
    }
  }

  function openGroup(data) {
    group = data;
    state = normalize(data.state);
    localStorage.setItem(GROUP_KEY, data.invite_token);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
    history.replaceState(null, "", `${location.pathname}?group=${data.invite_token}`);
    $("landing").classList.add("hidden");
    $("mainApp").classList.remove("hidden");
    $("currentGroup").textContent = data.name;
    const link = `${location.origin}${location.pathname}?group=${data.invite_token}`;
    $("inviteLink").textContent = link;
    $("qrImage").src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(link)}`;
    subscribe();
    render(false);
  }

  function subscribe() {
    if (channel) db.removeChannel(channel);
    channel = db.channel(`fairwash-${group.group_id}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "fairwash_groups",
        filter: `id=eq.${group.group_id}`
      }, payload => {
        const incoming = normalize(payload.new.state);
        if (incoming.revision < state.revision) return;
        state = incoming;
        localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
        $("syncStatus").textContent = "Gerade aktualisiert";
        render(false);
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED") $("syncStatus").textContent = "Live verbunden";
      });
  }

  function queueSave() {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
    $("syncStatus").textContent = "Speichert …";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCloud, 200);
  }

  async function saveCloud() {
    if (!group) return;
    if (saving) {
      saveAgain = true;
      return;
    }
    saving = true;
    const snapshot = JSON.parse(JSON.stringify(state));
    const result = await db.from("fairwash_groups").update({ state: snapshot }).eq("id", group.group_id);
    saving = false;
    if (result.error) {
      $("syncStatus").textContent = "Speichern fehlgeschlagen";
      toast(`Cloud-Fehler: ${result.error.message}`);
    } else {
      $("syncStatus").textContent = "Synchronisiert";
    }
    if (saveAgain) {
      saveAgain = false;
      saveCloud();
    }
  }

  function totals() {
    const scores = Array(state.participantCount).fill(0);
    const counts = Array(state.participantCount).fill(0);
    state.history.forEach(entry => {
      const person = Number(entry.person);
      if (person >= 0 && person < scores.length) {
        scores[person] += Number(entry.points) || 0;
        counts[person] += 1;
      }
    });
    return { scores, counts };
  }

  function candidates() {
    const { scores } = totals();
    const minimum = Math.min(...scores);
    return scores.map((value, index) => value === minimum ? index : -1).filter(index => index >= 0);
  }

  function nextPerson() {
    const list = candidates();
    if (state.raffled !== null && list.includes(state.raffled)) return state.raffled;
    if (!state.history.length) return list[0];
    const last = Number(state.history[state.history.length - 1].person) || 0;
    for (let step = 1; step <= state.participantCount; step += 1) {
      const candidate = (last + step) % state.participantCount;
      if (list.includes(candidate)) return candidate;
    }
    return list[0];
  }

  function renderStats() {
    const values = state.history.map(entry => Number(entry.points) || 0);
    const sum = values.reduce((a, b) => a + b, 0);
    $("statCount").textContent = values.length;
    $("statAverage").textContent = (values.length ? sum / values.length : 0).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    $("statMax").textContent = values.length ? Math.max(...values) : 0;
  }

  function render(save = true) {
    const data = totals();
    const next = nextPerson();
    $("participantCount").value = state.participantCount;
    $("heroName").textContent = state.names[next];
    $("washValue").textContent = Number(state.factors.amount) + Number(state.factors.fat) + Number(state.factors.difficulty);

    const players = $("players");
    players.innerHTML = "";
    const maximum = Math.max(...data.scores);
    const minimum = Math.min(...data.scores);
    for (let index = 0; index < state.participantCount; index += 1) {
      const card = document.createElement("div");
      card.className = `player${index === next ? " active" : ""}${data.scores[index] === maximum && maximum > minimum ? " high" : ""}`;
      card.innerHTML = `<input class="name-input" aria-label="Name Person ${index + 1}"><div class="score">${data.scores[index]} Punkte</div><div class="count">${data.counts[index]} Abwasche</div><div class="badge">${index === next ? "Als Nächstes" : data.scores[index] === maximum && maximum > minimum ? "Meiste Punkte" : "Aktuell fair"}</div>`;
      const input = card.querySelector("input");
      input.value = state.names[index];
      input.onchange = () => {
        state.names[index] = input.value.trim() || `Person ${index + 1}`;
        touchState();
        render();
      };
      players.appendChild(card);
    }

    const spread = maximum - minimum;
    const lowNames = data.scores.map((value, index) => value === minimum ? state.names[index] : null).filter(Boolean);
    const fairness = $("fairness");
    if (spread <= 2) {
      fairness.className = "fairness green";
      fairness.textContent = "🟢 Alles fair 👍";
    } else if (spread <= 5) {
      fairness.className = "fairness yellow";
      fairness.textContent = `🟡 Leichter Vorteil für ${lowNames.join(", ")}`;
    } else {
      fairness.className = "fairness red";
      fairness.textContent = `🔴 ${lowNames.join(", ")} ${lowNames.length > 1 ? "sollten" : "sollte"} jetzt übernehmen.`;
    }

    const list = candidates();
    const drawButton = $("drawBtn");
    drawButton.classList.toggle("hidden", list.length <= 1);
    drawButton.textContent = `🎲 Zwischen ${list.length} Personen auslosen`;

    document.querySelectorAll(".choices").forEach(groupElement => {
      const factor = groupElement.dataset.factor;
      groupElement.querySelectorAll(".choice").forEach(button => {
        button.classList.toggle("selected", Number(button.dataset.value) === Number(state.factors[factor]));
      });
    });

    renderStats();
    renderHistory();
    if (save) queueSave();
  }

  function renderHistory() {
    const historyElement = $("history");
    historyElement.innerHTML = "";
    if (!state.history.length) {
      historyElement.innerHTML = '<div class="muted" style="text-align:center">Noch kein Abwasch eingetragen.</div>';
      return;
    }
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
      const entry = state.history[index];
      const row = document.createElement("div");
      row.className = "entry";
      row.innerHTML = `<div class="entry-top"><div><div class="entry-name"></div><div class="muted">M ${entry.amount} · F ${entry.fat} · S ${entry.difficulty}</div></div><div class="entry-points">+${entry.points}</div></div><div class="entry-actions"><button class="mini">Bearbeiten</button><button class="mini danger">Löschen</button></div>`;
      row.querySelector(".entry-name").textContent = state.names[entry.person] || `Person ${entry.person + 1}`;
      const buttons = row.querySelectorAll("button");
      buttons[0].onclick = () => {
        const value = prompt("Neue Punkte (3–9):", entry.points);
        if (value !== null && Number(value) >= 3 && Number(value) <= 9) {
          entry.points = Number(value);
          state.raffled = null;
          touchState();
          render();
          toast("Eintrag geändert.");
        }
      };
      buttons[1].onclick = () => {
        if (confirm("Eintrag löschen?")) {
          state.history.splice(index, 1);
          state.raffled = null;
          touchState();
          render();
          toast("Eintrag gelöscht.");
        }
      };
      historyElement.appendChild(row);
    }
  }

  document.querySelectorAll(".choice").forEach(button => {
    button.onclick = () => {
      state.factors[button.parentNode.dataset.factor] = Number(button.dataset.value);
      touchState();
      render();
    };
  });

  $("createBtn").onclick = createGroup;
  $("joinBtn").onclick = () => joinGroup($("joinCode").value);
  $("participantCount").onchange = function () {
    if (state.history.length && !confirm("Dabei wird der Verlauf gelöscht. Fortfahren?")) {
      this.value = state.participantCount;
      return;
    }
    state.participantCount = Number(this.value);
    state.history = [];
    state.raffled = null;
    touchState();
    render();
  };
  $("drawBtn").onclick = () => {
    const list = candidates();
    if (list.length <= 1) return;
    state.raffled = list[Math.floor(Math.random() * list.length)];
    touchState();
    render();
    toast(`${state.names[state.raffled]} wurde ausgelost.`);
  };
  $("addBtn").onclick = () => {
    const person = nextPerson();
    const amount = Number(state.factors.amount);
    const fat = Number(state.factors.fat);
    const difficulty = Number(state.factors.difficulty);
    state.history = state.history.concat({
      person,
      amount,
      fat,
      difficulty,
      points: amount + fat + difficulty,
      createdAt: new Date().toISOString()
    });
    state.raffled = null;
    touchState();
    render();
    toast("✅ Abwasch eingetragen.");
  };
  $("undoBtn").onclick = () => {
    if (!state.history.length) return toast("Kein Eintrag vorhanden.");
    state.history = state.history.slice(0, -1);
    state.raffled = null;
    touchState();
    render();
    toast("Letzter Eintrag entfernt.");
  };
  $("resetBtn").onclick = () => {
    if (!state.history.length) return toast("Der Verlauf ist bereits leer.");
    if (confirm("Wirklich alles löschen?")) {
      state.history = [];
      state.raffled = null;
      touchState();
      render();
      toast("Verlauf gelöscht.");
    }
  };
  $("shareToggle").onclick = () => $("shareBox").classList.toggle("hidden");
  $("copyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("inviteLink").textContent);
      toast("Link kopiert.");
    } catch {
      toast("Link bitte manuell kopieren.");
    }
  };
  $("leaveBtn").onclick = () => {
    localStorage.removeItem(GROUP_KEY);
    history.replaceState(null, "", location.pathname);
    location.reload();
  };

  init();
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
  }
})();