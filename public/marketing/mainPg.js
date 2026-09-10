// === Hero black hole ===
// Pushed off-center via `focus` so the busy half and the reading half of the
// hero never overlap; `scrim` darkens only the edge the copy sits on. On
// narrow viewports there's no room to stand them side by side, so the whole
// thing turns 90°: hole low, copy high, veil from the top — and the ray
// count drops, since a phone pays for every step.
(() => {
  const host = document.getElementById('heroBlackhole');
  const canvas = document.getElementById('heroBlackholeCanvas');
  if (!host || !canvas || !window.RelativityBlackHole) return;

  const narrowQuery = window.matchMedia('(max-width: 767px)');

  const layoutFor = (narrow) => ({
    focus: narrow ? [0.5, 0.7] : [0.72, 0.46],
    scrim: narrow ? 'top' : 'left',
    elevation: narrow ? -7 : -5.5,
    fov: narrow ? 58 : 42,
    glow: narrow ? 0.85 : 1,
    steps: narrow ? 200 : 300,
    resolution: narrow ? 0.6 : 0.7,
  });

  const blackHole = window.RelativityBlackHole.init(host, canvas, Object.assign({
    distance: 24,
    roll: -20,
    diskInner: 3,
    diskOuter: 15,
    diskThickness: 0.26,
    diskDensity: 1,
    brightness: 1,
    spinSpeed: 0.06,
    grain: 0.48,
    doppler: 0.35,
    hotColor: '#FFF3DE',
    midColor: '#FF9838',
    coolColor: '#8E3A0B',
    exposure: 0.9,
    vignette: 0.28,
    scrimStrength: 0.9,
    maxDpr: 1.75,
  }, layoutFor(narrowQuery.matches)));

  narrowQuery.addEventListener('change', (e) => blackHole.setOptions(layoutFor(e.matches)));
})();

// === Nav scroll state ===
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// === Mobile menu ===
const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
const mobileNav = document.getElementById('mobileNav');

mobileMenuBtn.addEventListener('click', () => {
  const isOpen = nav.classList.toggle('menu-open');
  mobileMenuBtn.setAttribute('aria-expanded', isOpen);
});

mobileNav.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    nav.classList.remove('menu-open');
    mobileMenuBtn.setAttribute('aria-expanded', 'false');
  });
});

// === Scroll-triggered fade-ins ===
const fadeEls = document.querySelectorAll('.fade-in');
const ioOptions = { threshold: 0.1, rootMargin: '0px 0px -48px 0px' };
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      // Stagger cards in a grid if siblings (skip the stagger under reduced motion)
      const parent = entry.target.parentElement;
      const siblings = [...parent.querySelectorAll('.fade-in')];
      const idx = siblings.indexOf(entry.target);
      const isGrid = parent.classList.contains('sources-grid') || parent.classList.contains('outcomes-grid');
      const delay = (isGrid && !prefersReducedMotion) ? idx * 80 : 0;
      setTimeout(() => entry.target.classList.add('visible'), delay);
      io.unobserve(entry.target);
    }
  }
}, ioOptions);

for (const el of fadeEls) io.observe(el);

// === Contact form ===
const form = document.getElementById('contactForm');
const status = document.getElementById('formStatus');
const submitBtn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  submitBtn.textContent = 'Sending…';
  submitBtn.disabled = true;
  status.textContent = '';
  status.className = 'form-status';

  const data = {
    name:    form.elements['name'].value,
    email:   form.elements['email'].value,
    phone:   form.elements['phone'].value,
    company: form.elements['company'].value,
    message: form.elements['message'].value,
    website: form.elements['website'].value,
  };

  try {
    const res = await fetch('/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (res.ok) {
      status.textContent = "Message received. I'll reach out shortly.";
      status.classList.add('success');
      form.reset();
    } else {
      const body = await res.json().catch(() => ({}));
      status.textContent = body.error || 'Something went wrong. Please try again.';
      status.classList.add('error');
    }
  } catch {
    status.textContent = 'Network error. Please check your connection and try again.';
    status.classList.add('error');
  }

  submitBtn.textContent = 'Send Message';
  submitBtn.disabled = false;
});

// === Smooth scroll for anchor links ===
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});
