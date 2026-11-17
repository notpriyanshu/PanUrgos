// Renders PanUrgos's icon (.ico + .png) and the installer banner (.bmp) from the logo SVG.
// Run with:  npx electron build/make-assets.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = __dirname;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><path d="M16 2 4 8v8c0 7 5.2 12.4 12 14 6.8-1.6 12-7 12-14V8L16 2z" fill="url(#g)"/><path d="M16 9a7 7 0 1 0 0 14 5.2 5.2 0 0 1 0-14z" fill="#07080c"/></svg>`;

// ------------------------------------------------------------------ in-page drawing
const PAGE_JS = `
const LOGO = ${JSON.stringify(LOGO)};
const img = new Image();
const ready = new Promise((r) => { img.onload = r; });
img.src = 'data:image/svg+xml;base64,' + btoa(LOGO);

async function icon(size) {
  await ready;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d');
  // Small sizes get a dark rounded tile so the mark stays legible on any taskbar.
  const r = size * 0.22;
  x.fillStyle = '#0b0c14';
  x.beginPath(); x.roundRect(0, 0, size, size, r); x.fill();
  const glow = x.createRadialGradient(size * 0.5, size * 0.45, 0, size * 0.5, size * 0.45, size * 0.6);
  glow.addColorStop(0, 'rgba(139,92,246,0.35)'); glow.addColorStop(1, 'rgba(139,92,246,0)');
  x.fillStyle = glow; x.fillRect(0, 0, size, size);
  const pad = size * 0.14;
  x.drawImage(img, pad, pad, size - 2 * pad, size - 2 * pad);
  return { w: size, h: size, png: c.toDataURL('image/png'), rgba: Array.from(x.getImageData(0, 0, size, size).data) };
}

async function banner(w, h, opts) {
  await ready;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#0a0b10'; x.fillRect(0, 0, w, h);
  const g = x.createRadialGradient(w * 0.9, 0, 0, w * 0.9, 0, w * 0.9);
  g.addColorStop(0, 'rgba(139,92,246,0.45)'); g.addColorStop(1, 'rgba(139,92,246,0)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const s = opts.logo;
  x.drawImage(img, opts.lx, (h - s) / 2, s, s);
  x.fillStyle = '#eef0f8';
  x.font = '600 ' + opts.fs + 'px "Segoe UI Variable Display", "Segoe UI", sans-serif';
  x.textBaseline = 'middle';
  x.fillText('PanUrgos Studio', opts.lx + s + opts.gap, h / 2 - (opts.sub ? opts.fs * 0.35 : 0));
  if (opts.sub) {
    x.fillStyle = '#8e95ad';
    x.font = '400 ' + Math.round(opts.fs * 0.55) + 'px "Segoe UI", sans-serif';
    x.fillText(opts.sub, opts.lx + s + opts.gap, h / 2 + opts.fs * 0.55);
  }
  return { w, h, rgba: Array.from(x.getImageData(0, 0, w, h).data) };
}
`;

// ------------------------------------------------------------------ encoders
function bmp24(w, h, rgba) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4; // bottom-up
    const d = 54 + y * row + x * 3;
    buf[d] = rgba[s + 2]; buf[d + 1] = rgba[s + 1]; buf[d + 2] = rgba[s];
  }
  return buf;
}
/** Classic 32-bit DIB icon entry (works everywhere, including NSIS). */
function dibEntry(w, h, rgba) {
  const maskRow = Math.ceil(w / 32) * 4;
  const buf = Buffer.alloc(40 + w * h * 4 + maskRow * h);
  buf.writeUInt32LE(40, 0); buf.writeInt32LE(w, 4); buf.writeInt32LE(h * 2, 8);
  buf.writeUInt16LE(1, 12); buf.writeUInt16LE(32, 14); buf.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4; const d = 40 + (y * w + x) * 4;
    buf[d] = rgba[s + 2]; buf[d + 1] = rgba[s + 1]; buf[d + 2] = rgba[s]; buf[d + 3] = rgba[s + 3];
  }
  return buf;
}
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let off = head.length; const blobs = [];
  images.forEach((im, i) => {
    const data = im.w >= 256 ? Buffer.from(im.png.split(',')[1], 'base64') : dibEntry(im.w, im.h, im.rgba);
    const e = 6 + i * 16;
    head[e] = im.w >= 256 ? 0 : im.w; head[e + 1] = im.h >= 256 ? 0 : im.h;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += data.length; blobs.push(data);
  });
  return Buffer.concat([head, ...blobs]);
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<html><body></body></html>');
  await w.webContents.executeJavaScript(PAGE_JS + ';0');
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const icons = [];
  for (const s of sizes) icons.push(await w.webContents.executeJavaScript(`icon(${s})`));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(icons));
  fs.writeFileSync(path.join(OUT, 'icon.png'), Buffer.from(icons.at(-1).png.split(',')[1], 'base64'));
  // MUI header (150x57) and the uninstaller header use the same art.
  const head = await w.webContents.executeJavaScript(`banner(150, 57, { logo: 30, lx: 10, gap: 8, fs: 15 })`);
  fs.writeFileSync(path.join(OUT, 'installer-header.bmp'), bmp24(head.w, head.h, head.rgba));
  // Welcome/finish sidebar (164x314).
  const side = await w.webContents.executeJavaScript(`(async () => { await ready;
    const c = document.createElement('canvas'); c.width = 164; c.height = 314; const x = c.getContext('2d');
    x.fillStyle = '#0a0b10'; x.fillRect(0, 0, 164, 314);
    const g = x.createRadialGradient(82, 120, 0, 82, 120, 160); g.addColorStop(0, 'rgba(139,92,246,0.5)'); g.addColorStop(1, 'rgba(139,92,246,0)');
    x.fillStyle = g; x.fillRect(0, 0, 164, 314);
    x.drawImage(img, 42, 70, 80, 80);
    x.fillStyle = '#eef0f8'; x.font = '600 17px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText('PanUrgos Studio', 82, 186);
    x.fillStyle = '#8e95ad'; x.font = '11px "Segoe UI", sans-serif'; x.fillText('Private AI code editor', 82, 206);
    return { w: 164, h: 314, rgba: Array.from(x.getImageData(0, 0, 164, 314).data) }; })()`);
  fs.writeFileSync(path.join(OUT, 'installer-sidebar.bmp'), bmp24(side.w, side.h, side.rgba));
  // macOS/Linux want a large PNG (electron-builder turns it into .icns).
  const big = await w.webContents.executeJavaScript(`icon(1024)`);
  fs.writeFileSync(path.join(OUT, 'icon.png'), Buffer.from(big.png.split(',')[1], 'base64'));
  // DMG window background (540×380 and @2x): drag PanUrgos onto Applications.
  for (const scale of [1, 2]) {
    const png = await w.webContents.executeJavaScript(`(async () => { await ready; const s = ${scale};
      const c = document.createElement('canvas'); c.width = 540 * s; c.height = 380 * s; const x = c.getContext('2d'); x.scale(s, s);
      x.fillStyle = '#07080c'; x.fillRect(0, 0, 540, 380);
      let g = x.createRadialGradient(140, 190, 0, 140, 190, 260); g.addColorStop(0, 'rgba(139,92,246,0.35)'); g.addColorStop(1, 'rgba(139,92,246,0)'); x.fillStyle = g; x.fillRect(0, 0, 540, 380);
      g = x.createRadialGradient(470, 40, 0, 470, 40, 260); g.addColorStop(0, 'rgba(34,211,238,0.14)'); g.addColorStop(1, 'rgba(34,211,238,0)'); x.fillStyle = g; x.fillRect(0, 0, 540, 380);
      x.fillStyle = '#eef0f8'; x.font = '600 20px -apple-system, "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText('Keep your code private.', 270, 62);
      x.fillStyle = '#8e95ad'; x.font = '13px -apple-system, "Segoe UI", sans-serif'; x.fillText('Drag PanUrgos Studio into Applications', 270, 86);
      const ag = x.createLinearGradient(205, 0, 335, 0); ag.addColorStop(0, '#8b5cf6'); ag.addColorStop(1, '#22d3ee');
      x.strokeStyle = ag; x.lineWidth = 3; x.lineCap = 'round'; x.setLineDash([2, 9]);
      x.beginPath(); x.moveTo(212, 190); x.lineTo(320, 190); x.stroke(); x.setLineDash([]);
      x.beginPath(); x.moveTo(312, 180); x.lineTo(326, 190); x.lineTo(312, 200); x.stroke();
      x.fillStyle = '#5c6380'; x.font = '11px -apple-system, "Segoe UI", sans-serif'; x.fillText('No telemetry · Models run on this Mac', 270, 350);
      return c.toDataURL('image/png'); })()`);
    fs.writeFileSync(path.join(OUT, scale === 1 ? 'dmg-background.png' : 'dmg-background@2x.png'), Buffer.from(png.split(',')[1], 'base64'));
  }
  console.log('wrote icon.ico, icon.png (1024), installer-header.bmp, installer-sidebar.bmp, dmg-background(@2x).png');
  app.quit();
});
