// Background hearts + heart bursts, shared by both pages.
const HEARTS = ['❤️', '💖', '💕', '💗', '💓', '💘', '💞', '🩷', '♥', '🐱', '😻', '😽', '🐈', '🐾', '🌈', '😻', '🌈', '💖'];
const pick = a => a[Math.floor(Math.random() * a.length)];

function startSky(rate = 700) {
  const sky = document.getElementById('sky');
  if (!sky) return;
  const spawn = () => {
    if (document.hidden) return;
    const h = document.createElement('span');
    h.className = 'drift';
    h.textContent = pick(HEARTS);
    const size = 12 + Math.random() * 30;
    h.style.left = Math.random() * 100 + 'vw';
    h.style.fontSize = size + 'px';
    h.style.setProperty('--o', (0.25 + Math.random() * 0.5).toFixed(2));
    h.style.setProperty('--sway', (Math.random() * 120 - 60).toFixed(0) + 'px');
    h.style.animationDuration = (9 + Math.random() * 10).toFixed(1) + 's';
    sky.appendChild(h);
    h.addEventListener('animationend', () => h.remove());
  };
  for (let i = 0; i < 14; i++) setTimeout(spawn, i * 250);
  setInterval(spawn, rate);
}

function burstHearts(x = innerWidth / 2, y = innerHeight / 2, n = 26) {
  for (let i = 0; i < n; i++) {
    const h = document.createElement('span');
    h.className = 'burst';
    h.textContent = pick(HEARTS);
    const ang = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 260;
    h.style.left = x + 'px';
    h.style.top = y + 'px';
    h.style.fontSize = 18 + Math.random() * 34 + 'px';
    h.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    h.style.setProperty('--dy', Math.sin(ang) * dist - 120 + 'px');
    h.style.setProperty('--rot', (Math.random() * 80 - 40).toFixed(0) + 'deg');
    h.style.animationDelay = Math.random() * 0.25 + 's';
    document.body.appendChild(h);
    h.addEventListener('animationend', () => h.remove());
  }
}
