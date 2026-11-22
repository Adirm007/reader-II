(function (root) {
  'use strict';

  var modules = root.__ReaderIIModules = root.__ReaderIIModules || {};

  function createSemanticRouter(controller, runtimeStore, economy) {
    function routeFor(slot) {
      if (!modules.isSemanticSlot(slot)) throw new Error('未知语义槽位：' + slot);
      return runtimeStore.read().routing[slot];
    }

    function rootSegments(route) {
      var segments = economy.normalizeHostRef(route && route.rootRef);
      if (!segments) throw new Error('宿主路径引用无效，请重新选择');
      return segments;
    }

    function readBoundValue(data, slot, route) {
      var missing = {};
      var segments = rootSegments(route);
      var value = economy.getHostValue(data, segments, missing);
      if (value === missing) throw new Error('宿主路径已失效，请重新适配');
      return modules.validateSemanticLeaf(slot, value);
    }

    function markBroken(slot, reason) {
      runtimeStore.mutate(function (runtime) {
        var route = runtime.routing[slot];
        if (!route || (route.status !== 'active' && route.status !== 'broken')) return;
        route.status = 'broken';
        route.brokenReason = String(reason || '宿主语义绑定已失效').slice(0, 500);
      });
    }

    function selectedContainer(data, route) {
      var missing = {};
      var value = economy.getHostValue(data, rootSegments(route), missing);
      if (value === missing) throw new Error('宿主容器路径已失效，请重新适配');
      if (!value || typeof value !== 'object') throw new Error('宿主容器类型已改变，请重新适配');
      return value;
    }

    async function selectRoot(slot, input) {
      if (!modules.isSemanticSlot(slot)) throw new Error('未知语义槽位：' + slot);
      var segments = economy.normalizeHostRef(input);
      if (!segments) throw new Error('宿主路径引用无效');
      var stillCurrent = bindingGuard(slot);
      var snapshot = await controller.snapshot();
      stillCurrent();
      var missing = {};
      var value = economy.getHostValue(snapshot.data, segments, missing);
      if (value === missing) throw new Error('宿主路径当前不存在');
      if (slot === 'location' || slot === 'currency') modules.validateSemanticLeaf(slot, value);
      else if (!value || typeof value !== 'object') throw new Error('容器槽必须选择对象或数组根');
      runtimeStore.mutate(function (runtime) {
        runtime.routing[slot] = {
          status: 'draft',
          rootRef: economy.createHostRef(segments),
          brokenReason: ''
        };
        delete runtime.semanticMappings[slot];
        delete runtime.mappingDrafts[slot];
        delete runtime.schemaFingerprints[slot];
      });
      return routeFor(slot);
    }

    /* 候选只在内存里试。提交时在写入队列中重读真实容器，同时切换路由、映射和指纹。 */
    async function activateCandidate(slot, ref, mapping, stillCurrent) {
      var chat = controller.chatKey();
      var route = { status: 'active', rootRef: ref, brokenReason: '' };
      var records = ['routing', 'semanticMappings', 'schemaFingerprints', 'mappingDrafts'];
      var previous;
      try {
        await controller.mutate('confirm_semantic_binding:' + slot, function (data) {
          stillCurrent();
          var checked;
          if (slot === 'location' || slot === 'currency') readBoundValue(data, slot, route);
          else checked = modules.validateSemanticMapping(slot, mapping, ref, selectedContainer(data, route), { allowEmpty: true });
          runtimeStore.mutate(function (state) {
            previous = {};
            records.forEach(function (key) { previous[key] = state[key][slot]; });
            state.routing[slot] = route;
            if (checked) {
              state.semanticMappings[slot] = checked.mapping;
              state.schemaFingerprints[slot] = checked.fingerprint;
              state.mappingDrafts[slot] = checked;
            }
          });
        });
      } catch (error) {
        if (previous && controller.chatKey() === chat && routeFor(slot).rootRef === ref && routeFor(slot).status === 'active') {
          runtimeStore.mutate(function (state) {
            records.forEach(function (key) {
              if (previous[key] === undefined) delete state[key][slot];
              else state[key][slot] = previous[key];
            });
          });
        }
        throw error;
      }
      return routeFor(slot);
    }

    function bindingGuard(slot) {
      var chat = controller.chatKey();
      var before = runtimeStore.read();
      var signature = function (state) { return JSON.stringify([state.routing[slot], state.mappingDrafts[slot], state.semanticMappings[slot]]); };
      var expected = signature(before);
      return function () {
        if (controller.chatKey() !== chat || signature(runtimeStore.read()) !== expected) throw new Error('聊天或槽位绑定已改变，请重新适配');
      };
    }

    async function confirmBinding(slot) {
      var route = routeFor(slot);
      if (route.status !== 'draft') throw new Error('槽位没有待确认草案');
      var draft = runtimeStore.read().mappingDrafts[slot];
      if (modules.SEMANTIC_CONTAINER_SLOTS.indexOf(slot) >= 0 && (!draft || !draft.mapping)) throw new Error('容器映射尚未验证');
      return activateCandidate(slot, route.rootRef, draft && draft.mapping, bindingGuard(slot));
    }

    async function validateMappingDraft(slot, input) {
      if (modules.SEMANTIC_CONTAINER_SLOTS.indexOf(slot) < 0) throw new Error('此槽位不需要容器映射');
      var route = routeFor(slot);
      if (route.status !== 'draft') throw new Error('请先手动选择此槽位的宿主根路径');
      var stillCurrent = bindingGuard(slot);
      var snapshot = await controller.snapshot();
      stillCurrent();
      var checked = modules.validateSemanticMapping(slot, input, route.rootRef, selectedContainer(snapshot.data, route), { allowEmpty: true });
      runtimeStore.mutate(function (runtime) {
        runtime.mappingDrafts[slot] = {
          mapping: checked.mapping,
          fingerprint: checked.fingerprint,
          preview: checked.preview
        };
      });
      return {
        status: 'draft',
        route: route,
        mapping: checked.mapping,
        fingerprint: checked.fingerprint,
        preview: checked.preview
      };
    }

    async function validateMappingBatchDraft(input, requestedSlots) {
      if (!modules.isObject(input)) throw new Error('批量映射必须是包含本次锁定槽位的JSON对象');
      var allowedSlots = modules.SEMANTIC_CONTAINER_SLOTS.slice();
      var requested = Array.isArray(requestedSlots) ? requestedSlots.slice() : Object.keys(input);
      var requestedSet = Object.create(null);
      requested.forEach(function (slot) {
        if (allowedSlots.indexOf(slot) < 0) throw new Error('批量映射包含未知槽位：' + slot);
        requestedSet[slot] = true;
      });
      var slots = allowedSlots.filter(function (slot) { return requestedSet[slot]; });
      if (!slots.length) throw new Error('批量映射没有待分析的锁定容器');
      Object.keys(input).forEach(function (slot) {
        if (allowedSlots.indexOf(slot) < 0) throw new Error('批量映射包含未知槽位：' + slot);
        if (slots.indexOf(slot) < 0) throw new Error('批量映射包含本次未锁定的槽位：' + slot);
      });
      var checks = slots.map(bindingGuard);
      var snapshot = await controller.snapshot();
      checks.forEach(function (check) { check(); });
      var checkedBySlot = {};
      slots.forEach(function (slot) {
        if (!Object.prototype.hasOwnProperty.call(input, slot)) throw new Error('批量映射缺少本次锁定槽位：' + slot);
        var route = routeFor(slot);
        if (route.status !== 'draft') throw new Error('请先锁定四个容器根：' + slot + ' 尚未处于草案态');
        checkedBySlot[slot] = {
          route: route,
          checked: modules.validateSemanticMapping(slot, input[slot], route.rootRef, selectedContainer(snapshot.data, route), { allowEmpty: true })
        };
      });
      runtimeStore.mutate(function (runtime) {
        slots.forEach(function (slot) {
          var checked = checkedBySlot[slot].checked;
          runtime.mappingDrafts[slot] = {
            mapping: checked.mapping,
            fingerprint: checked.fingerprint,
            preview: checked.preview
          };
        });
      });
      var output = {};
      slots.forEach(function (slot) {
        var item = checkedBySlot[slot];
        output[slot] = {
          status: 'draft',
          route: item.route,
          mapping: item.checked.mapping,
          fingerprint: item.checked.fingerprint,
          preview: item.checked.preview
        };
      });
      return output;
    }

    function fallbackCharacters(reader) {
      var relations = reader && reader.关系列表;
      if (!modules.isObject(relations)) return [];
      var output = [];
      Object.keys(relations).forEach(function (name) {
        var relation = relations[name];
        if (!name || !modules.isObject(relation)) return;
        var item = { name: name };
        var favor = Number(relation.好感度);
        if (Number.isFinite(favor) && favor >= 0 && favor <= 100) item.favor = favor;
        var present = modules.normalizeSemanticPresence(relation.在场);
        if (present !== null) item.present = present;
        if (typeof relation.身份 === 'string' && relation.身份.trim()) item.identity = relation.身份.trim();
        else if (Array.isArray(relation.身份)) item.identity = relation.身份.filter(function (value) { return typeof value === 'string' && value.trim(); });
        if (present === true) item.details = modules.clone(relation);
        output.push(item);
      });
      return output;
    }

    function fallbackNames(record) {
      if (!modules.isObject(record)) return [];
      return Object.keys(record).filter(function (name) { return name && ['__proto__', 'prototype', 'constructor'].indexOf(name) < 0; });
    }

    function fallbackStatuses(reader) {
      var effects = reader && reader.主角 && reader.主角.状态效果;
      if (!modules.isObject(effects)) return [];
      var output = [];
      Object.keys(effects).forEach(function (name) {
        var effect = effects[name];
        if (!modules.isObject(effect) || typeof effect.效果 !== 'string' || !effect.效果.trim()
          || typeof effect.剩余时间 !== 'string' || !effect.剩余时间.trim()) return;
        var item = { name: name, effect: effect.效果, duration: effect.剩余时间 };
        if (typeof effect.来源 === 'string' && effect.来源.trim()) item.source = effect.来源;
        output.push(item);
      });
      return output;
    }

    async function readContainerSlot(slot) {
      var snapshot = await controller.snapshot();
      var route = routeFor(slot);
      if (route.status === 'broken') throw new Error('宿主' + slot + '绑定已损坏，请重新适配：' + (route.brokenReason || '结构验证失败'));
      if (route.status !== 'active') {
        if (slot === 'characters') return fallbackCharacters(snapshot.reader);
        if (slot === 'tasks') return fallbackNames(snapshot.reader && snapshot.reader.任务列表);
        if (slot === 'skills') return fallbackNames(snapshot.reader && snapshot.reader.主角 && snapshot.reader.主角.技能);
        if (slot === 'statuses') return fallbackStatuses(snapshot.reader);
        if (slot === 'inventory') {
          var bag = snapshot.reader && snapshot.reader.背包;
          return modules.isObject(bag) ? modules.readSemanticInventory(modules.FALLBACK_INVENTORY_MAPPING, bag) : [];
        }
        return [];
      }
      var target = boundContainer(snapshot.data, slot, route);
      return modules.normalizeSemanticContainer(target.mapping, target.container);
    }

    async function listCharacterNames() {
      var snapshot = await controller.snapshot();
      var route = routeFor('characters');
      if (route.status === 'active' || route.status === 'broken') return [];
      return fallbackNames(snapshot.reader && snapshot.reader.关系列表);
    }

    async function insertStatusIfAbsent(input) {
      var canonical = modules.normalizeCanonicalStatus(input);
      return controller.mutate('insert_status_if_absent:' + canonical.name, function (data, reader) {
        var route = routeFor('statuses');
        if (route.status === 'broken') throw new Error(route.brokenReason || '宿主状态绑定已损坏');
        if (route.status !== 'active') {
          var effects = reader && reader.主角 && reader.主角.状态效果;
          if (!modules.isObject(effects)) throw new Error('Reader状态后备路径不可用');
          if (Object.prototype.hasOwnProperty.call(effects, canonical.name)) {
            return { inserted: false, status: canonical };
          }
          var entry = {
            类型: '特殊',
            效果: canonical.effect,
            层数: 1,
            剩余时间: canonical.duration,
            来源: canonical.source || '九十九夜梦'
          };
          effects[canonical.name] = entry;
          return {
            inserted: true,
            status: canonical,
            locator: { kind: 'reader', key: canonical.name },
            target: { kind: 'reader_status', key: canonical.name },
            entry: modules.clone(entry)
          };
        }
        var target = boundContainer(data, 'statuses', route);
        var container = target.container;
        var result = modules.insertSemanticStatusIfAbsent(target.mapping, container, canonical);
        if (result.inserted) result.target = {
          kind: 'host_status',
          rootRef: route.rootRef,
          locator: modules.clone(result.locator)
        };
        runtimeStore.mutate(function (state) {
          state.schemaFingerprints.statuses = modules.semanticStructureFingerprint(container);
        });
        return result;
      });
    }

    async function rollbackStatusInsertion(operation) {
      var target = operation && operation.target;
      var entry = operation && operation.entry;
      if (!target || !entry) return false;
      var stringify = modules.stableStringify || JSON.stringify;
      var same = function (left, right) { return stringify(left) === stringify(right); };
      return controller.mutate('rollback_semantic_status_insert', function (data, reader) {
        if (target.kind === 'reader_status') {
          var effects = reader && reader.主角 && reader.主角.状态效果;
          if (modules.isObject(effects) && same(effects[target.key], entry)) {
            delete effects[target.key];
            return true;
          }
          return false;
        }
        if (target.kind !== 'host_status') return false;
        var container = economy.getHostValue(data, target.rootRef, undefined);
        if (Array.isArray(container)) {
          var index = target.locator && target.locator.index;
          if (Number.isInteger(index) && same(container[index], entry)) {
            container.splice(index, 1);
            return true;
          }
          var exact = container.findIndex(function (item) { return same(item, entry); });
          if (exact >= 0) {
            container.splice(exact, 1);
            return true;
          }
          return false;
        }
        if (modules.isObject(container)) {
          var key = target.locator && target.locator.key;
          if (key && same(container[key], entry)) {
            delete container[key];
            return true;
          }
        }
        return false;
      });
    }

    async function removeStatus(name) {
      var targetName = String(name || '').trim();
      if (!targetName) return { removed: false };
      return controller.mutate('remove_status:' + targetName, function (data, reader) {
        var route = routeFor('statuses');
        if (route.status === 'broken') return { removed: false };
        if (route.status !== 'active') {
          var effects = reader && reader.主角 && reader.主角.状态效果;
          if (!modules.isObject(effects) || !Object.prototype.hasOwnProperty.call(effects, targetName)) {
            return { removed: false };
          }
          var oldEntry = modules.clone(effects[targetName]);
          delete effects[targetName];
          return {
            removed: true,
            target: { kind: 'reader_status', key: targetName },
            entry: oldEntry
          };
        }
        var bound = boundContainer(data, 'statuses', route);
        var container = bound.container;
        var mapping = bound.mapping;
        if (Array.isArray(container)) {
          var namePath = mapping && mapping.name && Array.isArray(mapping.name.path) ? mapping.name.path : ['名称'];
          var idx = container.findIndex(function (item) {
            if (!modules.isObject(item)) return false;
            var cur = item;
            for (var i = 0; i < namePath.length; i += 1) {
              if (!cur || typeof cur !== 'object') { cur = undefined; break; }
              cur = cur[namePath[i]];
            }
            return typeof cur === 'string' && cur.trim() === targetName;
          });
          if (idx < 0) return { removed: false };
          var removedEntry = modules.clone(container[idx]);
          container.splice(idx, 1);
          return {
            removed: true,
            target: { kind: 'host_status', rootRef: route.rootRef, locator: { index: idx } },
            entry: removedEntry
          };
        }
        if (modules.isObject(container)) {
          var hitKey = null;
          if (mapping && mapping.name && mapping.name.from === 'key') {
            if (Object.prototype.hasOwnProperty.call(container, targetName)) hitKey = targetName;
          } else {
            var kPath = mapping && mapping.name && Array.isArray(mapping.name.path) ? mapping.name.path : [];
            hitKey = Object.keys(container).find(function (k) {
              if (k === targetName) return true;
              var cur = container[k];
              for (var i = 0; i < kPath.length; i += 1) {
                if (!cur || typeof cur !== 'object') { cur = undefined; break; }
                cur = cur[kPath[i]];
              }
              return typeof cur === 'string' && cur.trim() === targetName;
            }) || null;
          }
          if (!hitKey || !Object.prototype.hasOwnProperty.call(container, hitKey)) return { removed: false };
          var removedObj = modules.clone(container[hitKey]);
          delete container[hitKey];
          return {
            removed: true,
            target: { kind: 'host_status', rootRef: route.rootRef, locator: { key: hitKey } },
            entry: removedObj
          };
        }
        return { removed: false };
      });
    }

    async function rollbackStatusRemoval(operation) {
      var target = operation && operation.target;
      var entry = operation && operation.entry;
      if (!target || entry === undefined) return false;
      return controller.mutate('rollback_semantic_status_remove', function (data, reader) {
        if (target.kind === 'reader_status') {
          var effects = reader && reader.主角 && reader.主角.状态效果;
          if (modules.isObject(effects) && !Object.prototype.hasOwnProperty.call(effects, target.key)) {
            effects[target.key] = modules.clone(entry);
            return true;
          }
          return false;
        }
        if (target.kind !== 'host_status') return false;
        var container = economy.getHostValue(data, target.rootRef, undefined);
        if (Array.isArray(container)) {
          var pos = target.locator && Number.isInteger(target.locator.index) ? target.locator.index : container.length;
          container.splice(Math.min(Math.max(0, pos), container.length), 0, modules.clone(entry));
          return true;
        }
        if (modules.isObject(container)) {
          var key = target.locator && target.locator.key;
          if (key && !Object.prototype.hasOwnProperty.call(container, key)) {
            container[key] = modules.clone(entry);
            return true;
          }
        }
        return false;
      });
    }

    async function unbind(slot) {
      if (!modules.isSemanticSlot(slot)) throw new Error('未知语义槽位：' + slot);
      runtimeStore.mutate(function (runtime) {
        runtime.routing[slot] = { status: 'unbound', rootRef: '', brokenReason: '' };
        delete runtime.semanticMappings[slot];
        delete runtime.mappingDrafts[slot];
        delete runtime.schemaFingerprints[slot];
      });
      await controller.mutate('unbind_semantic_slot:' + slot, function () {});
      return routeFor(slot);
    }

    /*
     * ---------- 事务内同步读写 ----------
     * 控制器里的 ReaderTransactions 在一次 updateVariablesWith 提交中直接改写传入的 data
     * （楼层变量根，含 stat_data）。这里按当前语义路由把“货币 / 状态 / 背包”落到宿主路径或 Reader 后备。
     */
    var FALLBACK_STATUS_MAPPING = {
      version: 1,
      slot: 'statuses',
      rootRef: '',
      containerKind: 'object',
      name: { from: 'key' },
      fields: { effect: { path: ['效果'] }, duration: { path: ['剩余时间'] }, source: { path: ['来源'] } },
      construct: { constants: [{ path: ['类型'], value: '特殊' }, { path: ['层数'], value: 1 }] }
    };

    function liveRoute(slot) {
      var route = routeFor(slot);
      if (route.status === 'broken') throw new Error(route.brokenReason || '宿主绑定已损坏，请在 Reader Core 面板重新适配');
      return route;
    }

    function ownObject(parent, key) {
      if (!modules.isObject(parent[key])) parent[key] = {};
      return parent[key];
    }

    function fallbackReader(data, create) {
      if (!modules.isObject(data)) throw new Error('楼层变量不可用');
      if (!create) return modules.isObject(data.stat_data) && modules.isObject(data.stat_data.READER) ? data.stat_data.READER : null;
      return ownObject(ownObject(data, 'stat_data'), 'READER');
    }

    function boundContainer(data, slot, route) {
      try {
        var state = runtimeStore.read();
        var mapping = state.semanticMappings[slot];
        if (!mapping) throw new Error('宿主映射缺失，请重新适配');
        var container = selectedContainer(data, route);
        var fingerprint = modules.semanticStructureFingerprint(container);
        if (state.schemaFingerprints[slot] !== fingerprint) {
          var checked = modules.validateSemanticMapping(slot, mapping, route.rootRef, container, { allowEmpty: true });
          runtimeStore.mutate(function (runtime) { runtime.schemaFingerprints[slot] = checked.fingerprint; });
        }
        return { mapping: mapping, container: container };
      } catch (error) {
        markBroken(slot, error.message || String(error));
        throw error;
      }
    }

    function txCurrencyRead(data) {
      var route = liveRoute('currency');
      if (route.status !== 'active') {
        var reader = fallbackReader(data, false);
        var raw = reader ? Number(reader.命运点数) : 0;
        return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
      }
      var missing = {};
      var value = economy.getHostValue(data, rootSegments(route), missing);
      if (value === missing || typeof value !== 'number' || !Number.isFinite(value)) throw new Error('还没有读到有效的宿主货币，请等待角色资料就绪或重新适配');
      return value;
    }

    function txCurrencyWrite(data, next) {
      var value = Number(next);
      if (!Number.isFinite(value) || value < 0) throw new Error('无效的货币余额');
      var route = liveRoute('currency');
      if (route.status !== 'active') fallbackReader(data, true).命运点数 = Math.trunc(value);
      else economy.setHostValue(data, rootSegments(route), value);
      return value;
    }

    function txStatusTarget(data, create) {
      var route = liveRoute('statuses');
      if (route.status === 'active') return boundContainer(data, 'statuses', route);
      var reader = fallbackReader(data, create);
      if (!reader) return { mapping: FALLBACK_STATUS_MAPPING, container: {} };
      if (!create) {
        var existing = reader.主角 && reader.主角.状态效果;
        return { mapping: FALLBACK_STATUS_MAPPING, container: modules.isObject(existing) ? existing : {} };
      }
      return { mapping: FALLBACK_STATUS_MAPPING, container: ownObject(ownObject(reader, '主角'), '状态效果') };
    }

    function txStatusList(data) {
      var target = txStatusTarget(data, false);
      return modules.normalizeSemanticContainer(target.mapping, target.container);
    }

    function txStatusSet(data, status) {
      var target = txStatusTarget(data, true);
      return modules.upsertSemanticStatus(target.mapping, target.container, status);
    }

    function txInventoryTarget(data, create) {
      var route = liveRoute('inventory');
      if (route.status === 'active') return boundContainer(data, 'inventory', route);
      var reader = fallbackReader(data, create);
      if (!reader) return { mapping: modules.FALLBACK_INVENTORY_MAPPING, container: {} };
      if (!create) return { mapping: modules.FALLBACK_INVENTORY_MAPPING, container: modules.isObject(reader.背包) ? reader.背包 : {} };
      return { mapping: modules.FALLBACK_INVENTORY_MAPPING, container: ownObject(reader, '背包') };
    }

    function txInventoryList(data) {
      var target = txInventoryTarget(data, false);
      return modules.readSemanticInventory(target.mapping, target.container);
    }

    function txInventoryAdd(data, item, options) {
      var target = txInventoryTarget(data, true);
      return modules.addSemanticInventoryItem(target.mapping, target.container, item, options);
    }

    function txInventoryRemove(data, name, amount) {
      var target = txInventoryTarget(data, true);
      return modules.removeSemanticInventoryItem(target.mapping, target.container, name, amount);
    }

    /* 背包映射里声明了哪些字段（抽卡据此决定品质、来源写在哪里）。 */
    function inventoryShape() {
      var route = routeFor('inventory');
      var mapping = route.status === 'active' ? runtimeStore.read().semanticMappings.inventory : modules.FALLBACK_INVENTORY_MAPPING;
      if (!mapping) return { bound: route.status === 'active', entryKind: 'object', fields: [] };
      return {
        bound: route.status === 'active',
        status: route.status,
        entryKind: mapping.entryKind || 'object',
        fields: Object.keys(mapping.fields || {}),
        stackable: mapping.entryKind === 'count' || (mapping.entryKind !== 'name' && !!(mapping.fields && mapping.fields.count))
      };
    }

    async function getLocation() {
      var snapshot = await controller.snapshot();
      var route = routeFor('location');
      if (route.status === 'active') {
        try { return readBoundValue(snapshot.data, 'location', route); }
        catch (error) {
          markBroken('location', error.message || String(error));
          throw error;
        }
      }
      if (route.status === 'broken') throw new Error(route.brokenReason || '当前地点绑定已损坏');
      return typeof snapshot.reader.地点 === 'string' ? snapshot.reader.地点 : '';
    }

    return {
      getRoute: routeFor,
      selectRoot: selectRoot,
      confirmBinding: confirmBinding,
      bindingGuard: bindingGuard,
      activateCandidate: activateCandidate,
      unbind: unbind,
      validateMappingDraft: validateMappingDraft,
      validateMappingBatchDraft: validateMappingBatchDraft,
      getLocation: getLocation,
      listImportantCharacters: function () { return readContainerSlot('characters'); },
      listCharacterNames: listCharacterNames,
      listTaskNames: function () { return readContainerSlot('tasks'); },
      listSkillNames: function () { return readContainerSlot('skills'); },
      hasSkill: async function (name) {
        var target = String(name || '').trim();
        return target ? (await readContainerSlot('skills')).indexOf(target) >= 0 : false;
      },
      listStatuses: function () { return readContainerSlot('statuses'); },
      findStatus: async function (query) {
        var list = await readContainerSlot('statuses');
        if (typeof query === 'function') return list.find(query);
        var target = String(query || '');
        return list.find(function (status) { return status.name === target; });
      },
      insertStatusIfAbsent: insertStatusIfAbsent,
      rollbackStatusInsertion: rollbackStatusInsertion,
      removeStatus: removeStatus,
      rollbackStatusRemoval: rollbackStatusRemoval,
      listInventory: function () { return readContainerSlot('inventory'); },
      inventoryShape: inventoryShape,
      sync: {
        currencyRead: txCurrencyRead,
        currencyWrite: txCurrencyWrite,
        statusList: txStatusList,
        statusSet: txStatusSet,
        inventoryList: txInventoryList,
        inventoryAdd: txInventoryAdd,
        inventoryRemove: txInventoryRemove
      }
    };
  }

  modules.createSemanticRouter = createSemanticRouter;
})(typeof globalThis !== 'undefined' ? globalThis : window);
