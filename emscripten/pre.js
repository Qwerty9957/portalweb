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

	const FS_LOCK = new Int32Array(new SharedArrayBuffer(4))
	const FS_META = new Int32Array(new SharedArrayBuffer(64))
	const FS_DATA = new Uint8Array(new SharedArrayBuffer(64 * 1024 * 1024))
	let _populating = false

	postMessage({
		cmd: 'callHandler',
		handler: 'registerFSBuffers',
		args: [FS_LOCK.buffer, FS_META.buffer, FS_DATA.buffer]
	})

	function syncReadFile(vfsPath) {
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

	Module.preRun = Module.preRun || []
	Module.preRun.push(function () {
		while (Atomics.load(FS_META, 4) === 0) {
			Atomics.wait(FS_META, 4, 0, 100)
		}
		const dirDataLen = FS_META[5]
		const dirStr = new TextDecoder().decode(FS_DATA.slice(0, dirDataLen))
		for (const dir of dirStr.split('\n')) {
			if (dir) try { FS.mkdirTree(dir) } catch (e) {}
		}

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

				const resolved = PATH.resolve(FS.cwd(), path)
				if (lazyLoadFile(resolved)) {
					return _origOpen(path, flags)
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
	})

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

	let _lock = null, _meta = null, _data = null

	Module.registerFSBuffers = function (lockBuf, metaBuf, dataBuf) {
		_lock = new Int32Array(lockBuf)
		_meta = new Int32Array(metaBuf)
		_data = new Uint8Array(dataBuf)
	}

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
			_meta[3] = Module._pathExistsInFolder(path) ? 0 : 1
		}

		Atomics.store(_lock, 0, 0)
		Atomics.notify(_lock, 0)
	}

	Module._pathExistsInFolder = function (path) {
		return Module._dirIndex && Module._dirIndex.has(path.toLowerCase())
	}

	Module._readFileFromFolder = async function (path) {
		const handle = Module._dirIndex && Module._dirIndex.get(path.toLowerCase())
		if (!handle) return null
		const file = await handle.getFile()
		return new Uint8Array(await file.arrayBuffer())
	}

	Module._writeFileToFolder = async function (path, data) {
		if (!Module._rootHandle) return
		const parts = path.split('/')
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
			setTimeout(Module._sendFolderIndexToWorker, 50)
			return
		}
		const allPaths = Array.from(Module._dirIndex.keys()).sort()
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
		Atomics.notify(_meta, 4)
	}
}
