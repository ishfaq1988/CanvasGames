/*!
 * CanvasGames P2P — direct browser-to-browser connections over WebRTC.
 *
 * Two ways to connect two devices, neither needs a server you run:
 *   1. Room link  — uses Trystero (vendored) and free public Nostr relays only
 *                   to find each other. Game data then flows peer-to-peer.
 *   2. Manual     — players copy/paste two codes (offer + reply) through any
 *                   chat app. No relay at all apart from public STUN.
 *
 * Optional global config (define before this script loads):
 *   window.CANVASGAMES_CONFIG = {
 *     appId: 'my-site-games',                 // namespace for room links
 *     iceServers: [{ urls: 'stun:...' }, { urls: 'turn:...', username, credential }]
 *   };
 */
(function (global) {
  'use strict';

  var cfg = global.CANVASGAMES_CONFIG || {};
  var ICE_SERVERS = cfg.iceServers || [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  var APP_ID = cfg.appId || 'canvasgames-p2p-v1';

  // Resolve the vendored Trystero bundle relative to this script, so the
  // library works from any folder or domain without a CDN.
  var scriptSrc = (document.currentScript && document.currentScript.src) || location.href;
  var TRYSTERO_URL = cfg.trysteroUrl || new URL('vendor/trystero-0.25.4.min.mjs', scriptSrc).href;

  var ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

  function randomId(len) {
    var out = '';
    var bytes = new Uint8Array(len || 6);
    crypto.getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    return out;
  }

  // ---------------------------------------------------------------------------
  // Connection: the single object games talk to, whichever transport is used.
  // ---------------------------------------------------------------------------
  function Connection(role, sendFn, closeFn) {
    this.role = role; // 'host' | 'guest'
    this.open = true;
    this.onmessage = null;
    this.onclose = null;
    this._send = sendFn;
    this._close = closeFn;
  }
  Connection.prototype.send = function (obj) {
    if (!this.open) return;
    try { this._send(obj); } catch (e) { /* channel closing */ }
  };
  Connection.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    try { this._close(); } catch (e) { /* already closed */ }
  };
  Connection.prototype._receive = function (obj) {
    if (this.open && this.onmessage) this.onmessage(obj);
  };
  Connection.prototype._closed = function (reason) {
    if (!this.open) return;
    this.open = false;
    try { this._close(); } catch (e) { /* already closed */ }
    if (this.onclose) this.onclose(reason || 'closed');
  };

  // ---------------------------------------------------------------------------
  // 1. Room link (Trystero over public Nostr relays)
  // ---------------------------------------------------------------------------
  var trysteroPromise = null;
  function loadTrystero() {
    if (!trysteroPromise) {
      trysteroPromise = import(TRYSTERO_URL).catch(function (e) {
        trysteroPromise = null;
        throw e;
      });
    }
    return trysteroPromise;
  }

  function openRoom(T, gameId, roomId) {
    var conf = { appId: APP_ID, rtcConfig: { iceServers: ICE_SERVERS } };
    var room = T.joinRoom(conf, gameId + '-' + roomId);
    var action = room.makeAction('g');
    return { room: room, action: action };
  }

  // Creator of the room is the host. Resolves `ready` with a Connection once
  // the first opponent arrives; later arrivals are ignored.
  function hostRoom(gameId, roomId) {
    roomId = roomId || randomId(6);
    var r = null;
    var cancelled = false;
    var ready = loadTrystero().then(function (T) {
      if (cancelled) throw new Error('cancelled');
      r = openRoom(T, gameId, roomId);
      return new Promise(function (resolve) {
        var peer = null;
        var conn = null;
        r.action.onMessage = function (data, ctx) {
          var from = ctx && ctx.peerId !== undefined ? ctx.peerId : ctx;
          if (conn && from === peer) conn._receive(data);
        };
        r.room.onPeerJoin = function (pid) {
          if (peer) return;
          peer = pid;
          conn = new Connection('host',
            function (d) { r.action.send(d, { target: pid }); },
            function () { r.room.leave(); });
          r.action.send({ t: 'hello' }, { target: pid });
          resolve(conn);
        };
        r.room.onPeerLeave = function (pid) {
          if (conn && pid === peer) conn._closed('Opponent left');
        };
      });
    });
    return {
      roomId: roomId,
      ready: ready,
      cancel: function () { cancelled = true; if (r) r.room.leave(); }
    };
  }

  // Joiner is the guest. Waits for the host's hello so two guests that open
  // the same stale link never pair up with each other.
  function joinRoom(gameId, roomId) {
    var r = null;
    var cancelled = false;
    var ready = loadTrystero().then(function (T) {
      if (cancelled) throw new Error('cancelled');
      r = openRoom(T, gameId, roomId);
      return new Promise(function (resolve) {
        var peer = null;
        var conn = null;
        r.action.onMessage = function (data, ctx) {
          var from = ctx && ctx.peerId !== undefined ? ctx.peerId : ctx;
          if (!conn) {
            if (data && data.t === 'hello') {
              peer = from;
              conn = new Connection('guest',
                function (d) { r.action.send(d, { target: from }); },
                function () { r.room.leave(); });
              resolve(conn);
            }
            return;
          }
          if (from === peer) conn._receive(data);
        };
        r.room.onPeerLeave = function (pid) {
          if (conn && pid === peer) conn._closed('Opponent left');
        };
      });
    });
    return {
      roomId: roomId,
      ready: ready,
      cancel: function () { cancelled = true; if (r) r.room.leave(); }
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Manual copy/paste signaling (plain WebRTC, zero relays)
  // ---------------------------------------------------------------------------
  function b64urlEncode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    var s = atob(str);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function streamBytes(bytes, transform) {
    var stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // Codes are compressed so they fit comfortably in a chat message.
  function encodeCode(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === 'function') {
      return streamBytes(bytes, new CompressionStream('deflate-raw'))
        .then(function (z) { return 'Z' + b64urlEncode(z); });
    }
    return Promise.resolve('J' + b64urlEncode(bytes));
  }
  function decodeCode(code) {
    code = String(code || '').replace(/\s+/g, '');
    var kind = code.charAt(0);
    var p;
    try {
      var bytes = b64urlDecode(code.slice(1));
      if (kind === 'Z') p = streamBytes(bytes, new DecompressionStream('deflate-raw'));
      else if (kind === 'J') p = Promise.resolve(bytes);
      else throw new Error('bad');
    } catch (e) {
      return Promise.reject(new Error('That code looks incomplete. Copy the whole code and try again.'));
    }
    return p.then(function (b) { return JSON.parse(new TextDecoder().decode(b)); })
      .catch(function () { throw new Error('That code looks incomplete. Copy the whole code and try again.'); });
  }

  function waitIceGathering(pc, ms) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var timer = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', function () {
        if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
  }

  function wrapChannel(dc, pc, role) {
    var conn = new Connection(role,
      function (d) { if (dc.readyState === 'open') dc.send(JSON.stringify(d)); },
      function () { dc.close(); pc.close(); });
    dc.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      conn._receive(msg);
    };
    dc.onclose = function () { conn._closed('Opponent left'); };
    pc.addEventListener('connectionstatechange', function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') conn._closed('Connection lost');
    });
    return conn;
  }

  // Host: produce an offer code; then accept the guest's reply code.
  function manualHost() {
    var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    var dc = pc.createDataChannel('game', { ordered: true });
    var ready = new Promise(function (resolve) {
      dc.onopen = function () { resolve(wrapChannel(dc, pc, 'host')); };
    });
    var offer = pc.createOffer()
      .then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { return waitIceGathering(pc, 4000); })
      .then(function () { return encodeCode({ k: 'o', s: pc.localDescription.sdp }); });
    return {
      offer: offer,
      accept: function (code) {
        return decodeCode(code).then(function (a) {
          if (a.k !== 'a') throw new Error('That is not a reply code. Paste the code your opponent sent back.');
          return pc.setRemoteDescription({ type: 'answer', sdp: a.s });
        }).then(function () { return ready; });
      },
      cancel: function () { pc.close(); }
    };
  }

  // Guest: take the host's offer code; produce a reply code to send back.
  function manualJoin(code) {
    var pc = null;
    return decodeCode(code).then(function (o) {
      if (o.k !== 'o') throw new Error('That is not an invite code. Paste the code the host sent you.');
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      var ready = new Promise(function (resolve) {
        pc.ondatachannel = function (e) {
          var dc = e.channel;
          if (dc.readyState === 'open') resolve(wrapChannel(dc, pc, 'guest'));
          else dc.onopen = function () { resolve(wrapChannel(dc, pc, 'guest')); };
        };
      });
      return pc.setRemoteDescription({ type: 'offer', sdp: o.s })
        .then(function () { return pc.createAnswer(); })
        .then(function (a) { return pc.setLocalDescription(a); })
        .then(function () { return waitIceGathering(pc, 4000); })
        .then(function () { return encodeCode({ k: 'a', s: pc.localDescription.sdp }); })
        .then(function (answer) {
          return { answer: answer, ready: ready, cancel: function () { pc.close(); } };
        });
    });
  }

  global.P2P = {
    randomId: randomId,
    hostRoom: hostRoom,
    joinRoom: joinRoom,
    manualHost: manualHost,
    manualJoin: manualJoin,
    supported: typeof RTCPeerConnection === 'function'
  };
})(window);
