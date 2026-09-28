// Watch party room: one RTCPeerConnection carries both cams and the movie.
// Whoever picks a file streams it via <video>.captureStream(); the other
// side just watches. Perfect negotiation handles tracks added mid-call.
const $ = id => document.getElementById(id);
// One room, two people. Each picks who they are on the intro screen.
const ROOM = 'lizzieandme-movie-night' + ((new URLSearchParams(location.search).get('test') || '').replace(/[^a-z0-9]/gi, '') ? '-test-' + new URLSearchParams(location.search).get('test').replace(/[^a-z0-9]/gi, '') : ''); // ?test=x = private test room
const WHO = {
  pookie: { name: 'Pookie', icon: '💖' },
  munchkin: { name: 'Munchkin', icon: '🐻' },
};
let me = null, them = null;

// Cloudflare TURN relay (phones / 5G / VPNs block direct links). Credentials expire ~48h after minting.
const iceServers = [
  {
    "urls": [
      "stun:stun.cloudflare.com:3478"
    ]
  },
  {
    "urls": [
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turn:turn.cloudflare.com:443?transport=udp",
      "turn:turn.cloudflare.com:80?transport=tcp",
      "turns:turn.cloudflare.com:443?transport=tcp"
    ],
    "username": "g042e20c31f92cf133eb83028a6dc60168110b397671da795a0d1e7073c5cd0a",
    "credential": "1e2fd5a1cc4138634bff295b86193106c0c88d5fdc53c47f96d6845d6b1321ac"
  }
];

let pc, polite = false, makingOffer = false, ignoreOffer = false;
let camStream = null, movieStream = null;
const movieSenders = new Map(); // track.id -> RTCRtpSender
const remoteStreams = new Map(); // stream.id -> MediaStream
let remoteMeta = { cam: null, movie: null };
let sharing = false, partnerSharing = false, partnerPaused = true;
let pendingSend = [];

const localMovie = $('localMovie'), remoteMovie = $('remoteMovie');
const screen_ = $('screen'), theater = $('theater');

startSky(900);

// ---------- intro ----------
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
// then a WebRTC data channel carries offers/answers/ICE and love notes.
// Each of us owns a fixed id; Pookie dials Munchkin (and keeps redialing),
// Munchkin just answers. So there is never a race over who connects.
let broker = null, conn = null, dialTimer = null;
const idFor = who => `${ROOM}-${who}`;

function send(msg) {
  const s = JSON.stringify(msg);
  if (conn && conn.open) conn.send(s); else pendingSend.push(s);
}

function onData(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case 'sdp': return onSdp(m.description);
    case 'ice':
      pc.addIceCandidate(m.candidate).catch(err => { if (!ignoreOffer) console.warn(err); });
      break;
    case 'meta': remoteMeta = m; partnerSharing = !!m.movie; route(); break;
    case 'gift': receiveGift(m.kind); break;
    case 'note': addNote(m.text, false); break;
    case 'ctl': if (sharing) control(m.action, m.t); break;
    case 'mstate': if (!sharing) { partnerPaused = m.p; showProgress(m.t, m.d, m.p); } break;
    case 'countdown': runCountdown(false); break;
    case 'cap': setCaption(m.text); break;
  }
}

function attach(c) {
  if (conn && conn !== c) conn.close();
  conn = c;
  c.on('open', () => {
    clearTimeout(dialTimer);
    pendingSend = [];
    polite = me === 'pookie';
    newPeer();
    sendMeta();
    pushState();
  });
  c.on('data', onData);
  const lost = () => {
    if (conn !== c) return;
    conn = null;
    setStatus(false);
    partnerLeft();
    dial();
  };
  c.on('close', lost);
  c.on('error', lost);
}

let dialedAt = 0;
function dial() {
  clearTimeout(dialTimer);
  if (me !== 'pookie' || !broker || broker.destroyed || (conn && conn.open)) return;
  // don't abandon an attempt that's still being set up
  if (broker.open && (!conn || Date.now() - dialedAt > 9000)) {
    dialedAt = Date.now();
    attach(broker.connect(idFor(them), { reliable: true, serialization: 'raw' }));
  }
  dialTimer = setTimeout(dial, 3000);
}

function connect() {
  broker = new Peer(idFor(me), { debug: 1, config: { iceServers } });
  broker.on('open', () => { setStatus(false); dial(); });
  broker.on('connection', c => attach(c));
  broker.on('disconnected', () => { if (!broker.destroyed) broker.reconnect(); });
  broker.on('error', err => {
    if (err.type === 'peer-unavailable') return; // they're not here yet; dial() retries
    if (err.type === 'unavailable-id') {
      setStatus(false, `${WHO[me].name} is already open in another tab`);
      sysNote(`Looks like ${WHO[me].name} is already in the room on another tab or device. Close that one, then refresh 💕`);
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      setStatus(false, 'reconnecting… 💫');
      broker.destroy();
      setTimeout(connect, 3000);
    } else console.warn(err);
  });
}

// ---------- peer connection ----------
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
    if (st === 'connected') { setStatus(true); tuneSenders(); }
    if (st === 'failed') { setStatus(false, 'connection failed, try refreshing 💔'); pc.restartIce(); }
  };
  if (camStream) camStream.getTracks().forEach(t => pc.addTrack(t, camStream));
  if (movieStream) movieStream.getTracks().forEach(addMovieTrack);
}

// Tell the other side we can take full-band stereo Opus, so the movie's
// soundtrack isn't squashed into mono voice-call audio.
function hifi(desc) {
  const pt = (desc.sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i) || [])[1];
  if (!pt) return desc;
  const sdp = desc.sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params) =>
    params.includes('stereo=1') ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=320000`);
  return { type: desc.type, sdp };
}

async function onSdp(description) {
  const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
  ignoreOffer = !polite && collision;
  if (ignoreOffer) return;
  await pc.setRemoteDescription(hifi(description));
  if (description.type === 'offer') {
    await pc.setLocalDescription();
    send({ type: 'sdp', description: pc.localDescription });
  }
  tuneSenders();
}

function sendMeta() {
  send({ type: 'meta', cam: camStream ? camStream.id : null, movie: sharing && movieStream ? movieStream.id : null });
}

// Movie video gets a big bitrate budget; cams stay modest so they never
// steal bandwidth from the picture.
async function tuneSenders() {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    const t = sender.track;
    if (!t) continue;
    const isMovie = movieSenders.has(t.id);
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) continue;
    if (t.kind === 'video') {
      p.encodings[0].maxBitrate = isMovie ? 10_000_000 : 1_200_000;
      p.encodings[0].maxFramerate = 30;
      p.encodings[0].scaleResolutionDownBy = 1;
      if (isMovie) p.encodings[0].networkPriority = p.encodings[0].priority = 'high';
      else p.encodings[0].networkPriority = p.encodings[0].priority = 'low';
    } else if (isMovie) {
      p.encodings[0].maxBitrate = 320_000;
      p.encodings[0].networkPriority = p.encodings[0].priority = 'high';
    }
    try { await sender.setParameters(p); } catch {}
  }
}

// ---------- routing remote streams to the right <video> ----------
function route() {
  const movie = remoteMeta.movie ? remoteStreams.get(remoteMeta.movie) || null : null;
  let cam = remoteMeta.cam ? remoteStreams.get(remoteMeta.cam) || null : null;
  if (!cam && !remoteMeta.cam) cam = [...remoteStreams.values()].find(s => s !== movie && s.id !== remoteMeta.movie) || null;
  const pv = $('partnerVideo');
  if (pv.srcObject !== cam) { pv.srcObject = cam; if (cam) pv.play().catch(() => {}); }
  camOverlay();
  const want = partnerSharing ? movie : null;
  if (remoteMovie.srcObject !== want) { remoteMovie.srcObject = want; if (want) remoteMovie.play().catch(() => {}); }
  refreshScreen();
}

// Show the "waiting" placeholder only while no picture is actually arriving.
function camOverlay() {
  const pv = $('partnerVideo');
  $('partnerNone').classList.toggle('hidden', !!(pv.srcObject && pv.videoWidth > 0));
}
['loadeddata', 'resize', 'playing', 'emptied'].forEach(ev => $('partnerVideo').addEventListener(ev, camOverlay));
setInterval(camOverlay, 2000);

function partnerLeft() {
  remoteMeta = { cam: null, movie: null };
  partnerSharing = false;
  $('partnerVideo').srcObject = null;
  remoteMovie.srcObject = null;
  $('partnerNone').classList.remove('hidden');
  refreshScreen();
}

function refreshScreen() {
  if (window.syncCC) syncCC();
  const showLocal = sharing, showRemote = !sharing && partnerSharing;
  localMovie.classList.toggle('show', showLocal);
  remoteMovie.classList.toggle('show', showRemote);
  const none = !showLocal && !showRemote;
  screen_.classList.toggle('nomovie', none);
  $('empty').classList.toggle('hidden', !none);
  syncVolumeUI();
}

// ---------- camera / mic ----------
async function startCam() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    try { camStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { camStream = null; }
  }
  if (camStream) $('myVideo').srcObject = camStream;
  $('myNone').classList.toggle('hidden', !!(camStream && camStream.getVideoTracks().length));
}

function toggleTrack(kind, btn) {
  const t = camStream && camStream.getTracks().find(x => x.kind === kind);
  if (!t) return;
  t.enabled = !t.enabled;
  btn.classList.toggle('off', !t.enabled);
  if (kind === 'video') $('myNone').classList.toggle('hidden', t.enabled);
}

// ---------- movie ----------
function addMovieTrack(track) {
  if (!pc || movieSenders.has(track.id)) return;
  movieSenders.set(track.id, pc.addTrack(track, movieStream));
  tuneSenders();
}

function removeMovieTrack(track) {
  const sender = movieSenders.get(track.id);
  if (sender && pc) { try { pc.removeTrack(sender); } catch {} }
  movieSenders.delete(track.id);
}

function pickMovie() {
  if (!localMovie.captureStream && !localMovie.mozCaptureStream) {
    return sysNote('This browser can\'t share a movie 😢 Open it in Chrome or Edge on a laptop to pick one. You can still watch from here.');
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
    movieStream.onaddtrack = e => addMovieTrack(e.track);
    movieStream.onremovetrack = e => removeMovieTrack(e.track);
  }
  sharing = true;
  sendMeta();
  refreshScreen();
  localMovie.play().catch(() => {});
  sysNote('🎬 ' + f.name.replace(/\.[^.]+$/, '').replace(/[._]/g, ' '));
  wake();
};
localMovie.addEventListener('playing', () => movieStream && movieStream.getTracks().forEach(addMovieTrack));
localMovie.addEventListener('error', () => sysNote('That file won\'t play in the browser 😿 Try an .mp4 (H.264) version.'));

function control(action, t) {
  if (sharing) {
    if (action === 'toggle') localMovie.paused ? localMovie.play() : localMovie.pause();
    if (action === 'back') localMovie.currentTime = Math.max(0, localMovie.currentTime - 10);
    if (action === 'fwd') localMovie.currentTime = Math.min(localMovie.duration || 0, localMovie.currentTime + 10);
    if (action === 'seek' && isFinite(t)) localMovie.currentTime = t;
    if (action === 'capoff' && isFinite(t)) { capOffset = t; syncCC(); }
    pushState();
  } else if (partnerSharing) {
    send({ type: 'ctl', action, t });
  }
}

const fmt = s => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
let seeking = false, lastDur = 0;
function showProgress(t, d, paused) {
  lastDur = d || 0;
  $('tNow').textContent = fmt(t);
  $('tDur').textContent = fmt(d);
  $('play').textContent = paused ? '▶' : '❚❚';
  if (!seeking) {
    const v = d ? Math.round(1000 * t / d) : 0;
    $('seek').value = v;
    $('seek').style.setProperty('--p', v / 10 + '%');
  }
  if (paused) wake();
}
function pushState() {
  if (!sharing) return;
  showProgress(localMovie.currentTime, localMovie.duration, localMovie.paused);
  send({ type: 'mstate', t: localMovie.currentTime, d: localMovie.duration, p: localMovie.paused });
}
setInterval(pushState, 1000);
['play', 'pause', 'seeked'].forEach(ev => localMovie.addEventListener(ev, pushState));

// Volume only changes what *you* hear. The host's copy keeps feeding the
// stream at full level (Chrome's captureStream ignores element volume).
function activeMovie() { return sharing ? localMovie : remoteMovie; }
function syncVolumeUI() {
  const v = activeMovie();
  $('vol').value = v.muted ? 0 : v.volume;
  $('muteBtn').textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
}

// ---------- captions ----------
// The sharer loads an .srt/.vtt; their browser times the cues against the
// movie and sends each line to the other side, so both see the same text.
let cues = [], capOffset = 0, capOn = true, capShown = '', capScale = 1;

function parseSubs(text) {
  const t = s => {
    const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/);
    return m ? (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]) : NaN;
  };
  return text.replace(/\r/g, '').split(/\n{2,}/).map(block => {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) return null;
    const [a, b] = lines[i].split('-->');
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    return { start: t(a), end: t(b), text: body };
  }).filter(c => c && c.text && isFinite(c.start) && isFinite(c.end)).sort((x, y) => x.start - y.start);
}

function setCaption(text) {
  capShown = text || '';
  $('capText').textContent = capShown;
  syncCC();
}

function tickCaptions() {
  if (!sharing || !cues.length) return;
  const now = localMovie.currentTime - capOffset;
  let lo = 0, hi = cues.length - 1, hit = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = cues[mid];
    if (now < c.start) hi = mid - 1; else if (now > c.end) lo = mid + 1; else { hit = c.text; break; }
  }
  if (hit !== capShown) { setCaption(hit); send({ type: 'cap', text: hit }); }
}
setInterval(tickCaptions, 100);

$('subFile').onchange = async () => {
  const f = $('subFile').files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf); // older .srt files
  cues = parseSubs(text);
  $('subFile').value = '';
  if (!cues.length) return sysNote('Couldn\'t read any subtitles from that file 😿');
  capOn = true;
  syncCC();
  sysNote(`💬 subtitles loaded (${cues.length} lines)`);
};

function syncCC() {
  $('captions').classList.toggle('off', !capOn);
  $('ccBtn').classList.toggle('on', capOn);
  $('ccToggle').textContent = 'Captions: ' + (capOn ? 'on' : 'off');
  $('ccOff').textContent = (capOffset > 0 ? '+' : '') + capOffset.toFixed(1) + 's';
  $('captions').style.setProperty('--cap', `calc(clamp(13px, 1.45vw, 22px) * ${capScale})`);
}
window.syncCC = syncCC;
function toggleCaptions() { capOn = !capOn; syncCC(); }

$('ccBtn').onclick = e => { e.stopPropagation(); $('ccMenu').classList.toggle('hidden'); wake(); };
$('ccToggle').onclick = toggleCaptions;
$('ccLoad').onclick = () => {
  $('ccMenu').classList.add('hidden');
  if (!sharing) return sysNote('Subtitles are loaded on the laptop that\'s sharing the movie 🎬');
  $('subFile').click();
};
const nudge = d => {
  capOffset = Math.round((capOffset + d) * 10) / 10;
  syncCC();
  if (!sharing) send({ type: 'ctl', action: 'capoff', t: capOffset });
};
$('ccEarlier').onclick = () => nudge(-0.5);
$('ccLater').onclick = () => nudge(0.5);
$('ccSmaller').onclick = () => { capScale = Math.max(0.6, capScale - 0.15); syncCC(); };
$('ccBigger').onclick = () => { capScale = Math.min(2.2, capScale + 0.15); syncCC(); };
document.addEventListener('click', e => { if (!e.target.closest('.ccwrap')) $('ccMenu').classList.add('hidden'); });

// ---------- auto-hiding controls ----------
let idleTimer;
function wake() {
  screen_.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const paused = sharing ? localMovie.paused : partnerPaused;
    if (!paused && !$('controls').matches(':hover')) screen_.classList.add('idle');
  }, 2800);
}
screen_.addEventListener('mousemove', wake);
screen_.addEventListener('touchstart', wake, { passive: true });

// ---------- gifts ----------
const GIFTS = {
  popcorn: { e: ['🍿', '🍿', '🍿', '🧈'], label: 'shared popcorn with you 🍿' },
  love: { e: ['💖', '💕', '💗', '❤️', '💞'], label: 'sent you love 💖' },
  kiss: { e: ['💋', '😘', '💋', '💕'], label: 'blew you a kiss 💋' },
  hug: { e: ['🤗', '🫂', '💞', '🤍'], label: 'is hugging you 🤗' },
  cat: { e: ['😻', '🐱', '🐾', '😽', '🐈'], label: 'sent kitties 😻' },
  rainbow: { e: ['🌈', '✨', '🌈', '💫'], label: 'made a rainbow 🌈' },
};
const tally = { sent: 0, got: 0 };

// small emojis rise inside the side lanes of the screen + rain on a cam tile
function playGift(kind, target) {
  const g = GIFTS[kind] || GIFTS.love;
  const lanes = [$('edgeL'), $('edgeR')];
  for (let i = 0; i < 14; i++) {
    const lane = lanes[i % 2];
    const s = document.createElement('span');
    s.className = 'floaty';
    s.textContent = pick(g.e);
    s.style.left = 8 + Math.random() * 30 + 'px';
    s.style.fontSize = 18 + Math.random() * 14 + 'px';
    s.style.setProperty('--sway', (Math.random() * 20 - 10).toFixed(0) + 'px');
    s.style.animationDuration = 2.6 + Math.random() * 1.8 + 's';
    s.style.animationDelay = i * 0.09 + 's';
    lane.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  }
  const cam = target === 'me' ? $('myCam') : $('partnerCam');
  const fx = target === 'me' ? $('fxMe') : $('fxPartner');
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.className = 'burst';
    s.style.position = 'absolute';
    s.textContent = pick(g.e);
    s.style.left = 20 + Math.random() * 60 + '%';
    s.style.top = 55 + Math.random() * 30 + '%';
    s.style.fontSize = 20 + Math.random() * 16 + 'px';
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
    const dist = 50 + Math.random() * 80;
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    s.style.setProperty('--rot', (Math.random() * 60 - 30).toFixed(0) + 'deg');
    s.style.animationDelay = Math.random() * 0.3 + 's';
    fx.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  }
  cam.classList.remove('hit'); void cam.offsetWidth; cam.classList.add('hit');
  screen_.classList.add('glow');
  clearTimeout(playGift.t);
  playGift.t = setTimeout(() => screen_.classList.remove('glow'), 1200);
}

function sendGift(kind) {
  playGift(kind, 'partner');
  send({ type: 'gift', kind });
  tally.sent++;
  showTally();
}
function receiveGift(kind) {
  playGift(kind, 'me');
  tally.got++;
  showTally();
  addNote(WHO[them].name + ' ' + (GIFTS[kind] || GIFTS.love).label, false, true);
}
function showTally() { $('tally').textContent = `💝 ${tally.sent} sent · ${tally.got} received`; }

// ---------- notes ----------
function addNote(text, mine, soft) {
  const b = document.createElement('div');
  b.className = 'bubble' + (mine ? ' mine' : '') + (soft ? ' sys' : '');
  b.textContent = text;
  const box = $('notes');
  box.appendChild(b);
  while (box.children.length > 8) box.firstChild.remove();
}
function sysNote(text) { addNote(text, false, true); }

function setStatus(together, text) {
  const s = $('status');
  s.classList.toggle('together', together);
  s.lastElementChild.textContent = text || (together ? `with ${WHO[them].name} 💞` : `waiting for ${WHO[them] ? WHO[them].name : 'your love'}…`);
  if (together && !setStatus.was) { burstHearts(innerWidth / 2, 60, 20); sysNote(`${WHO[them].name} is here 💞`); }
  setStatus.was = together;
}

// ---------- 3-2-1 together ----------
function runCountdown(mine) {
  if (mine) send({ type: 'countdown' });
  const box = $('countdown'), num = $('cdNum');
  box.classList.remove('hidden');
  let n = 3;
  const step = () => {
    num.textContent = n > 0 ? n : '🍿';
    box.classList.remove('pop'); void box.offsetWidth; box.classList.add('pop');
    if (n === 0) {
      if (sharing) localMovie.play().catch(() => {});
      burstHearts(innerWidth / 2, innerHeight / 2, 24);
      return setTimeout(() => box.classList.add('hidden'), 900);
    }
    n--;
    setTimeout(step, 1000);
  };
  step();
}

// ---------- fullscreen ----------
function toggleFull() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (theater.requestFullscreen) return theater.requestFullscreen().catch(() => {});
  const v = activeMovie(); // iPhone: native player fullscreen only
  if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
}

// ---------- wiring ----------
document.querySelectorAll('[data-pick]').forEach(b => b.onclick = pickMovie);
$('play').onclick = () => control('toggle');
$('back').onclick = () => control('back');
$('fwd').onclick = () => control('fwd');
$('seek').addEventListener('input', e => { seeking = true; e.target.style.setProperty('--p', e.target.value / 10 + '%'); $('tNow').textContent = fmt(lastDur * e.target.value / 1000); });
$('seek').addEventListener('change', e => { seeking = false; control('seek', lastDur * e.target.value / 1000); });
$('vol').addEventListener('input', e => { const v = activeMovie(); v.volume = +e.target.value; v.muted = v.volume === 0; syncVolumeUI(); });
$('muteBtn').onclick = () => { const v = activeMovie(); v.muted = !v.muted; syncVolumeUI(); };
$('mic').onclick = e => toggleTrack('audio', e.currentTarget);
$('camBtn').onclick = e => toggleTrack('video', e.currentTarget);
$('railBtn').onclick = () => theater.classList.toggle('norail');
$('full').onclick = toggleFull;
$('syncBtn').onclick = $('syncStart').onclick = () => runCountdown(true);
document.querySelectorAll('[data-gift]').forEach(b => b.onclick = () => sendGift(b.dataset.gift));

screen_.addEventListener('click', e => {
  if (e.target.closest('.controls, .choice, .countdown, .ccmenu') || screen_.classList.contains('nomovie')) return;
  clearTimeout(screen_.clickT);
  screen_.clickT = setTimeout(() => control('toggle'), 220); // single click = play/pause
});
screen_.addEventListener('dblclick', e => {
  if (e.target.closest('.controls, .choice')) return;
  clearTimeout(screen_.clickT);
  sendGift('love');
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input:not([type=range])')) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); control('toggle'); }
  else if (k === 'arrowleft') control('back');
  else if (k === 'arrowright') control('fwd');
  else if (k === 'f') toggleFull();
  else if (k === 'm') $('muteBtn').click();
  else if (k === 'c') $('railBtn').click();
  else if (k === 's') toggleCaptions();
  else return;
  wake();
});

$('whisper').onsubmit = e => {
  e.preventDefault();
  const text = e.target.msg.value.trim();
  if (!text) return;
  send({ type: 'note', text });
  addNote(text, true);
  e.target.msg.value = '';
};
$('copy').onclick = async () => {
  const b = $('copy');
  try { await navigator.clipboard.writeText(location.href); b.textContent = '💘 Copied!'; }
  catch { b.textContent = location.href; }
  setTimeout(() => (b.textContent = '🔗 Copy our link'), 2500);
};

let saved = null;
try { saved = localStorage.getItem('who'); } catch {}
if (WHO[saved]) document.querySelector(`[data-who="${saved}"]`).classList.add('last');

document.querySelectorAll('[data-who]').forEach(b => b.onclick = () => enter(b.dataset.who));
async function enter(who) {
  me = who;
  them = who === 'pookie' ? 'munchkin' : 'pookie';
  try { localStorage.setItem('who', who); } catch {}
  $('meTag').textContent = `${WHO[me].name} ${WHO[me].icon}`;
  $('themTag').textContent = `${WHO[them].name} ${WHO[them].icon}`;
  $('partnerWait').textContent = `waiting for ${WHO[them].name}…`;
  $('gate').classList.add('hidden');
  burstHearts(innerWidth / 2, innerHeight / 2, 40);
  await startCam();
  connect();
}
refreshScreen();
