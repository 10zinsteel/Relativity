(function () {
  'use strict';

  var canvas = document.getElementById('starfield');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var stars = [];
  var rafId = null;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var rgb = { r: 255, g: 255, b: 255 };

  function hexToRgb(hex) {
    hex = (hex || '').trim().replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    var num = parseInt(hex, 16);
    if (isNaN(num)) return { r: 255, g: 255, b: 255 };
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function readColor() {
    var hex = getComputedStyle(document.documentElement).getPropertyValue('--text-primary');
    rgb = hexToRgb(hex);
  }

  function resize() {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    initStars();
  }

  function initStars() {
    stars = [];
    var density = 6000;
    var count = Math.floor((canvas.width * canvas.height) / density);
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 2 + 0.5,
        o: Math.random() * 0.5 + 0.15,
        speed: Math.random() * 0.5 + 0.03,
      });
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + s.o + ')';
      ctx.fill();
      s.y -= s.speed;
      if (s.y + s.r < 0) {
        s.y = canvas.height + s.r;
        s.x = Math.random() * canvas.width;
      }
    }
  }

  function tick() {
    draw();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (reduceMotion) {
      draw();
    } else {
      cancelAnimationFrame(rafId);
      tick();
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (reduceMotion) return;
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      tick();
    }
  });

  document.addEventListener('themechange', function () {
    readColor();
    if (reduceMotion) draw();
  });

  readColor();
  var resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.parentElement);
  resize();
  start();
})();
