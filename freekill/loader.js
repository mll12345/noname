// FreeKill Lua 内核加载器
// 同时供 Node（fs）与浏览器（fetch）使用：只要给出 readFile(path) -> string
//
// 这一层的职责：把 C++/Qt 提供的东西（虚拟文件系统、require、dofile、io、fk 命名空间）
// 全部用 JS 补上，让 lua/freekill.lua 能原样跑起来。

// Node 用 require，浏览器用 wasmoon 的 UMD 全局
const LuaFactory = (typeof require === "function" && typeof module !== "undefined")
  ? require("wasmoon").LuaFactory
  : globalThis.wasmoon.LuaFactory;

// ---------- 文件收集 / 模块解析 ----------

function collectFromFs(fs, path, root) {
  const out = {};
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".lua")) {
        let src = fs.readFileSync(p, "utf8");
        if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // Lua 的 load 不认 BOM
        out[path.relative(root, p).split(path.sep).join("/")] = src;
      }
    }
  };
  walk(path.join(root, "lua"));
  walk(path.join(root, "ltk"));
  walk(path.join(root, "packages"));
  return out;
}

function makeResolver(SRC) {
  return function resolve(name) {
    const base = name.replace(/\./g, "/");
    const cands = [
      base + ".lua",
      "lua/" + base + ".lua",
      "lua/lib/" + base + ".lua",
      base + "/init.lua",
      "lua/" + base + "/init.lua",
      "lua/lib/" + base + "/init.lua",
      name.endsWith(".lua") ? name : null,
      name,
    ].filter(Boolean);
    for (const c of cands) if (SRC[c] !== undefined) return c;
    return null;
  };
}

// ---------- 启动 ----------

/**
 * @param {object} opt
 * @param {Record<string,string>} opt.src       路径 -> Lua 源码
 * @param {(kind:string, msg:string)=>void} [opt.log]
 * @param {(now:()=>number)=>void} [opt.beforeRun]  dofile("lua/freekill.lua") 之前执行，用于注入额外全局
 * @returns {Promise<{lua:any, SRC:Record<string,string>}>}
 */
async function bootLua(opt) {
  const SRC = opt.src;
  const log = opt.log || (() => {});
  const resolve = makeResolver(SRC);

  const lua = await new LuaFactory().createEngine();

  // 注意：JS 侧一律返回字符串而不是 null/undefined。
  // wasmoon 会把 null 变成一个 pending promise，Lua 里就是 "attempt to index" 或者
  // "Cannot read properties of null (reading 'then')"。
  await lua.global.set("__src", (p) => (SRC[p] !== undefined ? SRC[p] : ""));
  await lua.global.set("__resolve", (n) => resolve(n) || "");
  await lua.global.set("__log", (kind, msg) => log(kind, msg));
  await lua.global.set("__now", () => Date.now());

  let vcwd = "";
  await lua.global.set("__pwd", () => vcwd);
  await lua.global.set("__cd", (p) => {
    if (!p || p === ".") return;
    vcwd = p.startsWith("/") ? p : (vcwd ? vcwd + "/" + p : p);
  });
  await lua.global.set("__anyPrefix", (pre) => Object.keys(SRC).some((k) => k.startsWith(pre)));
  await lua.global.set("__listDir", (dir) => {
    const pre = String(dir || ".").replace(/^\.\/?/, "").replace(/\/$/, "");
    const prefix = pre ? pre + "/" : "";
    const set = new Set();
    for (const k of Object.keys(SRC)) {
      if (!k.startsWith(prefix)) continue;
      const first = k.slice(prefix.length).split("/")[0];
      if (first) set.add(first);
    }
    return Array.from(set).join("|");
  });

  // ---- fk 命名空间（C++ SWIG 注入的那一半） ----
  await lua.doString(`
    fk = {}
    function fk.qInfo(s) __log("info", s) end
    function fk.qWarning(s) __log("warn", s) end
    function fk.qCritical(s) __log("crit", s) end
    function fk.qDebug(s) __log("dbg", s) end

    function fk.QmlBackend_pwd() return __pwd() end
    function fk.QmlBackend_cd(p) __cd(p) end
    function fk.QmlBackend_ls(d)
      local s = __listDir(d)
      local t = {}
      for line in string.gmatch(s, "[^|]+") do t[#t + 1] = line end
      return t
    end
    function fk.QmlBackend_exists(f) local s = __src(f) return s ~= nil and s ~= "" end
    function fk.QmlBackend_isDir(f) return __anyPrefix((f:gsub("/$", "")) .. "/") end
    function fk.GetMicroSecond() return __now() end
    function fk.GetDisabledPacks() return "[]" end
    fk.FK_VER = "0.5.25"
  `);

  // ---- 虚拟文件系统 + require/dofile/io ----
  await lua.doString(`
    local cwd = ""
    FileIO = {}
    function FileIO.pwd() return cwd end
    function FileIO.cd(p)
      if p:sub(1,1) == "/" then cwd = p else cwd = cwd == "" and p or (cwd .. "/" .. p) end
    end
    function FileIO.exists(p) local s = __src(p) return s ~= nil and s ~= "" end
    function FileIO.isDir(p) return __anyPrefix((p:gsub("/$","")) .. "/") end
    function FileIO.ls(dir) return __listDir(dir) end

    local loaded = {}
    function require(name)
      if loaded[name] ~= nil then return loaded[name] end
      local p = __resolve(name)
      if p == "" then error("module not found: " .. tostring(name), 2) end
      local chunk = assert(load(__src(p), "@" .. p))
      local r = chunk(name)
      if r == nil then r = true end
      loaded[name] = r
      return r
    end

    local function loadfile2(p)
      local s = __src(p)
      if s == nil or s == "" then return nil, "file not found: " .. tostring(p) end
      return assert(load(s, "@" .. p))
    end
    dofile = function(p) return assert(loadfile2(p))() end
    loadfile = loadfile2

    io = {}
    function io.open(p, mode)
      local s = __src(p)
      if s == nil or s == "" then return nil end
      return {
        read = function() return s end,
        close = function() end,
        lines = function() local done=false; return function() if done then return nil end; done=true; return s end end,
      }
    end

    os.getms = function() return __now() end
  `);

  return { lua, SRC, resolve };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { bootLua, collectFromFs, makeResolver };
} else {
  globalThis.FKLoader = { bootLua };
}
