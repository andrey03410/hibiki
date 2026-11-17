// Real HTTP/MCP/worker/portable-library verification. Browser QA is performed separately.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDb } from '../apps/server/src/db.ts';
import { LibraryService } from '../apps/server/src/library.ts';
import { AuthService } from '../apps/server/src/auth.ts';
import { createApp } from '../apps/server/src/app.ts';
import { inspectArchive, applyArchive } from '../apps/server/src/portability.ts';

const base = process.env.PUBLIC_URL ?? 'http://localhost:8790';
const storage = path.resolve(process.env.STORAGE_DIR ?? 'storage');
const evidence = path.join(storage, 'verification/01-mvp');
const access = JSON.parse(await readFile(path.join(evidence, 'access.json'), 'utf8'));
const demo = JSON.parse(await readFile(path.join(evidence, 'demo.json'), 'utf8'));
const report = { startedAt: new Date().toISOString(), checks: [], jobs: {}, accounts: [] };
const clients = [];
const check = (name, data = {}) => { report.checks.push({ name, ...data }); console.log(`PASS: ${name}`); };
async function api(url, options = {}, token = access.token) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers };
  const response = await fetch(`${base}${url}`, { ...options, headers });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response;
}
async function mcp(token) {
  const client = new Client({ name: 'hibiki-live-verification', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const value = JSON.parse(result.content.find(c => c.type === 'text').text);
    if (result.isError) throw new Error(`${name}: ${value.error?.message ?? 'tool failed'}`);
    return value;
  };
}
async function waitJob(id, token = access.token) {
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until) {
    const job = await (await api(`/api/jobs/${id}`, {}, token)).json();
    if (job.state === 'done') return job;
    if (job.state === 'failed' || job.state === 'cancelled') throw new Error(`Job ${id}: ${job.error ?? job.state}`);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Job ${id} timed out`);
}
async function account(prefix) {
  const login = `${prefix}_${Date.now().toString(36)}`; const password = randomBytes(18).toString('base64url');
  const response = await api('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password }) }, null);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const { user } = await response.json();
  const token = await (await fetch(`${base}/api/tokens`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Live verification' }) })).json();
  const result = { login, password, userId: user.id, token: token.token };
  const accounts = JSON.parse(await readFile(path.join(evidence, 'live-accounts.json'), 'utf8').catch(() => '[]'));
  accounts.push(result); await writeFile(path.join(evidence, 'live-accounts.json'), JSON.stringify(accounts, null, 2), { mode: 0o600 });
  report.accounts.push({ login, userId: user.id }); return result;
}
try {
  const call = await mcp(access.token);
  const caps = await call('capabilities'); assert.equal(caps.version, 1);
  const page = await call('media_list', { limit: 2 }); assert.equal(page.items.length, 2); assert.ok(page.nextCursor);
  const page2 = await call('media_list', { limit: 2, cursor: page.nextCursor }); assert.ok(page2.items.every(i => !page.items.some(j => i.id === j.id)));
  check('real MCP initialization, capabilities and pagination');
  const mixed = await call('playlist_get', { playlistId: demo.playlists.mixed });
  assert.deepEqual([...new Set(mixed.resolved.items.map(i => i.kind))].sort(), ['audio', 'video']);
  assert.equal(mixed.resolved.total, 8);
  const explanation = await call('playlist_explain', { playlistId: demo.playlists.mixed, itemId: demo.audioIds[0] }); assert.equal(explanation.included, true); assert.ok(explanation.reasons.length);
  const cycle = await call('playlist_validate', { playlistId: demo.playlists.key, definition: { version: 1, sort: 'source', rule: { type: 'playlist', id: demo.playlists.mixed } } }); assert.equal(cycle.valid, false);
  check('mixed playlist resolves, explains membership and rejects cycles', { count: mixed.resolved.total });
  const localVideo = await call('media_get', { itemId: demo.videoIds[0] });
  assert.ok(localVideo.sources.some(s => s.provider === 'local' && s.status === 'available'));
  assert.ok(localVideo.sources.some(s => s.provider === 'youtube'));
  const source = localVideo.sources.find(s => s.provider === 'local' && s.status === 'available');
  const range = await api(source.streamUrl, { headers: { range: 'bytes=0-1023' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 1024);
  check('download added a local video source to the same item; real HTTP Range', { itemId: localVideo.id });

  const target = await account('verify_transfer'); const targetCall = await mcp(target.token);
  const denied = await fetch(`${base}${source.streamUrl}`, { headers: { authorization: `Bearer ${target.token}` } }); assert.equal(denied.status, 404);
  await assert.rejects(targetCall('media_get', { itemId: localVideo.id }));
  await assert.rejects(targetCall('playlist_get', { playlistId: demo.playlists.mixed }));
  check('real cross-account denial for media, files and playlists');

  const exported = await call('library_export', { includeFiles: true }); report.jobs.export = exported.id;
  await waitJob(exported.id);
  const archive = path.join(evidence, 'full-library.zip');
  const download = await api(`/api/jobs/${exported.id}/download`); await pipeline(Readable.fromWeb(download.body), createWriteStream(archive));
  const form = new FormData(); form.append('file', await openAsBlob(archive, { type: 'application/zip' }), 'hibiki-library.zip');
  const preview = await (await api('/api/imports/upload', { method: 'POST', body: form }, target.token)).json(); report.jobs.preview = preview.id;
  const checked = await waitJob(preview.id, target.token); assert.equal(checked.result.preview.canApply, true); assert.equal(checked.result.preview.counts.items, 8);
  const applied = await targetCall('library_import_apply', { previewJobId: preview.id }); report.jobs.apply = applied.id;
  await waitJob(applied.id, target.token);
  const imported = await (await api('/api/library', {}, target.token)).json();
  const owner = await (await api('/api/library')).json();
  assert.equal(imported.items.length, owner.items.length);
  assert.deepEqual(imported.items.map(i => i.title).sort(), owner.items.map(i => i.title).sort());
  assert.ok(imported.items.every(i => !owner.items.some(j => j.id === i.id)));
  const importedMix = imported.playlists.find(p => p.title === 'Hibiki Mix');
  assert.equal((await targetCall('playlist_get', { playlistId: importedMix.id })).resolved.total, 8);
  for (const item of imported.items) for (const local of item.sources.filter(s => s.provider === 'local' && s.status === 'available')) {
    const result = await api(local.streamUrl, { headers: { range: 'bytes=0-15' } }, target.token); assert.equal(result.status, 206); assert.equal((await result.arrayBuffer()).byteLength, 16);
  }
  const reapplied = await targetCall('library_import_apply', { previewJobId: preview.id }); await waitJob(reapplied.id, target.token);
  assert.equal((await (await api('/api/library', {}, target.token)).json()).items.length, 8);
  check('real full export, authenticated upload, preview, apply and repeat into another account', { items: imported.items.length, playlists: imported.playlists.length });

  const freshRoot = path.join(evidence, `fresh-${Date.now()}`); await mkdir(freshRoot, { recursive: true });
  const sql = new Database(path.join(freshRoot, 'hibiki.db')); const migrations = path.resolve('apps/server/prisma/migrations');
  for (const folder of (await readdir(migrations)).filter(n => /^\d/.test(n)).sort()) sql.exec(await readFile(path.join(migrations, folder, 'migration.sql'), 'utf8')); sql.close();
  const db = createDb(freshRoot, { databaseUrl: `file:${path.join(freshRoot, 'hibiki.db')}` });
  try {
    const auth = new AuthService(db); const user = await auth.register('fresh_listener', randomBytes(18).toString('hex'));
    const verified = await inspectArchive(archive, path.join(freshRoot, 'extracted')); assert.equal(verified.preview.canApply, true);
    await applyArchive(db, user.id, freshRoot, verified);
    const freshLibrary = new LibraryService(db, freshRoot); const snapshot = await freshLibrary.snapshot(user.id); assert.equal(snapshot.items.length, 8);
    const freshMix = snapshot.playlists.find(p => p.title === 'Hibiki Mix'); assert.equal((await freshLibrary.resolve(user.id, freshMix.id)).total, 8);
    const app = await createApp({ db, storageRoot: freshRoot }); await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const cookie = await auth.createSession(user.id); const address = app.server.address();
      const local = snapshot.items.flatMap(i => i.sources).find(s => s.provider === 'local' && s.status === 'available');
      const served = await fetch(`http://127.0.0.1:${address.port}${local.streamUrl}`, { headers: { cookie: `hibiki_session=${cookie}`, range: 'bytes=0-31' } }); assert.equal(served.status, 206); assert.equal((await served.arrayBuffer()).byteLength, 32);
    } finally { await app.close(); }
    check('fresh database and storage restore, valid references and playable HTTP media');
  } finally { await db.$disconnect(); }

  const playlistAccount = await account('verify_youtube'); const playlistCall = await mcp(playlistAccount.token);
  const playlistUrl = 'https://www.youtube.com/playlist?list=PLtdSPZNWT1AtEl2WGRD2d0pZT2fRE2AuX';
  const one = await playlistCall('media_import_youtube', { url: playlistUrl }); report.jobs.playlist = one.id; await waitJob(one.id, playlistAccount.token);
  const firstItems = (await playlistCall('media_list', { limit: 100 })).items; assert.equal(firstItems.length, 8); assert.ok(firstItems.every(i => i.title && !i.title.startsWith('YouTube ·')));
  const two = await playlistCall('media_import_youtube', { url: playlistUrl }); report.jobs.repeatPlaylist = two.id; await waitJob(two.id, playlistAccount.token);
  assert.equal((await playlistCall('media_list', { limit: 100 })).items.length, 8);
  check('real official eight-video YouTube playlist import and repeat without duplicates', { count: 8 });

  report.finishedAt = new Date().toISOString(); report.status = 'passed';
  await writeFile(path.join(evidence, 'live-report.json'), JSON.stringify(report, null, 2));
  console.log(`All ${report.checks.length} live integration checks passed; report saved.`);
} catch (error) {
  report.status = 'failed'; report.error = error.message;
  await writeFile(path.join(evidence, 'live-report.json'), JSON.stringify(report, null, 2)); throw error;
} finally { for (const client of clients) await client.close().catch(() => {}); }
