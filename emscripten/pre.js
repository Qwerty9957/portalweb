Module['arguments'] = Module['arguments'] || []
Module['arguments'].push(
	'-game', 'portal',
	'-noip',
	'-language', 'english',
	'-windowed',
	'+mat_hdr_level', '0',
	'+mat_colorcorrection', '1'
)

const ENV_IS_WORKER = typeof importScripts !== 'undefined'

if (ENV_IS_WORKER) {
	// ===================== WORKER (PTHREAD) =====================

	// Workers don't have alert() - polyfill it to avoid crashes
	if (typeof alert === 'undefined') {
		self.alert = function(msg) {
			console.error('WORKER alert:', msg);
		}
	}

	let FS_LOCK = null
	let FS_META = null
	let FS_DATA = null
	let _populating = false

	function initFSViews() {
		if (FS_LOCK) return true
		if (Module._FS_SAB_LOCK) {
			FS_LOCK = new Int32Array(Module._FS_SAB_LOCK)
			FS_META = new Int32Array(Module._FS_SAB_META)
			FS_DATA = new Uint8Array(Module._FS_SAB_DATA)
			return true
		}
		if (typeof wasmMemory !== 'undefined' && wasmMemory && HEAPU8) {
			try {
				var totalSize = 4 + 64 + 64 * 1024 * 1024
				var offset = _malloc(totalSize)
				FS_LOCK = new Int32Array(wasmMemory.buffer, offset, 1)
				FS_META = new Int32Array(wasmMemory.buffer, offset + 4, 16)
				FS_DATA = new Uint8Array(wasmMemory.buffer, offset + 68, 64 * 1024 * 1024)
				Module._FS_HEAP_OFFSET = offset
				return true
			} catch (e) {
				console.error('WORKER failed to allocate FS bridge in heap:', e)
				return false
			}
		}
		return false
	}

	function syncReadFile(vfsPath) {
		if (!initFSViews()) return null
		const p = new TextEncoder().encode(vfsPath.toLowerCase())
		if (p.length > FS_DATA.length) return null
		FS_DATA.set(p, 0)
		FS_META[0] = 0
		FS_META[1] = p.length
		FS_META[2] = 0
		FS_META[3] = 0

		Atomics.store(FS_LOCK, 0, 1)
		Atomics.notify(FS_LOCK, 0)
		postMessage({ cmd: 'callHandler', handler: 'fsRequest', args: [] })
		Atomics.wait(FS_LOCK, 0, 1)

		if (FS_META[3] !== 0) return null
		return FS_DATA.slice(0, FS_META[2])
	}

	function syncWriteFile(vfsPath, data) {
		if (!initFSViews()) return false
		const p = new TextEncoder().encode(vfsPath.toLowerCase())
		if (8 + p.length + data.length > FS_DATA.length) return false

		FS_DATA.set(p, 0)
		FS_DATA.set(data, 8 + p.length)
		FS_META[0] = 1
		FS_META[1] = p.length
		FS_META[2] = data.length
		FS_META[3] = 0

		Atomics.store(FS_LOCK, 0, 1)
		Atomics.notify(FS_LOCK, 0)
		postMessage({ cmd: 'callHandler', handler: 'fsRequest', args: [] })
		Atomics.wait(FS_LOCK, 0, 1)

		return FS_META[3] === 0
	}

	function syncReadFileRange(vfsPath, offset, length) {
		if (!initFSViews()) return null
		const p = new TextEncoder().encode(vfsPath.toLowerCase())
		if (p.length > FS_DATA.length) return null
		FS_DATA.set(p, 0)
		FS_META[0] = 3
		FS_META[1] = p.length
		FS_META[2] = offset
		FS_META[3] = length

		Atomics.store(FS_LOCK, 0, 1)
		Atomics.notify(FS_LOCK, 0)
		postMessage({ cmd: 'callHandler', handler: 'fsRequest', args: [] })
		Atomics.wait(FS_LOCK, 0, 1)

		if (FS_META[3] !== 0) return null
		return FS_DATA.slice(0, FS_META[2])
	}

	function syncGetFileSize(vfsPath) {
		if (!initFSViews()) return -1
		const p = new TextEncoder().encode(vfsPath.toLowerCase())
		if (p.length > FS_DATA.length) return -1
		FS_DATA.set(p, 0)
		FS_META[0] = 4
		FS_META[1] = p.length

		Atomics.store(FS_LOCK, 0, 1)
		Atomics.notify(FS_LOCK, 0)
		postMessage({ cmd: 'callHandler', handler: 'fsRequest', args: [] })
		Atomics.wait(FS_LOCK, 0, 1)

		if (FS_META[3] !== 0) return -1
		return FS_META[2]
	}

	function lazyLoadFile(vfsPath) {
		const data = syncReadFile(vfsPath)
		if (!data) return false
		_populating = true
		try {
			const parts = vfsPath.split('/')
			parts.pop()
			const dirPath = parts.join('/')
			if (dirPath) FS.mkdirTree(dirPath)
			FS.writeFile(vfsPath, new Uint8Array(data))
			return true
		} finally {
			_populating = false
		}
	}

	function isENOENT(e) {
		return Math.abs(e.errno) === 2 || Math.abs(e.errno) === 44
	}

	function installWorkerFSOverrides() {
		if (!initFSViews()) return
		console.log('WORKER: waiting for dir index from main thread...')
		var waited = 0
		while (Atomics.load(FS_META, 4) === 0) {
			Atomics.wait(FS_META, 4, 0, 100)
			waited++
			if (waited > 600) {
				console.error('WORKER: timeout waiting for dir index')
				return
			}
		}
		console.log('WORKER: dir index ready, creating directories...')
		var dirDataLen = FS_META[5]
		var dirStr = new TextDecoder().decode(FS_DATA.slice(0, dirDataLen))
		for (const dir of dirStr.split('\n')) {
			if (dir) try { FS.mkdirTree(dir) } catch (e) {}
		}
		console.log('WORKER: directories created, installing FS overrides')

		// Modify the startWorker to install FS overrides after the runtime is ready
		const _origOpen = FS.open
		FS.open = function (path, rawFlags) {
			if (_populating) return _origOpen(path, rawFlags)
			const flags = typeof rawFlags === 'string'
				? FS.modeStringToFlags(rawFlags)
				: rawFlags
			try {
				return _origOpen(path, flags)
			} catch (e) {
				if (!isENOENT(e)) throw e
				if (flags & 64) throw e

				const resolved = PATH.isAbs(path) ? PATH.normalize(path) : PATH.join2(FS.cwd(), path)
				console.log('WORKER FS.open ENOENT: path=' + path + ' resolved=' + resolved)
				if (lazyLoadFile(resolved)) {
					console.log('WORKER FS.open: lazy-loaded ' + resolved)
					return _origOpen(path, flags)
				}
				throw e
			}
		}

		const _origStat = FS.stat
		FS.stat = function (path, dontFollow) {
			try {
				return _origStat(path, dontFollow)
			} catch (e) {
				if (!isENOENT(e)) throw e
				const resolved = PATH.isAbs(path) ? PATH.normalize(path) : PATH.join2(FS.cwd(), path)
				if (lazyLoadFile(resolved)) {
					return _origStat(path, dontFollow)
				}
				throw e
			}
		}

		const _origLookupPath = FS.lookupPath
		FS.lookupPath = function (path, opts) {
			try {
				return _origLookupPath(path, opts)
			} catch (e) {
				if (!isENOENT(e)) throw e
				const resolved = PATH.isAbs(path) ? PATH.normalize(path) : PATH.join2(FS.cwd(), path)
				if (lazyLoadFile(resolved)) {
					return _origLookupPath(path, opts)
				}
				throw e
			}
		}

		const _origWrite = FS.write
		FS.write = function (stream, buffer, offset, length, position) {
			stream._dirty = true
			return _origWrite(stream, buffer, offset, length, position)
		}

		const _origClose = FS.close
		FS.close = function (stream) {
			if (stream._dirty && stream.node) {
				try {
					const data = FS.readFile(stream.node.path, { encoding: 'binary' })
					syncWriteFile(stream.node.path, new Uint8Array(data))
				} catch (e) {}
			}
			return _origClose(stream)
		}

		// ===== VPK lazy streaming FS: intercept reads on VPK data chunks
		// and fetch only the requested byte range from OPFS via SAB bridge,
		// instead of loading the entire multi-GB file into MEMFS.
		var _vpkFds = new Set()
		var _vpkPattern = /_\d{3}\.vpk$/i
		var _vpkSizes = new Map()

		var _prevOpen = FS.open
		FS.open = function (path, rawFlags) {
			var prevError
			try {
				return _prevOpen(path, rawFlags)
			} catch (e) {
				if (!isENOENT(e)) throw e
				if (rawFlags & 64) throw e
				prevError = e
			}
			var resolved = PATH.isAbs(path) ? PATH.normalize(path) : PATH.join2(FS.cwd(), path)
			var clean = resolved.replace(/^\/+/, '').toLowerCase()
			if (_vpkPattern.test(clean)) {
				var size = syncGetFileSize(resolved)
				if (size > 0) {
					var parts = resolved.split('/')
					parts.pop()
					if (parts.length) {
						try { FS.mkdirTree(parts.join('/')) } catch (e) {}
					}
					_vpkSizes.set(clean, size)
					FS.writeFile(resolved, new Uint8Array(1))
					try {
						var stream = _prevOpen(path, rawFlags)
						stream._vpkSize = size
						stream._vpkPath = clean
						_vpkFds.add(stream.fd)
						return stream
					} catch (e2) { throw e2 }
				}
			}
			throw prevError
		}

		var _prevSeek = FS.seek
		FS.seek = function (stream, offset, whence) {
			if (!stream) return -1
			if (_vpkFds.has(stream.fd)) {
				var pos = offset
				if (whence === 1) pos = stream.position + offset
				else if (whence === 2) pos = stream._vpkSize + offset
				if (pos < 0) pos = 0
				if (pos > stream._vpkSize) pos = stream._vpkSize
				stream.position = pos
				return pos
			}
			return _prevSeek(stream, offset, whence)
		}

		var _prevRead = FS.read
		FS.read = function (stream, buffer, offset, length, position) {
			if (!stream) return 0
			if (_vpkFds.has(stream.fd)) {
				var pos = (position >= 0) ? position : stream.position
				var remaining = stream._vpkSize - pos
				if (remaining <= 0) return 0
				var toRead = Math.min(length, remaining)
				var data = syncReadFileRange('/' + stream._vpkPath, pos, toRead)
				if (data && data.length > 0) {
					buffer.set(data, offset)
					if (position < 0) stream.position += data.length
					return data.length
				}
				return 0
			}
			return _prevRead(stream, buffer, offset, length, position)
		}

		var _prevStat = FS.stat
		FS.stat = function (path, dontFollow) {
			try {
				var result = _prevStat(path, dontFollow)
				var clean = path.replace(/^\/+/, '').toLowerCase()
				if (_vpkSizes.has(clean)) {
					result.size = _vpkSizes.get(clean)
				}
				return result
			} catch (e) {
				if (!isENOENT(e)) throw e
				var resolved = PATH.isAbs(path) ? PATH.normalize(path) : PATH.join2(FS.cwd(), path)
				var clean = resolved.replace(/^\/+/, '').toLowerCase()
				if (_vpkPattern.test(clean)) {
					var size = syncGetFileSize(resolved)
					if (size > 0) {
						_vpkSizes.set(clean, size)
						var parts = resolved.split('/')
						parts.pop()
						if (parts.length) {
							try { FS.mkdirTree(parts.join('/')) } catch (e) {}
						}
						FS.writeFile(resolved, new Uint8Array(1))
						return _prevStat(path, dontFollow)
					}
				}
				throw e
			}
		}

		var _prevCloseStream = FS.close
		FS.close = function (stream) {
			if (stream) _vpkFds.delete(stream.fd)
			return _prevCloseStream(stream)
		}
	}

	// Intercept self.startWorker so our FS overrides run before the worker signals readiness
	if (typeof Object.defineProperty !== 'undefined' && typeof self !== 'undefined') {
		var _wrappedStartWorker = null
		Object.defineProperty(self, 'startWorker', {
			configurable: true,
			enumerable: true,
			get: function () { return _wrappedStartWorker },
			set: function (fn) {
				_wrappedStartWorker = function (instance) {
					installWorkerFSOverrides()
					fn.call(self, instance)
				}
			}
		})
	}

	Module.downloadMap = (lock, mapName) => {
		Atomics.store(HEAP32, lock, 0)
		Atomics.notify(HEAP32, lock)
	}
} else {
	// ===================== MAIN THREAD =====================

	// Force array-buffer compilation (streaming can fail with COEP)
	delete WebAssembly.instantiateStreaming;

	console.log('MAIN: pre.js loaded');

	const _origAddDep = addRunDependency;
	const _origRemoveDep = removeRunDependency;
	addRunDependency = function(id) {
		console.log('MAIN addRunDependency:', id);
		_origAddDep(id);
	};
	removeRunDependency = function(id) {
		console.log('MAIN removeRunDependency:', id);
		_origRemoveDep(id);
	};

	let _lock = new Int32Array(Module._FS_SAB_LOCK)
	let _meta = new Int32Array(Module._FS_SAB_META)
	let _data = new Uint8Array(Module._FS_SAB_DATA)

	Module.fsRequest = async function () {
		if (!_lock || Atomics.load(_lock, 0) !== 1) return

		const type = _meta[0]
		const pathLen = _meta[1]
		const path = new TextDecoder().decode(new Uint8Array(_data.buffer, 0, pathLen))

		if (type === 0) {
			const data = await Module._readFileFromFolder(path)
			if (data) {
				_data.set(data, 0)
				_meta[2] = data.length
				_meta[3] = 0
			} else {
				_meta[2] = 0
				_meta[3] = 1
			}
		} else if (type === 1) {
			const dataLen = _meta[2]
			const fileData = new Uint8Array(_data.buffer, 8 + pathLen, dataLen)
			await Module._writeFileToFolder(path, new Uint8Array(fileData))
			_meta[2] = 0
			_meta[3] = 0
		} else if (type === 2) {
			const exists = Module._pathExistsInFolder(path)
			_meta[3] = exists ? 0 : 1
		} else if (type === 3) {
			const offset = _meta[2]
			const length = _meta[3]
			const data = await Module._readFileRangeFromFolder(path, offset, length)
			if (data) {
				_data.set(data, 0)
				_meta[2] = data.length
				_meta[3] = 0
			} else {
				_meta[2] = 0
				_meta[3] = 1
			}
		} else if (type === 4) {
			const size = await Module._getFileSizeFromFolder(path)
			if (size >= 0) {
				_meta[2] = size
				_meta[3] = 0
			} else {
				_meta[2] = 0
				_meta[3] = 1
			}
		}

		Atomics.store(_lock, 0, 0)
		Atomics.notify(_lock, 0)
	}

	Module._pathExistsInFolder = function (path) {
		const clean = path.replace(/^\/+/, '').toLowerCase()
		return Module._dirIndex && Module._dirIndex.has(clean)
	}

	Module._readFileFromFolder = async function (path) {
		const clean = path.replace(/^\/+/, '').toLowerCase()
		const handle = Module._dirIndex && Module._dirIndex.get(clean)
		if (!handle) return null
		const file = await handle.getFile()
		return new Uint8Array(await file.arrayBuffer())
	}

	Module._readFileRangeFromFolder = async function (path, offset, length) {
		const clean = path.replace(/^\/+/, '').toLowerCase()
		const handle = Module._dirIndex && Module._dirIndex.get(clean)
		if (!handle) return null
		const file = await handle.getFile()
		const blob = file.slice(offset, offset + length)
		return new Uint8Array(await blob.arrayBuffer())
	}

	Module._getFileSizeFromFolder = async function (path) {
		const clean = path.replace(/^\/+/, '').toLowerCase()
		const handle = Module._dirIndex && Module._dirIndex.get(clean)
		if (!handle) return -1
		const file = await handle.getFile()
		return file.size
	}

	Module._writeFileToFolder = async function (path, data) {
		if (!Module._rootHandle) return
		const clean = path.replace(/^\/+/, '')
		const parts = clean.split('/')
		const fileName = parts.pop()
		let cur = Module._rootHandle
		for (const part of parts) {
			if (!part) continue
			cur = await cur.getDirectoryHandle(part, { create: true })
		}
		const fh = await cur.getFileHandle(fileName, { create: true })
		const w = await fh.createWritable()
		await w.write(data)
		await w.close()
	}

	Module._sendFolderIndexToWorker = function () {
		if (!_meta || !_data) {
			console.log('MAIN _sendFolderIndexToWorker: retrying (meta/data not ready)')
			setTimeout(Module._sendFolderIndexToWorker, 50)
			return
		}
		const allPaths = Array.from(Module._dirIndex.keys()).sort()
		console.log('MAIN _sendFolderIndexToWorker: ' + allPaths.length + ' paths, first few: ' + allPaths.slice(0, 5).join(', '))
		console.log('MAIN _sendFolderIndexToWorker: Has portal/gameinfo.txt? ' + Module._dirIndex.has('portal/gameinfo.txt') + (Module._dirIndex.has('gameinfo.txt') ? ' (found as gameinfo.txt without portal/ prefix - WRONG FOLDER?)' : ''))
		const dirSet = new Set()
		for (const fp of allPaths) {
			const parts = fp.split('/')
			let path = ''
			for (let i = 0; i < parts.length - 1; i++) {
				path += '/' + parts[i]
				dirSet.add(path)
			}
		}
		const dirs = Array.from(dirSet).sort()
		const encoded = new TextEncoder().encode(dirs.join('\n'))

		if (encoded.length > _data.length) {
			console.error('Directory index too large for data buffer')
			return
		}

		_data.set(encoded, 0)
		_meta[4] = 1
		_meta[5] = encoded.length
		console.log('MAIN _sendFolderIndexToWorker: sent ' + dirs.length + ' dirs, ' + encoded.length + ' bytes')
		Atomics.notify(_meta, 4)
	}

	// Pre-load critical files into MEMFS before the engine starts.
	// This is called from the shell.html click handler before callMain().
	Module._preloadCriticalFiles = async function () {
		// Files the engine needs synchronously at startup
		// VPK dir files are small index files; the engine needs them to mount VPK archives
		var criticalFiles = [
			'/portal/gameinfo.txt',
			'/portal/steam.inf',
			'/portal/portal_pak_dir.vpk',
			'/hl2/hl2_textures_dir.vpk',
			'/hl2/hl2_sound_vo_english_dir.vpk',
			'/hl2/hl2_sound_misc_dir.vpk',
			'/hl2/hl2_misc_dir.vpk',
			'/platform/platform_misc_dir.vpk'
		]
		// VPK data chunk files (*_NNN.vpk) are NOT preloaded into MEMFS.
		// Instead, they are streamed on demand via the worker's lazy VPK FS,
		// which fetches only the requested byte ranges from OPFS using the
		// SAB bridge (syncReadFileRange). This avoids OOM on large VPKs.
		if (Module._dirIndex) {
			var vpkDataPattern = /_\d{3}\.vpk$/i
			var vpkCount = 0
			for (var entry of Module._dirIndex.entries()) {
				if (vpkDataPattern.test(entry[0])) vpkCount++
			}
			console.log('MAIN preload: ' + vpkCount + ' VPK data chunks will be streamed on demand')
		}
		for (const vfsPath of criticalFiles) {
			var data = await Module._readFileFromFolder(vfsPath)
			if (data) {
				var parts = vfsPath.split('/')
				parts.pop()
				if (parts.length) {
					try { FS.mkdirTree(parts.join('/')) } catch (e) {}
				}
				FS.writeFile(vfsPath, new Uint8Array(data))
				console.log('MAIN preloaded: ' + vfsPath)
			} else {
				console.warn('MAIN critical file not found: ' + vfsPath)
			}
		}
		// Guard against seek/read on NULL FILE* handles (avoids console noise when
		// the engine tries to use a NULL handle from a failed fopen)
		var _origSeek = FS.seek
		FS.seek = function(stream, offset, whence) {
			if (!stream) return -1
			return _origSeek(stream, offset, whence)
		}
		var _origRead = FS.read
		FS.read = function(stream, buffer, offset, length, position) {
			if (!stream) return 0
			return _origRead(stream, buffer, offset, length, position)
		}
		// Install FS overrides on the main thread for on-demand file loading.
		// The filesystem module runs on the main thread (dlopen proxying), so
		// we need to trigger async loads when files are found in OPFS but not MEMFS.
		// The C code retries some files, and subsequent opens will find them in MEMFS.
		var _populating = false
		var _pendingAsyncLoads = new Set()
		function isENOENT(e) { return Math.abs(e.errno) === 2 || Math.abs(e.errno) === 44 }

		function _triggerAsyncLoad(resolved, clean) {
			if (_pendingAsyncLoads.has(resolved)) return
			_pendingAsyncLoads.add(resolved)
			setTimeout(async function() {
				try {
					var data = await Module._readFileFromFolder('/' + clean)
					if (data) {
						var parts = resolved.split('/')
						parts.pop()
						if (parts.length) {
							try { FS.mkdirTree(parts.join('/')) } catch (e) {}
						}
						FS.writeFile(resolved, new Uint8Array(data))
						console.log('MAIN async loaded: ' + resolved)
					}
				} catch (e) {
					console.warn('MAIN async load failed for ' + resolved, e)
				}
			}, 0)
		}

		var _origOpen = FS.open
		FS.open = function (path, rawFlags) {
			if (_populating) return _origOpen(path, rawFlags)
			var flags = typeof rawFlags === 'string' ? FS.modeStringToFlags(rawFlags) : rawFlags
			try {
				return _origOpen(path, flags)
			} catch (e) {
				if (!isENOENT(e)) throw e
				if (flags & 64) throw e
				var resolved = PATH.isAbs(path) ? PATH.normalize(path) : PATH.join2(FS.cwd(), path)
				var clean = resolved.replace(/^\/+/, '').toLowerCase()
				if (Module._dirIndex && Module._dirIndex.has(clean)) {
					console.log('MAIN FS.open: async-loading: ' + resolved)
					_triggerAsyncLoad(resolved, clean)
				}
				throw e
			}
		}
	}
}
