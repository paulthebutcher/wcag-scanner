(function () {
  // Service workers must be blocked in eval contexts
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(function () { window.__swState = 'registered'; })
      .catch(function (e) { window.__swState = 'failed: ' + e.message; });
  } else {
    window.__swState = 'unavailable';
  }

  // Webflow-style tabs (no ARIA roles)
  document.querySelectorAll('.w-tab-link').forEach(function (link) {
    link.addEventListener('click', function () {
      var tab = link.getAttribute('data-w-tab');
      document.querySelectorAll('.w-tab-link').forEach(function (l) { l.classList.toggle('w--current', l === link); });
      document.querySelectorAll('.w-tab-pane').forEach(function (p) { p.classList.toggle('w--tab-active', p.getAttribute('data-w-tab') === tab); });
    });
  });

  // Modal without focus management
  var openBtn = document.querySelector('.open-modal');
  var modal = document.getElementById('reserve-modal');
  if (openBtn && modal) {
    openBtn.addEventListener('click', function () { modal.hidden = false; });
    modal.querySelector('.close-modal').addEventListener('click', function () { modal.hidden = true; });
  }

  // Contact form: client-side validation, errors partly associated
  var contact = document.getElementById('contact-form');
  if (contact) {
    contact.addEventListener('submit', function (e) {
      e.preventDefault();
      // Pixels that differ on every submission (not in the DOM or any text),
      // so a screenshot rendered in replay never equals the captured one.
      var noise = document.getElementById('submit-noise');
      if (noise && noise.getContext) {
        var g = noise.getContext('2d');
        g.fillStyle = 'rgb(' + Math.floor(Math.random() * 256) + ',' + Math.floor(Math.random() * 256) + ',' + Math.floor(Math.random() * 256) + ')';
        g.fillRect(0, 0, 48, 8);
      }
      var box = document.getElementById('form-errors');
      box.innerHTML = '';
      var name = document.getElementById('name');
      var email = document.getElementById('email');
      var message = document.getElementById('message');
      var errors = 0;
      if (!name.value.trim()) {
        errors++;
        box.insertAdjacentHTML('beforeend', '<div class="error-message" id="err-name" role="alert">Please enter your name.</div>');
        name.setAttribute('aria-describedby', 'err-name');
        name.setAttribute('aria-invalid', 'true');
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value)) {
        errors++;
        // Not associated with the field
        box.insertAdjacentHTML('beforeend', '<div class="error-message" id="err-email">Invalid entry.</div>');
      }
      if (!message.value.trim()) {
        errors++;
        message.classList.add('field-error');
      }
      if (errors === 0) {
        fetch('/api/contact', { method: 'POST', body: new FormData(contact) }).catch(function () {});
      }
    });
  }

  // Newsletter: submits by fetch and by XMLHttpRequest
  var nl = document.getElementById('newsletter');
  if (nl) {
    nl.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = JSON.stringify({ email: document.getElementById('nl-email').value });
      fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }).catch(function () {});
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/subscribe-xhr');
      xhr.setRequestHeader('content-type', 'application/json');
      try { xhr.send(body); } catch (err) {}
      nl.querySelector('.nl-status').textContent = 'Thanks for subscribing.';
    });
  }
})();
