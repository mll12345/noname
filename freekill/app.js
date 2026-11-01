// 新月杀 Web —— 浏览器端控制器
//
// 分工：
//   Lua（game.lua）负责规则、AI、状态机、交互合法性
//   JS（本文件）只负责两件事：
//     1. 把 Game.snapshot() 投影成 DOM
//     2. 把点击翻译成 Game.click() / Game.reply()
//
// 之所以能这么薄，是因为原版 ui_emu 把"渲染什么"和"点了之后算不算数"
// 拆开了：场景只吐出 Photo / CardItem / Button / SkillButton 这几类元素，
// 合不合法全在 Lua 里判。

(function () {
  "use strict";

  // ---------------------------------------------------------------- 小工具

  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  // Lua 的空表会变成 {}，数组也可能变对象，统一兜一下
  const arr = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);

  const IMG = window.FK_IMG || {};
  const CARD1 = new Set(IMG.cards || []);
  const CARD2 = new Set(IMG.cards2 || []);
  const GENS = new Set(IMG.generals || []);

  function cardArt(raw) {
    if (!raw) return "";
    if (CARD1.has(raw)) return "assets/cards/" + raw + ".png";
    if (CARD2.has(raw)) return "assets/cards2/" + raw + ".png";
    return "";
  }

  function generalArt(g) {
    return g && GENS.has(g) ? "assets/generals/" + g + ".jpg" : "";
  }

  // ---------------------------------------------------------------- 状态

  let api = null; // Game_api
  let S = null; // 最近一次快照
  let waiter = null; // 玩家操作的唤醒器
  let running = false;
  let lastRenderAt = 0;
  let logShown = 0;

  function wake() {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  }

  // 等待玩家操作。带超时：即使玩家不动，也要让 Lua 那边继续推进
  // （选将超时、无懈可击的读条都靠这个）
  function waitInput() {
    return new Promise((res) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (waiter === fin) waiter = null;
        res();
      };
      waiter = fin;
      const t = setTimeout(fin, 450);
    });
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  // ---------------------------------------------------------------- 启动

  function progress(pct, text) {
    const bar = $("#boot-progress");
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (text) $("#boot-status").textContent = text;
  }

  async function boot() {
    try {
      progress(8, "唤醒 Lua 虚拟机…");
      await sleep(20);

      const { lua } = await FKLoader.bootLua({
        src: window.FK_LUA,
        log: (kind, msg) => {
          if (kind === "crit" || kind === "warn") console.warn("[" + kind + "]", msg);
        },
      });

      progress(30, "载入内核…");
      await sleep(16);
      await lua.doString('dofile("lua/freekill.lua")');

      progress(62, "载入会话层…");
      await sleep(16);
      const gameSrc = window.FK_LUA["fkweb/game.lua"];
      if (!gameSrc) throw new Error("lua_bundle 里没有 fkweb/game.lua");
      await lua.doString("(function()\n" + gameSrc + "\nend)()");

      progress(82, "载入客户端…");
      await sleep(16);
      await lua.doString('dofile("lua/client/client.lua")');
      await lua.doString('dofile("lua/server/scheduler.lua")');

      api = await lua.global.get("Game_api");
      if (typeof api !== "function") throw new Error("Game_api 没有注册成功");
      window.FK_API = api; // 调试用

      progress(100, "就绪");
      await sleep(220);
      const boot = $("#boot");
      boot.classList.add("gone");
      $("#start").classList.add("show");
      // 淡出结束再彻底拿掉，否则会透在开始页上
      setTimeout(() => {
        boot.style.display = "none";
      }, 560);
    } catch (e) {
      console.error(e);
      progress(100, "启动失败：" + (e && e.message ? e.message : e));
      $("#boot-status").style.color = "#ff5a44";
    }
  }

  // ---------------------------------------------------------------- 开局

  let playerCount = 5;

  async function startGame() {
    $("#start").classList.remove("show");
    $("#table").classList.add("show");
    $("#over").classList.remove("show");

    const ids = [];
    for (let i = 1; i <= playerCount; i++) ids.push(i);

    const r = api("new", ids.join(","), "aaa_role_mode");
    if (r !== "ok") {
      toast("开局失败");
      return;
    }

    // 清掉上一局的 DOM 缓存标记
    for (const sel of ["#seats", "#hand", "#skills", "#special", "#actions", "#pick"]) {
      const el = $(sel);
      if (el) {
        el.dataset.sig = "";
        el.innerHTML = "";
      }
    }
    logShown = 0;
    $("#log-body").innerHTML = "";
    $("#log").classList.remove("open");

    render(true);
    loop();
  }

  // ---------------------------------------------------------------- 主循环

  async function loop() {
    running = true;
    let idle = 0;

    while (running) {
      let st = "wait",
        msRaw = "0",
        aw = "0",
        dlg = "0";
      try {
        const parts = String(api("step", "")).split("|");
        st = parts[0];
        msRaw = parts[1] || "0";
        aw = parts[2] || "0";
        dlg = parts[3] || "0";
      } catch (e) {
        console.error("[step]", e);
        break;
      }

      if (st === "over") {
        render(true);
        finish();
        return;
      }

      if (st === "delay") {
        render(true);
        await sleep(Math.min(Number(msRaw) || 0, 60));
        continue;
      }

      // st === "wait"
      const now = Date.now();
      if (aw === "1" || dlg === "1" || now - lastRenderAt > 120) render(false);

      if (aw === "1" || dlg === "1") {
        idle = 0;
        await waitInput();
      } else {
        idle++;
        await sleep(idle > 300 ? 4 : 0);
      }
    }
  }

  function finish() {
    running = false;
    const w = S && S.winner ? String(S.winner) : "";
    const win = w.split("+").indexOf("1") >= 0;
    const title = $("#over-title");
    title.textContent = win ? "胜" : "败";
    title.classList.toggle("lose", !win);
    $("#over-sub").textContent = win ? "主公一脉，笑到最后" : "牌局已终，来日再战";
    $("#over").classList.add("show");
  }

  // ---------------------------------------------------------------- 渲染

  function render(force) {
    let s;
    try {
      s = JSON.parse(api("snap"));
    } catch (e) {
      return;
    }
    S = s;
    lastRenderAt = Date.now();

    renderSeats(s);
    renderCenter(s);
    renderPiles(s);
    renderMe(s);
    renderLog(s);
    renderDialog(s);
  }

  // ---- 座位

  function photoMap(s) {
    const m = new Map();
    const sc = s.scene;
    if (sc) for (const p of arr(sc.Photo)) m.set(String(p.id), p);
    return m;
  }

  function hpDots(hp, maxHp, shield) {
    let out = "";
    const total = Math.max(maxHp, hp);
    for (let i = 0; i < total; i++) {
      out += '<i class="hpdot' + (i < hp ? " on" : "") + '"></i>';
    }
    for (let i = 0; i < (shield || 0); i++) out += '<i class="hpdot shield"></i>';
    return out;
  }

  function roleGlyph(role) {
    if (role === "lord") return "主";
    if (role === "loyalist") return "忠";
    if (role === "rebel") return "反";
    if (role === "renegade") return "内";
    return "";
  }

  function seatHtml(p, ph) {
    const cls = ["seat"];
    if (p.dead) cls.push("dead");
    if (p.isCurrent) cls.push("current");
    if (ph && ph.enabled) cls.push("targetable");
    if (ph && ph.selected) cls.push("selected");

    const art = generalArt(p.general);
    const role = roleGlyph(p.role);

    const gear = arr(p.equips)
      .map((c) => "<i>" + esc(c.name) + "</i>")
      .join("");
    const marks = arr(p.marks)
      .map((m) => "<span>" + esc(m.label) + (m.value ? esc(m.value) : "") + "</span>")
      .join("");

    return (
      '<div class="' +
      cls.join(" ") +
      '" data-pid="' +
      esc(p.id) +
      '">' +
      '<div class="face"' +
      (art ? ' style="background-image:url(' + art + ')"' : "") +
      ">" +
      (role ? '<div class="role ' + esc(p.role) + '">' + role + "</div>" : "") +
      '<div class="handcount">' +
      (p.handCount || 0) +
      "</div>" +
      '<div class="nm">' +
      esc(p.generalLabel || p.name) +
      "</div>" +
      "</div>" +
      '<div class="hpbar">' +
      hpDots(p.hp, p.maxHp, p.shield) +
      "</div>" +
      (gear ? '<div class="gear">' + gear + "</div>" : "") +
      (marks ? '<div class="marks">' + marks + "</div>" : "") +
      "</div>"
    );
  }

  function renderSeats(s) {
    const box = $("#seats");
    const photo = photoMap(s);
    const others = arr(s.players).filter((p) => !p.isSelf);

    const sig = JSON.stringify(
      others.map((p) => {
        const ph = photo.get(String(p.id));
        return [
          p.id, p.general, p.name, p.hp, p.maxHp, p.shield, p.handCount, p.dead,
          p.role, p.isCurrent,
          ph ? (ph.enabled ? 1 : 0) : -1,
          ph && ph.selected ? 1 : 0,
          arr(p.equips).map((e) => e.id).join(","),
          arr(p.marks).map((m) => m.label + ":" + m.value).join(","),
        ];
      })
    );
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.classList.toggle("dense", others.length > 4);
    box.innerHTML = others.map((p) => seatHtml(p, photo.get(String(p.id)))).join("");
  }

  // ---- 卡牌

  function cardHtml(c, flags, extra) {
    const url = cardArt(c.raw);
    const cls = ["card"];
    cls.push(c.color === "red" ? "red" : "black");
    if (flags) {
      if (flags.enabled) cls.push("selectable");
      if (flags.selected) cls.push("selected");
      if (!flags.enabled && S && S.awaiting) cls.push("disabled");
    }
    if (extra) cls.push(extra);
    return (
      '<div class="' +
      cls.join(" ") +
      '" data-cid="' +
      esc(c.id) +
      '">' +
      '<div class="art"' +
      (url ? ' style="background-image:url(' + url + ')"' : "") +
      "></div>" +
      '<div class="sn">' +
      esc(c.suit) +
      esc(c.number) +
      "</div>" +
      '<div class="cn">' +
      esc(c.name) +
      "</div>" +
      "</div>"
    );
  }

  function cardItemMap(s) {
    const m = new Map();
    const sc = s.scene;
    if (sc) for (const c of arr(sc.CardItem)) m.set(String(c.id), c);
    return m;
  }

  // 不在手牌里的可选卡（弃牌堆、别人装备区……）
  function renderPick(s) {
    const box = $("#pick");
    const items = [];
    const sc = s.scene;
    const handIds = new Set(arr(s.hand).map((c) => String(c.id)));
    if (sc) {
      for (const it of arr(sc.CardItem)) {
        if (handIds.has(String(it.id))) continue;
        if (!it.card) continue;
        items.push(it);
      }
    }
    const sig = JSON.stringify(items.map((i) => [i.id, i.enabled ? 1 : 0, i.selected ? 1 : 0]));
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = items.length
      ? items.map((i) => cardHtml(i.card, { enabled: i.enabled, selected: i.selected })).join("")
      : "";
  }

  function renderHand(s) {
    const box = $("#hand");
    const map = cardItemMap(s);
    const hand = arr(s.hand);

    const sig = JSON.stringify(
      hand.map((c) => {
        const it = map.get(String(c.id));
        return [c.id, it ? (it.enabled ? 1 : 0) : 0, it && it.selected ? 1 : 0];
      })
    );
    if (box.dataset.sig === sig) return;

    const keep = box.scrollLeft;
    box.dataset.sig = sig;
    box.innerHTML = hand
      .map((c) => {
        const it = map.get(String(c.id));
        return cardHtml(c, it ? { enabled: it.enabled, selected: it.selected } : null);
      })
      .join("");
    box.scrollLeft = keep;
  }

  // ---- 中央区 / 按钮

  // 提示串里带一点点 HTML（<br>、<font color=...>），只放行这两种
  function formatPrompt(text) {
    if (!text) return "";
    return esc(text)
      .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
      .replace(
        /&lt;font\s+color=['"]?([^'">\s]+)['"]?&gt;([\s\S]*?)&lt;\/font&gt;/gi,
        '<span style="color:$1">$2</span>'
      )
      .replace(/【([^】]*)】/g, "<em>【$1】</em>")
      .replace(/「([^」]*)」/g, "<em>「$1」</em>");
  }

  const BTN_LABEL = { OK: "确 定", Cancel: "取 消", End: "结 束", Trust: "托 管" };

  function renderCenter(s) {
    const sc = s.scene;
    const promptEl = $("#prompt");
    const text = sc && sc.prompt ? sc.prompt : "";

    const shown = text || (s.awaiting ? "" : "");
    if (promptEl.dataset.t !== shown) {
      promptEl.dataset.t = shown;
      promptEl.innerHTML = formatPrompt(shown);
    }

    renderPick(s);

    const acts = $("#actions");
    const btns = sc ? arr(sc.Button) : [];
    const sig = JSON.stringify(btns.map((b) => [b.id, b.enabled ? 1 : 0]));
    if (acts.dataset.sig === sig) return;
    acts.dataset.sig = sig;
    acts.innerHTML = btns
      .map((b) => {
        const id = String(b.id);
        let cls = "act";
        if (id === "OK") cls += " ok";
        else if (id === "Cancel") cls += " cancel";
        else if (id === "End") cls += " end";
        const label = BTN_LABEL[id] || esc(id);
        return (
          '<button class="' + cls + '" data-bid="' + esc(id) + '"' +
          (b.enabled ? "" : " disabled") + ">" + label + "</button>"
        );
      })
      .join("");
  }

  // ---- 我的区域

  function renderMe(s) {
    const me = s.me;
    if (!me) return;
    const sc = s.scene;

    const art = generalArt(me.general);
    const face = $("#me-face");
    if (face.dataset.art !== art) {
      face.dataset.art = art;
      face.style.backgroundImage = art ? "url(" + art + ")" : "";
    }
    const nm = $("#me-name");
    const label = me.generalLabel || me.name || "";
    if (nm.dataset.t !== label) {
      nm.dataset.t = label;
      nm.innerHTML =
        esc(label) + (me.role ? ' <span style="color:#d8b46a">[' + esc(roleGlyph(me.role)) + "]</span>" : "");
    }

    const hpBox = $("#me-hp");
    const hpSig = [me.hp, me.maxHp, me.shield].join("/");
    if (hpBox.dataset.sig !== hpSig) {
      hpBox.dataset.sig = hpSig;
      hpBox.innerHTML = hpDots(me.hp, me.maxHp, me.shield);
    }

    // 自己的牌也是可选目标（桃、铁索连环、无中生有……）
    const ph = photoMap(s).get(String(me.id));
    const info = $("#me-info");
    info.classList.toggle("targetable", !!(ph && ph.enabled));
    info.classList.toggle("selected", !!(ph && ph.selected));

    // 技能
    const skBox = $("#skills");
    const skills = sc ? arr(sc.SkillButton) : [];
    const skSig = JSON.stringify(skills.map((k) => [k.id, k.enabled ? 1 : 0, k.selected ? 1 : 0]));
    if (skBox.dataset.sig !== skSig) {
      skBox.dataset.sig = skSig;
      skBox.innerHTML = skills
        .map((k) => {
          const cls = ["skill-btn"];
          if (k.selected) cls.push("selected");
          else if (k.enabled) cls.push("on");
          return (
            '<button class="' + cls.join(" ") + '" data-sk="' + esc(k.id) + '">' +
            esc(k.label || k.id) + "</button>"
          );
        })
        .join("");
    }

    // 特殊技能条（转化技的用法选择，本质是单选）
    const spBox = $("#special");
    const spItems = [];
    for (const it of sc ? arr(sc.SpecialSkills) : []) {
      const names = arr(it.skills);
      const labels = arr(it.labels);
      names.forEach((name, i) => spItems.push({ name, label: labels[i] || name }));
    }
    const spSig = JSON.stringify(spItems.map((x) => x.name));
    if (spBox.dataset.sig !== spSig) {
      spBox.dataset.sig = spSig;
      spBox.innerHTML = spItems
        .map(
          (x) =>
            '<button class="special-btn" data-sp="' + esc(x.name) + '">' + esc(x.label) + "</button>"
        )
        .join("");
    }

    renderHand(s);
  }

  // ---- 牌堆

  function renderPiles(s) {
    const el = $("#piles");
    const sig = (s.drawPile || 0) + "/" + (s.discardPile || 0);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML =
      '<span>牌堆 ' + (s.drawPile || 0) + "</span>" +
      '<span>弃牌 ' + (s.discardPile || 0) + "</span>";
  }

  // ---- 战报

  function logLine(text) {
    const t = String(text == null ? "" : text);
    let cls = "";
    if (/造成了|受到|阵亡|体力值为 0/.test(t)) cls = "dmg";
    else if (/回复|摸了|获得/.test(t)) cls = "heal";
    else if (/使用了|装备了|判定/.test(t)) cls = "hl";
    return '<p class="' + cls + '">' + esc(t) + "</p>";
  }

  function renderLog(s) {
    const log = arr(s.log);
    const body = $("#log-body");
    if (log.length < logShown) {
      body.innerHTML = "";
      logShown = 0;
    }
    if (log.length === logShown) return;
    const frag = log.slice(logShown).map(logLine).join("");
    logShown = log.length;
    body.insertAdjacentHTML("beforeend", frag);
    const panel = $("#log");
    if (panel.classList.contains("open")) body.scrollTop = body.scrollHeight;
  }

  // ---------------------------------------------------------------- 弹窗

  let dlgState = null; // { cmd, data, picked:Set }

  function dialogBox() {
    let el = $("#dlg");
    if (el) return el;
    el = document.createElement("div");
    el.id = "dlg";
    el.innerHTML =
      '<div class="dlg-box">' +
      '<div class="dlg-prompt" id="dlg-prompt"></div>' +
      '<div class="dlg-body" id="dlg-body"></div>' +
      '<div class="dlg-foot" id="dlg-foot"></div>' +
      "</div>";
    document.body.appendChild(el);
    return el;
  }

  function closeDialog() {
    const el = $("#dlg");
    if (el) el.classList.remove("show");
    dlgState = null;
  }

  function answer(v) {
    api("answer", JSON.stringify(v));
    closeDialog();
    wake();
  }

  function renderDialog(s) {
    const d = s.dialog;
    if (!d) {
      if (dlgState) closeDialog();
      return;
    }

    let data;
    try {
      data = JSON.parse(d.data || "{}");
    } catch (e) {
      data = { kind: "raw" };
    }

    // 同一个弹窗不重建
    const sig = d.cmd + "|" + (d.data || "");
    if (dlgState && dlgState.sig === sig) return;
    dlgState = { sig, cmd: d.cmd, data, picked: new Set() };

    const el = dialogBox();
    el.classList.add("show");
    $("#dlg-prompt").innerHTML = "";
    $("#dlg-body").innerHTML = "";
    $("#dlg-foot").innerHTML = "";

    if (data.kind === "choices") buildChoices(data);
    else if (data.kind === "card") buildCardChosen(data);
    else if (data.kind === "general") buildGeneral(data);
    else answer("");
  }

  function buildChoices(data) {
    const labels = arr(data.labels).map(String);
    const values = arr(data.choices);
    const minNum = Number(data.min || 1);
    const maxNum = Number(data.max || 1);
    const single = !!data.single || maxNum <= 1;

    $("#dlg-prompt").innerHTML = formatPrompt(data.prompt || "请选择");

    const body = $("#dlg-body");
    body.innerHTML = labels
      .map((label, i) => '<button class="dlg-opt" data-idx="' + i + '">' + esc(label) + "</button>")
      .join("");

    body.onclick = (ev) => {
      const btn = ev.target.closest(".dlg-opt");
      if (!btn) return;
      const idx = Number(btn.dataset.idx);

      if (single) {
        answer([values[idx]]);
        return;
      }
      const key = String(idx);
      if (dlgState.picked.has(key)) dlgState.picked.delete(key);
      else if (dlgState.picked.size < maxNum) dlgState.picked.add(key);
      btn.classList.toggle("on", dlgState.picked.has(key));
      syncFoot();
    };

    buildFoot(data.cancelable, !single, () => {
      const out = [...dlgState.picked].map((k) => values[Number(k)]);
      if (out.length < minNum) {
        toast("至少选 " + minNum + " 项");
        return;
      }
      answer(out);
    });
  }

  function buildCardChosen(data) {
    const cards = data.cards || {};
    const hidden = data.hidden || {};
    const zones = arr(data.zones);

    $("#dlg-prompt").innerHTML = formatPrompt(data.prompt || "请选择一张牌");

    const flat = [];
    for (const z of zones) {
      for (const cid of arr(z.ids)) flat.push({ cid, zone: z.name });
    }

    const body = $("#dlg-body");
    body.innerHTML =
      '<div class="dlg-cards">' +
      flat
        .map((c, i) => {
          if (hidden[String(c.cid)]) {
            return '<div class="card back" data-idx="' + i + '"><div class="cn">未知</div></div>';
          }
          const info = cards[String(c.cid)] || { id: c.cid, name: "?", raw: "" };
          return cardHtml(info, { enabled: true }).replace(
            'data-cid="' + esc(info.id) + '"',
            'data-idx="' + i + '"'
          );
        })
        .join("") +
      "</div>";

    body.onclick = (ev) => {
      const el = ev.target.closest(".card");
      if (!el) return;
      const c = flat[Number(el.dataset.idx)];
      if (!c) return;
      answer(c.cid);
    };

    buildFoot(true, false, () => answer(""));
  }

  function buildGeneral(data) {
    const gens = arr(data.generals).map(String);
    const labels = arr(data.labels).map(String);
    const n = Number(data.n || 1);
    const initial = data.source === "initial";

    const promptText = data.prompt || "请选择 " + n + " 名武将";
    $("#dlg-prompt").innerHTML = formatPrompt(promptText);

    const body = $("#dlg-body");
    body.innerHTML =
      '<div class="dlg-gens">' +
      gens
        .map((g, i) => {
          const art = generalArt(g);
          return (
            '<button class="gen" data-idx="' + i + '">' +
            '<span class="pic"' + (art ? ' style="background-image:url(' + art + ')"' : "") + "></span>" +
            '<span class="gname">' + esc(labels[i] || g) + "</span>" +
            "</button>"
          );
        })
        .join("") +
      "</div>";

    const commit = (picked) => {
      if (initial) {
        // 选将面板的回包是 { "武将1,武将2", "kingdom," }
        answer([picked.join(","), "kingdom,"]);
      } else {
        answer(picked);
      }
    };

    body.onclick = (ev) => {
      const btn = ev.target.closest(".gen");
      if (!btn) return;
      const idx = btn.dataset.idx;
      if (n === 1) {
        commit([gens[Number(idx)]]);
        return;
      }
      if (dlgState.picked.has(idx)) dlgState.picked.delete(idx);
      else if (dlgState.picked.size < n) dlgState.picked.add(idx);
      btn.classList.toggle("on", dlgState.picked.has(idx));
      syncFoot();
    };

    buildFoot(true, n > 1, () => {
      const out = [...dlgState.picked].map((k) => gens[Number(k)]);
      if (out.length < n) {
        toast("请选择 " + n + " 名武将");
        return;
      }
      commit(out);
    });
  }

  let footOk = null;

  function buildFoot(showCancel, needConfirm, onOk) {
    footOk = onOk;
    const foot = $("#dlg-foot");
    foot.innerHTML =
      (showCancel ? '<button class="act cancel" id="dlg-cancel">取 消</button>' : "") +
      (needConfirm ? '<button class="act ok" id="dlg-ok">确 定</button>' : "");
    const c = $("#dlg-cancel");
    if (c) c.onclick = () => answer("");
    const o = $("#dlg-ok");
    if (o) o.onclick = () => footOk && footOk();
  }

  function syncFoot() {
    const o = $("#dlg-ok");
    if (!o) return;
    const n = dlgState ? dlgState.picked.size : 0;
    o.textContent = "确 定" + (n ? "（" + n + "）" : "");
  }

  // ---------------------------------------------------------------- 事件

  function bind() {
    // 人数
    $("#count-row").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".mode-btn");
      if (!btn) return;
      for (const b of document.querySelectorAll(".mode-btn")) b.classList.remove("on");
      btn.classList.add("on");
      playerCount = Number(btn.dataset.n) || 5;
    });

    $("#start-btn").addEventListener("click", () => startGame());
    $("#again-btn").addEventListener("click", () => location.reload());

    $("#trust-btn").addEventListener("click", () => {
      api("trust");
      toast("本手交给 AI");
      wake();
    });

    $("#log-toggle").addEventListener("click", () => {
      const p = $("#log");
      p.classList.toggle("open");
      if (p.classList.contains("open")) {
        const b = $("#log-body");
        b.scrollTop = b.scrollHeight;
      }
    });
    $("#log-close").addEventListener("click", () => $("#log").classList.remove("open"));

    // 牌桌点击（事件委托）
    $("#table").addEventListener("click", (ev) => {
      if (!api) return;

      // 原版 QML 每次都把 selected / autoTarget 一起带上：
      // selected 是"点完之后我想要的状态"，autoTarget 让只有一个合法目标时自动选中
      const payload = (cur) => JSON.stringify({ selected: !cur, autoTarget: true });

      const card = ev.target.closest(".card");
      if (card && card.dataset.cid) {
        const cid = Number(card.dataset.cid);
        api("click", "CardItem", cid, "click", payload(card.classList.contains("selected")));
        wake();
        return;
      }

      const skill = ev.target.closest(".skill-btn");
      if (skill) {
        const name = skill.dataset.sk;
        const it = sceneItem("SkillButton", name);
        api("click", "SkillButton", name, "click", payload(!!(it && it.selected)));
        wake();
        return;
      }

      const sp = ev.target.closest(".special-btn");
      if (sp) {
        // SpecialSkills 只有一个 item（id 恒为 "1"），data 直接是技能名
        api("click", "SpecialSkills", "1", "click", JSON.stringify(sp.dataset.sp));
        wake();
        return;
      }

      const act = ev.target.closest(".act");
      if (act && act.dataset.bid) {
        if (act.disabled) return;
        api("click", "Button", act.dataset.bid, "click");
        wake();
        return;
      }

      const seat = ev.target.closest(".seat");
      if (seat && seat.classList.contains("targetable")) {
        const pid = Number(seat.dataset.pid);
        const it = sceneItem("Photo", pid);
        api("click", "Photo", pid, "click", payload(!!(it && it.selected)));
        wake();
        return;
      }

      const meBox = ev.target.closest("#me-info");
      if (meBox && meBox.classList.contains("targetable") && S && S.me) {
        const it = sceneItem("Photo", S.me.id);
        api("click", "Photo", S.me.id, "click", payload(!!(it && it.selected)));
        wake();
      }
    });
  }

  function sceneItem(type, id) {
    const sc = S && S.scene;
    if (!sc) return null;
    for (const it of arr(sc[type])) if (String(it.id) === String(id)) return it;
    return null;
  }

  // ---------------------------------------------------------------- 起飞

  bind();
  if (window.FK_LUA) boot();
  else progress(0, "资源未载入");

  // 注册自己的 Service Worker，把这块目录从父级（无名杀）的 SW 手里抢过来
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch((e) => {
      console.warn("[sw]", e && e.message);
    });
  }
})();
