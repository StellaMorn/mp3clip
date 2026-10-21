// mp3clip — 動画から時間・音量を指定して MP3 を切り出し、動画のフレームをジャケットにする。
// 外部依存なし。変換は ffmpeg を呼ぶだけ。
// hub 配下（/mp3clip/）でも直アクセスでも動くよう、URL はすべて相対パス。

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 5190;
const HOST = process.env.HOST || '127.0.0.1';
const WORK = path.join(__dirname, 'work');
const KEEP_HOURS = 12;                       // アップロードと出力はこの時間で消す

function findBin(name) {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()];
  const known = `C:\\Program Files\\ffmpeg-4.4-full_build\\bin\\${name}.exe`;
  return fs.existsSync(known) ? known : name;   // 無ければ PATH に任せる
}
const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

fs.mkdirSync(WORK, { recursive: true });

// ---------------------------------------------------------------- 状態
const uploads = new Map();   // id -> { file, name, duration, ... }
const jobs = new Map();      // id -> { state, progress, error, out, filename }

const newId = () => crypto.randomBytes(8).toString('hex');
const ID_RE = /^[0-9a-f]{16}$/;

function cleanup() {
  const limit = Date.now() - KEEP_HOURS * 3600e3;
  for (const f of fs.readdirSync(WORK)) {
    const p = path.join(WORK, f);
    try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch {}
  }
  for (const [id, u] of uploads) if (!fs.existsSync(u.file)) uploads.delete(id);
  for (const [id, j] of jobs) if (j.out && !fs.existsSync(j.out)) jobs.delete(id);
}
cleanup();
setInterval(cleanup, 3600e3).unref();

// ---------------------------------------------------------------- ffmpeg
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(lastLines(Buffer.concat(err).toString())));
    });
  });
}
const lastLines = s => s.trim().split(/\r?\n/).slice(-3).join('\n') || 'ffmpeg failed';

async function probe(file) {
  const json = JSON.parse((await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ])).toString());
  const v = json.streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = json.streams.find(s => s.codec_type === 'audio');
  return {
    duration: Number(json.format.duration) || 0,
    hasVideo: !!v, hasAudio: !!a,
    width: v ? v.width : 0, height: v ? v.height : 0,
  };
}

// 正方形なら中央を切り抜く。ジャケットは大きすぎても意味が無いので長辺 1200 に抑える
function coverFilter(square) {
  const crop = square ? "crop='min(iw,ih)':'min(iw,ih)'," : '';
  return `${crop}scale='if(gt(iw,ih),min(1200,iw),-2)':'if(gt(iw,ih),-2,min(1200,ih))'`;
}

function frameArgs(file, t, vf) {
  return ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', vf,
    '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
}

async function exportJob(job, u, o) {
  const start = clamp(num(o.start, 0), 0, u.duration);
  const end = clamp(num(o.end, u.duration), start, u.duration);
  const dur = end - start;
  if (dur < 0.1) throw new Error('範囲が短すぎます');

  let coverFile = null;
  // ブラウザが表示していたフレームそのもの（ffmpeg の -ss は「t 以降の最初のフレーム」なので1コマずれる）
  const jpeg = typeof o.coverJpeg === 'string' && /^data:image\/jpeg;base64,/.test(o.coverJpeg)
    ? Buffer.from(o.coverJpeg.slice(o.coverJpeg.indexOf(',') + 1), 'base64') : null;
  if (o.cover && jpeg && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
    coverFile = path.join(WORK, `${job.id}.jpg`);
    fs.writeFileSync(coverFile, jpeg);
  } else if (o.cover && u.hasVideo) {
    coverFile = path.join(WORK, `${job.id}.jpg`);
    const t = clamp(num(o.coverTime, start), 0, Math.max(0, u.duration - 0.05));
    fs.writeFileSync(coverFile, await run(FFMPEG, frameArgs(u.file, t, coverFilter(!!o.square))));
  }

  const af = [];
  if (o.loudnorm) af.push('loudnorm=I=-14:TP=-1:LRA=11');
  const gain = clamp(num(o.gainDb, 0), -40, 40);
  if (gain) af.push(`volume=${gain}dB`);
  const fi = clamp(num(o.fadeIn, 0), 0, dur), fo = clamp(num(o.fadeOut, 0), 0, dur);
  if (fi > 0) af.push(`afade=t=in:st=0:d=${fi}`);
  if (fo > 0) af.push(`afade=t=out:st=${(dur - fo).toFixed(3)}:d=${fo}`);

  const bitrate = [128, 160, 192, 256, 320].includes(Number(o.bitrate)) ? Number(o.bitrate) : 192;
  job.out = path.join(WORK, `${job.id}.mp3`);

  const args = ['-y', '-v', 'error', '-ss', String(start), '-i', u.file];
  if (coverFile) args.push('-i', coverFile);
  args.push('-t', String(dur), '-map', '0:a:0', '-map_metadata', '-1');   // 元動画のタグは持ち込まない
  if (coverFile) args.push('-map', '1:0', '-c:v', 'copy', '-disposition:v', 'attached_pic',
    '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
  if (af.length) args.push('-af', af.join(','));
  args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-ar', '44100', '-id3v2_version', '3');
  for (const k of ['title', 'artist', 'album']) {
    const v = String(o[k] || '').trim();
    if (v) args.push('-metadata', `${k}=${v}`);
  }
  args.push('-progress', 'pipe:1', '-nostats', job.out);

  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    const err = [];
    p.stdout.on('data', d => {
      const m = /out_time_(?:us|ms)=(\d+)\s*$/m.exec(d.toString());   // どちらもマイクロ秒
      if (m) job.progress = Math.min(0.99, Number(m[1]) / 1e6 / dur);
    });
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(lastLines(Buffer.concat(err).toString()))));
  });
  if (coverFile) fs.unlink(coverFile, () => {});
}

const num = (v, d) => (v === '' || v == null || !isFinite(Number(v))) ? d : Number(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- HTTP
function send(res, code, body, type = 'application/json; charset=utf-8') {
  if (typeof body === 'object' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const fail = (res, code, msg) => send(res, code, { error: msg });

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    req.on('data', c => { len += c.length; if (len > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function getUpload(q) {
  const id = q.get('id') || '';
  return ID_RE.test(id) ? uploads.get(id) : null;
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const safeName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 150) || 'audio';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, q = url.searchParams;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }

    // 動画本体を生のボディで受ける（multipart を解かなくて済む）
    if (req.method === 'PUT' && p === '/api/upload') {
      const name = String(q.get('name') || 'video').slice(0, 200);
      const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,5}$/) || ['.bin'])[0];
      const id = newId();
      const file = path.join(WORK, id + ext);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(file);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('aborted', () => { ws.destroy(); reject(new Error('aborted')); });
      });
      let info;
      try { info = await probe(file); }
      catch (e) { fs.unlink(file, () => {}); return fail(res, 400, '動画として読めません: ' + e.message); }
      if (!info.hasAudio) { fs.unlink(file, () => {}); return fail(res, 400, '音声トラックがありません'); }
      uploads.set(id, { id, file, name, ...info });
      return send(res, 200, { id, name, ...info });
    }

    // 指定時刻のフレーム（ブラウザで再生できない形式のときのプレビュー用）
    if (req.method === 'GET' && p === '/api/frame') {
      const u = getUpload(q);
      if (!u) return fail(res, 404, 'not found');
      if (!u.hasVideo) return fail(res, 400, '映像がありません');
      const t = clamp(num(q.get('t'), 0), 0, Math.max(0, u.duration - 0.05));
      const w = clamp(num(q.get('w'), 640), 64, 1600) | 0;
      const vf = (q.get('square') === '1' ? "crop='min(iw,ih)':'min(iw,ih)'," : '') + `scale=${w}:-2`;
      const jpg = await run(FFMPEG, frameArgs(u.file, t, vf));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return res.end(jpg);
    }

    // 変換は時間がかかるのでジョブにして返す（hub のプロキシタイムアウトに掛からないように）
    if (req.method === 'POST' && p === '/api/export') {
      const o = await readJson(req, 20 * 1024 * 1024);   // ジャケットの JPEG を含む
      const u = ID_RE.test(o.id || '') ? uploads.get(o.id) : null;
      if (!u) return fail(res, 404, '動画が見つかりません。もう一度読み込んでください');
      const job = { id: newId(), state: 'running', progress: 0, error: null, out: null,
        filename: safeName(o.filename || o.title || path.parse(u.name).name) + '.mp3' };
      jobs.set(job.id, job);
      exportJob(job, u, o).then(
        () => { job.state = 'done'; job.progress = 1; job.size = fs.statSync(job.out).size; },
        e => { job.state = 'error'; job.error = e.message; if (job.out) fs.unlink(job.out, () => {}); });
      return send(res, 200, { job: job.id });
    }

    if (req.method === 'GET' && p === '/api/job') {
      const job = jobs.get(q.get('id') || '');
      if (!job) return fail(res, 404, 'not found');
      return send(res, 200, { state: job.state, progress: job.progress, error: job.error,
        filename: job.filename, size: job.size || 0 });
    }

    if (req.method === 'GET' && p === '/api/download') {
      const job = jobs.get(q.get('id') || '');
      if (!job || job.state !== 'done' || !fs.existsSync(job.out)) return fail(res, 404, 'not found');
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': fs.statSync(job.out).size,
        'Content-Disposition': contentDisposition(job.filename),
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(job.out).pipe(res);
    }

    fail(res, 404, 'not found');
  } catch (e) {
    console.error(`[${req.method} ${p}]`, e.message);
    if (!res.headersSent) fail(res, 500, e.message); else res.destroy();
  }
});
server.requestTimeout = 0;   // 大きい動画のアップロードを切らない

server.listen(PORT, HOST, () => console.log(`mp3clip: http://${HOST}:${PORT}/  (ffmpeg: ${FFMPEG})`));
