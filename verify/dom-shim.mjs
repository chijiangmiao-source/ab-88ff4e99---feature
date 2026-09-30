/**
 * dom-shim.mjs — 仅供一次性验收使用的零依赖迷你 DOM
 *
 * verify 容器内没有浏览器；本模块实现 app.js 实际用到的 DOM 子集
 *（createElement / querySelector / classList / dataset / innerHTML 解析 /
 * addEventListener / click / template 克隆 / input 事件），从真实
 * web/index.html 解析出骨架后在同一 vm 上下文里加载页面三件套脚本，
 * 从而以“页面操作”的方式驱动校核与最小停用集审计。
 */
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class ClassList {
  constructor(el) { this.el = el; }
  _list() { return this.el.className ? this.el.className.trim().split(/\s+/) : []; }
  add(...cs) {
    const set = new Set(this._list());
    cs.forEach((c) => set.add(c));
    this.el.className = Array.from(set).join(' ');
  }
  remove(...cs) {
    const set = new Set(this._list());
    cs.forEach((c) => set.delete(c));
    this.el.className = Array.from(set).join(' ');
  }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : force;
    if (want && !has) this.add(c);
    if (!want && has) this.remove(c);
    return want;
  }
  contains(c) { return this._list().includes(c); }
}

let NODE_SEQ = 1;

class Node {
  constructor() {
    this._seq = NODE_SEQ += 1;
    this.childNodes = [];
    this.parentNode = null;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1 || n.nodeType === 11); }
  get firstElementChild() { return this.children[0] || null; }

  appendChild(n) {
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  append(...ns) { ns.forEach((n) => this.appendChild(n)); }

  _walk(out) {
    for (const c of this.childNodes) {
      if (c.nodeType === 1) { out.push(c); c._walk(out); }
    }
  }
  _descendants() {
    const out = [];
    this._walk(out);
    return out;
  }
  _matchesSimple(sel) {
    // 支持 tag / #id / .class 任意组合（如 table.potentials、span.tag.ok）
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)/g;
    let tag = null;
    let m;
    while ((m = re.exec(sel)) !== null) {
      if (m[1] !== undefined) { if (tag !== null) return false; tag = m[1]; }
      else if (m[2] !== undefined) { if (this.id !== m[2]) return false; }
      else if (!this.classList.contains(m[3])) return false;
    }
    return tag === null || this.tagName === tag;
  }
  _matches(sel) {
    return this._matchesSimple(sel.trim());
  }
  querySelectorAll(sel) {
    // 支持后代选择器（以空白分隔的简单选择器序列）
    const groups = sel.trim().split(/\s+/);
    let current = [this];
    for (const g of groups) {
      const next = [];
      for (const el of current) {
        for (const d of el._descendants()) if (d._matchesSimple(g)) next.push(d);
      }
      current = next;
    }
    return current;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(s) {
    this.childNodes = [];
    if (s !== '') this.appendChild(new TextNode(String(s)));
  }

  addEventListener(type, fn) {
    (this._listeners ||= {})[type] ||= [];
    this._listeners[type].push(fn);
  }
  dispatchEvent(ev) {
    for (const fn of (this._listeners?.[ev.type] || [])) fn.call(this, ev);
    return true;
  }
  click() { this.dispatchEvent(new EventShim('click')); }

  cloneTree() {
    if (this.nodeType === 3) return new TextNode(this.text);
    const c = new Element(this.tagName);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    c.className = this.className;
    c.hidden = this.hidden;
    c.value = this.value;
    Object.assign(c.dataset, this.dataset);
    Object.assign(c.style, this.style);
    for (const ch of this.childNodes) c.appendChild(ch.cloneTree());
    return c;
  }
  cloneNode(deep) {
    if (!deep) {
      const c = new Element(this.tagName);
      c.className = this.className;
      return c;
    }
    return this.cloneTree();
  }
}

class Element extends Node {
  constructor(tagName) {
    super();
    this.nodeType = 1;
    this.tagName = tagName.toLowerCase();
    this.attrs = new Map();
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.value = '';
    this.classList = new ClassList(this);
  }
  set innerHTML(html) {
    this.childNodes = [];
    const frag = parseHtml(html);
    for (const c of frag.childNodes) this.appendChild(c);
  }
}

class TextNode extends Node {
  constructor(text) {
    super();
    this.nodeType = 3;
    this.text = text;
  }
  get textContent() { return this.text; }
  cloneTree() { return new TextNode(this.text); }
}

class Fragment extends Node {
  constructor() {
    super();
    this.nodeType = 11;
  }
}

class TemplateElement extends Element {
  constructor() {
    super('template');
    this.content = new Fragment();
  }
}

/**
 * 极简 HTML 解析：仅支持本页面出现的标签/属性/文本/自闭合 input。
 */
function parseHtml(html) {
  const root = new Fragment();
  const stack = [root];
  const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:.-]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[5] !== undefined) {
      const t = m[5];
      if (t.trim() || t === ' ') stack[stack.length - 1].appendChild(new TextNode(t));
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrText = m[3] || '';
    const selfClose = m[4] === '/' || VOID.has(tag);
    if (closing) {
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tagName === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = tag === 'template' ? new TemplateElement() : new Element(tag);
    const attrRe = /([a-zA-Z_:.-]+)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(attrText)) !== null) {
      const name = am[1];
      const val = am[2] === undefined ? '' : am[2];
      el.attrs.set(name, val);
      if (name === 'class') el.className = val;
      if (name === 'id') el.id = val;
    }
    stack[stack.length - 1].appendChild(el);
    if (tag === 'template') {
      // 模板内容继续解析进 el.content；闭合时弹回
      stack.push(el);
      el.appendChild = function (n) { // 内容进 content 片段
        n.parentNode = el;
        el.content.appendChild(n);
        return n;
      };
    } else if (!selfClose) {
      stack.push(el);
    }
  }
  return root;
}

class EventShim {
  constructor(type) { this.type = type; }
}

class DocumentShim {
  constructor(bodyFragment) {
    this.body = new Element('body');
    // parseHtml 会留下空的 template 占位（内容已单独注入），构建 body 时剔除
    for (const c of bodyFragment.childNodes.slice()) {
      if (c.tagName === 'template') continue;
      this.body.appendChild(c);
    }
    this._byId = new Map();
    for (const el of this.body._descendants()) if (el.id) this._byId.set(el.id, el);
  }
  createElement(tag) { return new Element(tag); }
  createTextNode(t) { return new TextNode(t); }
  getElementById(id) { return this._byId.get(id) || null; }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    return this.body.querySelector(sel);
  }
  querySelectorAll(sel) {
    if (sel.startsWith('#')) {
      const el = this.getElementById(sel.slice(1));
      return el ? [el] : [];
    }
    return this.body.querySelectorAll(sel);
  }
}

/**
 * 从 web/index.html 构建文档并加载页面脚本，返回 { window, document }。
 */
export async function loadPage(webDir) {
  const html = await readFile(`${webDir}/index.html`, 'utf8');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  const bodyFrag = parseHtml(bodyMatch[1]);

  // template 元素在 parseHtml 中被换成了普通挂载点结构，这里显式还原
  const templates = new Map();
  const tplMatch = html.match(/<template id="tpl-result">([\s\S]*?)<\/template>/);
  if (tplMatch) templates.set('tpl-result', tplMatch[1]);

  const documentShim = new DocumentShim(bodyFrag);
  for (const [id, inner] of templates) {
    const tpl = new TemplateElement();
    tpl.id = id;
    const frag = parseHtml(inner);
    for (const c of frag.childNodes.slice()) tpl.content.appendChild(c);
    documentShim._byId.set(id, tpl);
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Event: EventShim,
  };
  sandbox.window = sandbox;
  sandbox.document = documentShim;
  vm.createContext(sandbox);

  for (const file of ['js/solver.js', 'js/parser.js', 'js/app.js']) {
    const code = await readFile(`${webDir}/${file}`, 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return { window: sandbox, document: documentShim };
}
