/*!
 * CanvasGames Shell — menus, game loop, input, sound and online sync shared by
 * every game. A game only describes its rules; the shell runs it in one of
 * four modes:
 *
 *   cpu    1 player vs computer
 *   local  2 players on one device
 *   host   online, this device runs the simulation and streams snapshots
 *   guest  online, this device sends input and renders the host's snapshots
 *
 * Game definition (all functions receive plain objects):
 *   id, title, width, height, players: [{name, color, side}, ...]
 *   init({mode})                       -> state
 *   step(state, inputs, dt, api)       mutate state; api.sfx(name)
 *   readInput(input)                   -> input object (see makeInput below)
 *   ai(state, playerIndex, dt)         -> input object for the CPU player
 *   winner(state)                      -> null | 0 | 1 | 'draw'
 *   render(ctx, state, view)           world drawing (flipped for P2 if flipP2)
 *   hud(ctx, state, view)              optional, never flipped
 *   snapshot(state) / applySnapshot(prevState, snap)   optional, online only
 *   interpolate(a, b, t)               optional, smooths guest rendering
 *   sounds: {name: [freq, seconds, wave, volume, slideToFreq]}
 *   controls: {cpu, local, online}     help text shown in the menu
 *   flipP2: true                       rotate the view 180° for player 2 online
 */
(function (global) {
  'use strict';

  var STEP = 1 / 60;
  var INTERP_DELAY_MS = 50;
  var TIMEOUT_MS = 10000;

  var CSS = [
    '.cg-root{position:relative;width:100%;height:100%;min-height:240px;overflow:hidden;background:#05060d;color:#e8ecff;',
    'font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;outline:none;user-select:none;-webkit-user-select:none;display:flex;align-items:center;justify-content:center}',
    '.cg-root canvas{display:block;touch-action:none;border-radius:6px;box-shadow:0 0 40px rgba(80,140,255,.15)}',
    '.cg-bar{position:absolute;top:8px;right:8px;display:flex;gap:6px;align-items:center;z-index:3}',
    '.cg-bar span{font-size:12px;opacity:.75;padding:0 4px;white-space:nowrap}',
    '.cg-icon{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:inherit;border-radius:6px;width:32px;height:32px;cursor:pointer;font-size:15px;padding:0}',
    '.cg-icon:hover{background:rgba(255,255,255,.16)}',
    '.cg-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,4,10,.72);z-index:2;padding:16px;box-sizing:border-box;overflow:auto}',
    '.cg-overlay[hidden]{display:none}',
    '.cg-card{background:#0d1022;border:1px solid rgba(120,150,255,.25);border-radius:14px;padding:22px;width:100%;max-width:420px;box-sizing:border-box;text-align:center;box-shadow:0 10px 50px rgba(0,0,0,.5);margin:auto}',
    '.cg-card h1{margin:0 0 4px;font-size:28px;letter-spacing:.04em;background:linear-gradient(90deg,#4cf,#a6f,#f5a);-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.cg-card h2{margin:0 0 10px;font-size:20px}',
    '.cg-card p{margin:8px 0;opacity:.85}',
    '.cg-card small{display:block;opacity:.6;margin-top:10px;font-size:12px;white-space:pre-line}',
    '.cg-btn{display:block;width:100%;margin:8px 0;padding:12px 14px;border-radius:10px;border:1px solid rgba(120,160,255,.35);background:linear-gradient(180deg,#1d2752,#141a38);color:#fff;font:inherit;font-weight:600;cursor:pointer}',
    '.cg-btn:hover{border-color:#6af;background:linear-gradient(180deg,#26346c,#18204a)}',
    '.cg-btn:disabled{opacity:.5;cursor:default}',
    '.cg-btn.cg-ghost{background:transparent;font-weight:500;border-color:rgba(255,255,255,.15)}',
    '.cg-row{display:flex;gap:8px;align-items:stretch}.cg-row>*{flex:1}.cg-row .cg-btn{margin:8px 0}',
    '.cg-input{width:100%;box-sizing:border-box;padding:11px 12px;margin:8px 0;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:#060814;color:#fff;font:inherit}',
    'textarea.cg-input{height:84px;resize:vertical;font:12px/1.3 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;user-select:text;-webkit-user-select:text}',
    '.cg-code{font:700 30px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.2em;margin:6px 0;color:#7df}',
    '.cg-link{background:none;border:0;color:#8af;text-decoration:underline;cursor:pointer;font:inherit;font-size:13px;margin-top:6px}',
    '.cg-err{color:#ff7a8a;font-size:13px;min-height:1em}',
    '.cg-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#6cf;border-radius:50%;animation:cg-spin 1s linear infinite;vertical-align:-2px;margin-right:6px}',
    '@keyframes cg-spin{to{transform:rotate(360deg)}}',
    '.cg-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:rgba(13,16,34,.92);border:1px solid rgba(120,150,255,.3);padding:8px 14px;border-radius:8px;font-size:13px;z-index:3;pointer-events:none;transition:opacity .4s}'
  ].join('');

  var KEYMAP = {
    p1: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], fire: ['Space', 'KeyF'] },
    p2: { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], fire: ['Enter', 'NumpadEnter', 'Slash', 'Numpad0', 'ShiftRight'] }
  };
  KEYMAP.any = {};
  ['up', 'down', 'left', 'right', 'fire'].forEach(function (k) {
    KEYMAP.any[k] = KEYMAP.p1[k].concat(KEYMAP.p2[k], ['Swipe' + k.charAt(0).toUpperCase() + k.slice(1)]);
  });
  var GAME_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'onclick') e.addEventListener('click', attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // ---------------------------------------------------------------------------
  // Sound: tiny WebAudio synth, so games need no audio files.
  // ---------------------------------------------------------------------------
  function Sound(defs) {
    this.defs = defs || {};
    this.muted = storageGet('cg-muted') === '1';
    this.ctx = null;
  }
  Sound.prototype.unlock = function () {
    if (!this.ctx) {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  };
  Sound.prototype.play = function (name) {
    var d = this.defs[name];
    if (!d || this.muted || !this.ctx) return;
    var c = this.ctx, t = c.currentTime;
    var o = c.createOscillator(), g = c.createGain();
    o.type = d[2] || 'square';
    o.frequency.setValueAtTime(d[0], t);
    if (d[4]) o.frequency.exponentialRampToValueAtTime(d[4], t + d[1]);
    g.gain.setValueAtTime(d[3] || 0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d[1]);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + d[1] + 0.02);
  };

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------
  function Shell(def, mount) {
    this.def = def;
    this.mode = null;
    this.phase = 'menu'; // menu | countdown | play | over
    this.state = null;
    this.conn = null;
    this.pending = null; // pending connection attempt (cancel-able)
    this.sound = new Sound(def.sounds);
    this.keys = new Set();
    this.pressed = [];
    this.pointers = new Map();
    this.remoteInput = null;
    this.fxQueue = [];
    this.snaps = [];
    this.countdown = 0;
    this.result = null;
    this.again = [false, false];
    this.pingMs = null;
    this.lastMsgAt = 0;
    this._build(mount);
    this._bindInput();
    this._loop = this._loop.bind(this);
    this.last = performance.now();
    this.acc = 0;
    requestAnimationFrame(this._loop);

    var m = /[#&]join=([a-z0-9]+)/i.exec(location.hash);
    if (m) this._joinRoom(m[1].toLowerCase());
    else this.showMenu();
  }

  Shell.prototype._build = function (mount) {
    if (!document.getElementById('cg-style')) {
      document.head.appendChild(el('style', { id: 'cg-style' })).textContent = CSS;
    }
    var self = this;
    this.root = el('div', { 'class': 'cg-root', tabindex: '0' });
    this.canvas = el('canvas', { 'aria-label': this.def.title });
    this.ctx = this.canvas.getContext('2d');
    this.overlay = el('div', { 'class': 'cg-overlay' });
    this.statusEl = el('span');
    this.muteBtn = el('button', { 'class': 'cg-icon', title: 'Sound on/off', onclick: function () {
      self.sound.muted = !self.sound.muted;
      storageSet('cg-muted', self.sound.muted ? '1' : '0');
      self._syncMute();
      self.root.focus();
    } });
    this.menuBtn = el('button', { 'class': 'cg-icon', title: 'Leave game', text: '✕', onclick: function () { self.leave(); } });
    this.bar = el('div', { 'class': 'cg-bar' }, [this.statusEl, this.muteBtn, this.menuBtn]);
    this.toastEl = el('div', { 'class': 'cg-toast' });
    this.toastEl.style.opacity = '0';
    this.root.appendChild(this.canvas);
    this.root.appendChild(this.overlay);
    this.root.appendChild(this.bar);
    this.root.appendChild(this.toastEl);
    mount.appendChild(this.root);
    this._syncMute();
    this._fit();
    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self._fit(); });
      this._ro.observe(this.root);
    }
    this._listen('resize', function () { self._fit(); });
  };

  Shell.prototype._syncMute = function () {
    this.muteBtn.textContent = this.sound.muted ? '🔇' : '🔊';
  };

  Shell.prototype._fit = function () {
    var W = this.def.width, H = this.def.height;
    var rw = this.root.clientWidth || W, rh = this.root.clientHeight || H;
    var scale = Math.max(0.1, Math.min(rw / W, rh / H));
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    this.scale = scale;
    this.dpr = dpr;
    this.canvas.style.width = Math.floor(W * scale) + 'px';
    this.canvas.style.height = Math.floor(H * scale) + 'px';
    this.canvas.width = Math.floor(W * scale * dpr);
    this.canvas.height = Math.floor(H * scale * dpr);
  };

  // ---- input ---------------------------------------------------------------
  Shell.prototype._bindInput = function () {
    var self = this;
    this._listen('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (self.phase !== 'menu' && GAME_KEYS.indexOf(e.code) >= 0) e.preventDefault();
      if (!e.repeat) self.pressed.push(e.code);
      self.keys.add(e.code);
      self.sound.unlock();
    });
    this._listen('keyup', function (e) { self.keys.delete(e.code); });
    this._listen('blur', function () { self.keys.clear(); });

    var c = this.canvas;
    function toGame(e) {
      var r = c.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / r.width * self.def.width,
        y: (e.clientY - r.top) / r.height * self.def.height
      };
    }
    c.addEventListener('pointerdown', function (e) {
      self.sound.unlock();
      self.root.focus();
      var p = toGame(e);
      self.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, ax: p.x, ay: p.y, tap: true });
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic */ }
      e.preventDefault();
    });
    c.addEventListener('pointermove', function (e) {
      var ptr = self.pointers.get(e.pointerId);
      if (!ptr) {
        // Mouse hover still steers pointer-driven games (paddles, mallets).
        if (e.pointerType === 'mouse') {
          var h = toGame(e);
          self.hover = { x: h.x, y: h.y };
        }
        return;
      }
      var p = toGame(e);
      ptr.x = p.x; ptr.y = p.y;
      // Swipe gestures (used by Tron): emit a swipe whenever the finger has
      // travelled far enough from the last anchor, so turns feel immediate.
      var dx = p.x - ptr.ax, dy = p.y - ptr.ay;
      var min = 28 / self.scale;
      if (dx * dx + dy * dy > min * min) {
        var dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'SwipeRight' : 'SwipeLeft') : (dy > 0 ? 'SwipeDown' : 'SwipeUp');
        self.pressed.push(dir);
        ptr.ax = p.x; ptr.ay = p.y; ptr.tap = false;
      }
    });
    function up(e) { self.pointers.delete(e.pointerId); }
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') self.hover = null; });
  };

  // Build the input helper handed to def.readInput for one player.
  Shell.prototype._makeInput = function (scheme, player, flip) {
    var self = this, map = KEYMAP[scheme];
    var W = this.def.width, H = this.def.height;
    var tf = function (p) { return flip ? { x: W - p.x, y: H - p.y, sx: W - p.sx, sy: H - p.sy } : { x: p.x, y: p.y, sx: p.sx, sy: p.sy }; };
    var pointers = [];
    this.pointers.forEach(function (p) { pointers.push(tf(p)); });
    if (!pointers.length && this.hover && this.def.mouseHover) pointers.push(tf({ x: this.hover.x, y: this.hover.y, sx: this.hover.x, sy: this.hover.y }));
    var pressed = this.pressed;
    return {
      scheme: scheme,
      player: player,
      mode: this.mode,
      pointers: pointers,
      held: function (name) {
        var codes = map[name];
        for (var i = 0; i < codes.length; i++) if (self.keys.has(codes[i])) return true;
        return false;
      },
      // Keys pressed since the previous frame, in order, as action names.
      taps: function () {
        var out = [];
        pressed.forEach(function (code) {
          for (var name in map) if (map[name].indexOf(code) >= 0) out.push(name);
        });
        return out;
      }
    };
  };

  Shell.prototype._localInputs = function () {
    var d = this.def, m = this.mode, inputs;
    var flip = !!(d.flipP2 && m === 'guest');
    if (m === 'cpu') {
      inputs = [d.readInput(this._makeInput('any', 0, false)), null];
    } else if (m === 'local') {
      inputs = [d.readInput(this._makeInput('p1', 0, false)), d.readInput(this._makeInput('p2', 1, false))];
    } else if (m === 'host') {
      inputs = [d.readInput(this._makeInput('any', 0, false)), this.remoteInput];
    } else {
      inputs = [null, d.readInput(this._makeInput('any', 1, flip))];
    }
    this.pressed.length = 0;
    return inputs;
  };

  // ---- loop ----------------------------------------------------------------
  Shell.prototype._listen = function (type, fn) {
    (this._listeners || (this._listeners = [])).push([type, fn]);
    global.addEventListener(type, fn);
  };

  // Remove the game from the page (for sites that switch games in place).
  Shell.prototype.destroy = function () {
    if (this.destroyed) return;
    this.leave();
    this.destroyed = true;
    (this._listeners || []).forEach(function (l) { global.removeEventListener(l[0], l[1]); });
    if (this._ro) this._ro.disconnect();
    this.root.remove();
  };

  Shell.prototype._loop = function (now) {
    if (this.destroyed) return;
    requestAnimationFrame(this._loop);
    var dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    if (this.state && this.phase !== 'menu') {
      var inputs = this._localInputs();
      if (this.mode === 'guest') {
        this._sendGuestInput(inputs[1], now);
      } else {
        this.acc += dt;
        while (this.acc >= STEP) {
          this.acc -= STEP;
          this._tick(inputs);
        }
      }
    } else {
      this.pressed.length = 0;
    }

    if (this.conn && now - this.lastMsgAt > TIMEOUT_MS) {
      this._disconnected('Connection timed out');
    }
    this._render(now);
  };

  Shell.prototype._tick = function (inputs) {
    var d = this.def, self = this;
    if (this.phase === 'countdown') {
      this.countdown -= STEP;
      if (this.countdown <= 0) { this.phase = 'play'; this._sfx('go'); }
    } else if (this.phase === 'play') {
      if (this.mode === 'cpu') inputs[1] = d.ai(this.state, 1, STEP);
      d.step(this.state, inputs, STEP, { sfx: function (n) { self._sfx(n); }, mode: this.mode });
      var w = d.winner(this.state);
      if (w !== null && w !== undefined) this._finish(w);
    }
    if (this.mode === 'host') {
      this._sinceSend = (this._sinceSend || 0) + 1;
      if (this._sinceSend >= (d.sendEvery || 1)) {
        this._sinceSend = 0;
        this._sendSnapshot();
      }
    }
  };

  Shell.prototype._sfx = function (name) {
    this.sound.play(name);
    if (this.mode === 'host') this.fxQueue.push(name);
  };

  Shell.prototype._render = function (now) {
    var d = this.def, ctx = this.ctx, k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, d.width, d.height);
    var state = this.state;
    if (this.mode === 'guest' && d.interpolate && this.snaps.length > 1) {
      state = this._interpolated(now);
    }
    if (!state) state = this._demoState || (this._demoState = d.init({ mode: 'cpu' }));
    var me = this.mode === 'guest' ? 1 : 0;
    var flip = !!(d.flipP2 && this.mode === 'guest');
    var view = { me: me, mode: this.mode, flip: flip, phase: this.phase, players: d.players, now: now };
    ctx.save();
    if (flip) {
      ctx.translate(d.width, d.height);
      ctx.rotate(Math.PI);
    }
    d.render(ctx, state, view);
    ctx.restore();
    if (d.hud) { ctx.save(); d.hud(ctx, state, view); ctx.restore(); }
    if (this.phase === 'countdown') {
      var n = Math.ceil(this.countdown);
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.font = '700 ' + Math.round(d.height / 4) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#6af';
      ctx.shadowBlur = 30;
      ctx.fillText(n > 0 ? String(n) : 'GO', d.width / 2, d.height / 2);
      ctx.restore();
    }
  };

  Shell.prototype._interpolated = function (now) {
    var renderT = now - INTERP_DELAY_MS, s = this.snaps;
    if (renderT >= s[s.length - 1].t) return s[s.length - 1].s;
    for (var i = s.length - 1; i > 0; i--) {
      var a = s[i - 1], b = s[i];
      if (a.t <= renderT) return this.def.interpolate(a.s, b.s, (renderT - a.t) / Math.max(1, b.t - a.t));
    }
    return s[0].s;
  };

  // ---- networking ----------------------------------------------------------
  Shell.prototype._sendSnapshot = function () {
    var d = this.def;
    var snap = d.snapshot ? d.snapshot(this.state) : this.state;
    this.conn.send({
      t: 's', d: snap, fx: this.fxQueue.length ? this.fxQueue : undefined,
      ph: this.phase, cd: Math.round(this.countdown * 100) / 100,
      w: this.result, a: this.again
    });
    this.fxQueue = [];
  };

  Shell.prototype._sendGuestInput = function (inp, now) {
    var str = JSON.stringify(inp);
    if (str !== this._lastInput || now - (this._lastInputAt || 0) > 100) {
      this._lastInput = str;
      this._lastInputAt = now;
      this.conn.send({ t: 'i', d: inp });
    }
  };

  Shell.prototype._onMessage = function (m) {
    if (!m || typeof m !== 'object') return;
    var self = this, d = this.def;
    this.lastMsgAt = performance.now();
    switch (m.t) {
      case 's': // host -> guest snapshot
        if (this.mode !== 'guest') return;
        var prev = this.state;
        this.state = d.applySnapshot ? d.applySnapshot(prev, m.d) : m.d;
        var t = performance.now();
        this.snaps.push({ t: t, s: this.state });
        while (this.snaps.length > 2 && this.snaps[0].t < t - 1000) this.snaps.shift();
        if (m.fx) m.fx.forEach(function (n) { self.sound.play(n); });
        var wasPhase = this.phase;
        this.phase = m.ph;
        this.countdown = m.cd;
        this.again = m.a || [false, false];
        if (m.ph === 'over' && wasPhase !== 'over') { this.result = m.w; this._showOver(); }
        else if (m.ph === 'over') this._updateOver();
        else if (m.ph !== 'over' && wasPhase === 'over') this._hideOverlay();
        break;
      case 'i': // guest -> host input
        if (this.mode === 'host') this.remoteInput = m.d;
        break;
      case 'again':
        if (this.mode === 'host' && this.phase === 'over') {
          this.again[1] = true;
          this._maybeRestart();
        }
        break;
      case 'p':
        this.conn.send({ t: 'q', ts: m.ts });
        break;
      case 'q':
        this.pingMs = Math.round(performance.now() - m.ts);
        this._status();
        break;
      case 'bye':
        this._disconnected('Opponent left the game');
        break;
    }
  };

  Shell.prototype._attach = function (conn) {
    var self = this;
    this.pending = null;
    this.conn = conn;
    this.lastMsgAt = performance.now();
    conn.onmessage = function (m) { self._onMessage(m); };
    conn.onclose = function (why) { self._disconnected(why); };
    this._pingTimer = setInterval(function () {
      if (self.conn) self.conn.send({ t: 'p', ts: performance.now() });
    }, 1000);
    var role = conn.role;
    this._start(role);
    var p = this.def.players[role === 'host' ? 0 : 1];
    this.toast('Connected! You are ' + p.name + (p.side ? ' (' + p.side + ')' : ''));
    if (location.hash) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sandboxed */ }
    }
  };

  Shell.prototype._disconnected = function (why) {
    if (!this.conn) return;
    var c = this.conn;
    this.conn = null;
    clearInterval(this._pingTimer);
    c.onclose = null;
    c.close();
    this.state = null;
    this.phase = 'menu';
    this.mode = null;
    this._status();
    var self = this;
    this._card([
      el('h2', { text: 'Disconnected' }),
      el('p', { text: why || 'The connection to your opponent was lost.' }),
      el('button', { 'class': 'cg-btn', text: 'Back to menu', onclick: function () { self.showMenu(); } })
    ]);
  };

  // ---- game flow -----------------------------------------------------------
  Shell.prototype._start = function (mode) {
    this.mode = mode;
    this.remoteInput = null;
    this.snaps = [];
    this.result = null;
    this.again = [false, false];
    this.acc = 0;
    this._hideOverlay();
    this.root.focus();
    if (mode !== 'guest') {
      this.state = this.def.init({ mode: mode });
      this.phase = 'countdown';
      this.countdown = 3;
    } else {
      this.state = null;
      this.phase = 'countdown';
      this.countdown = 3;
    }
    this._status();
  };

  Shell.prototype._finish = function (w) {
    this.phase = 'over';
    this.result = w;
    this._sfx('win');
    this._showOver();
  };

  Shell.prototype._resultText = function () {
    var w = this.result, P = this.def.players;
    if (w === 'draw') return 'Draw!';
    if (this.mode === 'cpu') return w === 0 ? 'You win!' : 'CPU wins';
    if (this.mode === 'local') return P[w].name + ' wins!';
    var me = this.mode === 'guest' ? 1 : 0;
    return w === me ? 'You win!' : P[w].name + ' wins';
  };

  Shell.prototype._showOver = function () {
    var self = this;
    var online = this.mode === 'host' || this.mode === 'guest';
    this.againBtn = el('button', { 'class': 'cg-btn', text: 'Play again', onclick: function () {
      if (!online) return self._start(self.mode);
      if (self.mode === 'host') { self.again[0] = true; self._maybeRestart(); }
      else { self.conn.send({ t: 'again' }); self.again[1] = true; }
      self._updateOver();
    } });
    this.againNote = el('small');
    this._card([
      el('h2', { text: this._resultText() }),
      this.againBtn,
      this.againNote,
      el('button', { 'class': 'cg-btn cg-ghost', text: 'Main menu', onclick: function () { self.leave(); } })
    ]);
    this._updateOver();
  };

  Shell.prototype._updateOver = function () {
    if (!this.againBtn) return;
    var me = this.mode === 'guest' ? 1 : 0, other = 1 - me;
    var online = this.mode === 'host' || this.mode === 'guest';
    if (!online) { this.againNote.textContent = ''; return; }
    this.againBtn.disabled = !!this.again[me];
    this.againNote.textContent = this.again[me] ? 'Waiting for your opponent…'
      : this.again[other] ? 'Your opponent wants a rematch!' : '';
  };

  Shell.prototype._maybeRestart = function () {
    if (this.again[0] && this.again[1]) {
      this._start('host');
    } else {
      this._updateOver();
    }
  };

  Shell.prototype.leave = function () {
    if (this.conn) {
      this.conn.send({ t: 'bye' });
      var c = this.conn;
      this.conn = null;
      clearInterval(this._pingTimer);
      c.onclose = null;
      setTimeout(function () { c.close(); }, 100);
    }
    this._cancelPending();
    this.state = null;
    this.mode = null;
    this.phase = 'menu';
    this.showMenu();
  };

  Shell.prototype._cancelPending = function () {
    if (this.pending) { try { this.pending.cancel(); } catch (e) { /* ignore */ } }
    this.pending = null;
  };

  Shell.prototype._status = function () {
    var m = this.mode, txt = '';
    if (m === 'cpu') txt = 'vs CPU';
    else if (m === 'local') txt = '2 players';
    else if (m === 'host' || m === 'guest') txt = 'Online' + (this.pingMs !== null ? ' · ' + this.pingMs + ' ms' : '');
    this.statusEl.textContent = txt;
    this.menuBtn.style.display = m ? '' : 'none';
  };

  Shell.prototype.toast = function (msg) {
    var t = this.toastEl;
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 3000);
  };

  // ---- overlay screens -----------------------------------------------------
  Shell.prototype._card = function (children) {
    this.overlay.innerHTML = '';
    this.overlay.appendChild(el('div', { 'class': 'cg-card' }, children));
    this.overlay.hidden = false;
  };
  Shell.prototype._hideOverlay = function () {
    this.overlay.hidden = true;
    this.overlay.innerHTML = '';
    this.againBtn = null;
  };

  Shell.prototype.showMenu = function () {
    var self = this, d = this.def, c = d.controls || {};
    this._cancelPending();
    this.mode = null;
    this.phase = 'menu';
    this._status();
    this._card([
      el('h1', { text: d.title }),
      d.tagline ? el('p', { text: d.tagline }) : null,
      el('button', { 'class': 'cg-btn', text: '1 Player · vs CPU', onclick: function () { self.sound.unlock(); self._start('cpu'); } }),
      global.P2P ? el('button', { 'class': 'cg-btn', text: '2 Players · Online', onclick: function () { self.sound.unlock(); self.showOnline(); } }) : null,
      el('button', { 'class': 'cg-btn cg-ghost', text: '2 Players · Same device', onclick: function () { self.sound.unlock(); self._start('local'); } }),
      el('small', { text: [c.cpu && 'Controls: ' + c.cpu, c.local && 'Same device: ' + c.local].filter(Boolean).join('\n') })
    ]);
  };

  Shell.prototype.showOnline = function () {
    var self = this;
    if (!global.P2P || !global.P2P.supported) {
      return this._card([
        el('h2', { text: 'Online play unavailable' }),
        el('p', { text: 'This browser does not support WebRTC.' }),
        el('button', { 'class': 'cg-btn', text: 'Back', onclick: function () { self.showMenu(); } })
      ]);
    }
    var code = el('input', { 'class': 'cg-input', placeholder: 'Room code', maxlength: '12', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    var join = function () {
      var v = code.value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      var m = /join=([a-z0-9]+)/i.exec(code.value);
      if (m) v = m[1].toLowerCase();
      if (v) self._joinRoom(v);
    };
    code.addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
    this._card([
      el('h2', { text: 'Play online' }),
      el('p', { text: 'Your devices connect directly to each other. Game data never passes through a server.' }),
      el('button', { 'class': 'cg-btn', text: 'Create game & get link', onclick: function () { self._hostRoom(); } }),
      el('div', { 'class': 'cg-row' }, [code, el('button', { 'class': 'cg-btn', text: 'Join', onclick: join })]),
      el('button', { 'class': 'cg-link', text: 'No link? Connect by copy-pasting codes instead', onclick: function () { self.showManual(); } }),
      el('button', { 'class': 'cg-btn cg-ghost', text: 'Back', onclick: function () { self.showMenu(); } }),
      el('small', { text: (this.def.controls && this.def.controls.online) ? 'Controls: ' + this.def.controls.online : '' })
    ]);
  };

  Shell.prototype._shareUrl = function (roomId) {
    var cfg = global.CANVASGAMES_CONFIG || {};
    if (typeof cfg.shareUrl === 'function') return cfg.shareUrl(roomId, this.def.id);
    return location.href.split('#')[0] + '#join=' + roomId;
  };

  function copyText(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'Copied ✓';
      setTimeout(function () { btn.textContent = old; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* user can copy manually */ }
      ta.remove();
    }
  }

  Shell.prototype._hostRoom = function () {
    var self = this;
    this._cancelPending();
    var h = global.P2P.hostRoom(this.def.id);
    this.pending = h;
    var url = this._shareUrl(h.roomId);
    var link = el('input', { 'class': 'cg-input', readonly: 'readonly' });
    link.value = url;
    link.addEventListener('focus', function () { link.select(); });
    var copyBtn = el('button', { 'class': 'cg-btn', text: 'Copy link', onclick: function () { copyText(url, copyBtn); } });
    var shareBtn = navigator.share ? el('button', { 'class': 'cg-btn', text: 'Share…', onclick: function () {
      navigator.share({ title: self.def.title, text: 'Play ' + self.def.title + ' with me!', url: url }).catch(function () {});
    } }) : null;
    var status = el('p', {}, [el('span', { 'class': 'cg-spin' }), document.createTextNode('Waiting for opponent…')]);
    var err = el('p', { 'class': 'cg-err' });
    this._card([
      el('h2', { text: 'Invite a friend' }),
      el('p', { text: 'Send this link, or tell them the room code:' }),
      el('div', { 'class': 'cg-code', text: h.roomId }),
      link,
      el('div', { 'class': 'cg-row' }, [copyBtn, shareBtn]),
      status, err,
      el('button', { 'class': 'cg-btn cg-ghost', text: 'Cancel', onclick: function () { self.showOnline(); } })
    ]);
    h.ready.then(function (conn) {
      if (self.pending !== h) return conn.close();
      self._attach(conn);
    }, function (e) {
      if (self.pending !== h) return;
      err.textContent = 'Could not reach the matchmaking relays. Check your internet connection, or use the copy-paste option.';
      status.hidden = true;
    });
  };

  Shell.prototype._joinRoom = function (roomId) {
    var self = this;
    this._cancelPending();
    if (!global.P2P || !global.P2P.supported) return this.showOnline();
    var j = global.P2P.joinRoom(this.def.id, roomId);
    this.pending = j;
    var hint = el('small', { text: '' });
    this._card([
      el('h2', { text: 'Joining room' }),
      el('div', { 'class': 'cg-code', text: roomId }),
      el('p', {}, [el('span', { 'class': 'cg-spin' }), document.createTextNode('Connecting to host…')]),
      hint,
      el('button', { 'class': 'cg-btn cg-ghost', text: 'Cancel', onclick: function () { self.showOnline(); } })
    ]);
    var slow = setTimeout(function () {
      hint.textContent = 'Taking a while? Make sure the host still has the invite screen open. Strict networks can block direct connections; try the copy-paste option or another network.';
    }, 12000);
    j.ready.then(function (conn) {
      clearTimeout(slow);
      if (self.pending !== j) return conn.close();
      self._attach(conn);
    }, function () {
      clearTimeout(slow);
      if (self.pending !== j) return;
      hint.textContent = 'Could not reach the matchmaking relays. Check your internet connection.';
    });
  };

  // Copy/paste signaling: zero relays, two codes exchanged by the players.
  Shell.prototype.showManual = function () {
    var self = this;
    this._cancelPending();
    this._card([
      el('h2', { text: 'Connect with codes' }),
      el('p', { text: 'One player creates an invite code and sends it (by chat, email…). The other sends back a reply code. No server involved.' }),
      el('button', { 'class': 'cg-btn', text: 'I\'ll host: create invite code', onclick: function () { self._manualHost(); } }),
      el('button', { 'class': 'cg-btn', text: 'I have an invite code', onclick: function () { self._manualJoinScreen(); } }),
      el('button', { 'class': 'cg-btn cg-ghost', text: 'Back', onclick: function () { self.showOnline(); } })
    ]);
  };

  Shell.prototype._manualHost = function () {
    var self = this;
    var h = global.P2P.manualHost();
    this.pending = h;
    var offer = el('textarea', { 'class': 'cg-input', readonly: 'readonly', placeholder: 'Creating code…' });
    var copyBtn = el('button', { 'class': 'cg-btn', text: 'Copy invite code', disabled: 'disabled' });
    var reply = el('textarea', { 'class': 'cg-input', placeholder: 'Paste the reply code here' });
    var err = el('p', { 'class': 'cg-err' });
    var connectBtn = el('button', { 'class': 'cg-btn', text: 'Connect', onclick: function () {
      err.textContent = '';
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting…';
      var timer = setTimeout(function () {
        err.textContent = 'Still connecting… Your networks may block direct connections.';
      }, 15000);
      h.accept(reply.value).then(function (conn) {
        clearTimeout(timer);
        if (self.pending !== h) return conn.close();
        self._attach(conn);
      }, function (e) {
        clearTimeout(timer);
        err.textContent = e.message;
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
      });
    } });
    this._card([
      el('h2', { text: 'Step 1 · Send this invite' }),
      offer, copyBtn,
      el('h2', { text: 'Step 2 · Paste their reply' }),
      reply, connectBtn, err,
      el('button', { 'class': 'cg-btn cg-ghost', text: 'Cancel', onclick: function () { self.showManual(); } })
    ]);
    h.offer.then(function (code) {
      offer.value = code;
      copyBtn.disabled = false;
      copyBtn.addEventListener('click', function () { copyText(code, copyBtn); });
    }, function (e) { err.textContent = 'Could not create a code: ' + e.message; });
  };

  Shell.prototype._manualJoinScreen = function () {
    var self = this;
    var invite = el('textarea', { 'class': 'cg-input', placeholder: 'Paste the invite code here' });
    var err = el('p', { 'class': 'cg-err' });
    var next = el('button', { 'class': 'cg-btn', text: 'Create reply code', onclick: function () {
      err.textContent = '';
      next.disabled = true;
      global.P2P.manualJoin(invite.value).then(function (j) {
        self.pending = j;
        var ans = el('textarea', { 'class': 'cg-input', readonly: 'readonly' });
        ans.value = j.answer;
        var copyBtn = el('button', { 'class': 'cg-btn', text: 'Copy reply code', onclick: function () { copyText(j.answer, copyBtn); } });
        var hint = el('small', { text: '' });
        self._card([
          el('h2', { text: 'Send this reply back' }),
          ans, copyBtn,
          el('p', {}, [el('span', { 'class': 'cg-spin' }), document.createTextNode('Waiting for the host to paste it…')]),
          hint,
          el('button', { 'class': 'cg-btn cg-ghost', text: 'Cancel', onclick: function () { self.showManual(); } })
        ]);
        var slow = setTimeout(function () {
          hint.textContent = 'If the host already pasted it, your networks may block direct connections.';
        }, 30000);
        j.ready.then(function (conn) {
          clearTimeout(slow);
          if (self.pending !== j) return conn.close();
          self._attach(conn);
        });
      }, function (e) {
        err.textContent = e.message;
        next.disabled = false;
      });
    } });
    this._card([
      el('h2', { text: 'Join with an invite code' }),
      invite, next, err,
      el('button', { 'class': 'cg-btn cg-ghost', text: 'Back', onclick: function () { self.showManual(); } })
    ]);
  };

  // ---------------------------------------------------------------------------
  // Shared helpers for games
  // ---------------------------------------------------------------------------
  var U = {
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    lerpAngle: function (a, b, t) {
      var d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      return a + d * t;
    },
    round: function (v, p) { var k = p || 10; return Math.round(v * k) / k; },
    glow: function (ctx, color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
  };

  global.GameShell = {
    utils: U,
    start: function (def, mount) {
      mount = typeof mount === 'string' ? document.querySelector(mount) : (mount || document.body);
      return (global.GameShell.current = new Shell(def, mount));
    }
  };
})(window);
