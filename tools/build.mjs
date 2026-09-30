#!/usr/bin/env node
/**
 * build.mjs — 静态产物构建 / 校验
 *
 * 构建：node tools/build.mjs
 *   - 将 web/ 全量拷贝到 dist/
 *   - 校验 index.html 引用的本地资源齐全
 *   - 生成 dist/build-manifest.json（文件列表 + sha256）
 *
 * 校验：node tools/build.mjs --check
 *   - dist/ 必须存在且与源目录同构
 *   - 每个文件 sha256 与清单一致；index.html 引用资源存在
 *   - 退出码 0/1
 */
import { cp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'web');
const DIST = join(ROOT, 'dist');
const MANIFEST = 'build-manifest.json';

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function sha256(p) {
  const h = createHash('sha256');
  h.update(await readFile(p));
  return h.digest('hex');
}

function referencedAssets(html) {
  const refs = [];
  const re = /(?:src|href)\s*=\s*"([^"#?]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const r = m[1];
    if (!/^(?:https?:)?\/\//.test(r)) refs.push(r.replace(/^\//, ''));
  }
  return refs;
}

async function listMap(base) {
  const files = await walk(base);
  const map = {};
  for (const f of files) {
    const rel = relative(base, f).split('\\').join('/');
    if (rel === MANIFEST) continue;
    map[rel] = await sha256(f);
  }
  return map;
}

async function build() {
  await rm(DIST, { recursive: true, force: true });
  await cp(SRC, DIST, { recursive: true });

  const html = await readFile(join(DIST, 'index.html'), 'utf8');
  for (const ref of referencedAssets(html)) {
    await access(join(DIST, ref));
  }

  const files = await listMap(DIST);
  const manifest = {
    name: 'deepsea-cable-console',
    builtAt: new Date().toISOString(),
    entry: 'index.html',
    files,
  };
  await writeFile(join(DIST, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[build] 产物生成于 dist/，共 ${Object.keys(files).length} 个文件`);
  return manifest;
}

async function check() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(DIST, MANIFEST), 'utf8'));
  } catch (e) {
    console.error(`[check] 缺少构建清单 ${MANIFEST}，请先执行构建：${e.message}`);
    return false;
  }

  let ok = true;
  const fail = (msg) => { console.error(`[check] ${msg}`); ok = false; };

  const actual = await listMap(DIST).catch((e) => {
    fail(`无法读取 dist/：${e.message}`);
    return null;
  });
  if (!actual) return false;

  const aKeys = new Set(Object.keys(actual));
  const eKeys = new Set(Object.keys(manifest.files || {}));
  for (const k of eKeys) if (!aKeys.has(k)) fail(`清单文件缺失：${k}`);
  for (const k of aKeys) if (!eKeys.has(k)) fail(`存在清单外文件：${k}`);
  for (const k of eKeys) {
    if (actual[k] && actual[k] !== manifest.files[k]) fail(`校验和不一致：${k}`);
  }

  const html = await readFile(join(DIST, 'index.html'), 'utf8').catch((e) => {
    fail(`缺少入口 index.html：${e.message}`);
    return null;
  });
  if (html) {
    if (!html.includes('站间偏移校核台')) fail('index.html 缺少页面标识文案');
    for (const ref of referencedAssets(html)) {
      if (!aKeys.has(ref)) fail(`index.html 引用的资源不存在：${ref}`);
    }
  }

  if (ok) console.log(`[check] 构建产物校验通过（${Object.keys(manifest.files).length} 个文件，sha256 全部一致）`);
  return ok;
}

const mode = process.argv.includes('--check') ? 'check' : 'build';
const success = await (mode === 'check' ? check() : build().then(() => true).catch((e) => {
  console.error(`[build] 失败：${e.stack || e.message}`);
  return false;
}));
process.exit(success ? 0 : 1);
