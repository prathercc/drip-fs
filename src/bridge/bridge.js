/**
 * Bridge handler for drip-fs
 *
 * Registers a dedicated service worker (sw.js) for fetch interception,
 * then forwards messages from the parent window to that SW.
 *
 * Messages that arrive before the SW is ready are queued and replayed
 * once the SW activates.
 *
 * A dedicated SW is required because the extension's background service
 * worker cannot intercept navigations from pages outside its scope.
 */

// Queue messages that arrive before the SW is ready
var pendingMessages = [];
window.onmessage = function (evt) {
  pendingMessages.push(evt);
};

navigator.serviceWorker
  .getRegistration('./')
  .then(function (existing) {
    return existing || navigator.serviceWorker.register('sw.js', { scope: './' });
  })
  .then(function (registration) {
    var sw =
      registration.active || registration.waiting || registration.installing;

    if (sw.state === 'activated') {
      ready(registration);
    } else {
      sw.addEventListener('statechange', function () {
        if (sw.state === 'activated') {
          ready(registration);
        }
      });
    }
  })
  .catch(function (error) {
    console.error('[drip-fs] Failed to register service worker:', error);
  });

function ready(registration) {
  // Replace queuing handler with forwarding handler
  window.onmessage = function (event) {
    forwardMessage(registration, event);
  };

  // Replay any messages that arrived before SW was ready
  pendingMessages.forEach(function (event) {
    forwardMessage(registration, event);
  });
  pendingMessages = null;
}

function forwardMessage(registration, event) {
  var port = event.ports[0];
  if (!port) return;
  var sw = registration.active;
  if (sw) {
    sw.postMessage(event.data, [port]);
  } else {
    port.postMessage({ error: 'Service worker not active' });
  }
}
