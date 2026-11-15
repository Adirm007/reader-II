(function (root) {
  'use strict';

  /*
   * 资源挂载（VFS）：酒馆里的东西统一成「路径 → 文本」。
   *
   *   路径  <挂载名>:/<段>/<段>…[#/JSON/指针]
   *   名字里的 / # % 写成 %2F %23 %25（ls 给出的名字已经转好，照抄即可）。
   *
   * 挂载点（provider）接口，除 id 外都可省略：
   *   { id, title, hint, readonly,
   *     scope(segs, action) → 'workspace' | 'chat' | 'card' | 'tavern' | 'external' | 'device',
   *     list(segs, { offset, limit }) → { items: [{ name, dir, size, note }], total },
   *     read(segs) → string | null（不存在）,
   *     write(segs, text), remove(segs),
   *     bulk(segs) → [{ path, text }]   检索用的快速通道，省略时按 list / read 递归 }
   *
   * 写入一律经过这里：先留写入前镜像（撤销用），再交给挂载点。
   */
  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function enc(name) { return String(name).replace(/%/g, '%25').replace(/\//g, '%2F').replace(/#/g, '%23'); }
  function dec(name) { try { return decodeURIComponent(name); } catch (error) { return name; } }

  function parsePath(input) {
    var raw = String(input == null ? '' : input).trim();
    var match = raw.match(/^([A-Za-z][\w-]*):\/?(.*)$/);
    if (!match) throw new Error('路径要写成「挂载名:/…」，例如 wb:/书名/条目名。用 ls 不带参数可以看到所有挂载点。');
    var rest = match[2], pointer = null;
    var hash = rest.indexOf('#/');
    if (hash < 0 && /#$/.test(rest)) hash = rest.length - 1;
    if (hash >= 0) { pointer = rest.slice(hash + 1); rest = rest.slice(0, hash); }
    var segs = rest.split('/').filter(function (part) { return part !== ''; }).map(dec);
    return { mount: match[1], segs: segs, pointer: pointer, canonical: match[1] + ':/' + segs.map(enc).join('/') + (pointer ? '#' + pointer : '') };
  }

  function pointerParts(pointer) {
    return String(pointer || '').split('/').slice(1).map(function (part) { return part.replace(/~1/g, '/').replace(/~0/g, '~'); });
  }

  function pointerGet(doc, pointer) {
    var parts = pointerParts(pointer), current = doc;
    for (var index = 0; index < parts.length; index += 1) {
      if (current === null || typeof current !== 'object' || !(parts[index] in current)) return { found: false };
      current = current[parts[index]];
    }
    return { found: true, value: current };
  }

  function pointerSet(doc, pointer, value, remove) {
    var parts = pointerParts(pointer);
    if (!parts.length) return value;
    var current = doc;
    for (var index = 0; index < parts.length - 1; index += 1) {
      var key = parts[index];
      if (/^(?:__proto__|constructor|prototype)$/.test(key)) throw new Error('路径里有不允许的键名');
      if (current[key] === null || typeof current[key] !== 'object') {
        if (remove) return doc;
        current[key] = /^\d+$/.test(parts[index + 1]) ? [] : {};
      }
      current = current[key];
    }
    var last = parts[parts.length - 1];
    if (/^(?:__proto__|constructor|prototype)$/.test(last)) throw new Error('路径里有不允许的键名');
    if (remove) { if (Array.isArray(current)) current.splice(Number(last), 1); else delete current[last]; }
    else current[last] = value;
    return doc;
  }

  function numbered(lines, start) {
    return lines.map(function (line, index) { return String(start + index).padStart(5, ' ') + '\t' + line; }).join('\n');
  }

  function createVfs(deps) {
    var journal = deps && deps.journal;
    var mounts = new Map();
    var pauseAt = 0;

    /* 长循环里隔一阵让出主线程，别让酒馆卡住。 */
    function breathe() {
      var now = Date.now();
      if (now - pauseAt < 24) return null;
      pauseAt = now;
      return new Promise(function (resolve) { setTimeout(function () { pauseAt = Date.now(); resolve(); }, 0); });
    }

    function provider(parsed) {
      var found = mounts.get(parsed.mount);
      if (!found) throw new Error('没有名为 ' + parsed.mount + ': 的挂载点。可用：' + Array.from(mounts.keys()).join('、'));
      return found;
    }

    function scope(path, action) {
      var parsed = parsePath(path), target = provider(parsed);
      return typeof target.scope === 'function' ? target.scope(parsed.segs, action) : target.scope || 'tavern';
    }

    async function list(path, options) {
      var raw = String(path == null ? '' : path).trim();
      if (!raw) {
        var items = Array.from(mounts.values()).map(function (item) { return { name: item.id + ':/', dir: true, note: item.title + (item.hint ? '。' + item.hint : '') }; });
        return { items: items, total: items.length };
      }
      var parsed = parsePath(raw), target = provider(parsed);
      if (typeof target.list !== 'function') throw new Error(parsed.mount + ': 不能列目录');
      var result = await target.list(parsed.segs, options || {});
      if (Array.isArray(result)) result = { items: result, total: result.length };
      return result || { items: [], total: 0 };
    }

    /* 原文；不存在时返回 null。带 JSON 指针时返回那棵子树（字符串叶子原样返回，其余为 JSON）。 */
    async function readText(path) {
      var parsed = parsePath(path), target = provider(parsed);
      if (typeof target.read !== 'function') throw new Error(parsed.mount + ': 不能读取');
      var text = await target.read(parsed.segs);
      if (text === null || text === undefined) return null;
      if (!parsed.pointer) return String(text);
      var doc;
      try { doc = JSON.parse(text); } catch (error) { throw new Error('这个文件不是 JSON，不能用 # 指针'); }
      var hit = pointerGet(doc, parsed.pointer);
      if (!hit.found) return null;
      return typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value, null, 1);
    }

    async function read(path, options) {
      var text = await readText(path);
      if (text === null) throw new Error('没有这个文件：' + path + '。先用 ls 看看上一级目录里有什么。');
      var lines = text.split('\n');
      var offset = Math.max(1, Math.trunc(Number(options && options.offset) || 1));
      var limit = Math.max(1, Math.min(2000, Math.trunc(Number(options && options.limit) || 200)));
      var cap = Math.max(1000, Number(options && options.cap) || 12000);
      var slice = lines.slice(offset - 1, offset - 1 + limit);
      /* 单行极长（压成一行的脚本）时按字符再切，行号后标出列范围。 */
      var body = '', used = 0, shown = 0;
      for (var index = 0; index < slice.length; index += 1) {
        var line = slice[index];
        var column = index === 0 ? Math.max(0, Math.trunc(Number(options && options.column) || 0)) : 0;
        var room = cap - used;
        if (room <= 0) break;
        var piece = line.slice(column, column + room);
        var partial = column > 0 || piece.length < line.length - column;
        body += (body ? '\n' : '') + String(offset + index).padStart(5, ' ') + (partial ? '[' + column + '-' + (column + piece.length) + '/' + line.length + ']' : '') + '\t' + piece;
        used += piece.length + 1;
        shown += 1;
        if (partial && piece.length < line.length - column) { shown -= 1; break; }
      }
      var next = offset + shown;
      var more = next <= lines.length;
      return {
        text: body, totalLines: lines.length, totalChars: text.length, from: offset, to: next - 1,
        more: more ? '还有内容：共 ' + lines.length + ' 行 / ' + text.length + ' 字。继续读用 offset=' + next + (slice[shown] !== undefined && slice[shown].length > cap ? '（这一行很长，可加 column=字符位置 分段读，或直接用 grep 定位）' : '') : ''
      };
    }

    async function writeRaw(parsed, target, text, run) {
      var basePath = parsed.mount + ':/' + parsed.segs.map(enc).join('/');
      var before = typeof target.read === 'function' ? await target.read(parsed.segs) : null;
      var next = text;
      if (parsed.pointer) {
        var doc;
        try { doc = before === null || before === undefined ? {} : JSON.parse(before); } catch (error) { throw new Error('这个文件不是 JSON，不能用 # 指针写入'); }
        var existing = pointerGet(doc, parsed.pointer);
        var value;
        if (existing.found && typeof existing.value === 'string') value = text;
        else {
          try { value = JSON.parse(text); }
          catch (error) {
            if (existing.found) throw new Error('这里原来不是字符串，要写入合法的 JSON 值');
            value = text;
          }
        }
        next = JSON.stringify(pointerSet(doc, parsed.pointer, value), null, 1);
      }
      if (journal && run) await journal.capture(run, basePath, before === undefined ? null : before);
      await target.write(parsed.segs, next);
      if (journal && run) await journal.settle(run, basePath, typeof target.read === 'function' ? await target.read(parsed.segs) : next);
      return { path: parsed.canonical, created: before === null || before === undefined, chars: String(text).length };
    }

    async function write(path, text, run) {
      var parsed = parsePath(path), target = provider(parsed);
      if (target.readonly || typeof target.write !== 'function') throw new Error(parsed.mount + ': 是只读的');
      return writeRaw(parsed, target, String(text == null ? '' : text), run);
    }

    async function remove(path, run) {
      var parsed = parsePath(path), target = provider(parsed);
      if (parsed.pointer) {
        var before = await target.read(parsed.segs);
        if (before === null || before === undefined) throw new Error('没有这个文件：' + path);
        var doc = pointerSet(JSON.parse(before), parsed.pointer, undefined, true);
        var basePath = parsed.mount + ':/' + parsed.segs.map(enc).join('/');
        if (journal && run) await journal.capture(run, basePath, before);
        await target.write(parsed.segs, JSON.stringify(doc, null, 1));
        if (journal && run) await journal.settle(run, basePath, await target.read(parsed.segs));
        return { path: parsed.canonical, removed: true };
      }
      if (target.readonly || typeof target.remove !== 'function') throw new Error(parsed.mount + ': 这里不能删除');
      var old = typeof target.read === 'function' ? await target.read(parsed.segs) : null;
      if (old === null || old === undefined) throw new Error('没有这个文件：' + path);
      if (journal && run) await journal.capture(run, parsed.canonical, old);
      await target.remove(parsed.segs);
      if (journal && run) await journal.settle(run, parsed.canonical, null);
      return { path: parsed.canonical, removed: true };
    }

    /* 精确替换。old 必须在文件里恰好出现一次（all=true 时替换全部）。 */
    async function edit(path, oldText, newText, all, run) {
      var text = await readText(path);
      if (text === null) throw new Error('没有这个文件：' + path + '。新建请用 write。');
      var needle = String(oldText == null ? '' : oldText);
      if (!needle) throw new Error('old 不能为空');
      var count = text.split(needle).length - 1;
      if (count === 0) {
        var loose = needle.replace(/\r\n/g, '\n').trim();
        var hint = loose && text.replace(/\r\n/g, '\n').indexOf(loose) >= 0 ? '（去掉首尾空白或换成 \\n 换行后能找到——请原样复制 read 给出的内容，不带行号）' : '';
        throw new Error('没有找到要替换的原文' + hint + '。先 read 或 grep 确认现在的内容。');
      }
      if (count > 1 && !all) throw new Error('要替换的原文出现了 ' + count + ' 次。多带一些上下文让它唯一，或者加 all=true 全部替换。');
      var next = all ? text.split(needle).join(String(newText == null ? '' : newText)) : text.replace(needle, function () { return String(newText == null ? '' : newText); });
      var outcome = await write(path, next, run);
      outcome.replaced = all ? count : 1;
      return outcome;
    }

    async function collect(path, budget) {
      var parsed = parsePath(path), target = provider(parsed);
      if (typeof target.bulk === 'function') {
        var fast = await target.bulk(parsed.segs);
        if (fast) return fast;
      }
      var single = typeof target.read === 'function' ? await Promise.resolve().then(function () { return target.read(parsed.segs); }).catch(function () { return null; }) : null;
      if (single !== null && single !== undefined) return [{ path: parsed.canonical, text: String(single) }];
      var output = [];
      var queue = [parsed.canonical];
      while (queue.length && output.length < budget.files) {
        var dir = queue.shift();
        var listing = await list(dir, { offset: 0, limit: 2000 }).catch(function () { return { items: [] }; });
        for (var index = 0; index < listing.items.length && output.length < budget.files; index += 1) {
          var item = listing.items[index];
          var child = dir.replace(/\/$/, '') + '/' + enc(item.name);
          if (item.dir) { queue.push(child); continue; }
          var text = await readText(child).catch(function () { return null; });
          if (text !== null) output.push({ path: child, text: text });
          var pause = breathe();
          if (pause) await pause;
        }
      }
      return output;
    }

    /* 在一个文件或一棵目录里检索。pattern 是正则（写错时按字面量找）。 */
    async function grep(path, pattern, options) {
      var opts = options || {};
      var flags = String(opts.flags || 'i').replace(/[^imsu]/g, '');
      var expression;
      try { expression = new RegExp(String(pattern), flags); }
      catch (error) { expression = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); }
      var context = Math.max(0, Math.min(5, Math.trunc(Number(opts.context) || 0)));
      var limit = Math.max(1, Math.min(200, Math.trunc(Number(opts.limit) || 40)));
      var files = await collect(path, { files: Math.max(1, Number(opts.maxFiles) || 600) });
      var hits = [], total = 0, matchedFiles = 0;
      for (var index = 0; index < files.length; index += 1) {
        var file = files[index];
        if (opts.signal && opts.signal.aborted) break;
        if (!expression.test(file.text)) continue;
        matchedFiles += 1;
        var lines = file.text.split('\n');
        for (var line = 0; line < lines.length; line += 1) {
          var found = expression.exec(lines[line]);
          if (!found) continue;
          total += 1;
          if (hits.length >= limit) continue;
          var textLine = lines[line];
          /* 极长的行只给命中处前后一段，并给出列号，方便接着 read column=…。 */
          var excerpt = textLine.length > 300
            ? '[列 ' + found.index + '] …' + textLine.slice(Math.max(0, found.index - 100), found.index + 180) + '…'
            : textLine;
          var block = file.path + ':' + (line + 1) + ': ' + excerpt;
          if (context) {
            var from = Math.max(0, line - context), to = Math.min(lines.length, line + context + 1);
            block = file.path + '\n' + numbered(lines.slice(from, to).map(function (item) { return item.length > 300 ? item.slice(0, 300) + '…' : item; }), from + 1);
          }
          hits.push(block);
        }
        var pause = breathe();
        if (pause) await pause;
      }
      return { hits: hits, total: total, files: matchedFiles, scanned: files.length };
    }

    return {
      mount: function (item) { if (!item || !item.id) throw new Error('挂载点缺少 id'); mounts.set(item.id, item); return item; },
      unmount: function (id) { return mounts.delete(id); },
      mounts: function () { return Array.from(mounts.values()); },
      has: function (id) { return mounts.has(id); },
      parse: parsePath, scope: scope, list: list, readText: readText, read: read, write: write, remove: remove, edit: edit, grep: grep
    };
  }

  modules.vfsEnc = enc;
  modules.vfsDec = dec;
  modules.parseVfsPath = parsePath;
  modules.createVfs = createVfs;
})(typeof globalThis !== 'undefined' ? globalThis : window);
