// Watch party room: one RTCPeerConnection carries both cams and the movie.
// Whoever picks a file streams it via <video>.captureStream(); the other
// side just watches. Perfect-negotiation handles tracks added mid-call.
const $ = id => document.getElementById(id);
const room = (new URLSearchParams(location.search).get('r') || '').toLowerCase().replace(/[^a-z0-9]/g, '');
if (!room) location.replace('index.html');

let pc, polite = false, makingOffer = false, ignoreOffer = false;
const iceServers = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
let camStream = null, movieStream = null;
const movieSenders = new Map(); // track.id -> RTCRtpSender
const remoteStreams = new Map(); // stream.id -> MediaStream
let remoteMeta = { cam: null, movie: null };
let sharing = false, partnerSharing = false;
let pendingSend = [];

const localMovie = $('localMovie'), remoteMovie = $('remoteMovie');
const stage = $('stage');

startSky(500);

// intro: type out the love line, then reveal the button
(() => {
  const line = 'I love you, my little Lizzie pookie 💖';
  const el = $('typed'), chars = [...line];
  let i = 0;
  const tick = () => {
    el.textContent = chars.slice(0, ++i).join('');
    if (i < chars.length) return setTimeout(tick, 70 + Math.random() * 60);
    burstHearts(innerWidth / 2, innerHeight / 2.4, 40);
    setTimeout(() => $('after').classList.add('show'), 500);
  };
  setTimeout(tick, 600);
})();

// ---------- signaling ----------
// No server of our own: the free PeerJS broker introduces the two browsers,
// then a WebRTC data channel carries our offers/answers/ICE and love notes.
// First one in claims the room id ("host"); the second connects to it.
const HOST_ID = 'lizzie-movie-night-' + room;
const PEER_OPTS = { debug: 1 };
let broker = null, conn = null, isHost = false;

function send(msg) {
  const s = JSON.stringify(msg);
  if (conn && conn.open) conn.send(s); else pendingSend.push(s);
}

function onData(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case 'full':
      alertInline('This room already has two lovebirds 💑 — make a new one.');
      break;
    case 'sdp': return onSdp(m.description);
    case 'ice':
      pc.addIceCandidate(m.candidate).catch(err => { if (!ignoreOffer) console.warn(err); });
      break;
    case 'meta': remoteMeta = m; partnerSharing = !!m.movie; route(); break;
    case 'love': burstHearts(innerWidth * (0.3 + Math.random() * 0.4), innerHeight * 0.55, 34); break;
    case 'note': showNote(m.text, false); break;
    case 'ctl': if (sharing) control(m.action); break;
    case 'mstate': if (!sharing) showProgress(m.t, m.d); break;
  }
}

function attach(c) {
  conn = c;
  c.on('open', () => {
    pendingSend = [];
    polite = !isHost;
    newPeer();
    sendMeta();
  });
  c.on('data', onData);
  c.on('close', () => {
    if (conn !== c) return;
    conn = null;
    setStatus(false);
    partnerLeft();
    if (!isHost) { broker.destroy(); setTimeout(connect, 1000); } // host left: try to become host
  });
}

function connect() {
  isHost = false;
  broker = new Peer(HOST_ID, { ...PEER_OPTS, config: { iceServers } });
  broker.on('open', () => {
    isHost = true;
    setStatus(false);
  });
  broker.on('connection', c => {
    if (conn && conn.open) {
      c.on('open', () => { c.send(JSON.stringify({ type: 'full' })); setTimeout(() => c.close(), 500); });
      return;
    }
    attach(c);
  });
  broker.on('disconnected', () => { if (!broker.destroyed) broker.reconnect(); });
  broker.on('error', err => {
    if (err.type === 'unavailable-id') {
      // Someone already holds the room: join them as the guest.
      broker.destroy();
      broker = new Peer({ ...PEER_OPTS, config: { iceServers } });
      broker.on('open', () => attach(broker.connect(HOST_ID, { reliable: true, serialization: 'raw' })));
      broker.on('error', e => {
        if (e.type === 'peer-unavailable') { broker.destroy(); setTimeout(connect, 1500); }
        else console.warn(e);
      });
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      setStatus(false, 'reconnecting… 💫');
      broker.destroy();
      setTimeout(connect, 3000);
    } else console.warn(err);
  });
}

function newPeer() {
  if (pc) { pc.onicecandidate = pc.ontrack = pc.onnegotiationneeded = pc.onconnectionstatechange = null; pc.close(); }
  movieSenders.clear();
  remoteStreams.clear();
  pc = new RTCPeerConnection({ iceServers });
  pc.onicecandidate = ({ candidate }) => candidate && send({ type: 'ice', candidate });
  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      send({ type: 'sdp', description: pc.localDescription });
    } catch (err) { console.warn(err); } finally { makingOffer = false; }
  };
  pc.ontrack = ({ track, streams }) => {
    const s = streams[0] || new MediaStream([track]);
    remoteStreams.set(s.id, s);
    track.onunmute = route;
    route();
  };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') { setStatus(true); tuneMovieSenders(); }
    if (st === 'failed') { setStatus(false, 'connection failed — try refreshing 💔'); pc.restartIce(); }
  };
  if (camStream) camStream.getTracks().forEach(t => pc.addTrack(t, camStream));
  if (movieStream) movieStream.getTracks().forEach(addMovieTrack);
}

async function onSdp(description) {
  const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
  ignoreOffer = !polite && collision;
  if (ignoreOffer) return;
  await pc.setRemoteDescription(description);
  if (description.type === 'offer') {
    await pc.setLocalDescription();
    send({ type: 'sdp', description: pc.localDescription });
  }
  tuneMovieSenders();
}

function sendMeta() {
  send({ type: 'meta', cam: camStream ? camStream.id : null, movie: sharing && movieStream ? movieStream.id : null });
}

// ---------- routing remote streams to the right <video> ----------
function route() {
  let cam = null, movie = null;
  for (const [id, s] of remoteStreams) {
    if (remoteMeta.movie && id === remoteMeta.movie) movie = s;
    else if (!remoteMeta.cam || id === remoteMeta.cam) cam = cam || s;
  }
  const pv = $('partnerVideo');
  if (cam && pv.srcObject !== cam) { pv.srcObject = cam; pv.play().catch(() => {}); }
  $('partnerNone').classList.toggle('hidden', !!(cam && cam.getVideoTracks().length));
  if (movie && remoteMovie.srcObject !== movie) { remoteMovie.srcObject = movie; remoteMovie.play().catch(() => {}); }
  if (!partnerSharing) remoteMovie.srcObject = null;
  refreshStage();
}

function partnerLeft() {
  remoteMeta = { cam: null, movie: null };
  partnerSharing = false;
  $('partnerVideo').srcObject = null;
  remoteMovie.srcObject = null;
  $('partnerNone').classList.remove('hidden');
  refreshStage();
}

function refreshStage() {
  const showLocal = sharing, showRemote = !sharing && partnerSharing;
  localMovie.classList.toggle('show', showLocal);
  remoteMovie.classList.toggle('show', showRemote);
  stage.classList.toggle('nomovie', !showLocal && !showRemote);
  stage.classList.toggle('hascams', !!camStream || !!$('partnerVideo').srcObject);
}

// ---------- camera / mic ----------
async function startCam() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    try { camStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { camStream = null; }
  }
  if (camStream) $('myVideo').srcObject = camStream;
  else $('myCam').classList.add('hidden');
  refreshStage();
}

function toggleTrack(kind, btn) {
  const t = camStream && camStream.getTracks().find(x => x.kind === kind);
  if (!t) return;
  t.enabled = !t.enabled;
  btn.classList.toggle('off', !t.enabled);
}

// ---------- movie ----------
function addMovieTrack(track) {
  if (!pc || movieSenders.has(track.id)) return;
  movieSenders.set(track.id, pc.addTrack(track, movieStream));
}

function removeMovieTrack(track) {
  const sender = movieSenders.get(track.id);
  if (sender && pc) { try { pc.removeTrack(sender); } catch {} }
  movieSenders.delete(track.id);
}

async function tuneMovieSenders() {
  for (const sender of movieSenders.values()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) continue;
    p.encodings[0].maxBitrate = 6_000_000;
    p.degradationPreference = 'balanced';
    try { await sender.setParameters(p); } catch {}
  }
}

function pickMovie() {
  if (!localMovie.captureStream && !localMovie.mozCaptureStream) {
    return alertInline('This browser can\'t share a movie 😢 — open the room in Chrome or Edge on a laptop to pick it. You can still watch from here.');
  }
  $('file').click();
}

$('file').onchange = () => {
  const f = $('file').files[0];
  if (!f) return;
  if (localMovie.src) URL.revokeObjectURL(localMovie.src);
  localMovie.src = URL.createObjectURL(f);
  if (!movieStream) {
    movieStream = localMovie.captureStream ? localMovie.captureStream() : localMovie.mozCaptureStream();
    movieStream.onaddtrack = e => { addMovieTrack(e.track); tuneMovieSenders(); };
    movieStream.onremovetrack = e => removeMovieTrack(e.track);
  }
  sharing = true;
  sendMeta();
  refreshStage();
  localMovie.play().catch(() => {});
  showNote('🎬 ' + f.name.replace(/\.[^.]+$/, ''), true);
};

localMovie.addEventListener('playing', () => movieStream && movieStream.getTracks().forEach(addMovieTrack));

function control(action) {
  if (sharing) {
    if (action === 'toggle') localMovie.paused ? localMovie.play() : localMovie.pause();
    if (action === 'back') localMovie.currentTime = Math.max(0, localMovie.currentTime - 10);
    if (action === 'fwd') localMovie.currentTime = Math.min(localMovie.duration || 0, localMovie.currentTime + 10);
  } else if (partnerSharing) {
    send({ type: 'ctl', action });
  }
}

const fmt = s => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
function showProgress(t, d) {
  $('tNow').textContent = fmt(t);
  $('tDur').textContent = fmt(d);
  $('tBar').style.width = d ? (100 * t / d).toFixed(2) + '%' : '0';
}
setInterval(() => {
  if (!sharing) return;
  showProgress(localMovie.currentTime, localMovie.duration);
  send({ type: 'mstate', t: localMovie.currentTime, d: localMovie.duration, p: localMovie.paused });
}, 1000);

// ---------- love ----------
function sendLove(x, y) {
  burstHearts(x ?? innerWidth / 2, y ?? innerHeight / 2, 30);
  send({ type: 'love' });
}

function showNote(text, mine) {
  const n = document.createElement('div');
  n.className = 'note' + (mine ? ' mine' : '');
  n.textContent = (mine ? '' : '💌 ') + text;
  stage.appendChild(n);
  n.addEventListener('animationend', () => n.remove());
}

function alertInline(text) { showNote(text, true); }

function setStatus(together, text) {
  const s = $('status');
  s.classList.toggle('together', together);
  s.textContent = text || (together ? 'together 💞' : 'waiting for your love…');
  if (together) burstHearts(innerWidth / 2, 80, 20);
}

// ---------- UI wiring ----------
document.querySelectorAll('[data-pick]').forEach(b => b.onclick = pickMovie);
$('play').onclick = () => control('toggle');
$('back').onclick = () => control('back');
$('fwd').onclick = () => control('fwd');
$('mic').onclick = e => toggleTrack('audio', e.currentTarget);
$('camBtn').onclick = e => toggleTrack('video', e.currentTarget);
$('camsToggle').onclick = e => {
  const c = stage.querySelector('.cams');
  const hide = c.style.opacity !== '0';
  c.style.opacity = hide ? '0' : '1';
  e.currentTarget.textContent = hide ? '🙉' : '🙈';
};
$('full').onclick = () => document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen().catch(() => {});
$('love').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); sendLove(r.left + r.width / 2, r.top); };
stage.addEventListener('dblclick', e => { if (e.target.closest('button')) return; e.preventDefault(); sendLove(e.clientX, e.clientY); });
let lastTap = 0;
stage.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTap < 300) { const t = e.changedTouches[0]; sendLove(t.clientX, t.clientY); }
  lastTap = now;
});
$('whisper').onsubmit = e => {
  e.preventDefault();
  const text = e.target.msg.value.trim();
  if (!text) return;
  send({ type: 'note', text });
  showNote(text, true);
  e.target.msg.value = '';
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('copy').textContent = '💘 Copied!'; }
  catch { prompt('Send this to your love:', location.href); }
  setTimeout(() => ($('copy').textContent = '🔗 Copy our link'), 2000);
};

$('enter').onclick = async () => {
  $('gate').classList.add('hidden');
  burstHearts(innerWidth / 2, innerHeight / 2, 40);
  await startCam();
  connect();
};
