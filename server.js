// mp3clip — 動画から時間・音量を指定して MP3 を切り出し、動画のフレームをジャケットにする。
// 外部依存なし。変換は ffmpeg を呼ぶだけ。
// hub 配下（/mp3clip/）でも直アクセスでも動くよう、URL はすべて相対パス。

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream');

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
// id -> { file, name, duration, ... }。local: true は「このPCのフォルダ」の元ファイルを直接指す（消さない）
const uploads = new Map();
const jobs = new Map();      // id -> { state, progress, error, out, filename }

const newId = () => crypto.randomBytes(8).toString('hex');
const ID_RE = /^[0-9a-f]{16}$/;

function cleanup() {
  const limit = Date.now() - KEEP_HOURS * 3600e3;
  for (const f of fs.readdirSync(WORK)) {
    const p = path.join(WORK, f);
    try { if (fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch {}
  }
  // 元ファイルを指すエントリは表から外すだけ（work/ の外なので上のループでも消えない）
  for (const [id, u] of uploads) if (!fs.existsSync(u.file) || (u.local && u.used < limit)) uploads.delete(id);
  for (const [id, j] of jobs) if (j.out && !fs.existsSync(j.out)) jobs.delete(id);
}
cleanup();
setInterval(cleanup, 3600e3).unref();

// ---------------------------------------------------------------- ffmpeg
function run(bin, args, wantStderr = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(wantStderr ? Buffer.concat(err).toString() : Buffer.concat(out));
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
    // ブラウザがこの映像を再生できるか確かめるのに使う（HEVC は音だけ再生されてエラーにならないため）
    vcodec: v ? v.codec_name : '', vtag: v ? v.codec_tag_string : '',
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

function range(u, o) {
  const start = clamp(num(o.start, 0), 0, u.duration);
  const end = clamp(num(o.end, u.duration), start, u.duration);
  return { start, end };
}

// ラウドネスを測る（loudnorm の1パス目の出力を読む）。無音なら null
async function loudness(inputArgs) {
  const stderr = await run(FFMPEG, ['-hide_banner', '-nostats', ...inputArgs,
    '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], true);
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
  if (!m) throw new Error('ラウドネスを測れませんでした');
  const j = JSON.parse(m[0]);
  const r = { i: Number(j.input_i), tp: Number(j.input_tp), lra: Number(j.input_lra), thresh: Number(j.input_thresh) };
  return isFinite(r.i) && r.i > -70 ? r : null;
}

// 範囲のラウドネス。同じ範囲は使い回す
function measure(u, start, end) {
  const key = `${start.toFixed(3)}-${end.toFixed(3)}`;
  u.loud = u.loud || new Map();
  if (!u.loud.has(key)) {
    const p = loudness(['-ss', String(start), '-i', u.file, '-t', String(end - start), '-map', '0:a:0']);
    p.catch(() => u.loud.delete(key));
    u.loud.set(key, p);
  }
  return u.loud.get(key);
}

async function exportJob(job, u, o) {
  const { start, end } = range(u, o);
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
  if (o.volMode === 'abs') {
    // 目標ラウドネス（LUFS）。測った値を渡す2パス目は linear=true で一律の増減になる。
    // 増やすとピークが TP を超える場合だけ、ffmpeg が自動で動的処理（軽い圧縮）に切り替える
    const target = clamp(num(o.targetLufs, -14), -40, -5);
    const m = await measure(u, start, end);
    // ffmpeg 4.4 は measured_LRA=0 を「未指定」扱いして動的処理に落ちる（一定音量の音で起きる）ので 0.1 を下限にする
    if (m) af.push(`loudnorm=I=${target}:TP=-1:LRA=20:measured_I=${m.i}:measured_TP=${m.tp}`
      + `:measured_LRA=${Math.max(0.1, m.lra)}:measured_thresh=${m.thresh}:linear=true`, 'aresample=44100');
  } else {
    const gain = clamp(num(o.gainDb, 0), -40, 40);
    if (gain) af.push(`volume=${gain}dB`);
  }
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

  // 出来上がりの音量を測って返す。目標が高すぎるとピーク制限で届かないことがあるので、実際の値を見せる
  try { job.loud = await loudness(['-i', job.out, '-map', '0:a:0']); } catch { job.loud = null; }
}

// ---------------------------------------------------------------- このPCのフォルダ（コピーしない）
// config.json の roots にあるフォルダの動画を、アップロードせずにそのまま読む。書き込み・削除は一切しない
const MEDIA_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m2ts|mts|mpg|mpeg|3gp|ogv|m4a|mp3|aac|flac|wav|ogg|opus)$/i;
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
};

// 毎回読む（config.json を書き換えたらサーバを再起動しなくても反映される）。無ければ機能ごと出さない
function roots() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    return (c.roots || []).filter(r => r && r.path).map(r => ({ name: String(r.name || r.path), path: path.resolve(r.path) }));
  } catch { return []; }
}

// root 番号＋相対パス → 実パス。root の外に出るもの（.. やリンクで抜けるもの）は null
function resolveLocal(rootIdx, rel) {
  const r = roots()[Number(rootIdx)];
  if (!r) return null;
  const inside = (p, base) => {
    const x = path.relative(base, p);   // Windows では大文字小文字を区別せずに比べる
    return x !== '..' && !x.startsWith('..' + path.sep) && !path.isAbsolute(x);
  };
  const abs = path.resolve(r.path, String(rel || '').replace(/^[\\/]+/, ''));
  if (!inside(abs, r.path)) return null;
  try { if (!inside(fs.realpathSync.native(abs), fs.realpathSync.native(r.path))) return null; }
  catch { return null; }
  return { abs, root: r };
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

function findUpload(id) {
  const u = ID_RE.test(id || '') ? uploads.get(id) : null;
  if (u) u.used = Date.now();
  return u;
}
const getUpload = q => findUpload(q.get('id'));

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

    // 連続処理で済んだ動画を消す（12 時間待たずに work/ を空ける）。このPCの元ファイルは表から外すだけ
    if (req.method === 'DELETE' && p === '/api/upload') {
      const u = getUpload(q);
      if (u) { uploads.delete(u.id); if (!u.local) fs.unlink(u.file, () => {}); }
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/roots') {
      return send(res, 200, { roots: roots().map((r, i) => ({ i, name: r.name })) });
    }

    // フォルダの中身（サブフォルダと、動画・音声ファイル）
    if (req.method === 'GET' && p === '/api/browse') {
      const loc = resolveLocal(q.get('root'), q.get('dir'));
      if (!loc) return fail(res, 404, 'フォルダが見つかりません');
      const ents = await fs.promises.readdir(loc.abs, { withFileTypes: true });
      const skip = n => n.startsWith('.') || n.startsWith('$');   // 隠しフォルダや $RECYCLE.BIN
      const dirs = ents.filter(e => e.isDirectory() && !skip(e.name)).map(e => e.name);
      const files = (await Promise.all(ents.filter(e => e.isFile() && MEDIA_EXT.test(e.name)).map(e =>
        fs.promises.stat(path.join(loc.abs, e.name)).then(s => ({ name: e.name, size: s.size, mtime: s.mtimeMs }), () => null))))
        .filter(Boolean);
      const coll = new Intl.Collator('ja', { numeric: true });
      dirs.sort(coll.compare); files.sort((a, b) => coll.compare(a.name, b.name));
      const dir = path.relative(loc.root.path, loc.abs).split(path.sep).join('/');
      return send(res, 200, { root: loc.root.name, dir, dirs, files });
    }

    // このPCのファイルを開く：コピーせず元ファイルを指すエントリを作る（以降はアップロードと同じ id で扱える）
    if (req.method === 'POST' && p === '/api/open-local') {
      const o = await readJson(req);
      const loc = resolveLocal(o.root, o.path);
      if (!loc || !MEDIA_EXT.test(loc.abs) || !fs.statSync(loc.abs).isFile()) return fail(res, 404, 'ファイルが見つかりません');
      let info;
      try { info = await probe(loc.abs); }
      catch (e) { return fail(res, 400, '動画として読めません: ' + e.message); }
      if (!info.hasAudio) return fail(res, 400, '音声トラックがありません');
      const id = newId(), name = path.basename(loc.abs);
      uploads.set(id, { id, file: loc.abs, name, local: true, used: Date.now(), ...info });
      return send(res, 200, { id, name, ...info });
    }

    // プレビュー用の動画配信（Range 対応。このPCのファイルをブラウザで再生する）
    if (req.method === 'GET' && p === '/api/video') {
      const u = getUpload(q);
      if (!u) return fail(res, 404, 'not found');
      const size = (await fs.promises.stat(u.file)).size;
      const head = { 'Content-Type': MIME[path.extname(u.file).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      let start = 0, end = size - 1;
      if (m && (m[1] || m[2])) {
        if (m[1] === '') start = Math.max(0, size - Number(m[2]));   // bytes=-N（末尾 N バイト）
        else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
        if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { ...head, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      } else res.writeHead(200, { ...head, 'Content-Length': size });
      // シークのたびにブラウザが接続を切るので、切れたら読み出しも止める（pipeline が両方閉じる）
      return pipeline(fs.createReadStream(u.file, { start, end }), res, () => {});
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

    // 範囲のラウドネス（LUFS）。目標音量モードの表示とプレビュー用
    if (req.method === 'GET' && p === '/api/measure') {
      const u = getUpload(q);
      if (!u) return fail(res, 404, 'not found');
      const { start, end } = range(u, { start: q.get('start'), end: q.get('end') });
      if (end - start < 0.1) return fail(res, 400, '範囲が短すぎます');
      const m = await measure(u, start, end);
      return send(res, 200, m ? { i: m.i, tp: m.tp, lra: m.lra } : { silent: true });
    }

    // 変換は時間がかかるのでジョブにして返す（hub のプロキシタイムアウトに掛からないように）
    if (req.method === 'POST' && p === '/api/export') {
      const o = await readJson(req, 20 * 1024 * 1024);   // ジャケットの JPEG を含む
      const u = findUpload(o.id);
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
        filename: job.filename, size: job.size || 0,
        loud: job.loud ? { i: job.loud.i, tp: job.loud.tp } : null });
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
