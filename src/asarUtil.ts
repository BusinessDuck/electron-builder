import { AsarFileInfo, listPackage, statFile, AsarOptions } from "asar-electron-builder"
import { statOrNull, debug, isCi } from "./util/util"
import {
  lstat,
  readdir,
  readFile,
  Stats,
  createWriteStream,
  ensureDir,
  createReadStream,
  readJson,
  writeFile,
  realpath,
  link
} from "fs-extra-p"
import BluebirdPromise from "bluebird-lst-c"
import * as path from "path"
import { log } from "./util/log"
import { deepAssign } from "./util/deepAssign"
import { Filter } from "./util/filter"

const isBinaryFile: any = BluebirdPromise.promisify(require("isbinaryfile"))
const pickle = require ("chromium-pickle-js")
const Filesystem = require("asar-electron-builder/lib/filesystem")
const UINT64 = require("cuint").UINT64

const MAX_FILE_REQUESTS = 8
const concurrency = {concurrency: MAX_FILE_REQUESTS}
const NODE_MODULES_PATTERN = path.sep + "node_modules" + path.sep

export async function walk(initialDirPath: string, consumer?: (file: string, stat: Stats) => void, filter?: Filter): Promise<Array<string>> {
  const result: Array<string> = []
  const queue: Array<string> = [initialDirPath]
  let addDirToResult = false
  while (queue.length > 0) {
    const dirPath = queue.pop()!
    if (addDirToResult) {
      result.push(dirPath)
    }
    else {
      addDirToResult = true
    }

    const childNames = await readdir(dirPath)
    childNames.sort()

    const dirs: Array<string> = []
    await BluebirdPromise.map(childNames, name => {
      const filePath = dirPath + path.sep + name
      return lstat(filePath)
        .then(stat => {
          if (filter != null && !filter(filePath, stat)) {
            return
          }

          if (consumer != null) {
            consumer(filePath, stat)
          }

          if (stat.isDirectory()) {
            dirs.push(filePath)
          }
          else {
            result.push(filePath)
          }
        })
    }, concurrency)

    for (let i = dirs.length - 1; i > -1; i--) {
      queue.push(dirs[i])
    }
  }

  return result
}

export async function createAsarArchive(src: string, resourcesPath: string, options: AsarOptions, filter: Filter, unpackPattern: Filter | null): Promise<any> {
  // sort files to minimize file change (i.e. asar file is not changed dramatically on small change)
  await new AsarPackager(src, resourcesPath, options, unpackPattern).pack(filter)
}

function addValue(map: Map<string, Array<string>>, key: string, value: string) {
  let list = map.get(key)
  if (list == null) {
    list = [value]
    map.set(key, list)
  }
  else {
    list.push(value)
  }
}

class AsarPackager {
  private readonly toPack: Array<string> = []
  private readonly fs = new Filesystem(this.src)
  private readonly changedFiles = new Map<string, string>()
  private readonly outFile: string

  private srcRealPath: Promise<string>

  constructor(private readonly src: string, private readonly resourcesPath: string, private readonly options: AsarOptions, private readonly unpackPattern: Filter | null) {
    this.outFile = path.join(this.resourcesPath, "app.asar")
  }

  async pack(filter: Filter) {
    const metadata = new Map<string, Stats>()
    const files = await walk(this.src, (it, stat) => {
      metadata.set(it, stat)
    }, filter)

    await this.createPackageFromFiles(this.options.ordering == null ? files : await this.order(files), metadata)
    await this.writeAsarFile()
  }

  getSrcRealPath(): Promise<string> {
    if (this.srcRealPath == null) {
      this.srcRealPath = realpath(this.src)
    }
    return this.srcRealPath
  }

  async detectUnpackedDirs(files: Array<string>, metadata: Map<string, Stats>, autoUnpackDirs: Set<string>, unpackedDest: string, fileIndexToModulePackageData: Map<number, BluebirdPromise<string>>) {
    const packageJsonStringLength = "package.json".length
    const dirToCreate = new Map<string, Array<string>>()

    for (let i = 0, n = files.length; i < n; i++) {
      const file = files[i]
      const index = file.lastIndexOf(NODE_MODULES_PATTERN)
      if (index < 0) {
        continue
      }

      const nextSlashIndex = file.indexOf(path.sep, index + NODE_MODULES_PATTERN.length + 1)
      if (nextSlashIndex < 0) {
        continue
      }

      if (!metadata.get(file)!.isFile()) {
        continue
      }

      const nodeModuleDir = file.substring(0, nextSlashIndex)

      if (file.length === (nodeModuleDir.length + 1 + packageJsonStringLength) && file.endsWith("package.json")) {
        fileIndexToModulePackageData.set(i, readJson(file).then(it => cleanupPackageJson(it)))
      }

      if (autoUnpackDirs.has(nodeModuleDir)) {
        const fileParent = path.dirname(file)
        if (fileParent !== nodeModuleDir && !autoUnpackDirs.has(fileParent)) {
          autoUnpackDirs.add(fileParent)
          addValue(dirToCreate, path.relative(this.src, nodeModuleDir), path.relative(nodeModuleDir, fileParent))
        }
        continue
      }

      const ext = path.extname(file)
      let shouldUnpack = false
      if (ext === ".dll" || ext === ".exe") {
        shouldUnpack = true
      }
      else if (ext === "") {
        shouldUnpack = await isBinaryFile(file)
      }

      if (!shouldUnpack) {
        continue
      }

      debug(`${path.relative(this.src, nodeModuleDir)} is not packed into asar archive - contains executable code`)

      let fileParent = path.dirname(file)

      // create parent dir to be able to copy file later without directory existence check
      addValue(dirToCreate, path.relative(this.src, nodeModuleDir), path.relative(nodeModuleDir, fileParent))

      while (fileParent !== nodeModuleDir) {
        autoUnpackDirs.add(fileParent)
        fileParent = path.dirname(fileParent)
      }
      autoUnpackDirs.add(nodeModuleDir)
    }

    if (fileIndexToModulePackageData.size > 0) {
      await BluebirdPromise.all(<any>fileIndexToModulePackageData.values())
    }

    if (dirToCreate.size > 0) {
      // child directories should be not created asynchronously - parent directories should be created first
      await BluebirdPromise.map(dirToCreate.keys(), async (it) => {
        const base = path.join(unpackedDest, it)
        await ensureDir(base)
        await BluebirdPromise.each(dirToCreate.get(it)!, it => ensureDir(path.join(base, it)))
      }, concurrency)
    }
  }

  async createPackageFromFiles(files: Array<string>, metadata: Map<string, Stats>) {
    // search auto unpacked dir
    const unpackedDirs = new Set<string>()
    const unpackedDest = `${this.outFile}.unpacked`
    const fileIndexToModulePackageData = new Map<number, BluebirdPromise<string>>()
    await ensureDir(path.dirname(this.outFile))

    if (this.options.smartUnpack !== false) {
      await this.detectUnpackedDirs(files, metadata, unpackedDirs, unpackedDest, fileIndexToModulePackageData)
    }

    const copyPromises: Array<Promise<any>> = []
    const mainPackageJson = path.join(this.src, "package.json")
    for (let i = 0, n = files.length; i < n; i++) {
      const file = files[i]
      const stat = metadata.get(file)!
      if (stat.isFile()) {
        const fileParent = path.dirname(file)
        const dirNode = this.fs.searchNodeFromPath(fileParent)
        const packageDataPromise = fileIndexToModulePackageData.get(i)
        let newData: any | null = null
        if (packageDataPromise == null) {
          if (this.options.extraMetadata != null && file === mainPackageJson) {
            newData = JSON.stringify(deepAssign(await readJson(file), this.options.extraMetadata), null, 2)
          }
        }
        else {
          newData = packageDataPromise.value()
        }

        const fileSize = newData == null ? stat.size : Buffer.byteLength(newData)
        const node = this.fs.searchNodeFromPath(file)
        node.size = fileSize
        if (dirNode.unpacked || (this.unpackPattern != null && this.unpackPattern(file, stat))) {
          node.unpacked = true

          if (!dirNode.unpacked && !unpackedDirs.has(fileParent)) {
            unpackedDirs.add(fileParent)
            await ensureDir(path.join(unpackedDest, path.relative(this.src, fileParent)))
          }

          const unpackedFile = path.join(unpackedDest, path.relative(this.src, file))
          copyPromises.push(newData == null ? copyFile(file, unpackedFile, stat) : writeFile(unpackedFile, newData))
          if (copyPromises.length > MAX_FILE_REQUESTS) {
            await BluebirdPromise.all(copyPromises)
            copyPromises.length = 0
          }
        }
        else {
          if (newData != null) {
            this.changedFiles.set(file, newData)
          }

          if (fileSize > 4294967295) {
            throw new Error(`${file}: file size can not be larger than 4.2GB`)
          }

          node.offset = this.fs.offset.toString()
          //noinspection JSBitwiseOperatorUsage
          if (process.platform !== "win32" && stat.mode & 0x40) {
            node.executable = true
          }
          this.toPack.push(file)
          this.fs.offset.add(UINT64(fileSize))
        }
      }
      else if (stat.isDirectory()) {
        let unpacked = false
        if (unpackedDirs.has(file)) {
          unpacked = true
        }
        else {
          for (const dir of unpackedDirs) {
            if (file.length > (dir.length + 2) && file[dir.length] === path.sep && file.startsWith(dir)) {
              unpacked = true
              unpackedDirs.add(file)
              // not all dirs marked as unpacked after first iteration - because node module dir can be marked as unpacked after processing node module dir content
              // e.g. node-notifier/example/advanced.js processed, but only on process vendor/terminal-notifier.app module will be marked as unpacked
              await ensureDir(path.join(unpackedDest, path.relative(this.src, file)))
              break
            }
          }
        }
        this.fs.insertDirectory(file, unpacked)
      }
      else if (stat.isSymbolicLink()) {
        await this.addLink(file)
      }
    }

    if (copyPromises.length > 0) {
      await BluebirdPromise.all(copyPromises)
    }
  }

  private async addLink(file: string) {
    const realFile = await realpath(file)
    const link = path.relative(await this.getSrcRealPath(), realFile)
    if (link.startsWith("..")) {
      throw new Error(realFile + ": file links out of the package")
    }
    else {
      this.fs.searchNodeFromPath(file).link = link
    }
  }

  private writeAsarFile(): Promise<any> {
    const headerPickle = pickle.createEmpty()
    headerPickle.writeString(JSON.stringify(this.fs.header))
    const headerBuf = headerPickle.toBuffer()

    const sizePickle = pickle.createEmpty()
    sizePickle.writeUInt32(headerBuf.length)
    const sizeBuf = sizePickle.toBuffer()

    const writeStream = createWriteStream(this.outFile)
    return new BluebirdPromise((resolve, reject) => {
      writeStream.on("error", reject)
      writeStream.once("finish", resolve)
      writeStream.write(sizeBuf)

      let w: (list: Array<any>, index: number) => void
      w = (list: Array<any>, index: number) => {
        if (list.length === index) {
          writeStream.end()
          return
        }

        const file = list[index]

        const data = this.changedFiles.get(file)
        if (data != null) {
          writeStream.write(data, () => w(list, index + 1))
          return
        }

        const readStream = createReadStream(file)
        readStream.on("error", reject)
        readStream.once("end", () => w(list, index + 1))
        readStream.pipe(writeStream, {
          end: false
        })
      }

      writeStream.write(headerBuf, () => w(this.toPack, 0))
    })
  }

  private async order(filenames: Array<string>) {
    const orderingFiles = (await readFile(this.options.ordering!, "utf8")).split("\n").map(line => {
      if (line.indexOf(":") !== -1) {
        line = line.split(":").pop()!
      }
      line = line.trim()
      if (line[0] === "/") {
        line = line.slice(1)
      }
      return line
    })

    const ordering: Array<string> = []
    for (const file of orderingFiles) {
      let pathComponents = file.split(path.sep)
      let str = this.src
      for (let pathComponent of pathComponents) {
        str = path.join(str, pathComponent)
        ordering.push(str)
      }
    }

    const filenamesSorted: Array<string> = []
    let missing = 0
    const total = filenames.length
    for (const file of ordering) {
      if (!filenamesSorted.includes(file) && filenames.includes(file)) {
        filenamesSorted.push(file)
      }
    }
    for (const file of filenames) {
      if (!filenamesSorted.includes(file)) {
        filenamesSorted.push(file)
        missing += 1
      }
    }
    log(`Ordering file has ${((total - missing) / total * 100)}% coverage.`)
    return filenamesSorted
  }
}

function cleanupPackageJson(data: any): any {
  try {
    let changed = false
    for (const prop of Object.getOwnPropertyNames(data)) {
      if (prop[0] === "_" || prop === "dist" || prop === "gitHead" || prop === "keywords") {
        delete data[prop]
        changed = true
      }
    }

    if (changed) {
      return JSON.stringify(data, null, 2)
    }
  }
  catch (e) {
    debug(e)
  }

  return null
}

export async function checkFileInArchive(asarFile: string, relativeFile: string, messagePrefix: string) {
  function error(text: string) {
    return new Error(`${messagePrefix} "${relativeFile}" in the "${asarFile}" ${text}`)
  }

  let stat: AsarFileInfo | null
  try {
    stat = statFile(asarFile, relativeFile)
  }
  catch (e) {
    const fileStat = await statOrNull(asarFile)
    if (fileStat == null) {
      throw error(`does not exist. Seems like a wrong configuration.`)
    }

    try {
      listPackage(asarFile)
    }
    catch (e) {
      throw error(`is corrupted: ${e}`)
    }

    // asar throws error on access to undefined object (info.link)
    stat = null
  }

  if (stat == null) {
    throw error(`does not exist. Seems like a wrong configuration.`)
  }
  if (stat.size === 0) {
    throw error(`is corrupted: size 0`)
  }
}

function copyFile(src: string, dest: string, stats: Stats) {
  if (process.platform != "win32" && (isCi || process.env.USE_HARD_LINKS === "true")) {
    return link(src, dest)
  }

  return new BluebirdPromise(function (resolve, reject) {
    const readStream = createReadStream(src)
    const writeStream = createWriteStream(dest, {mode: stats.mode})

    readStream.on("error", reject)
    writeStream.on("error", reject)

    writeStream.on("open", function () {
      readStream.pipe(writeStream)
    })

    writeStream.once("finish", resolve)
  })
}