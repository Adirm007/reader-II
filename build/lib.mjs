// 构建用的小工具：带计数校验的文本替换，以及按函数名定位 / 替换整个函数声明。
// 所有替换都要求“恰好命中预期次数”，上游改动导致锚点失效时构建会直接报错并指出是哪一处。
import fs from 'node:fs';
import { Script } from 'node:vm';

export const lf = text => text.replace(/\r\n/g, '\n');
export const read = file => lf(fs.readFileSync(file, 'utf8'));

export function countExact(source, token) {
  return source.split(token).length - 1;
}

export function replaceExact(source, token, replacement, label, expected = 1) {
  const count = countExact(source, token);
  if (count !== expected) throw new Error(`${label}：预期命中 ${expected} 处，实际 ${count} 处`);
  return source.split(token).join(replacement);
}

export function replaceRange(source, startToken, endToken, replacement, label) {
  const count = countExact(source, startToken);
  if (count !== 1) throw new Error(`${label}：起点应唯一，实际 ${count} 处`);
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  if (end < 0) throw new Error(`${label}：找不到终点`);
  return source.slice(0, start) + replacement + source.slice(end);
}

export function replaceRegex(source, pattern, replacement, label, expected = 1) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== expected) throw new Error(`${label}：预期命中 ${expected} 处，实际 ${matches.length} 处`);
  /* 用函数返回替换文本：替换内容里的 $& / $1 不会被展开。 */
  return source.replace(new RegExp(pattern.source, flags), typeof replacement === 'function' ? replacement : () => replacement);
}

/* ---------- 按名字定位函数声明 ---------- */
function skipString(source, index, quote) {
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    if (quote !== '`' && ch === '\n') return i + 1;
    i += 1;
  }
  return source.length;
}

function regexAllowed(source, index) {
  let k = index - 1;
  while (k >= 0 && /\s/.test(source[k])) k -= 1;
  if (k < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(source[k])) return true;
  return /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|do|else)$/.test(source.slice(Math.max(0, k - 9), k + 1));
}

/* index 指向 '{'，返回与之配对的 '}' 之后的位置。 */
function matchBrace(source, index) {
  let depth = 0;
  let i = index;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i, ch); continue; }
    if (ch === '/') {
      const next = source[i + 1];
      if (next === '/') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
      if (next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
      if (regexAllowed(source, i)) {
        let j = i + 1, inClass = false;
        while (j < source.length) {
          const cc = source[j];
          if (cc === '\\') { j += 2; continue; }
          if (cc === '\n') break;
          if (cc === '[') inClass = true;
          else if (cc === ']') inClass = false;
          else if (cc === '/' && !inClass) break;
          j += 1;
        }
        i = j + 1;
        continue;
      }
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  throw new Error('花括号不配对');
}

/* 返回 [{ start, end }]：每一处 `function name(...) {...}` 声明（含前面的 async）。 */
export function findFunctions(source, name) {
  const pattern = new RegExp('(?:async\\s+)?function\\s+' + name.replace(/[$]/g, '\\$&') + '\\s*\\(', 'g');
  const output = [];
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const before = source[match.index - 1];
    if (before && /[\w$.]/.test(before)) continue;
    let i = match.index + match[0].length - 1, depth = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === '`') { i = skipString(source, i, ch); continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) break; }
      i += 1;
    }
    const open = source.indexOf('{', i);
    if (open < 0) continue;
    output.push({ start: match.index, end: matchBrace(source, open) });
  }
  return output;
}

export function functionSource(source, name) {
  const found = findFunctions(source, name);
  if (found.length !== 1) throw new Error(`函数 ${name}：应恰有 1 处声明，实际 ${found.length} 处`);
  return source.slice(found[0].start, found[0].end);
}

/* 整个替换一个函数声明；replacement 可以是字符串，或 (原函数源码) => 新源码。 */
export function replaceFunction(source, name, replacement, label) {
  const found = findFunctions(source, name);
  if (found.length !== 1) throw new Error(`${label || name}：函数 ${name} 应恰有 1 处声明，实际 ${found.length} 处`);
  const { start, end } = found[0];
  const next = typeof replacement === 'function' ? replacement(source.slice(start, end)) : replacement;
  return source.slice(0, start) + next + source.slice(end);
}

/* 在某一个函数体内做带校验的替换，避免误伤别处同样的文本。 */
export function patchFunction(source, name, edits, label) {
  return replaceFunction(source, name, body => {
    let next = body;
    for (const [token, replacement, expected = 1] of edits) next = replaceExact(next, token, replacement, `${label || name} 内`, expected);
    return next;
  }, label);
}

export function assertSyntax(code, filename) {
  try { new Script(code, { filename }); }
  catch (error) { throw new Error(`${filename} 语法错误：${error.message}`); }
  return code;
}

/* 控制器脚本会经过酒馆宏替换（<user>、{{char}} …）：新增的代码里不能出现这些记号。 */
export function assertNoMacro(code, label) {
  const macro = /<user>|\{\{user\}\}|<(?:bot|char)>|\{\{char\}\}/i.exec(code);
  if (macro) throw new Error(`${label} 里有酒馆宏 ${macro[0]}`);
  return code;
}
