/* Lets the Desk open with no signal. The page's own files are fetched fresh when there is a
   connection and kept, so the last good copy opens when there is not. Requests to GitHub's API are
   never touched here: the page keeps its own saved summary and its outbox. */
"use strict";
const CACHE = "desk-page-v1";
const FILES = ["./", "index.html", "app.js", "style.css", "config.json", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", ev => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== "GET" || url.origin !== self.location.origin) return;
  ev.respondWith(
    fetch(ev.request).then(resp => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then(c => c.put(ev.request, copy)); }
      return resp;
    }).catch(() => caches.match(ev.request).then(hit => hit || caches.match("index.html")))
  );
});
