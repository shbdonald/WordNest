// WordNest 记忆曲线（艾宾浩斯阶梯式间隔复习）
// 在 main.html（window）与 background.js（service worker，importScripts）中共用
(function (root) {
  'use strict';

  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;

  // 第 n 次连续答对后，下一次复习的间隔（艾宾浩斯阶梯）
  // stage 0 → 1 天，1 → 2 天，2 → 4 天，3 → 7 天，4 → 15 天，5 → 30 天，6 → 60 天，7+ → 120 天
  const LADDER = [1 * DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY];
  const RELEARN_MS = 10 * MIN;   // 忘记：10 分钟后重来
  const MASTER_STAGE = 5;        // 连续答对 5 轮（已撑过 15 天间隔）视为“已记住”
  const MIGRATE_SPREAD_DAYS = 30; // 旧的「已记住」词：分散在 30 天内各抽查一次

  function reviewKey(userKey) {
    return `${userKey}wordReview`;
  }

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function intervalForStage(stage) {
    const i = Math.max(0, Math.min(LADDER.length - 1, stage | 0));
    return LADDER[i];
  }

  // rating: 'again' 忘记 | 'hard' 模糊 | 'good' 认识
  function schedule(rec, rating, now) {
    if (now == null) now = Date.now();
    const r = Object.assign({ stage: 0, due: 0, last: 0, reps: 0, lapses: 0 }, rec || {});
    if (rating === 'again') {
      r.stage = 0;
      r.lapses += 1;
      r.due = now + RELEARN_MS;
    } else if (rating === 'hard') {
      // 模糊：阶段不升，按上一级间隔再来（至少 1 天）
      r.due = now + intervalForStage(Math.max(0, r.stage - 1));
    } else {
      r.due = now + intervalForStage(r.stage);
      r.stage += 1;
    }
    r.reps += 1;
    r.last = now;
    r.lastRating = rating;
    return r;
  }

  // 由复习记录推导旧的 new/mastered 状态（保持页面标记、统计兼容）
  function statusFor(rec, fallback) {
    if (!rec || !rec.reps) return fallback || 'new';
    return rec.stage >= MASTER_STAGE ? 'mastered' : 'new';
  }

  // 为没有记录的「已记住」词补一条记录：stage=MASTER_STAGE，到期日按词散列分散在 30 天内
  // 未记住且没复习过的词不写记录，视为“新词”
  function migrate(savedWords, statusMap, reviewMap, now) {
    if (now == null) now = Date.now();
    let changed = 0;
    (savedWords || []).forEach((w) => {
      const lower = String(w).toLowerCase();
      if (reviewMap.has(lower)) return;
      const st = statusMap.get(w) || statusMap.get(lower);
      if (st === 'mastered') {
        const offset = (hashStr(lower) % MIGRATE_SPREAD_DAYS + 1) * DAY;
        reviewMap.set(lower, { stage: MASTER_STAGE, due: now + offset, last: 0, reps: 0, lapses: 0, migrated: true });
        changed += 1;
      }
    });
    return changed;
  }

  // 按到期分类：due（到期复习，越早到期越靠前）、fresh（从未复习的新词）、later（还没到期）
  function classify(savedWords, statusMap, reviewMap, now) {
    if (now == null) now = Date.now();
    const due = [];
    const fresh = [];
    const later = [];
    (savedWords || []).forEach((w) => {
      const lower = String(w).toLowerCase();
      const rec = reviewMap.get(lower);
      const st = statusMap.get(w) || statusMap.get(lower) || 'new';
      if (!rec) {
        if (st !== 'mastered') fresh.push(w);
        return;
      }
      if (rec.due <= now) due.push(w);
      else later.push(w);
    });
    const dueOf = (w) => (reviewMap.get(String(w).toLowerCase()) || {}).due || 0;
    due.sort((a, b) => dueOf(a) - dueOf(b));
    later.sort((a, b) => dueOf(a) - dueOf(b));
    return { due, fresh, later, nextDue: later.length ? dueOf(later[0]) : 0 };
  }

  function formatIn(ms) {
    if (ms <= 0) return '现在';
    if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))} 分钟后`;
    if (ms < 20 * 60 * MIN) return `${Math.round(ms / (60 * MIN))} 小时后`;
    return `${Math.round(ms / DAY)} 天后`;
  }

  function strength(rec) {
    // 0~1，用于页面标记深浅：未复习 0，最高阶段 1
    if (!rec || !rec.reps) return 0;
    return Math.min(1, rec.stage / LADDER.length);
  }

  root.WordNestSRS = {
    LADDER, RELEARN_MS, MASTER_STAGE, DAY, MIN,
    reviewKey, schedule, statusFor, migrate, classify, formatIn, strength, intervalForStage
  };
})(typeof self !== 'undefined' ? self : globalThis);
