-- 新月杀 Web 会话层
--
-- 把原版 C++ 负责的三件事用纯 Lua 重做：
--   1. fk.Room / fk.ServerPlayer —— 服务端房间与玩家
--   2. fk.Client               —— 客户端到服务端的通道
--   3. 调度器                   —— 用 Game.step() 手动推协程
--
-- 服务端与客户端跑在同一个 Lua VM 里，就像单机版那样，
-- 区别只是"渲染"这一层交给了 JS。

Game = {
  replies = {},
  log = {},
  dirty = true,
  LOCAL_ID = 1,
}

local LOCAL_ID = 1

-- 原版用 QML 弹窗处理的请求。网页版把其中常用的几个做成了 DOM 弹窗，
-- 剩下的（拼点、整理牌、小游戏、五谷丰登取牌）仍然交给 AI 顶一手。
local UI_DIALOGS = {
  AskForChoices = true,   -- 选项列表：技能触发、花色选择…
  AskForOptions = true,   -- 选项列表（卡牌式）
  AskForCardChosen = true, -- 从某角色手牌/装备/判定区挑一张
  AskForGeneral = true,   -- 选将（旧接口）
  CustomDialog = true,    -- 只有"选将面板"这一种能认，其余退回托管
}

local AUTO_TRUST_DIALOGS = {
  AskForPoxi = true,
  AskForArrangeCards = true,
  AskForMoveCardInBoard = true,
  AskForCardsAndChoice = true,
  MiniGame = true,
  AskForAG = true,
  FillAG = true,
  GetPlayerHandcards = true,
}

-- ============================================================ 基础工具

-- Player::State 枚举，必须和 src/player.h 一致
fk.Player_Invalid = 0
fk.Player_Online = 1
fk.Player_Trust = 2
fk.Player_Run = 3
fk.Player_Leave = 4
fk.Player_Robot = 5
fk.Player_Offline = 6

local function QList(arr)
  return setmetatable(arr or {}, {
    __index = {
      at = function(self, i) return self[i + 1] end,
      length = function(self) return #self end,
    },
  })
end

local SUIT_CHAR = { [1] = "♠", [2] = "♣", [3] = "♥", [4] = "♦", [5] = "" }

local function cardJsonFromCard(card)
  if not card then return { id = 0, name = "?" } end
  local name = card.ui_name or card.name
  return {
    id = card.id,
    name = Fk:translate(name),
    raw = name,
    suit = SUIT_CHAR[card.suit] or "",
    number = card:getNumberStr(),
    color = (card.suit == 3 or card.suit == 4) and "red" or "black",
    ctype = card.type,
  }
end

local function cardJson(cid)
  local card = Fk:getCardById(cid)
  if not card then return { id = cid, name = "?" } end
  local j = cardJsonFromCard(card)
  j.id = cid
  return j
end

-- ============================================================ fk.Player

local FPlayer = {}
function FPlayer:getId() return self.id end
function FPlayer:setId(v) self.id = v end
function FPlayer:getScreenName() return self.screenName or ("P" .. tostring(self.id)) end
function FPlayer:setScreenName(v) self.screenName = v end
function FPlayer:getAvatar() return self.avatar or "guojia" end
function FPlayer:setAvatar(v) self.avatar = v end
function FPlayer:getTotalGameTime() return self.totalGameTime or 0 end
function FPlayer:addTotalGameTime(v) self.totalGameTime = (self.totalGameTime or 0) + (v or 0) end
function FPlayer:getState() return self.state end
function FPlayer:setState(v) self.state = v end
function FPlayer:getGameData() return QList { 0, 0, 0 } end
function FPlayer:setGameData() end
function FPlayer:isDied() return self.died and true or false end
function FPlayer:setDied(v) self.died = v end
fk.Player = FPlayer

function Game.newCppPlayer(id, name, avatar)
  local p = setmetatable({}, { __index = FPlayer })
  p:setId(id)
  p:setScreenName(name or ("P" .. tostring(id)))
  p:setAvatar(avatar or "guojia")
  p:setState(fk.Player_Online)
  p:setDied(false)
  return p
end

-- ============================================================ fk.ServerPlayer

local FSP = setmetatable({}, { __index = FPlayer })

-- 答复队列。
-- 原版客户端是"发一个包给服务端"，服务端按当前请求取用，不存在队列错位的问题；
-- 这里只有一条 FIFO，一旦多推了一条（连点两下确定、托管后遗留、请求被取消……），
-- 后面所有请求都会取到别人的答复——症状是 askToDiscard 拿到一张牌 id 当 card_data 用。
-- 所以每条答复都记上"它属于哪个请求"，取的时候不匹配就丢弃。
local function currentRequest()
  -- 注意用 Game.room 而不是 RoomInstance：玩家点鼠标时协程不在跑，
  -- RoomInstance 是 nil，那样打出来的标签就永远是 nil，等于没打。
  return (Game.room and Game.room.current_request) or (Game.dialog and Game.dialog.req)
end

local function pushReply(data)
  table.insert(Game.replies, { req = currentRequest(), data = cbor.encode(data) })
end
Game.pushReply = pushReply

-- 只在"我自己"的玩家上做客户端回调，其余玩家的通知没人看。
--
-- 单 VM 跑服务端+客户端有个坑：原版服务端进程里 ClientInstance 是 nil，
-- 而 AI 在服务端也会构造 RequestHandler/Scene，Scene:notifyUI 只判断
-- "ClientInstance 是否存在"。所以服务端执行期间必须把它藏起来。
local function toClient(command, jsonData, isRequest)
  local saved = ClientInstance
  ClientInstance = Game.client
  if not ClientInstance then ClientInstance = saved end
  local room = RoomInstance
  RoomInstance = nil
  local s = Self
  Self = ClientSelf
  local ok, err = pcall(ClientCallback, FClient, command, jsonData, isRequest)
  ClientSelf = Self -- 回调里可能重建了 Self（EnterRoom）
  Self = s
  RoomInstance = room
  -- EnterRoom 会重建 ClientInstance，所以 Game.client 要以回调后的为准；
  -- 但局部变量仍恢复成进入前的值（服务端执行时它是 nil，必须还回去）
  Game.client = ClientInstance
  ClientInstance = saved
  if not ok then fk.qCritical("[client] " .. tostring(err)) end

  -- 客户端刚设好的技能 extra_data 要留一份。
  -- AI 在服务端跑完会把同一个技能的 _extra_data 清空（单 VM 共用一份），
  -- 不清这一手，弃牌/拼点这类"点牌"交互就会报 num 为 nil。
  if command == "AskForUseActiveSkill" and ok then
    Game.clientExtra = Game.clientExtra or {}
    for name, sk in pairs(Fk.skills or {}) do
      local d = sk._extra_data
      if type(d) == "table" and next(d) ~= nil then Game.clientExtra[name] = d end
    end
  end
end

function FSP:doNotify(command, jsonData)
  if self.id == LOCAL_ID then toClient(command, jsonData, false) end
  Game.dirty = true
end

function FSP:doRequest(command, jsonData, timeout, timestamp)
  if self.id == LOCAL_ID then toClient(command, jsonData, true) end
end

function FSP:waitForReply(timeout)
  if self.id ~= LOCAL_ID then return "__cancel" end
  local cur = Game.room and Game.room.current_request
  while #Game.replies > 0 do
    local r = table.remove(Game.replies, 1)
    -- 上一手没被取走的答复，直接丢掉，别让它污染这一手
    if r.req == nil or r.req == cur then return r.data end
  end
  return "__notready"
end

function FSP:thinking() return self._thinking and true or false end
function FSP:setThinking(v) self._thinking = v end
function FSP:emitKick() self.state = fk.Player_Offline end
function FSP:saveState() end
function FSP:getSaveState() return "{}" end
function FSP:saveGlobalState() end
function FSP:getGlobalSaveState() return "{}" end

fk.ServerPlayer = FSP

function Game.newServerPlayer(id, name, state)
  local p = setmetatable({}, { __index = FSP })
  p:setId(id)
  p:setScreenName(name or ("AI" .. tostring(id)))
  p:setAvatar("guojia")
  p:setState(state or fk.Player_Trust)
  p:setDied(false)
  p:setThinking(false)
  return p
end

-- ============================================================ fk.Room

local FRoom = {}
function FRoom:getId() return self.id end
function FRoom:getPlayers() return self.players end
function FRoom:getOwner() return self.owner end
function FRoom:getObservers() return self.observers end
function FRoom:hasObserver() return false end
function FRoom:getTimeout() return self.timeout end
function FRoom:delay(ms) end
function FRoom:updatePlayerWinRate() end
function FRoom:updateGeneralWinRate() end
function FRoom:gameOver()
  for _, p in ipairs(self.players) do
    p:setDied(false)
    p:setThinking(false)
  end
end
function FRoom:setRequestTimer(ms) Game.timerMs = ms end
function FRoom:destroyRequestTimer() Game.timerMs = nil end
function FRoom:increaseRefCount() end
function FRoom:decreaseRefCount() end
function FRoom:settings() return self._settings end
function FRoom:addNpc()
  self._npcSeq = (self._npcSeq or 0) - 1
  local p = Game.newServerPlayer(self._npcSeq, "Bot" .. tostring(-self._npcSeq))
  table.insert(self.players, p)
  return p
end
function FRoom:removeNpc(p) table.removeOne(self.players, p) end
function FRoom:saveGlobalState() end
function FRoom:getGlobalSaveState() return "{}" end
function FRoom:getSessionId() return 0 end
function FRoom:getSessionData() return "{}" end
function FRoom:setSessionData() end
fk.Room = FRoom

-- ============================================================ fk.Client

FClient = {}

function FClient:sendSetupPacket() end
function FClient:setupServerLag() end
function FClient:notifyServer() end
function FClient:installMyAESKey() end
function FClient:saveRecord() end
function FClient:saveGameData() end

function FClient:addPlayer(id, name, avatar)
  self.players[id] = Game.newCppPlayer(id, name, avatar)
  return self.players[id]
end

function FClient:removePlayer(id) self.players[id] = nil end
function FClient:getSelf() return self.self end
function FClient:changeSelf(id) self.self = self.players[id] or self.self end

function FClient:replyToServer(command, data)
  pushReply(data)
  Game.dirty = true
end

-- 弹窗数据要过一遍 JSON：里面可能有 CBOR 对象、QML 组件描述之类
-- 编不出来的字段直接丢掉，保证 UI 那边总能拿到一个对象
local function encodeDialogData(data)
  local ok, s = pcall(json.encode, data)
  if ok and type(s) == "string" and s ~= "" then return s end
  return "{}"
end

-- 把原版 QML 弹窗的入参整理成 JS 好直接用的形状。
-- 原版这些数组的位置参数实在难记，索性在这边一次解析干净。
local function dialogPayload(command, data)
  if command == "AskForChoices" or command == "AskForOptions" then
    local choices = data[1] or {}
    local range = data[3] or {}
    local labels = {}
    for i, c in ipairs(choices) do labels[i] = Fk:translate(tostring(c)) end
    return {
      kind = "choices",
      choices = choices,
      labels = labels,
      min = range[1] or 1,
      max = range[2] or 1,
      cancelable = data[4] and true or false,
      prompt = Fk:translate(data[6] or ""),
      single = data[8] and true or false,
    }
  elseif command == "AskForCardChosen" then
    local zones, cards, hidden = {}, {}, {}
    for _, z in ipairs(data.card_data or {}) do
      local ids = z[2] or {}
      table.insert(zones, { name = tostring(z[1] or ""), ids = ids })
      for _, cid in ipairs(ids) do cards[tostring(cid)] = cardJson(cid) end
    end
    for cid, v in pairs(data.visible_data or {}) do
      if v == false then hidden[tostring(cid)] = true end
    end
    return {
      kind = "card",
      zones = zones,
      cards = cards,
      hidden = hidden,
      prompt = Fk:translate(data.prompt or ""),
    }
  elseif command == "AskForGeneral" then
    local gens = data[1] or {}
    local labels = {}
    for i, g in ipairs(gens) do labels[i] = Fk:translate(g) end
    return {
      kind = "general",
      generals = gens,
      labels = labels,
      n = data[2] or 1,
      prompt = Fk:translate(data[6] or ""),
    }
  elseif command == "CustomDialog" then
    -- 0.5.x 的选将走的是"自定义 QML 组件"，这里只认选将面板这一种。
    -- 回包格式很刁钻：{ "武将1,武将2", "kingdom," }
    local comp = data.component
    local model = type(comp) == "table" and comp.model or nil
    local prop = type(model) == "table" and model.prop or nil
    if type(comp) == "table" and comp.name == "ChooseInitialGeneralBox" and type(prop) == "table" then
      local gens = prop.generals or {}
      local labels = {}
      for i, g in ipairs(gens) do labels[i] = Fk:translate(g) end
      return {
        kind = "general",
        source = "initial",
        generals = gens,
        labels = labels,
        n = prop.choiceNum or 1,
        prompt = "",
      }
    end
    return { kind = "raw" }
  end
  return { kind = "raw" }
end

-- 立刻把自己切成托管，让 AI 接这一手。
-- 必须马上切：Request:_checkReply 是轮询的，看到非 Online 才会走 AI 分支。
local function autoTrustNow()
  local me = Game.cRoom and Game.cRoom.players[1]
  if not me then return end
  if me:getState() == fk.Player_Online then
    me:setState(fk.Player_Trust)
    Game.autoTrust = true
    Game.trustedReq = Game.room and Game.room.current_request
  end
end
Game.autoTrustNow = autoTrustNow

function FClient:notifyUI(command, data)
  -- 交互处理器把答复交回来了
  if command == "ReplyToServer" then
    pushReply(data)
    Game.dirty = true
    return
  end

  if command == "GameLog" then
    table.insert(Game.log, data)
    if #Game.log > 400 then table.remove(Game.log, 1) end
    Game.dirty = true
    return
  end

  -- 空请求：直接回空串
  if command == "EmptyRequest" then
    pushReply("")
    Game.dirty = true
    return
  end

  -- 结算：data 是 "1+3" 这样的胜利者 id 串
  if command == "GameOver" then
    Game.winner = data
    Game.dirty = true
    return
  end

  -- 这些是原版用 QML 弹窗处理的请求
  if UI_DIALOGS[command] then
    local ok, payload = pcall(dialogPayload, command, data)
    if ok and type(payload) == "table" and payload.kind and payload.kind ~= "raw" then
      Game.dialog = {
        cmd = command,
        data = encodeDialogData(payload),
        req = Game.room and Game.room.current_request,
      }
      Game.dirty = true
      Game.lastCmd = command
      return
    end
    -- 认不出来的自定义组件，只能交给 AI
    Game.autoTrustNote = command
    autoTrustNow()
  end
  if AUTO_TRUST_DIALOGS[command] then
    Game.autoTrustNote = command
    autoTrustNow()
  end

  Game.dirty = true
  Game.lastCmd = command
  Game.cmdLog = Game.cmdLog or {}
  table.insert(Game.cmdLog, command)
  if #Game.cmdLog > 60 then table.remove(Game.cmdLog, 1) end
end

fk.Client = FClient

-- ============================================================ 开局

---@param opt {mode:string, playerIds:integer[], settings:table?}
function Game.newGame(opt)
  Game.replies = {}
  Game.log = {}
  Game.cmdLog = {}
  Game.dirty = true
  Game.autoTrust = false
  Game.trustedReq = nil
  Game.dialog = nil
  Game.winner = nil
  Game.autoTrustNote = nil
  Game.clientExtra = {}
  Game.timerMs = nil

  local ids = opt.playerIds or { 1, 2, 3, 4, 5 }
  LOCAL_ID = ids[1]
  Game.LOCAL_ID = LOCAL_ID

  local settings = {
    gameMode = opt.mode or "aaa_role_mode",
    generalNum = 3,
    generalTimeout = 30,
    timeout = 900,
    luckTime = 0,
    enableFreeAssign = false,
    enableDeputy = false,
    disabledPack = {},
    disabledGenerals = {},
    password = "",
  }
  if opt.settings then
    for k, v in pairs(opt.settings) do settings[k] = v end
  end

  -- ---- 客户端 ----
  FClient.players = {}
  FClient.self = Game.newCppPlayer(LOCAL_ID, "你", "guojia")
  FClient.players[LOCAL_ID] = FClient.self

  CreateLuaClient(FClient)
  Game.client = ClientInstance
  Self = ClientPlayer:new(FClient.self)
  ClientSelf = Self

  -- 模拟"进房"：原版是 C++ 在 Room::addPlayer 里发这几条
  local cRoom = setmetatable({
    id = 1,
    players = QList {},
    owner = nil,
    observers = QList {},
    timeout = settings.timeout,
    _settings = cbor.encode(settings),
  }, { __index = FRoom })

  for _, id in ipairs(ids) do
    table.insert(cRoom.players, Game.newServerPlayer(id, id == LOCAL_ID and "你" or ("AI" .. id),
      id == LOCAL_ID and fk.Player_Online or fk.Player_Trust))
  end
  cRoom.owner = cRoom.players[1]

  local enter = { #ids, settings.timeout, settings }
  toClient("EnterRoom", cbor.encode(enter), true)
  for i = 2, #ids do
    local p = cRoom.players[i]
    toClient("AddPlayer", cbor.encode { p:getId(), p:getScreenName(), p:getAvatar(), true, 0 }, false)
  end
  toClient("RoomOwner", cbor.encode { LOCAL_ID }, false)

  -- ---- 服务端 ----
  local Room = require "ltk.server.room"
  local room = Room:new(cRoom)
  Game.room = room
  Game.cRoom = cRoom

  -- 只建主协程，不在这里 resume：第一脚交给 Game.step 推，
  -- 这样"上一次 yield 在等什么理由"就始终由 step 统一记录。
  room.main_co = coroutine.create(function() room:run() end)
  Game.nextReason = nil
  ClientInstance = Game.client
  return "ok"
end

-- ============================================================ 推协程

-- 单 VM 跑服务端+客户端还有一个副作用：
-- AI 在服务端跑 makeReply 时会把 Fk.skills[x]._extra_data 改成它自己那份，跑完再清成空表
-- （见 ltk/server/ai/ai.lua:208）。原版这是两个进程所以互不干扰，
-- 但在这里 AI 一清，客户端刚设好的 extra_data 就没了——
-- 表现就是弃牌时点牌报 "attempt to compare nil with number"。
-- 所以每推一次协程，都把被清空的那几项还原回去；客户端这一轮新设的则保留。
local function snapshotExtraData()
  local saved = {}
  for name, sk in pairs(Fk.skills or {}) do
    local d = sk._extra_data
    if type(d) == "table" and next(d) ~= nil then saved[name] = d end
  end
  return saved
end

local function restoreExtraData(saved)
  for name, d in pairs(saved) do
    local sk = Fk.skills[name]
    if sk then
      local cur = sk._extra_data
      if type(cur) ~= "table" or next(cur) == nil then sk._extra_data = d end
    end
  end
  -- 客户端在这一手设过的优先
  for name, d in pairs(Game.clientExtra or {}) do
    local sk = Fk.skills[name]
    if sk then
      local cur = sk._extra_data
      if type(cur) ~= "table" or next(cur) == nil then sk._extra_data = d end
    end
  end
end

--- 推一下房间的协程
---
--- 房间用 coroutine.yield 把控制权交出来，并留下一个"我接受什么理由被唤醒"的判断函数。
--- 所以唤醒理由必须对上：delay 之后只能传 "delay_done"，否则 resume 会直接返回、什么都不做。
--- 这里自动记住上一次的 yield 类型，调用方不用操心。
---@param reason string?
---@return string 状态: "over" | "delay" | "wait"
---@return integer 需要等待的毫秒数
function Game.step(reason)
  local room = Game.room
  if not room then return "over", 0 end

  -- 上一次是自动托管的话，等那一手处理完就收回控制权。
  -- 判断依据是"请求换了"——同一个请求还没完就恢复 Online 会打断 AI 的回复。
  if Game.autoTrust and room.current_request ~= Game.trustedReq then
    Game.autoTrust = false
    Game.trustedReq = nil
    local me = Game.cRoom and Game.cRoom.players[1]
    if me then me:setState(fk.Player_Online) end
  end

  reason = reason or Game.nextReason or "loop"
  if reason == "" then reason = Game.nextReason or "loop" end
  Game.nextReason = nil

  -- 服务端执行期间藏起客户端实例，否则 AI 侧的 Scene:notifyUI 会往 UI 推数据
  ClientInstance = nil

  local savedExtra = snapshotExtraData()

  RoomInstance = room
  local ok, over, rest = pcall(room.resume, room, reason)
  RoomInstance = nil

  restoreExtraData(savedExtra)

  ClientInstance = Game.client

  if not ok then
    fk.qCritical("[resume] " .. tostring(over))
    return "over", 0
  end
  if over then return "over", 0 end

  -- 请求翻篇了，过期的弹窗要收掉，否则会一直挂在屏幕上
  if Game.dialog and Game.dialog.req and Game.dialog.req ~= room.current_request then
    Game.dialog = nil
  end

  if type(rest) == "number" then
    Game.nextReason = "delay_done"
    return "delay", rest
  end
  return "wait", 0
end

-- 当前这个 Request 是不是在问我？
local function requestIsMine()
  local room = Game.room
  local req = room and room.current_request
  if not req then return false end
  local me = Game.cRoom and Game.cRoom.players[1]
  if not me then return false end
  for _, p in ipairs(req.players) do
    if p.serverplayer == me then return true end
  end
  return false
end
Game.requestIsMine = requestIsMine

--- 我自己是否要烧条
function Game.awaiting()
  return requestIsMine()
end

-- ============================================================ 交互

--- 处理一次 UI 点击
---@param elemType string CardItem | Photo | Button | SkillButton | SpecialSkills | Interaction
---@param id any
---@param action string?
---@param dataJson string? JSON
function Game.click(elemType, id, action, dataJson)
  local handler = ClientInstance and ClientInstance.current_request_handler
  if not handler then return false end
  local data
  if dataJson and dataJson ~= "" then
    local ok, d = pcall(json.decode, dataJson)
    if ok then data = d end
  end

  -- 点之前再兜一次 extra_data：AI 在服务端跑完可能刚把它清空，
  -- 而 card_filter 读的是 Fk.skills[name]._extra_data（不是 handler 自己那份）
  local sn = handler.skill_name
  local sk = sn and Fk.skills[sn]
  if sk and type(handler.extra_data) == "table" and next(handler.extra_data) ~= nil then
    local cur = sk._extra_data
    if type(cur) ~= "table" or next(cur) == nil then sk._extra_data = handler.extra_data end
  end

  local ok, err = xpcall(function()
    return handler.update(handler, elemType, id, action or "click", data)
  end, function(e)
    return tostring(e) .. " | skill=" .. tostring(sn)
  end)
  if not ok then fk.qWarning("[click] " .. tostring(err)) return false end
  Game.dirty = true
  return true
end

--- 直接把一个答复塞给服务端（弹窗用）
---@param dataJson string JSON，可以是字符串/数字/数组/对象
function Game.reply(dataJson)
  local ok, d = pcall(json.decode, dataJson)
  local v = ok and d or ""
  pushReply(v)
  Game.dialog = nil
  Game.dirty = true
end

--- 放弃这一手，交给 AI
function Game.trustOnce()
  autoTrustNow()
end

-- ============================================================ 渲染投影

local function roleOf(p)
  -- 身份场上只有主公和自己是明牌
  if p.id == LOCAL_ID then return p.role or "" end
  if p.role == "lord" then return "lord" end
  return ""
end

local function playerJson(p)
  local cpp = p.player
  local cards = p.player_cards or {}
  local equips, judges = {}, {}
  for _, cid in ipairs(cards[Player.Equip] or {}) do table.insert(equips, cardJson(cid)) end
  for _, cid in ipairs(cards[Player.Judge] or {}) do table.insert(judges, cardJson(cid)) end

  local skills = {}
  for _, s in ipairs(p.player_skills or {}) do
    if s.visible then table.insert(skills, { name = s.name, label = Fk:translate(s.name) }) end
  end

  local marks = {}
  for name, value in pairs(p.mark or {}) do
    if name:sub(1, 1) == "@" and not name:find("^@@") and value ~= 0 and value ~= nil then
      local label = name:sub(2)
      if label:sub(1, 1) == "!" then label = label:sub(2) end
      table.insert(marks, { label = Fk:translate(label), value = type(value) == "table" and #value or value })
    end
  end

  return {
    id = p.id,
    seat = p.seat or 0,
    name = cpp and cpp:getScreenName() or ("P" .. tostring(p.id)),
    avatar = cpp and cpp:getAvatar() or "guojia",
    general = p.general or "",
    generalLabel = (p.general and p.general ~= "" and p.general ~= "anjiang") and Fk:translate(p.general) or "",
    deputy = p.deputyGeneral or "",
    deputyLabel = (p.deputyGeneral and p.deputyGeneral ~= "" and p.deputyGeneral ~= "anjiang")
      and Fk:translate(p.deputyGeneral) or "",
    kingdom = p.kingdom or "",
    role = roleOf(p),
    hp = p.hp or 0,
    maxHp = p.maxHp or 0,
    shield = p.shield or 0,
    dead = p.dead and true or false,
    faceup = p.faceup ~= false,
    chained = p.chained and true or false,
    handCount = #(cards[Player.Hand] or {}),
    equips = equips,
    judges = judges,
    skills = skills,
    marks = marks,
    isSelf = p.id == LOCAL_ID,
    isCurrent = (ClientInstance and ClientInstance.current and ClientInstance.current.id == p.id) or false,
  }
end

-- 提示串的格式是 "#Key:src:dest:arg:arg2"，QML 那边自己拼，这里照抄一份
local function translatePrompt(prompt)
  if type(prompt) ~= "string" or prompt == "" then return "" end
  if prompt:sub(1, 1) ~= "#" then return Fk:translate(prompt) end
  local parts = prompt:split(":")
  local raw = Fk:translate(parts[1])
  local c = ClientInstance
  local src, dest = tonumber(parts[2]), tonumber(parts[3])
  if src and c then
    local p = c:getPlayerById(src)
    if p then raw = raw:gsub("%%src", Fk:translate(p.general or "")) end
  end
  if dest and c then
    local p = c:getPlayerById(dest)
    if p then raw = raw:gsub("%%dest", Fk:translate(p.general or "")) end
  end
  -- 注意顺序：%arg2 必须先换，否则 "最少 %arg2 张" 会被 %arg 先吃掉，变成 "22"
  if parts[5] and parts[5] ~= "" then raw = raw:gsub("%%arg2", Fk:translate(parts[5])) end
  if parts[4] and parts[4] ~= "" then raw = raw:gsub("%%arg", Fk:translate(parts[4])) end
  return raw
end

local function sceneJson()
  local c = ClientInstance
  local h = c and c.current_request_handler
  if not h or not h.scene then return nil end

  local function dump(elemType)
    local out = {}
    for id, item in pairs(h.scene:getAllItems(elemType)) do
      local d = { id = id, enabled = item.enabled and true or false, selected = item.selected and true or false }
      if item.state then d.state = item.state end
      if item.skills then
        d.skills = item.skills
        local labels = {}
        for _, s in ipairs(item.skills) do table.insert(labels, Fk:translate(s)) end
        d.labels = labels
        d.label = table.concat(labels, " / ")
      end
      if item.spec then d.spec = item.spec end
      if elemType == "CardItem" then
        d.card = item.card and cardJsonFromCard(item.card) or cardJson(id)
      elseif elemType == "SkillButton" and not d.label then
        d.label = Fk:translate(tostring(id))
      end
      table.insert(out, d)
    end
    return out
  end

  return {
    name = h.scene.scene_name or "Room",
    prompt = translatePrompt(h.prompt or ""),
    Photo = dump("Photo"),
    CardItem = dump("CardItem"),
    Button = dump("Button"),
    SkillButton = dump("SkillButton"),
    SpecialSkills = dump("SpecialSkills"),
    Interaction = dump("Interaction"),
  }
end

--- 整个牌桌的快照
function Game.snapshot()
  local c = ClientInstance
  if not c or not c.players then return "{}" end

  local me = c:getPlayerById(LOCAL_ID)
  local hand = {}
  if me then
    for _, cid in ipairs(me.player_cards[Player.Hand] or {}) do
      table.insert(hand, cardJson(cid))
    end
  end

  local players = {}
  for _, p in ipairs(c.players) do table.insert(players, playerJson(p)) end

  local out = {
    players = players,
    hand = hand,
    me = me and playerJson(me) or nil,
    scene = sceneJson(),
    dialog = Game.dialog and { cmd = Game.dialog.cmd, data = Game.dialog.data } or nil,
    log = Game.log,
    drawPile = #(c.draw_pile or {}),
    discardPile = #(c.discard_pile or {}),
    gameStarted = c.gameStarted and true or false,
    current = c.current and c.current.id or nil,
    awaiting = Game.awaiting(),
    autoTrust = Game.autoTrust and true or false,
    autoTrustNote = Game.autoTrustNote,
    winner = Game.winner,
    timerMs = Game.timerMs,
  }
  return json.encode(out)
end

--- 供 JS 调试
function Game.eval(code)
  local f = assert(load(code, "@eval"))
  return f()
end

-- ============================================================ JS 唯一入口
-- 反复 doString 会让 wasmoon 的 chunk 环境出问题，所以只注册一个函数，
-- JS 侧拿一次引用反复调用。

---@param cmd string
function Game_api(cmd, a, b, c, d)
  if cmd == "new" then
    local ids = {}
    for s in string.gmatch(a or "1,2,3,4,5", "%d+") do table.insert(ids, tonumber(s)) end
    return Game.newGame { mode = b or "aaa_role_mode", playerIds = ids }
  elseif cmd == "step" then
    local s, ms = Game.step(a)
    -- 返回值后面缀上两个标志位，让 JS 不必每帧都去取整份快照
    return s .. "|" .. tostring(ms or 0)
      .. "|" .. (Game.awaiting() and "1" or "0")
      .. "|" .. (Game.dialog and "1" or "0")
  elseif cmd == "snap" then
    return Game.snapshot()
  elseif cmd == "click" then
    return Game.click(a, b, c or "click", d) and "1" or "0"
  elseif cmd == "trust" then
    Game.trustOnce()
    return "1"
  elseif cmd == "reply" then
    Game.reply(a)
    return "1"
  elseif cmd == "answer" then
    Game.reply(a)
    return "1"
  elseif cmd == "eval" then
    local ok, ret = pcall(Game.eval, a)
    return ok and tostring(ret) or ("ERR: " .. tostring(ret))
  end
  return ""
end
