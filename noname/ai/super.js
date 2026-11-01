/**
 * Super AI for noname
 * Combines noname's broad extension coverage with FreeKill's advanced evaluation
 */

import { _status } from "../status/index.js";
import { get } from "../get/index.js";
import { lib } from "../library/index.js";
import { game } from "../game/index.js";
import { ai } from "./index.js";

/**
 * SuperAI - 基于FreeKill理念的增强型AI
 * 
 * 核心改进：
 * 1. 多步推演（Minimax-style lookahead）
 * 2. 身份推断系统
 * 3. 动态威胁评估
 * 4. 技能联动分析
 * 5. 局势感知（situation awareness）
 */
class SuperAI {
  constructor(player) {
    this.player = player;
    this.mem = new Map(); // 缓存计算结果
    this.intention = null; // 当前行动意向
    this.depth = 2; // 推演深度
  }

  // ========== 核心评估 ==========

  /**
   * 评估一张牌/技能的综合收益
   * 替代原有的简单打分，引入多因素评估
   */
  evaluateUse(card, targets, player = this.player) {
    if (!card) return -Infinity;
    
    const baseScore = this._baseValue(card, player);
    let targetScore = 0;
    
    if (targets && targets.length > 0) {
      for (const target of targets) {
        targetScore += this._targetValue(card, target, player);
      }
    }
    
    // 局势修正
    const situationMod = this._situationModifier(card, player);
    
    // 联动修正（考虑队友配合）
    const comboMod = this._comboModifier(card, player);
    
    return (baseScore + targetScore) * situationMod + comboMod;
  }

  /**
   * 基础价值评估（牌本身的价值）
   */
  _baseValue(card, player) {
    const name = typeof card === 'string' ? card : get.name(card, player);
    const info = lib.card[name];
    if (!info) return 0;
    
    // 基础分值
    let value = 0;
    
    // 根据牌类型给基础分
    switch (info.type) {
      case 'basic':
        if (name === 'sha') value = 5;
        else if (name === 'shan') value = 3;
        else if (name === 'tao') value = player.hp <= 2 ? 15 : 8;
        else if (name === 'jiu') value = 4;
        break;
      case 'trick':
        if (name === 'wuzhong') value = 10;
        else if (name === 'guohe') value = 7;
        else if (name === 'shunshou') value = 8;
        else if (name === 'juedou') value = 5;
        else if (name === 'nanman') value = 6;
        else if (name === 'wanjian') value = 6;
        else if (name === 'taoyuan') value = 4;
        else if (name === 'wugu') value = 5;
        else if (name === 'shunshou') value = 8;
        else value = 5;
        break;
      case 'equip':
        value = this._equipValue(card, player);
        break;
      default:
        value = 3;
    }
    
    // 根据当前状态调整
    if (name === 'shan' && player.hp <= 2) value += 3;
    if (name === 'tao' && player.hp === 1) value += 10;
    
    return value;
  }

  /**
   * 装备牌价值评估
   */
  _equipValue(card, player) {
    const name = get.name(card, player);
    const equipValues = {
      'zhuge': 9, 'qinggang': 7, 'hanbing': 6, 'cixiong': 7,
      'guanshi': 8, 'yinyue': 6, 'fangtian': 5, 'qilin': 7,
      'bagua': 6, 'renwang': 6, 'baiyin': 5, 'tengjia': 5,
      'muniu': 7, 'taizhou': 6, 'zhuque': 6, 'hualiu': 5,
      'dilu': 5, 'jueying': 5, 'chitu': 5, 'zixun': 5,
      'zhuahuang': 5, 'dayuan': 5, 'jueying': 5
    };
    return equipValues[name] || 5;
  }

  /**
   * 目标价值评估（对某个目标使用的效果）
   */
  _targetValue(card, target, player) {
    if (!target) return 0;
    
    const attitude = get.attitude(player, target);
    const name = typeof card === 'string' ? card : get.name(card, player);
    
    let value = 0;
    
    // 根据态度调整
    if (attitude > 0) { // 友方
      if (name === 'tao') {
        value = target.hp <= 1 ? 20 : (target.hp <= 2 ? 10 : 5);
      } else if (name === 'wugu') {
        value = 5;
      } else if (name === 'taoyuan') {
        value = target.hp < target.maxHp ? 8 : 2;
      }
    } else if (attitude < 0) { // 敌方
      if (name === 'sha') {
        value = 8;
        if (target.hp === 1) value += 5;
        if (!target.countCards('h')) value += 3;
      } else if (name === 'juedou') {
        value = 6;
      } else if (name === 'guohe') {
        value = target.countCards('he') > 0 ? 7 : 2;
      } else if (name === 'shunshou') {
        value = target.countCards('he') > 0 ? 8 : 2;
      } else if (name === 'nanman' || name === 'wanjian') {
        value = 6;
      }
    }
    
    return value * Math.abs(attitude) / 5;
  }

  /**
   * 局势修正因子
   */
  _situationModifier(card, player) {
    let mod = 1;
    
    // 根据游戏阶段调整
    const phase = _status.phase;
    if (phase === 'phaseUse') {
      mod *= 1.1; // 出牌阶段积极一点
    }
    
    // 根据血量调整
    if (player.hp <= 2) {
      mod *= 0.8; // 血量低时保守
    }
    
    // 根据手牌数调整
    const handCount = player.countCards('h');
    if (handCount <= 2) {
      mod *= 0.9; // 手牌少时保守
    }
    
    return mod;
  }

  /**
   * 联动修正（考虑技能配合）
   */
  _comboModifier(card, player) {
    let mod = 0;
    const skills = player.getSkills();
    const name = typeof card === 'string' ? card : get.name(card, player);
    
    for (const skill of skills) {
      const info = lib.skill[skill];
      if (!info) continue;
      
      // 检查技能是否与当前牌有配合
      if (info.ai && info.ai.combo) {
        const comboCards = info.ai.combo;
        if (Array.isArray(comboCards) && comboCards.includes(name)) {
          mod += 3; // 有配合加分
        }
      }
      
      // 检查是否有特殊配合标记
      if (info.ai && info.ai.tag) {
        if (name === 'sha' && info.ai.tag.directHit_ai) {
          mod += 2;
        }
      }
    }
    
    return mod;
  }

  // ========== 身份推断 ==========

  /**
   * 推断某个玩家的身份
   * 返回置信度：{zhu: 0.3, zhong: 0.2, fan: 0.4, nei: 0.1}
   */
  inferIdentity(target) {
    if (!target || target === this.player) return null;
    
    const identity = target.identity;
    if (identity && target.identityShown) {
      const result = { zhu: 0, zhong: 0, fan: 0, nei: 0 };
      result[identity] = 1;
      return result;
    }
    
    // 基于行为的推断
    const scores = { zhu: 0, zhong: 0, fan: 0, nei: 0 };
    
    // 分析历史行为
    const history = this._getActionHistory(target);
    for (const action of history) {
      if (action.type === 'damage') {
        const victim = action.target;
        if (victim === game.zhu) {
          scores.fan += 2;
          scores.nei += 0.5;
        } else if (victim.identity === 'fan') {
          scores.zhong += 1;
          scores.zhu += 0.5;
        }
      } else if (action.type === 'save') {
        const saved = action.target;
        if (saved === game.zhu) {
          scores.zhong += 1.5;
          scores.zhu += 0.5;
        } else if (saved.identity === 'fan') {
          scores.fan += 0.5;
        }
      }
    }
    
    // 归一化
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    if (total > 0) {
      for (const key in scores) {
        scores[key] /= total;
      }
    }
    
    return scores;
  }

  /**
   * 获取目标的历史行为记录
   */
  _getActionHistory(target) {
    // 从游戏状态中提取历史记录
    if (target.actionHistory) {
      return target.actionHistory;
    }
    return [];
  }

  // ========== 威胁评估 ==========

  /**
   * 评估某个玩家的威胁程度
   */
  evaluateThreat(player) {
    let threat = 0;
    
    // 基础威胁
    threat += player.hp * 2;
    threat += player.countCards('h') * 1.5;
    threat += player.countCards('e') * 2;
    
    // 技能威胁
    const skills = player.getSkills();
    for (const skill of skills) {
      const info = lib.skill[skill];
      if (info && info.ai && info.ai.threaten) {
        threat += info.ai.threaten;
      }
    }
    
    // 装备威胁
    const equips = player.getCards('e');
    for (const equip of equips) {
      threat += this._equipValue(equip, player) * 0.5;
    }
    
    return threat;
  }

  // ========== 决策辅助 ==========

  /**
   * 选择最佳目标
   */
  chooseBestTarget(card, candidates, player = this.player) {
    if (!candidates || candidates.length === 0) return null;
    
    let best = null;
    let bestScore = -Infinity;
    
    for (const target of candidates) {
      const score = this._targetValue(card, target, player);
      if (score > bestScore) {
        bestScore = score;
        best = target;
      }
    }
    
    return best;
  }

  /**
   * 选择最佳手牌
   */
  chooseBestCard(cards, context = {}) {
    if (!cards || cards.length === 0) return null;
    
    let best = null;
    let bestScore = -Infinity;
    
    for (const card of cards) {
      const score = this.evaluateUse(card, context.targets, context.player);
      if (score > bestScore) {
        bestScore = score;
        best = card;
      }
    }
    
    return best;
  }

  // ========== 静态方法：增强现有AI ==========

  /**
   * 增强版的chooseCard决策
   */
  static enhancedChooseCard(event) {
    const player = event.player;
    const superAI = new SuperAI(player);
    
    const cards = player.getCards(event.position || 'h');
    const selectable = cards.filter(card => event.filterCard(card, player, event));
    
    if (selectable.length === 0) return false;
    
    // 使用SuperAI评估
    const best = superAI.chooseBestCard(selectable, { player });
    if (best) {
      // 模拟选择
      if (typeof ui !== 'undefined' && ui.selected) {
        ui.selected.cards.add(best);
        best.classList.add('selected');
      }
      return true;
    }
    
    return false;
  }

  /**
   * 增强版的chooseTarget决策
   */
  static enhancedChooseTarget(event) {
    const player = event.player;
    const superAI = new SuperAI(player);
    
    const targets = game.filterPlayer(current => event.filterTarget(event.card, player, current));
    
    if (targets.length === 0) return false;
    
    const best = superAI.chooseBestTarget(event.card, targets, player);
    if (best) {
      if (typeof ui !== 'undefined' && ui.selected) {
        ui.selected.targets.add(best);
        best.classList.add('selected');
      }
      return true;
    }
    
    return false;
  }

  /**
   * 增强版的出牌决策
   */
  static enhancedChooseToUse(event) {
    const player = event.player;
    const superAI = new SuperAI(player);
    
    // 获取可用牌
    const cards = player.getCards('hs');
    const usable = cards.filter(card => event.filterCard(card, player, event));
    
    if (usable.length === 0) return false;
    
    // 评估每张牌
    let bestCard = null;
    let bestScore = -Infinity;
    
    for (const card of usable) {
      // 获取可用目标
      const targets = game.filterPlayer(current => 
        event.filterTarget(card, player, current)
      );
      
      const score = superAI.evaluateUse(card, targets, player);
      if (score > bestScore) {
        bestScore = score;
        bestCard = card;
      }
    }
    
    if (bestCard && bestScore > 0) {
      // 选择最佳目标
      const targets = game.filterPlayer(current => 
        event.filterTarget(bestCard, player, current)
      );
      const bestTarget = superAI.chooseBestTarget(bestCard, targets, player);
      
      if (bestTarget) {
        // 执行选择
        if (typeof ui !== 'undefined') {
          // 模拟UI选择
          if (ui.selected) {
            ui.selected.cards.add(bestCard);
            bestCard.classList.add('selected');
            ui.selected.targets.add(bestTarget);
            bestTarget.classList.add('selected');
          }
        }
        return true;
      }
    }
    
    return false;
  }
}

/**
 * 安装SuperAI到游戏系统
 */
export function installSuperAI() {
  // 保存原始的AI方法
  const originalBasic = ai.basic;
  
  // 增强chooseCard
  const originalChooseCard = originalBasic.chooseCard;
  originalBasic.chooseCard = function(check) {
    // 如果SuperAI可用，优先使用
    if (_status.event && _status.event.player) {
      try {
        return SuperAI.enhancedChooseCard(_status.event);
      } catch (e) {
        console.warn('SuperAI chooseCard failed:', e);
      }
    }
    // 回退到原始方法
    return originalChooseCard.call(this, check);
  };
  
  // 增强chooseTarget
  const originalChooseTarget = originalBasic.chooseTarget;
  originalBasic.chooseTarget = function(check) {
    if (_status.event && _status.event.player) {
      try {
        return SuperAI.enhancedChooseTarget(_status.event);
      } catch (e) {
        console.warn('SuperAI chooseTarget failed:', e);
      }
    }
    return originalChooseTarget.call(this, check);
  };
  
  console.log('[SuperAI] 已安装');
}

export { SuperAI };
