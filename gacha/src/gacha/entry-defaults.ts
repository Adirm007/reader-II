/** 角色条目生成里随版本不同的默认值（Reader-II 通用版）。entry.ts 与上游读者相同，只有这个文件不同。 */
import {GENERIC_ENTRY_TEMPLATE} from './entry-template.generated';

/** 没有指定模板时用哪一个：自带的「通用角色条目」。模板系统的模板库里有同一个 id 时用模板库里的那一份（玩家改过的优先）。 */
export const PREFERRED_TEMPLATE_IDS: readonly string[] = ['reader-default-generic-character'];
/** 抽卡包自带的模板（模板库里存的那种形状）：../../../模板/ 里的通用角色条目模板，没有装模板系统也能用。 */
export const BUILTIN_ENTRY_TEMPLATES: readonly unknown[] = [GENERIC_ENTRY_TEMPLATE];
/** 模板没有写目标世界书时写进哪一本。 */
export const DEFAULT_ENTRY_BOOK = 'Reader生成条目';
/** 写条目时一并交给模型的世界观参考（世界书里名称包含这些字样的条目）：通用版不预设，每张卡的规则条目叫法不同，在设置里填。 */
export const DEFAULT_ENTRY_REFERENCES: readonly string[] = [];
/** 设置页里说模板从哪里来。 */
export const TEMPLATE_MANAGER_HINT = '默认用抽卡自带的通用角色模板；装了模板系统时，它模板库里的模板（「条目模仿 → 模板管理」）也可以选';
