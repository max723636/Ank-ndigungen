const { LavalinkManager: LavalinkClientManager } = require("lavalink-client");
const PublicNodeProvider = require("./PublicNodeProvider");
const config = require("../config");

let _lavalink = null;
let _publicNodeProvider = null;
let _reconnectAttempts = 0;
let _isReconnecting = false;
let _healthCheckInterval = null;

// ─── Node-Konfiguration holen (eigener Server ODER live öffentliche Liste) ──
async function getInitialNodes() {
  if (config.LAVALINK_HOST) {
    console.log(`[Lavalink] Eigener Node: ${config.LAVALINK_HOST}`);
    return { mode: "local", nodes: [{
      host: config.LAVALINK_HOST, port: config.LAVALINK_PORT,
      authorization: config.LAVALINK_PASSWORD, id: "main-node",
    }], provider: null };
  }

  console.log("[Lavalink] Kein eigener Server konfiguriert, lade öffentliche Nodes (live)...");
  const provider = new PublicNodeProvider();
  const ok = await provider.fetchNodes();
  if (!ok || !provider.hasNodes()) {
    throw new Error("Konnte keine öffentlichen Lavalink-Nodes laden");
  }
  provider.startAutoRefresh();
  const node = provider.getNextNode();
  console.log(`[Lavalink] Node gewählt: ${node.secure ? "wss" : "ws"}://${node.host}:${node.port}`);
  return { mode: "public", nodes: [node], provider };
}

// ─── Initialisierung ────────────────────────────────────────────────
async function initLavalink(client) {
  const { mode, nodes, provider } = await getInitialNodes();
  _publicNodeProvider = provider;

  _lavalink = new LavalinkClientManager({
    nodes,
    sendToShard: (guildId, payload) => {
      const guild = client.guilds.cache.get(guildId);
      if (guild) guild.shard.send(payload);
    },
    autoSkip: true,
    playerOptions: {
      clientBasedPositionUpdateInterval: 1000,
      defaultSearchPlatform: "ytmsearch",
      onEmptyQueue: {
        // Kein destroyAfterMs hier - wir steuern das Verlassen selbst
        // manuell im queueEnd-Handler, damit der 24/7-Modus (/247)
        // das automatische Verlassen unterdrücken kann.
        autoPlayFunction: async (player) => {
          if (!player._autoplay) return;
          try {
            const last = player._currentSong;
            if (!last) return;
            const res = await player.search(
              { query: `${last.title} mix`, source: "ytmsearch" },
              { username: "Autoplay" }
            );
            if (res?.tracks?.length) {
              const fresh = res.tracks.find(t => t.info.uri !== last.url);
              if (fresh) await player.queue.add(fresh);
            }
          } catch (err) { console.error("[Autoplay]", err.message); }
        },
      },
    },
  });

  _lavalink.nodeManager.on("connect", (node) => {
    console.log(`[Lavalink] ✅ Node "${node.id}" verbunden`);
    _reconnectAttempts = 0;
    _isReconnecting = false;
  });

  _lavalink.nodeManager.on("disconnect", (node, reason) => {
    const reasonText = reason?.reason || "Unbekannt";
    console.warn(`[Lavalink] ⚠️  Node getrennt: ${reasonText}`);
    if (reasonText !== "destroy") {
      setTimeout(() => _attemptReconnect(client), 3000);
    }
  });

  _lavalink.nodeManager.on("error", (node, err) => {
    console.error(`[Lavalink] ❌ Node-Fehler: ${err.message}`);
  });

  // ─── Track Events → unsere Embeds/Buttons ─────────────────────────
  _lavalink.on("trackStart", async (player, track) => {
    // Falls ein "Verlassen wegen Inaktivität"-Timer läuft: abbrechen,
    // da ja gerade wieder etwas spielt.
    _clearLeaveTimer(player);

    const { buildNowPlayingEmbed, buildPlayerButtons } = require("./EmbedBuilder");
    const ch = client.channels.cache.get(player.textChannelId);
    if (!ch) return;

    if (player._npMsgId) {
      ch.messages.fetch(player._npMsgId).then(m => m.delete()).catch(() => {});
      player._npMsgId = null;
    }

    const song = _trackToSong(track);
    player._currentSong = song;
    const wrap = _wrapPlayer(player, client);
    const msg = await ch.send({
      embeds:     [buildNowPlayingEmbed(song, wrap)],
      components: buildPlayerButtons(wrap),
    }).catch(() => null);
    if (msg) player._npMsgId = msg.id;
  });

  _lavalink.on("trackEnd", (player, track) => {
    player._history = player._history || [];
    player._history.push(_trackToSong(track));
    if (player._history.length > 20) player._history.shift();
  });

  _lavalink.on("queueEnd", (player) => {
    const ch = client.channels.cache.get(player.textChannelId);
    ch?.send("✅ Queue beendet!").catch(() => {});

    // Eigener Verlassen-Timer statt der eingebauten destroyAfterMs-Option,
    // damit /247 (Dauerbetrieb) das automatische Verlassen unterdrücken kann.
    if (player._stay247) return;
    _clearLeaveTimer(player);
    player._leaveTimer = setTimeout(() => {
      if (!player.playing && !player.paused) {
        ch?.send("👋 Inaktiv – verlasse den Channel.").catch(() => {});
        player.destroy();
      }
    }, config.QUEUE_EMPTY_TIMEOUT);
  });

  _lavalink.on("trackError", (player, track, payload) => {
    console.error("[Track Error]", payload?.exception?.message || "Unbekannt");
  });

  // ─── Leerer Voice-Channel: verlassen, außer 24/7 ist aktiv ────────
  client.on("voiceStateUpdate", (oldState, newState) => {
    const guildId = oldState.guild.id;
    const player  = _lavalink.getPlayer(guildId);
    if (!player || !player.voiceChannelId) return;

    const voiceChannel = oldState.guild.channels.cache.get(player.voiceChannelId);
    if (!voiceChannel) return;

    const humanCount = voiceChannel.members.filter(m => !m.user.bot).size;

    if (humanCount === 0) {
      if (player._stay247) return; // Dauerbetrieb: einfach bleiben
      _clearEmptyChannelTimer(player);
      player._emptyChannelTimer = setTimeout(() => {
        const stillEmpty = voiceChannel.members.filter(m => !m.user.bot).size === 0;
        if (stillEmpty) {
          const ch = client.channels.cache.get(player.textChannelId);
          ch?.send("👋 Niemand mehr im Channel – verlasse.").catch(() => {});
          player.destroy();
        }
      }, config.QUEUE_EMPTY_TIMEOUT);
    } else {
      _clearEmptyChannelTimer(player);
    }
  });

  // ─── ENTSCHEIDEND: init() startet die eigentliche Verbindung ───────
  // Ohne diesen Aufruf legt lavalink-client die Nodes nur als Konfiguration
  // an, kontaktiert sie aber NIE tatsächlich (kein WebSocket-Handshake).
  // Das war der Hauptbug - kein Node hätte je antworten können.
  await _lavalink.init({ ...client.user });
  console.log("[Lavalink] init() abgeschlossen - Verbindungsversuch läuft");

  // Health-Check als Sicherheitsnetz für spätere Verbindungsabbrüche
  _startHealthCheck(client);

  // Schneller erster Check falls der initiale Node nicht antwortet
  setTimeout(() => {
    if (!isNodeConnected()) {
      console.warn("[Lavalink] Node antwortet nicht, rotiere zum nächsten...");
      _attemptReconnect(client);
    }
  }, 15000);

  return _lavalink;
}

// ─── Reconnect-Logik (1:1 BeatDock: wartet wirklich auf Bestätigung) ──────
const CONNECTION_TIMEOUT_MS = 15000;
let _cooldownUntil = 0;

async function _attemptReconnect(client) {
  if (_isReconnecting) return;
  if (_cooldownUntil > Date.now()) return;
  _isReconnecting = true;

  let keepLock = false;

  try {
    const mainNode = _lavalink.nodeManager.nodes.get("main-node");
    if (mainNode?.connected) { _isReconnecting = false; return; }
    if (mainNode) { try { await mainNode.destroy(); } catch {} }

    let nodeConfig;
    if (_publicNodeProvider) {
      nodeConfig = _publicNodeProvider.getNextNode();
      if (!nodeConfig) {
        await _publicNodeProvider.fetchNodes();
        nodeConfig = _publicNodeProvider.getNextNode();
      }
      if (!nodeConfig) throw new Error("Keine öffentlichen Nodes verfügbar");
      console.log(`[Lavalink] Rotiere zu Node: ${nodeConfig.host}:${nodeConfig.port}`);
    } else {
      nodeConfig = { host: config.LAVALINK_HOST, port: config.LAVALINK_PORT, authorization: config.LAVALINK_PASSWORD, id: "main-node" };
    }

    console.log(`[Lavalink] Reconnect Versuch ${_reconnectAttempts + 1}/10...`);

    let newNode;
    try {
      newNode = _lavalink.nodeManager.createNode(nodeConfig);
    } catch (err) {
      throw new Error(`Node-Erstellung fehlgeschlagen: ${err.message}`);
    }
    if (!newNode) throw new Error("Keine Node-Instanz erhalten");

    // ─── ENTSCHEIDEND: wirklich auf Verbindung WARTEN statt sie anzunehmen ──
    // Vorher wurde createNode() aufgerufen und sofort "Erfolg" angenommen,
    // obwohl die WebSocket-Verbindung erst asynchron im Hintergrund läuft.
    // Dadurch zählte der Versuchszähler nie hoch ("Versuch 1/10" für immer).
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (typeof newNode.off === "function") {
          newNode.off("connect", onConnect);
          newNode.off("error", onError);
        }
        reject(new Error("Verbindungs-Timeout"));
      }, CONNECTION_TIMEOUT_MS);

      const onConnect = () => {
        clearTimeout(timeout);
        if (typeof newNode.off === "function") {
          newNode.off("connect", onConnect);
          newNode.off("error", onError);
        }
        resolve();
      };

      const onError = (err) => {
        clearTimeout(timeout);
        if (typeof newNode.off === "function") {
          newNode.off("connect", onConnect);
          newNode.off("error", onError);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      if (typeof newNode.once === "function") {
        newNode.once("connect", onConnect);
        newNode.once("error", onError);
      } else {
        // Fallback falls das Node-Objekt keine Event-Methoden hat
        setTimeout(() => {
          clearTimeout(timeout);
          if (newNode.connected) resolve();
          else reject(new Error("Node erstellt, aber nicht verbunden"));
        }, 2000);
      }
    });

    console.log(`[Lavalink] ✅ Reconnect erfolgreich!`);
    _reconnectAttempts = 0;
    _isReconnecting = false;

  } catch (err) {
    console.error("[Lavalink] Reconnect fehlgeschlagen:", err.message);
    _reconnectAttempts++;

    if (_reconnectAttempts >= 10) {
      console.error("[Lavalink] Max. Versuche erreicht, Pause für 5 Minuten...");
      _cooldownUntil = Date.now() + 5 * 60 * 1000;
      _isReconnecting = false;
      setTimeout(() => {
        _reconnectAttempts = 0;
        _isReconnecting = false;
        _attemptReconnect(client);
      }, 5 * 60 * 1000);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempts), 30000) + Math.random() * 1000;
    console.log(`[Lavalink] Nächster Versuch in ${Math.round(delay / 1000)}s...`);
    setTimeout(() => { _isReconnecting = false; _attemptReconnect(client); }, delay);
    keepLock = true;
  } finally {
    if (!keepLock && _reconnectAttempts === 0) _isReconnecting = false;
  }
}

function _startHealthCheck(client) {
  if (_healthCheckInterval) return; // nicht doppelt starten
  _healthCheckInterval = setInterval(() => {
    const mainNode = _lavalink.nodeManager.nodes.get("main-node");
    if (!mainNode?.connected) {
      console.warn("[Lavalink] Health-Check: Node nicht verbunden, reconnecte...");
      _attemptReconnect(client);
    }
  }, 30000);
}

function _clearLeaveTimer(player) {
  if (player._leaveTimer) { clearTimeout(player._leaveTimer); player._leaveTimer = null; }
}
function _clearEmptyChannelTimer(player) {
  if (player._emptyChannelTimer) { clearTimeout(player._emptyChannelTimer); player._emptyChannelTimer = null; }
}

// ─── Player erstellen/holen ─────────────────────────────────────────
async function getOrCreatePlayer(guildId, voiceChannel, textChannel, client) {
  let player = _lavalink.getPlayer(guildId);
  if (!player) {
    player = _lavalink.createPlayer({
      guildId: guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
      selfDeaf: true,
      volume: config.DEFAULT_VOLUME,
    });
    player._currentSong = null;
    player._npMsgId     = null;
    player._history     = [];
    player._autoplay    = config.AUTOPLAY_DEFAULT;
    player._stay247     = false;
  }
  if (!player.connected) player.connect();
  return _wrapPlayer(player, client);
}

function getPlayer(guildId, client) {
  const p = _lavalink?.getPlayer(guildId);
  return p ? _wrapPlayer(p, client) : null;
}

function getLavalink() { return _lavalink; }
function isNodeConnected() {
  const node = _lavalink?.nodeManager?.nodes?.get("main-node");
  return !!node?.connected;
}

// ─── Einheitlicher Wrapper (gleiche API wie vorher!) ───────────────
function _wrapPlayer(player, client) {
  return {
    get guildId()    { return player.guildId; },
    get current()    { return player._currentSong || null; },
    get songs()      { return player.queue.tracks.map(_trackToSong); },
    get history()    { return player._history || []; },
    get playing()    { return player.playing; },
    get paused()     { return player.paused; },
    get loop() {
      if (player.repeatMode === "track") return "song";
      if (player.repeatMode === "queue") return "queue";
      return "off";
    },
    set loop(v) {
      player.setRepeatMode(v === "song" ? "track" : v === "queue" ? "queue" : "off");
    },
    get shuffle()    { return player._shuffleOn ?? false; },
    set shuffle(v)   { player._shuffleOn = v; },
    get autoplay()   { return player._autoplay ?? false; },
    set autoplay(v)  { player._autoplay = v; },
    get stay247()    { return player._stay247 ?? false; },
    set stay247(v)   { player._stay247 = v; },
    get connection() { return player.connected ? {} : null; },
    get textChannel(){ return client?.channels.cache.get(player.textChannelId) || null; },
    set textChannel(ch){ if (ch?.id) player.textChannelId = ch.id; },

    getVolume()    { return player.volume; },
    setVolume(vol) { player.setVolume(Math.max(0, Math.min(150, vol))); },
    async seek(ms) { await player.seek(ms); },

    async pause()  { if (player.paused) return false; await player.pause();  return true; },
    async resume() { if (!player.paused) return false; await player.resume(); return true; },
    skip()  { player.skip(); },
    stop()  {
      player.queue.tracks.splice(0, player.queue.tracks.length);
      player.skip();
      player._currentSong = null;
      if (player._npMsgId && client) {
        client.channels.cache.get(player.textChannelId)
          ?.messages.fetch(player._npMsgId).then(m => m.delete()).catch(() => {});
        player._npMsgId = null;
      }
    },
    destroy()      { player.destroy(); },
    getSongCount() { return player.queue.tracks.length; },
    addTrack(t)    { player.queue.add(t); },
    shuffleQueue() { player.queue.shuffle(); },
    async play()   { if (!player.playing) await player.play(); },

    async updateNowPlaying() {
      if (!player._npMsgId || !player._currentSong) return;
      try {
        const ch  = client?.channels.cache.get(player.textChannelId);
        const msg = await ch?.messages.fetch(player._npMsgId).catch(() => null);
        if (!msg) return;
        const { buildNowPlayingEmbed, buildPlayerButtons } = require("./EmbedBuilder");
        const wrap = _wrapPlayer(player, client);
        await msg.edit({
          embeds:     [buildNowPlayingEmbed(player._currentSong, wrap)],
          components: buildPlayerButtons(wrap),
        }).catch(() => {});
      } catch {}
    },

    get _raw() { return player; },
  };
}

function _trackToSong(track) {
  if (!track?.info) return null;
  return {
    title:       track.info.title      || "Unbekannt",
    artist:      track.info.author     || "Unbekannt",
    duration:    track.info.length     ? Math.floor(track.info.length / 1000) : 0,
    url:         track.info.uri        || "",
    thumbnail:   track.info.artworkUrl || null,
    source:      track.info.sourceName || "youtube",
    requestedBy: track.requester?.username || track.requester || "Unbekannt",
  };
}

module.exports = {
  initLavalink, getOrCreatePlayer, getPlayer, getLavalink, isNodeConnected,
};
