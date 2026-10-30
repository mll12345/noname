/**
 * 无名杀 · 静态托管文件系统适配层
 *
 * 1.10.x 的浏览器端默认通过 HTTP 后端（/checkFile、/getFileList、/readFile…）访问文件，
 * 静态托管（GitHub Pages / 任何纯静态服务器）没有后端，启动即崩。
 *
 * 这一层用「构建期生成的 manifest.json 索引 + 真实 HTTP 请求 + IndexedDB 覆盖层」
 * 把同一套 API 在纯静态环境下补齐：
 *   - 读：先查 manifest（文件是否存在、目录里有什么），再按真实 URL 拉内容
 *   - 写：写进 IndexedDB 覆盖层（上传的背景图/音频、导入的扩展、导出的存档）
 *   - 覆盖层优先级高于 manifest，因此用户导入的东西当次及之后都能读到
 *
 * 约定：所有路径都是相对站点根目录的（如 "character/standard/extension.js"），
 * 由 noname 的 get.relativePath() 传入。
 */
(() => {
	"use strict";

	/** 站点根（index.html 所在目录），形如 https://host/noname/ */
	const BASE = new URL("./", document.baseURI).href;
	const OVERLAY_DB = "noname-staticfs";
	const OVERLAY_STORE = "files";

	/** 归一化路径：去 ./ 前缀、去前导 /、去尾部 /、统一分隔符 */
	function norm(p) {
		if (p === null || p === undefined) return "";
		let s = String(p).replace(/\\/g, "/");
		s = s.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
		return s;
	}

	function joinPath(dir, name) {
		const d = norm(dir);
		const n = norm(name);
		if (!d) return n;
		if (!n) return d;
		return `${d}/${n}`;
	}

	function toURL(p) {
		return new URL(norm(p), BASE).href;
	}

	/* ------------------------------------------------------------------ *
	 * manifest 索引
	 * ------------------------------------------------------------------ */

	let indexPromise = null;

	function getIndex() {
		if (!indexPromise) {
			indexPromise = fetch(new URL("manifest.json", BASE), { cache: "no-cache" })
				.then(res => {
					if (!res.ok) throw new Error(`manifest.json 加载失败（${res.status}）`);
					return res.json();
				})
				.then(data => ({
					files: new Set((data.files || []).map(norm)),
					dirs: new Set((data.dirs || []).map(norm)),
				}))
				.catch(err => {
					console.error("[static-fs] 索引加载失败，退化为 HTTP 探测模式：", err);
					return { files: new Set(), dirs: new Set(), degraded: true };
				});
		}
		return indexPromise;
	}

	/* ------------------------------------------------------------------ *
	 * IndexedDB 覆盖层
	 * ------------------------------------------------------------------ */

	let dbPromise = null;

	function getDB() {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise((resolve, reject) => {
			let req;
			try {
				req = indexedDB.open(OVERLAY_DB, 1);
			} catch (e) {
				reject(e);
				return;
			}
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(OVERLAY_STORE)) db.createObjectStore(OVERLAY_STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		}).catch(err => {
			console.warn("[static-fs] IndexedDB 不可用，写入只保留在内存中：", err);
			return null;
		});
		return dbPromise;
	}

	/** IndexedDB 不可用时的内存兜底 */
	const memoryStore = new Map();

	async function overlayGet(path) {
		const db = await getDB();
		if (!db) return memoryStore.get(path);
		return new Promise(resolve => {
			try {
				const tx = db.transaction(OVERLAY_STORE, "readonly");
				const rq = tx.objectStore(OVERLAY_STORE).get(path);
				rq.onsuccess = () => resolve(rq.result);
				rq.onerror = () => resolve(undefined);
			} catch {
				resolve(undefined);
			}
		});
	}

	async function overlayPut(path, record) {
		const db = await getDB();
		if (!db) {
			memoryStore.set(path, record);
			return;
		}
		return new Promise((resolve, reject) => {
			try {
				const tx = db.transaction(OVERLAY_STORE, "readwrite");
				tx.objectStore(OVERLAY_STORE).put(record, path);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			} catch (e) {
				reject(e);
			}
		});
	}

	async function overlayDelete(path) {
		const db = await getDB();
		if (!db) {
			memoryStore.delete(path);
			return;
		}
		return new Promise(resolve => {
			try {
				const tx = db.transaction(OVERLAY_STORE, "readwrite");
				tx.objectStore(OVERLAY_STORE).delete(path);
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
			} catch {
				resolve();
			}
		});
	}

	async function overlayKeys() {
		const db = await getDB();
		if (!db) return [...memoryStore.keys()];
		return new Promise(resolve => {
			try {
				const tx = db.transaction(OVERLAY_STORE, "readonly");
				const rq = tx.objectStore(OVERLAY_STORE).getAllKeys();
				rq.onsuccess = () => resolve(rq.result || []);
				rq.onerror = () => resolve([]);
			} catch {
				resolve([]);
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * 读取实现
	 * ------------------------------------------------------------------ */

	async function readBuffer(path) {
		const ov = await overlayGet(path);
		if (ov !== undefined && ov !== null) {
			if (ov.type === "text") return new TextEncoder().encode(ov.data).buffer;
			const raw = ov.data;
			if (raw instanceof ArrayBuffer) return raw;
			if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
			if (Array.isArray(raw)) return new Uint8Array(raw).buffer;
		}
		const res = await fetch(toURL(path), { cache: "force-cache" });
		if (!res.ok) throw new Error(`读取文件失败：${path}（${res.status}）`);
		return await res.arrayBuffer();
	}

	async function readText(path) {
		const ov = await overlayGet(path);
		if (ov !== undefined && ov !== null) {
			if (ov.type === "text") return ov.data;
			const buf = await readBuffer(path);
			return new TextDecoder().decode(buf);
		}
		const res = await fetch(toURL(path), { cache: "force-cache" });
		if (!res.ok) throw new Error(`读取文件失败：${path}（${res.status}）`);
		return await res.text();
	}

	/* ------------------------------------------------------------------ *
	 * 状态判断
	 * ------------------------------------------------------------------ */

	async function checkFileType(path) {
		const p = norm(path);
		if (!p) return 0; // 站点根目录

		const ov = await overlayGet(p);
		if (ov !== undefined && ov !== null) return 1;

		const index = await getIndex();
		if (index.files.has(p)) return 1;
		if (index.dirs.has(p)) return 0;

		// manifest 缺失时退化：只有带扩展名的路径才值得探一次
		if (index.degraded && /\.[a-z0-9]+$/i.test(p)) {
			try {
				const res = await fetch(toURL(p), { method: "HEAD" });
				if (res.ok) return 1;
			} catch {
				/* ignore */
			}
		}
		return -1;
	}

	async function checkDirType(path) {
		const p = norm(path);
		if (!p) return 1;

		const index = await getIndex();
		if (index.dirs.has(p)) return 1;
		if (index.files.has(p)) return 0;

		const keys = await overlayKeys();
		if (keys.some(k => norm(k).startsWith(`${p}/`))) return 1;
		return -1;
	}

	/* ------------------------------------------------------------------ *
	 * 目录枚举
	 * ------------------------------------------------------------------ */

	async function listDir(path) {
		const p = norm(path);
		const prefix = p ? `${p}/` : "";
		const folders = new Set();
		const files = new Set();

		const index = await getIndex();
		for (const dir of index.dirs) {
			if (!dir.startsWith(prefix) || dir === p) continue;
			const rest = dir.slice(prefix.length);
			if (!rest || rest.includes("/")) continue;
			folders.add(rest);
		}
		for (const file of index.files) {
			if (!file.startsWith(prefix)) continue;
			const rest = file.slice(prefix.length);
			if (!rest || rest.includes("/")) continue;
			files.add(rest);
		}
		// 覆盖层里的新文件/新目录
		for (const key of await overlayKeys()) {
			const k = norm(key);
			if (!k.startsWith(prefix)) continue;
			const rest = k.slice(prefix.length);
			if (!rest) continue;
			if (rest.includes("/")) folders.add(rest.split("/")[0]);
			else files.add(rest);
		}
		return [[...folders].sort(), [...files].sort()];
	}

	/* ------------------------------------------------------------------ *
	 * 对外 API
	 * ------------------------------------------------------------------ */

	function makeApi() {
		return {
			/**
			 * 检查路径是否是一个文件
			 * @param {string} fileName
			 * @param {(result: -1 | 0 | 1) => void} [callback] -1 不存在 / 0 是目录 / 1 是文件
			 * @param {(err: Error) => void} [onerror]
			 */
			checkFile(fileName, callback = () => {}, onerror = console.error) {
				checkFileType(fileName).then(callback, onerror);
			},

			/**
			 * 检查路径是否是一个目录
			 * @param {string} dir
			 * @param {(result: -1 | 0 | 1) => void} [callback] -1 不存在 / 0 是文件 / 1 是目录
			 * @param {(err: Error) => void} [onerror]
			 */
			checkDir(dir, callback = () => {}, onerror = console.error) {
				checkDirType(dir).then(callback, onerror);
			},

			/**
			 * 读取文件为 ArrayBuffer
			 * @param {string} fileName
			 * @param {(buffer: ArrayBuffer) => void} [callback]
			 * @param {(err: Error) => void} [onerror]
			 */
			readFile(fileName, callback = () => {}, onerror = console.error) {
				readBuffer(fileName).then(callback, onerror);
			},

			/**
			 * 读取文件为文本
			 * @param {string} fileName
			 * @param {(text: string) => void} [callback]
			 * @param {(err: Error) => void} [onerror]
			 */
			readFileAsText(fileName, callback = () => {}, onerror = console.error) {
				readText(fileName).then(callback, onerror);
			},

			/**
			 * 写入文件（存进 IndexedDB 覆盖层）
			 * @param {string | ArrayBuffer | ArrayBufferView | Blob | File} data
			 * @param {string} path 目录
			 * @param {string} name 文件名
			 * @param {(err?: Error) => void} [callback]
			 */
			writeFile(data, path, name, callback = () => {}) {
				const full = joinPath(path, name);
				const done = err => callback(err);
				(async () => {
					if (!full) throw new Error("写入路径为空");
					if (typeof data === "string") {
						await overlayPut(full, { type: "text", data, time: Date.now() });
					} else if (typeof Blob !== "undefined" && data instanceof Blob) {
						const buf = await data.arrayBuffer();
						await overlayPut(full, { type: "bin", data: buf, time: Date.now() });
					} else if (data instanceof ArrayBuffer) {
						await overlayPut(full, { type: "bin", data, time: Date.now() });
					} else if (ArrayBuffer.isView(data)) {
						await overlayPut(full, { type: "bin", data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), time: Date.now() });
					} else if (Array.isArray(data)) {
						await overlayPut(full, { type: "bin", data: new Uint8Array(data).buffer, time: Date.now() });
					} else {
						throw new Error("不支持的数据类型");
					}
					done();
				})().catch(err => {
					console.error("[static-fs] 写入失败：", full, err);
					done(err);
				});
			},

			/**
			 * 删除文件
			 * @param {string} fileName
			 * @param {(err?: Error) => void} [callback]
			 */
			removeFile(fileName, callback = () => {}) {
				overlayDelete(norm(fileName)).then(() => callback(), callback);
			},

			/**
			 * 列出目录内容
			 * @param {string} dir
			 * @param {(folders: string[], files: string[]) => void} [callback]
			 * @param {(err: Error) => void} [onerror]
			 */
			getFileList(dir, callback = () => {}, onerror = console.error) {
				listDir(dir).then(([folders, files]) => callback(folders, files), onerror);
			},

			/**
			 * 确保目录存在（静态托管下目录是虚拟的，直接成功）
			 * @param {string | string[]} list
			 * @param {() => void} [callback]
			 */
			ensureDirectory(list, callback = () => {}) {
				void list;
				callback();
			},

			/** 创建目录（虚拟，直接成功） */
			createDir(directory, successCallback = () => {}) {
				void directory;
				successCallback();
			},

			/** 删除目录（清掉覆盖层里该前缀下的所有文件） */
			removeDir(directory, successCallback = () => {}, errorCallback = () => {}) {
				const p = norm(directory);
				(async () => {
					const keys = await overlayKeys();
					await Promise.all(keys.map(norm).filter(k => k === p || k.startsWith(`${p}/`)).map(overlayDelete));
					successCallback();
				})().catch(errorCallback);
			},

			/**
			 * 下载远程文件到本地目录（写入覆盖层）
			 * @param {string} url
			 * @param {string} folder
			 * @param {() => void} [resolve]
			 * @param {(err: Error) => void} [reject]
			 * @param {boolean} [dev]
			 * @param {(loaded: number, total: number) => void} [onprogress]
			 */
			download(url, folder, resolve = () => {}, reject = console.error, dev = false, onprogress = () => {}) {
				void dev;
				(async () => {
					const res = await fetch(url);
					if (!res.ok) throw new Error(`下载失败：${url}（${res.status}）`);
					const total = Number(res.headers.get("content-length")) || 0;
					const buf = await res.arrayBuffer();
					onprogress(buf.byteLength, total || buf.byteLength);
					const clean = String(url).split("?")[0].split("#")[0];
					const name = decodeURIComponent(clean.slice(clean.lastIndexOf("/") + 1)) || `download-${Date.now()}`;
					await overlayPut(joinPath(folder, name), { type: "bin", data: buf, time: Date.now() });
					resolve();
				})().catch(reject);
			},
		};
	}

	// noname 的引导流程会把这个函数取走并立刻删除
	window.initReadWriteFunction = function initReadWriteFunction(game) {
		return new Promise(resolve => {
			const api = makeApi();
			for (const key of Object.keys(api)) {
				try {
					game[key] = api[key];
				} catch (e) {
					console.warn(`[static-fs] 挂载 ${key} 失败：`, e);
				}
			}
			console.log("[static-fs] 静态文件系统已就绪（只读资源 + IndexedDB 覆盖层）");
			resolve();
		});
	};
})();
