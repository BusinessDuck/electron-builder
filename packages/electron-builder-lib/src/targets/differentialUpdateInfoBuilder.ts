import { BlockMapDataHolder, PackageFileInfo } from "builder-util-runtime"
import { exec } from "builder-util/out/util"
import * as path from "path"
import { Target } from "../core"
import { PlatformPackager } from "../platformPackager"
import { ArchiveOptions } from "./archive"
import { getTool } from "./tools"

export const BLOCK_MAP_FILE_SUFFIX = ".blockmap"

export function createNsisWebDifferentialUpdateInfo(artifactPath: string, packageFiles: { [arch: string]: PackageFileInfo }) {
  if (packageFiles == null) {
    return null
  }

  const keys = Object.keys(packageFiles)
  if (keys.length <= 0) {
    return null
  }

  const packages: { [arch: string]: PackageFileInfo } = {}
  for (const arch of keys) {
    const packageFileInfo = packageFiles[arch]
    packages[arch] = {
      ...packageFileInfo,
      path: path.basename(packageFileInfo.path)
    }
  }
  return {packages}
}

export function configureDifferentialAwareArchiveOptions(archiveOptions: ArchiveOptions): ArchiveOptions {
  archiveOptions.solid = false
  // our reader doesn't support compressed headers
  archiveOptions.isArchiveHeaderCompressed = false
  /*
   * dict size 64 MB: Full: 33,744.88 KB, To download: 17,630.3 KB (52%)
   * dict size 16 MB: Full: 33,936.84 KB, To download: 16,175.9 KB (48%)
   * dict size  8 MB: Full: 34,187.59 KB, To download:  8,229.9 KB (24%)
   * dict size  4 MB: Full: 34,628.73 KB, To download: 3,782.97 KB (11%)

   as we can see, if file changed in one place, all block is invalidated (and update size approximately equals to dict size)
   */
  archiveOptions.dictSize = 4
  // do not allow to change compression level to avoid different packages
  archiveOptions.compression = "normal"
  return archiveOptions
}

function getBlockMapTool() {
  // noinspection SpellCheckingInspection
  return getTool({
    repository: "develar/block-map-builder",
    name: "block-map-builder",
    version: "0.1.0",
    mac: "hqlM948NJFglvJ9S0OC4COcc1rw2CwYjc1KJQKED/PfKHhPQsLbv5Z1Mi13mP5C/g/6bXqTnwjs2gLYTocfTVQ==",
    "linux-ia32": "E7YpTsavXC9vZ0NZV6pykpvgYhHxyQBJsoLCHIWwwQA9mrSpnq828qCdE5c4/aMsoETlwxBWe6BFObSn4dzSPw==",
    "linux-x64": "08Ps5UWzeUrfOBDwu3QGjH/QcHeFHnfURdrl8OpXNGLfYFMgobFGbIMw3YY+Jc+YFofpvruRoWDJ0yBGXWHr9w==",
    "win-ia32": "63xaYaZl/8LAwGigfVBgeDWEhZeViOvv4tRetkeppD4qCohwCRgoMI1l9+k5LeyqOnjethFzkJASZfbGi6Ww+Q==",
    "win-x64": "ABcfppB8I5O2A1L1ZwpRjCXqHFMuqoeeNCE+mhR9i9nKJANz2peS0Ob6sD7Y5M2R0TYDNLyQCC4YCexk6NWVHw==",
  })
}

export async function appendBlockmap(file: string): Promise<BlockMapDataHolder> {
  return JSON.parse(await exec(await getBlockMapTool(), ["-in", file, "-append", "-compression", "deflate"]))
}

export async function createBlockmap(file: string, target: Target, packager: PlatformPackager<any>, safeArtifactName: string | null): Promise<BlockMapDataHolder> {
  const blockMapFile = `${file}${BLOCK_MAP_FILE_SUFFIX}`
  const updateInfo: BlockMapDataHolder = JSON.parse(await exec(await getBlockMapTool(), ["-in", file, "-out", blockMapFile]))
  packager.info.dispatchArtifactCreated({
    file: blockMapFile,
    safeArtifactName: `${safeArtifactName}${BLOCK_MAP_FILE_SUFFIX}`,
    target,
    arch: null,
    packager,
    updateInfo,
  })
  return updateInfo
}