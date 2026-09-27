/* FilmX APK — YouTube oynatıcısında reklamsız izleme (yalnız bu uygulamada, kişisel kullanım)
   Kaynak: Desktop/adblock eklentileri (oynatici-temiz + reklam-temizle), tek dosyada.
   YouTube gömülü oynatıcısının (youtube-nocookie.com/embed) içinde, sayfanın kendi betiklerinden ÖNCE çalışır.

   1) Oynatıcı verisinden reklam alanları silinir (adPlacements, playerAds...) -> reklam hiç oluşmaz
   2) Yine de reklam başlarsa: sessize al, sonuna atla, "Atla" düğmesine bas
   3) Oynatıcı üstü reklam kutuları CSS ile gizlenir
*/
(function () {
  'use strict';
  if (window.__fxReklamsiz) return;
  window.__fxReklamsiz = true;

  /* ---------- 1) reklam alanlarını budama (json-prune) ---------- */
  var ALANLAR = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adParams', 'adServingDataEntry', 'importantForAds'];

  // metinde reklam kelimesi yoksa ağaca hiç girilmez (YouTube JSON'ları çok büyük)
  function ilgiliMi(metin) {
    if (typeof metin !== 'string') return true;
    for (var i = 0; i < ALANLAR.length; i++) if (metin.indexOf(ALANLAR[i]) >= 0) return true;
    return false;
  }
  function buda(kok) {
    if (!kok || typeof kok !== 'object') return kok;
    var yigin = [kok], sayac = 0;
    while (yigin.length && sayac < 6000) {
      var o = yigin.pop(); sayac++;
      if (!o || typeof o !== 'object') continue;
      for (var i = 0; i < ALANLAR.length; i++) {
        if (Object.prototype.hasOwnProperty.call(o, ALANLAR[i])) { try { delete o[ALANLAR[i]]; } catch (e) {} }
      }
      if (Array.isArray(o)) { for (var j = 0; j < o.length; j++) if (o[j] && typeof o[j] === 'object') yigin.push(o[j]); }
      else { for (var k in o) if (o[k] && typeof o[k] === 'object') yigin.push(o[k]); }
    }
    return kok;
  }

  var asilParse = JSON.parse;
  JSON.parse = function (metin, canlandir) {
    if (!ilgiliMi(metin)) return asilParse.call(this, metin, canlandir);
    return buda(asilParse.call(this, metin, canlandir));
  };
  if (window.Response && Response.prototype && Response.prototype.json) {
    var asilJson = Response.prototype.json;
    Response.prototype.json = function () { return asilJson.apply(this, arguments).then(buda); };
  }
  var saklanan;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true, get: function () { return saklanan; }, set: function (d) { saklanan = buda(d); }
    });
  } catch (e) {}
  var saklananYt;
  try {
    Object.defineProperty(window, 'ytplayer', {
      configurable: true, get: function () { return saklananYt; },
      set: function (d) { if (d && d.config && d.config.args) buda(d.config.args); saklananYt = d; }
    });
  } catch (e) {}

  /* ---------- 2) yine de başlayan reklamı geçme ---------- */
  var ATLA = '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button';
  function reklamMi() {
    return !!document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-player-overlay, .ytp-ad-preview-container');
  }
  var bizSustuk = false;
  setInterval(function () {
    var v = document.querySelector('video');
    if (!v) return;
    if (reklamMi()) {
      if (!v.muted) { v.muted = true; bizSustuk = true; }
      // hızlandırma yok (oynatıcı takılıyordu): sadece sona atla
      if (isFinite(v.duration) && v.duration > 0 && v.duration - v.currentTime > 0.3) { try { v.currentTime = v.duration; } catch (e) {} }
      var d = document.querySelector(ATLA); if (d) d.click();
      var k = document.querySelector('.ytp-ad-overlay-close-button, .ytp-ad-overlay-close-container'); if (k) k.click();
    } else if (bizSustuk) {
      // reklam bitti: sesi geri ver, bir kez devam ettir
      bizSustuk = false; v.muted = false;
      if (v.paused && v.currentTime > 0 && !v.ended) v.play().catch(function () {});
    }
  }, 300);

  /* ---------- 3) oynatıcı üstü reklam kutuları ---------- */
  var CSS = '.ytp-ad-overlay-container,.ytp-ad-image-overlay,.ytp-ad-overlay-slot,.video-ads,.ytp-ad-module,' +
            '.ytp-featured-product,.ytp-suggested-action,.ytp-ad-text-overlay{display:none!important}';
  function stilEkle() {
    if (document.getElementById('fx-reklamsiz')) return;
    var s = document.createElement('style'); s.id = 'fx-reklamsiz'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  if (document.documentElement) stilEkle();
  document.addEventListener('DOMContentLoaded', stilEkle);
})();
